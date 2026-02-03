/**
 * Segment Module
 *
 * Implements immutable segment files for long-term storage.
 * Segments are created from WAL rotation and are never modified after creation.
 *
 * File Format (same as WAL):
 * - Header (16 bytes):
 *   - Magic number: 4 bytes "MSEG"
 *   - Version: 4 bytes (uint32)
 *   - Store ID length: 4 bytes (uint32)
 *   - Record count: 4 bytes (uint32)
 * - Store ID: variable length UTF-8
 * - Records: variable length, each self-describing with length prefix
 *
 * @module store/segment
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  readdirSync,
  unlinkSync,
  renameSync
} from 'fs';
import { join, dirname, basename } from 'path';
import { deserializeRecord } from './record.js';

const MAGIC = Buffer.from('MSEG');
const VERSION = 1;
const HEADER_SIZE = 16;

/**
 * @typedef {Object} SegmentInfo
 * @property {string} path - Path to segment file
 * @property {string} storeId - Store/fork ID
 * @property {number} recordCount - Number of records
 * @property {number} size - File size in bytes
 * @property {number} segmentNumber - Segment sequence number
 */

/**
 * @typedef {Object} RecordLocation
 * @property {string} segmentPath - Path to segment file
 * @property {number} offset - Byte offset in file
 * @property {number} length - Record length in bytes
 */

/**
 * Segment Reader class
 * Reads records from an immutable segment file
 */
export class SegmentReader {
  /**
   * Create a new SegmentReader
   *
   * @param {string} path - Path to segment file
   */
  constructor(path) {
    this.path = path;
    this.fd = null;
    this.storeId = null;
    this.recordCount = 0;
    this.size = 0;
    this.dataOffset = 0; // Offset where records start
  }

  /**
   * Open the segment file for reading
   *
   * @returns {Promise<void>}
   */
  async open() {
    if (!existsSync(this.path)) {
      throw new Error(`Segment file not found: ${this.path}`);
    }

    this.fd = openSync(this.path, 'r');

    const stat = fstatSync(this.fd);
    this.size = stat.size;

    // Read and verify header
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    readSync(this.fd, headerBuf, 0, HEADER_SIZE, 0);

    const magic = headerBuf.slice(0, 4);
    // Accept both MSEG (segment) and MWAL (rotated WAL)
    if (!magic.equals(MAGIC) && !magic.equals(Buffer.from('MWAL'))) {
      throw new Error(`Invalid segment file: bad magic number`);
    }

    const version = headerBuf.readUInt32BE(4);
    if (version !== VERSION) {
      throw new Error(`Unsupported segment version: ${version}`);
    }

    const storeIdLength = headerBuf.readUInt32BE(8);
    this.recordCount = headerBuf.readUInt32BE(12);

    // Read store ID
    const storeIdBuf = Buffer.alloc(storeIdLength);
    readSync(this.fd, storeIdBuf, 0, storeIdLength, HEADER_SIZE);
    this.storeId = storeIdBuf.toString('utf-8');

    this.dataOffset = HEADER_SIZE + storeIdLength;
  }

  /**
   * Read a record at a specific offset
   *
   * @param {number} offset - Byte offset in file
   * @returns {Object} Deserialized record
   */
  readAt(offset) {
    if (!this.fd) {
      throw new Error('Segment not open');
    }

    // Read record length first
    const lengthBuf = Buffer.alloc(4);
    readSync(this.fd, lengthBuf, 0, 4, offset);
    const recordLength = lengthBuf.readUInt32BE(0);

    // Read full record
    const recordBuf = Buffer.alloc(recordLength);
    readSync(this.fd, recordBuf, 0, recordLength, offset);

    const { record } = deserializeRecord(recordBuf, 0);
    return record;
  }

  /**
   * Iterate over all records in the segment
   *
   * @yields {{record: Object, offset: number, length: number}}
   */
  *iterate() {
    if (!this.fd) {
      throw new Error('Segment not open');
    }

    let offset = this.dataOffset;

    while (offset < this.size) {
      // Read record length
      const lengthBuf = Buffer.alloc(4);
      const bytesRead = readSync(this.fd, lengthBuf, 0, 4, offset);

      if (bytesRead < 4) {
        break;
      }

      const recordLength = lengthBuf.readUInt32BE(0);

      if (offset + recordLength > this.size) {
        break;
      }

      // Read full record
      const recordBuf = Buffer.alloc(recordLength);
      readSync(this.fd, recordBuf, 0, recordLength, offset);

      const { record } = deserializeRecord(recordBuf, 0);

      yield {
        record,
        offset,
        length: recordLength
      };

      offset += recordLength;
    }
  }

  /**
   * Get all records as an array
   *
   * @returns {Object[]} Array of records
   */
  getAllRecords() {
    const records = [];
    for (const { record } of this.iterate()) {
      records.push(record);
    }
    return records;
  }

  /**
   * Get segment info
   *
   * @returns {SegmentInfo}
   */
  getInfo() {
    const segmentNumber = this._parseSegmentNumber();
    return {
      path: this.path,
      storeId: this.storeId,
      recordCount: this.recordCount,
      size: this.size,
      segmentNumber
    };
  }

  /**
   * Parse segment number from filename
   *
   * @private
   * @returns {number}
   */
  _parseSegmentNumber() {
    const name = basename(this.path);
    const match = name.match(/^(\d+)\.seg$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Close the segment file
   */
  close() {
    if (this.fd) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Segment Manager class
 * Manages multiple segments for a store
 */
export class SegmentManager {
  /**
   * Create a new SegmentManager
   *
   * @param {string} segmentsDir - Directory containing segment files
   * @param {string} storeId - Store/fork ID
   */
  constructor(segmentsDir, storeId) {
    this.segmentsDir = segmentsDir;
    this.storeId = storeId;
    this.segments = new Map(); // segmentNumber -> SegmentReader
    this.nextSegmentNumber = 1;
  }

  /**
   * Initialize the segment manager
   * Scans directory for existing segments
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    // Ensure directory exists
    if (!existsSync(this.segmentsDir)) {
      mkdirSync(this.segmentsDir, { recursive: true });
      return;
    }

    // Scan for existing segments
    const files = readdirSync(this.segmentsDir);
    const segmentFiles = files
      .filter((f) => f.match(/^\d+\.seg$/))
      .sort((a, b) => {
        const numA = parseInt(a.match(/^(\d+)/)[1], 10);
        const numB = parseInt(b.match(/^(\d+)/)[1], 10);
        return numA - numB;
      });

    for (const file of segmentFiles) {
      const path = join(this.segmentsDir, file);
      const reader = new SegmentReader(path);

      try {
        await reader.open();

        // Verify store ID matches
        if (reader.storeId !== this.storeId) {
          console.warn(
            `Segment ${file} has wrong store ID: ${reader.storeId}, expected ${this.storeId}`
          );
          reader.close();
          continue;
        }

        const info = reader.getInfo();
        this.segments.set(info.segmentNumber, reader);

        if (info.segmentNumber >= this.nextSegmentNumber) {
          this.nextSegmentNumber = info.segmentNumber + 1;
        }
      } catch (err) {
        console.warn(`Failed to open segment ${file}: ${err.message}`);
      }
    }
  }

  /**
   * Get the path for the next segment file
   *
   * @returns {string} Path to next segment file
   */
  getNextSegmentPath() {
    const filename = String(this.nextSegmentNumber).padStart(8, '0') + '.seg';
    return join(this.segmentsDir, filename);
  }

  /**
   * Register a new segment (after WAL rotation)
   *
   * @param {string} path - Path to the new segment file
   * @returns {Promise<SegmentReader>}
   */
  async registerSegment(path) {
    const reader = new SegmentReader(path);
    await reader.open();

    const info = reader.getInfo();
    this.segments.set(info.segmentNumber, reader);

    if (info.segmentNumber >= this.nextSegmentNumber) {
      this.nextSegmentNumber = info.segmentNumber + 1;
    }

    return reader;
  }

  /**
   * Read a record from a specific location
   *
   * @param {RecordLocation} location - Record location
   * @returns {Object} Record
   */
  readRecord(location) {
    // Find the segment containing this offset
    for (const [, reader] of this.segments) {
      if (reader.path === location.segmentPath) {
        return reader.readAt(location.offset);
      }
    }
    throw new Error(`Segment not found: ${location.segmentPath}`);
  }

  /**
   * Iterate over all records in all segments
   * Yields records in segment order (oldest first)
   *
   * @yields {{record: Object, location: RecordLocation}}
   */
  *iterateAll() {
    const sortedSegments = Array.from(this.segments.entries()).sort(
      (a, b) => a[0] - b[0]
    );

    for (const [, reader] of sortedSegments) {
      for (const { record, offset, length } of reader.iterate()) {
        yield {
          record,
          location: {
            segmentPath: reader.path,
            offset,
            length
          }
        };
      }
    }
  }

  /**
   * Get a segment reader by segment number
   *
   * @param {number} segmentNumber
   * @returns {SegmentReader|undefined}
   */
  getSegment(segmentNumber) {
    return this.segments.get(segmentNumber);
  }

  /**
   * Get all segment infos
   *
   * @returns {SegmentInfo[]}
   */
  getSegmentInfos() {
    return Array.from(this.segments.values()).map((r) => r.getInfo());
  }

  /**
   * Get total record count across all segments
   *
   * @returns {number}
   */
  getTotalRecordCount() {
    let count = 0;
    for (const reader of this.segments.values()) {
      count += reader.recordCount;
    }
    return count;
  }

  /**
   * Get total size of all segments in bytes
   *
   * @returns {number}
   */
  getTotalSize() {
    let size = 0;
    for (const reader of this.segments.values()) {
      size += reader.size;
    }
    return size;
  }

  /**
   * Remove a segment (for compaction)
   *
   * @param {number} segmentNumber - Segment number to remove
   */
  removeSegment(segmentNumber) {
    const reader = this.segments.get(segmentNumber);
    if (reader) {
      const path = reader.path;
      reader.close();
      this.segments.delete(segmentNumber);

      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }

  /**
   * Close all segment files
   */
  close() {
    for (const reader of this.segments.values()) {
      reader.close();
    }
    this.segments.clear();
  }
}

/**
 * Open a segment reader
 *
 * @param {string} path - Path to segment file
 * @returns {Promise<SegmentReader>}
 */
export async function openSegment(path) {
  const reader = new SegmentReader(path);
  await reader.open();
  return reader;
}

/**
 * Create a segment manager
 *
 * @param {string} segmentsDir - Directory for segments
 * @param {string} storeId - Store/fork ID
 * @returns {Promise<SegmentManager>}
 */
export async function createSegmentManager(segmentsDir, storeId) {
  const manager = new SegmentManager(segmentsDir, storeId);
  await manager.initialize();
  return manager;
}

export default {
  SegmentReader,
  SegmentManager,
  openSegment,
  createSegmentManager
};
