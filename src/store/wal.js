/**
 * Write-Ahead Log (WAL) Module
 *
 * Implements an append-only write-ahead log for durability.
 * Records are appended to the WAL and periodically flushed to immutable segments.
 *
 * File Format:
 * - Header (16 bytes):
 *   - Magic number: 4 bytes "MWAL"
 *   - Version: 4 bytes (uint32)
 *   - Store ID length: 4 bytes (uint32)
 *   - Record count: 4 bytes (uint32)
 * - Store ID: variable length UTF-8
 * - Records: variable length, each prefixed with length
 *
 * @module store/wal
 */

import { existsSync, mkdirSync, openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import { serializeRecord, deserializeRecord } from "./record.js";

const MAGIC = Buffer.from("MWAL");
const VERSION = 1;
const HEADER_SIZE = 16;

/**
 * @typedef {Object} WALOptions
 * @property {string} path - Path to WAL file
 * @property {string} storeId - Store/fork ID
 * @property {boolean} [syncOnWrite=true] - Sync to disk after each write
 * @property {number} [maxSizeBytes=16777216] - Max size before rotation (16MB default)
 */

/**
 * Write-Ahead Log class
 */
export class WAL {
  /**
   * Create a new WAL instance
   *
   * @param {WALOptions} options - WAL options
   */
  constructor(options) {
    this.path = options.path;
    this.storeId = options.storeId;
    this.syncOnWrite = options.syncOnWrite !== false;
    this.maxSizeBytes = options.maxSizeBytes || 16 * 1024 * 1024;

    this.fd = null;
    this.recordCount = 0;
    this.currentSize = 0;
    this.records = []; // In-memory cache of records
    this.dirty = false;
  }

  /**
   * Open or create the WAL file
   *
   * @returns {Promise<void>}
   */
  async open() {
    // Ensure directory exists
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(this.path)) {
      // Open existing WAL and read contents
      await this._openExisting();
    } else {
      // Create new WAL
      await this._createNew();
    }
  }

  /**
   * Open an existing WAL file and load records
   *
   * @private
   */
  async _openExisting() {
    this.fd = openSync(this.path, "r+");

    const stat = fstatSync(this.fd);
    this.currentSize = stat.size;

    // Read and verify header
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    readSync(this.fd, headerBuf, 0, HEADER_SIZE, 0);

    const magic = headerBuf.slice(0, 4);
    if (!magic.equals(MAGIC)) {
      throw new Error(`Invalid WAL file: bad magic number`);
    }

    const version = headerBuf.readUInt32BE(4);
    if (version !== VERSION) {
      throw new Error(`Unsupported WAL version: ${version}`);
    }

    const storeIdLength = headerBuf.readUInt32BE(8);
    this.recordCount = headerBuf.readUInt32BE(12);

    // Read store ID
    const storeIdBuf = Buffer.alloc(storeIdLength);
    readSync(this.fd, storeIdBuf, 0, storeIdLength, HEADER_SIZE);
    const fileStoreId = storeIdBuf.toString("utf-8");

    if (fileStoreId !== this.storeId) {
      throw new Error(`WAL store ID mismatch: expected ${this.storeId}, got ${fileStoreId}`);
    }

    // Read all records
    let offset = HEADER_SIZE + storeIdLength;
    this.records = [];

    while (offset < this.currentSize) {
      // Read record length
      const lengthBuf = Buffer.alloc(4);
      const bytesRead = readSync(this.fd, lengthBuf, 0, 4, offset);

      if (bytesRead < 4) {
        // Truncated record, file may be corrupt
        console.warn(`WAL truncated at offset ${offset}, truncating file`);
        break;
      }

      const recordLength = lengthBuf.readUInt32BE(0);

      if (offset + recordLength > this.currentSize) {
        // Incomplete record
        console.warn(`WAL incomplete record at offset ${offset}, truncating file`);
        break;
      }

      // Read record data
      const recordBuf = Buffer.alloc(recordLength);
      readSync(this.fd, recordBuf, 0, recordLength, offset);

      try {
        const { record } = deserializeRecord(recordBuf, 0);
        this.records.push({
          record,
          offset,
          length: recordLength,
        });
      } catch (err) {
        console.warn(`WAL corrupt record at offset ${offset}: ${err.message}`);
        break;
      }

      offset += recordLength;
    }

    // Update record count if we had to truncate
    if (this.records.length !== this.recordCount) {
      this.recordCount = this.records.length;
      this._updateHeader();
    }
  }

  /**
   * Create a new WAL file
   *
   * @private
   */
  async _createNew() {
    this.fd = openSync(this.path, "w+");

    const storeIdBuf = Buffer.from(this.storeId, "utf-8");

    // Write header
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(headerBuf, 0);
    headerBuf.writeUInt32BE(VERSION, 4);
    headerBuf.writeUInt32BE(storeIdBuf.length, 8);
    headerBuf.writeUInt32BE(0, 12); // Record count

    writeSync(this.fd, headerBuf, 0, HEADER_SIZE, 0);
    writeSync(this.fd, storeIdBuf, 0, storeIdBuf.length, HEADER_SIZE);

    this.currentSize = HEADER_SIZE + storeIdBuf.length;
    this.recordCount = 0;
    this.records = [];

    if (this.syncOnWrite) {
      fsyncSync(this.fd);
    }
  }

  /**
   * Update the header with current record count
   *
   * @private
   */
  _updateHeader() {
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32BE(this.recordCount, 0);
    writeSync(this.fd, countBuf, 0, 4, 12);

    if (this.syncOnWrite) {
      fsyncSync(this.fd);
    }
  }

  /**
   * Append a record to the WAL
   *
   * @param {Object} record - Record to append
   * @returns {{offset: number, length: number}} Location of record
   */
  append(record) {
    if (!this.fd) {
      throw new Error("WAL not open");
    }

    const serialized = serializeRecord(record);
    const offset = this.currentSize;

    writeSync(this.fd, serialized, 0, serialized.length, offset);

    this.currentSize += serialized.length;
    this.recordCount++;
    this.dirty = true;

    this.records.push({
      record,
      offset,
      length: serialized.length,
    });

    // Update header with new record count
    this._updateHeader();

    return { offset, length: serialized.length };
  }

  /**
   * Get all records in the WAL
   *
   * @returns {Object[]} Array of records
   */
  getRecords() {
    return this.records.map(r => r.record);
  }

  /**
   * Get the number of records in the WAL
   *
   * @returns {number} Record count
   */
  getRecordCount() {
    return this.recordCount;
  }

  /**
   * Get the current size of the WAL in bytes
   *
   * @returns {number} Size in bytes
   */
  getSize() {
    return this.currentSize;
  }

  /**
   * Check if WAL should be rotated (exceeds max size)
   *
   * @returns {boolean} True if rotation needed
   */
  shouldRotate() {
    return this.currentSize >= this.maxSizeBytes;
  }

  /**
   * Sync the WAL to disk
   */
  sync() {
    if (this.fd) {
      fsyncSync(this.fd);
      this.dirty = false;
    }
  }

  /**
   * Close the WAL file
   */
  close() {
    if (this.fd) {
      if (this.dirty) {
        fsyncSync(this.fd);
      }
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Clear the WAL (after rotation to segment)
   * Creates a new empty WAL file
   */
  async clear() {
    this.close();

    // Remove old file
    if (existsSync(this.path)) {
      unlinkSync(this.path);
    }

    // Create new empty WAL
    await this._createNew();
  }

  /**
   * Rotate the WAL to a segment file
   * Returns the path to the new segment and clears the WAL
   *
   * @param {string} segmentPath - Path for the new segment file
   * @returns {Promise<{segmentPath: string, recordCount: number}>}
   */
  async rotate(segmentPath) {
    if (this.recordCount === 0) {
      return { segmentPath: null, recordCount: 0 };
    }

    // Ensure segment directory exists
    const segmentDir = dirname(segmentPath);
    if (!existsSync(segmentDir)) {
      mkdirSync(segmentDir, { recursive: true });
    }

    // Sync and close current WAL
    this.sync();
    this.close();

    // Rename WAL to segment
    renameSync(this.path, segmentPath);

    const recordCount = this.recordCount;

    // Create new empty WAL
    await this._createNew();

    return { segmentPath, recordCount };
  }
}

/**
 * Create and open a new WAL
 *
 * @param {WALOptions} options - WAL options
 * @returns {Promise<WAL>} Opened WAL instance
 */
export async function openWAL(options) {
  const wal = new WAL(options);
  await wal.open();
  return wal;
}

export default {
  WAL,
  openWAL,
};
