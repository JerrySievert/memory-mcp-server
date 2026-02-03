/**
 * Latest Index Implementation
 *
 * Provides O(1) lookup of the current (latest) version of any memory or relationship.
 * Maps memory_id/relationship_id to their latest record location.
 *
 * Structure: Map<id, { segmentNumber, offset, version, timestamp, deleted }>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { RecordType } from './record.js';

/**
 * Index entry for a memory or relationship
 * @typedef {Object} IndexEntry
 * @property {number|null} segmentNumber - Segment file number (null if in WAL)
 * @property {number} offset - Byte offset within segment/WAL
 * @property {number} version - Record version
 * @property {number} timestamp - Record timestamp
 * @property {boolean} deleted - Whether the record is soft-deleted
 * @property {string} contentHash - Content hash of the record
 */

/**
 * LatestIndex class for fast latest-version lookups
 */
export class LatestIndex {
  /**
   * @param {Object} options
   * @param {string} [options.indexPath] - Path to persist the index
   */
  constructor(options = {}) {
    this.indexPath = options.indexPath || null;

    // Map<memory_id, IndexEntry>
    this.memories = new Map();

    // Map<relationship_id, IndexEntry>
    this.relationships = new Map();

    // Track dirty state
    this.dirty = false;
  }

  /**
   * Update index with a new memory record
   * @param {Object} record - Memory record
   * @param {number|null} segmentNumber - Segment number (null if WAL)
   * @param {number} offset - Byte offset
   */
  updateMemory(record, segmentNumber, offset) {
    const existing = this.memories.get(record.memory_id);

    // Only update if this is a newer version OR same version with different location
    // (same version with different location happens during WAL rotation)
    if (existing && existing.version > record.version) {
      return;
    }

    this.memories.set(record.memory_id, {
      segmentNumber,
      offset,
      version: record.version,
      timestamp: record.timestamp,
      deleted: record.deleted,
      contentHash: record.content_hash
    });

    this.dirty = true;
  }

  /**
   * Update index with a new relationship record
   * @param {Object} record - Relationship record
   * @param {number|null} segmentNumber - Segment number (null if WAL)
   * @param {number} offset - Byte offset
   */
  updateRelationship(record, segmentNumber, offset) {
    const existing = this.relationships.get(record.relationship_id);

    // Only update if this is a newer version OR same version with different location
    // (same version with different location happens during WAL rotation)
    if (existing && existing.version > record.version) {
      return;
    }

    this.relationships.set(record.relationship_id, {
      segmentNumber,
      offset,
      version: record.version,
      timestamp: record.timestamp,
      deleted: record.deleted,
      contentHash: record.content_hash
    });

    this.dirty = true;
  }

  /**
   * Update index with a record (auto-detects type)
   * @param {Object} record - Record to index
   * @param {number|null} segmentNumber - Segment number
   * @param {number} offset - Byte offset
   */
  update(record, segmentNumber, offset) {
    if (record.record_type === RecordType.MEMORY) {
      this.updateMemory(record, segmentNumber, offset);
    } else if (record.record_type === RecordType.RELATIONSHIP) {
      this.updateRelationship(record, segmentNumber, offset);
    }
  }

  /**
   * Get the latest version entry for a memory
   * @param {string} memoryId
   * @returns {IndexEntry|undefined}
   */
  getMemory(memoryId) {
    return this.memories.get(memoryId);
  }

  /**
   * Get the latest version entry for a relationship
   * @param {string} relationshipId
   * @returns {IndexEntry|undefined}
   */
  getRelationship(relationshipId) {
    return this.relationships.get(relationshipId);
  }

  /**
   * Check if a memory exists (including deleted)
   * @param {string} memoryId
   * @returns {boolean}
   */
  hasMemory(memoryId) {
    return this.memories.has(memoryId);
  }

  /**
   * Check if a relationship exists (including deleted)
   * @param {string} relationshipId
   * @returns {boolean}
   */
  hasRelationship(relationshipId) {
    return this.relationships.has(relationshipId);
  }

  /**
   * Get all memory IDs (optionally excluding deleted)
   * @param {boolean} [includeDeleted=false]
   * @returns {string[]}
   */
  getAllMemoryIds(includeDeleted = false) {
    const ids = [];
    for (const [id, entry] of this.memories) {
      if (includeDeleted || !entry.deleted) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Get all relationship IDs (optionally excluding deleted)
   * @param {boolean} [includeDeleted=false]
   * @returns {string[]}
   */
  getAllRelationshipIds(includeDeleted = false) {
    const ids = [];
    for (const [id, entry] of this.relationships) {
      if (includeDeleted || !entry.deleted) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Get count of memories
   * @param {boolean} [includeDeleted=false]
   * @returns {number}
   */
  getMemoryCount(includeDeleted = false) {
    if (includeDeleted) {
      return this.memories.size;
    }
    let count = 0;
    for (const entry of this.memories.values()) {
      if (!entry.deleted) count++;
    }
    return count;
  }

  /**
   * Get count of relationships
   * @param {boolean} [includeDeleted=false]
   * @returns {number}
   */
  getRelationshipCount(includeDeleted = false) {
    if (includeDeleted) {
      return this.relationships.size;
    }
    let count = 0;
    for (const entry of this.relationships.values()) {
      if (!entry.deleted) count++;
    }
    return count;
  }

  /**
   * Remove a memory from the index (for compaction)
   * @param {string} memoryId
   */
  removeMemory(memoryId) {
    if (this.memories.delete(memoryId)) {
      this.dirty = true;
    }
  }

  /**
   * Remove a relationship from the index (for compaction)
   * @param {string} relationshipId
   */
  removeRelationship(relationshipId) {
    if (this.relationships.delete(relationshipId)) {
      this.dirty = true;
    }
  }

  /**
   * Serialize the index to a buffer
   * @returns {Buffer}
   */
  serialize() {
    const data = {
      version: 1,
      memories: Object.fromEntries(this.memories),
      relationships: Object.fromEntries(this.relationships)
    };
    return Buffer.from(JSON.stringify(data));
  }

  /**
   * Deserialize an index from a buffer
   * @param {Buffer} buffer
   * @returns {LatestIndex}
   */
  static deserialize(buffer) {
    const data = JSON.parse(buffer.toString());

    if (data.version !== 1) {
      throw new Error(`Unsupported latest index version: ${data.version}`);
    }

    const index = new LatestIndex();
    index.memories = new Map(Object.entries(data.memories));
    index.relationships = new Map(Object.entries(data.relationships));
    index.dirty = false;

    return index;
  }

  /**
   * Save the index to disk
   * @param {string} [path] - Optional path override
   */
  save(path = null) {
    const savePath = path || this.indexPath;
    if (!savePath) {
      throw new Error('No index path specified for latest index persistence');
    }

    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(savePath, this.serialize());
    this.dirty = false;
  }

  /**
   * Load the index from disk
   * @param {string} path
   * @returns {LatestIndex}
   */
  static load(path) {
    if (!existsSync(path)) {
      throw new Error(`Latest index file not found: ${path}`);
    }

    const buffer = readFileSync(path);
    const index = LatestIndex.deserialize(buffer);
    index.indexPath = path;
    return index;
  }

  /**
   * Check if index needs to be persisted
   * @returns {boolean}
   */
  isDirty() {
    return this.dirty;
  }

  /**
   * Clear the index
   */
  clear() {
    this.memories.clear();
    this.relationships.clear();
    this.dirty = true;
  }

  /**
   * Iterate over all memory entries
   * @param {boolean} [includeDeleted=false]
   * @yields {[string, IndexEntry]}
   */
  *iterateMemories(includeDeleted = false) {
    for (const [id, entry] of this.memories) {
      if (includeDeleted || !entry.deleted) {
        yield [id, entry];
      }
    }
  }

  /**
   * Iterate over all relationship entries
   * @param {boolean} [includeDeleted=false]
   * @yields {[string, IndexEntry]}
   */
  *iterateRelationships(includeDeleted = false) {
    for (const [id, entry] of this.relationships) {
      if (includeDeleted || !entry.deleted) {
        yield [id, entry];
      }
    }
  }

  /**
   * Rebuild index from records (e.g., from segment replay)
   * @param {Iterable<{record: Object, segmentNumber: number|null, offset: number}>} records
   * @returns {LatestIndex}
   */
  static rebuildFromRecords(records) {
    const index = new LatestIndex();

    for (const { record, segmentNumber, offset } of records) {
      index.update(record, segmentNumber, offset);
    }

    return index;
  }
}

export default LatestIndex;
