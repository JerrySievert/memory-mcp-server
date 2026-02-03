/**
 * Record Module
 *
 * Defines the record structures for memories and relationships,
 * with serialization/deserialization and content-addressable hashing.
 *
 * Records are immutable once created. Updates create new versions.
 *
 * @module store/record
 */

import { createHash } from 'crypto';

/**
 * Record types
 */
export const RecordType = {
  MEMORY: 'memory',
  RELATIONSHIP: 'relationship'
};

/**
 * Generate a UUID v4
 *
 * @returns {string} UUID string
 */
export function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Generate a content hash for a record
 * Uses SHA-256 and includes all content fields (not metadata like timestamps)
 *
 * @param {Object} data - Data to hash
 * @param {string} [algorithm="sha256"] - Hash algorithm
 * @returns {string} Hex-encoded hash
 */
export function contentHash(data, algorithm = 'sha256') {
  const hash = createHash(algorithm);

  // Sort keys for deterministic hashing
  const sortedKeys = Object.keys(data).sort();

  for (const key of sortedKeys) {
    const value = data[key];
    hash.update(key + ':');

    if (value === null || value === undefined) {
      hash.update('null');
    } else if (typeof value === 'string') {
      hash.update(value);
    } else if (typeof value === 'number') {
      hash.update(value.toString());
    } else if (typeof value === 'boolean') {
      hash.update(value ? 'true' : 'false');
    } else if (Array.isArray(value)) {
      hash.update(JSON.stringify(value.sort()));
    } else if (value instanceof Float32Array || value instanceof Uint8Array) {
      hash.update(Buffer.from(value.buffer));
    } else if (Buffer.isBuffer(value)) {
      hash.update(value);
    } else {
      hash.update(JSON.stringify(value));
    }
    hash.update('|');
  }

  return hash.digest('hex');
}

/**
 * @typedef {Object} MemoryRecord
 * @property {string} record_type - Always "memory"
 * @property {string} content_hash - SHA-256 hash of content fields
 * @property {string} memory_id - UUID, stable across versions
 * @property {number} version - Incrementing version number
 * @property {string} store_id - Fork/store UUID ("main" for default)
 * @property {number} timestamp - Unix timestamp in ms
 * @property {string} category - Memory category
 * @property {string} type - Memory type (person, fact, etc.)
 * @property {string} content - The actual memory content
 * @property {string[]} tags - Array of tags
 * @property {number} importance - Priority score 1-10
 * @property {string} cadence_type - Cadence type
 * @property {string|null} cadence_value - Cadence value
 * @property {string|null} context - Creation context
 * @property {Float32Array|null} embedding - Vector embedding (384 dimensions)
 * @property {boolean} deleted - Soft delete flag
 * @property {string|null} prev_hash - Hash of previous version
 */

/**
 * Create a new memory record
 *
 * @param {Object} data - Memory data
 * @param {string} data.memory_id - UUID (generated if not provided)
 * @param {number} [data.version=1] - Version number
 * @param {string} [data.store_id="main"] - Store/fork ID
 * @param {string} data.category - Memory category
 * @param {string} data.type - Memory type
 * @param {string} data.content - Memory content
 * @param {string[]} [data.tags=[]] - Tags
 * @param {number} [data.importance=5] - Importance 1-10
 * @param {string} [data.cadence_type="monthly"] - Cadence type
 * @param {string|null} [data.cadence_value=null] - Cadence value
 * @param {string|null} [data.context=null] - Context
 * @param {Float32Array|null} [data.embedding=null] - Embedding vector
 * @param {boolean} [data.deleted=false] - Deleted flag
 * @param {string|null} [data.prev_hash=null] - Previous version hash
 * @returns {MemoryRecord} Memory record
 */
export function createMemoryRecord(data) {
  const record = {
    record_type: RecordType.MEMORY,
    memory_id: data.memory_id || generateUUID(),
    version: data.version || 1,
    store_id: data.store_id || 'main',
    timestamp: data.timestamp || Date.now(),

    // Content fields (included in hash)
    category: data.category,
    type: data.type,
    content: data.content,
    tags: Array.isArray(data.tags) ? [...data.tags].sort() : [],
    importance: Math.max(1, Math.min(10, Math.round(data.importance || 5))),
    cadence_type: data.cadence_type || 'monthly',
    cadence_value: data.cadence_value || null,
    context: data.context || null,
    embedding: data.embedding || null,
    deleted: Boolean(data.deleted),

    // Linking
    prev_hash: data.prev_hash || null
  };

  // Generate content hash from content fields only
  record.content_hash = contentHash({
    memory_id: record.memory_id,
    version: record.version,
    store_id: record.store_id,
    category: record.category,
    type: record.type,
    content: record.content,
    tags: record.tags,
    importance: record.importance,
    cadence_type: record.cadence_type,
    cadence_value: record.cadence_value,
    context: record.context,
    deleted: record.deleted
  });

  return Object.freeze(record);
}

/**
 * Create a new version of a memory record
 *
 * @param {MemoryRecord} previous - Previous version
 * @param {Object} updates - Fields to update
 * @returns {MemoryRecord} New version
 */
export function createMemoryVersion(previous, updates) {
  return createMemoryRecord({
    ...previous,
    ...updates,
    memory_id: previous.memory_id, // Preserve ID
    version: previous.version + 1,
    timestamp: Date.now(),
    prev_hash: previous.content_hash,
    // Preserve embedding if content didn't change
    embedding:
      updates.content !== undefined && updates.content !== previous.content
        ? updates.embedding || null // Must provide new embedding or null
        : updates.embedding !== undefined
          ? updates.embedding
          : previous.embedding
  });
}

/**
 * @typedef {Object} RelationshipRecord
 * @property {string} record_type - Always "relationship"
 * @property {string} content_hash - SHA-256 hash
 * @property {string} relationship_id - UUID
 * @property {number} version - Version number
 * @property {string} store_id - Fork/store ID
 * @property {number} timestamp - Unix timestamp in ms
 * @property {string} memory_id - Source memory UUID
 * @property {string} related_memory_id - Target memory UUID
 * @property {string} relationship_type - Type of relationship
 * @property {boolean} deleted - Soft delete flag
 * @property {string|null} prev_hash - Previous version hash
 */

/**
 * Valid relationship types
 */
export const RelationshipTypes = [
  'related_to',
  'supersedes',
  'contradicts',
  'elaborates',
  'references'
];

/**
 * Create a new relationship record
 *
 * @param {Object} data - Relationship data
 * @param {string} [data.relationship_id] - UUID (generated if not provided)
 * @param {number} [data.version=1] - Version number
 * @param {string} [data.store_id="main"] - Store/fork ID
 * @param {string} data.memory_id - Source memory UUID
 * @param {string} data.related_memory_id - Target memory UUID
 * @param {string} [data.relationship_type="related_to"] - Relationship type
 * @param {boolean} [data.deleted=false] - Deleted flag
 * @param {string|null} [data.prev_hash=null] - Previous version hash
 * @returns {RelationshipRecord} Relationship record
 */
export function createRelationshipRecord(data) {
  const relationshipType = data.relationship_type || 'related_to';

  if (!RelationshipTypes.includes(relationshipType)) {
    throw new Error(
      `Invalid relationship type: ${relationshipType}. Must be one of: ${RelationshipTypes.join(', ')}`
    );
  }

  const record = {
    record_type: RecordType.RELATIONSHIP,
    relationship_id: data.relationship_id || generateUUID(),
    version: data.version || 1,
    store_id: data.store_id || 'main',
    timestamp: data.timestamp || Date.now(),

    memory_id: data.memory_id,
    related_memory_id: data.related_memory_id,
    relationship_type: relationshipType,
    deleted: Boolean(data.deleted),

    prev_hash: data.prev_hash || null
  };

  record.content_hash = contentHash({
    relationship_id: record.relationship_id,
    version: record.version,
    store_id: record.store_id,
    memory_id: record.memory_id,
    related_memory_id: record.related_memory_id,
    relationship_type: record.relationship_type,
    deleted: record.deleted
  });

  return Object.freeze(record);
}

/**
 * Create a new version of a relationship record
 *
 * @param {RelationshipRecord} previous - Previous version
 * @param {Object} updates - Fields to update
 * @returns {RelationshipRecord} New version
 */
export function createRelationshipVersion(previous, updates) {
  return createRelationshipRecord({
    ...previous,
    ...updates,
    relationship_id: previous.relationship_id,
    version: previous.version + 1,
    timestamp: Date.now(),
    prev_hash: previous.content_hash
  });
}

/**
 * Serialize a record to binary format for storage
 *
 * Format:
 * - 4 bytes: total length (uint32, big-endian)
 * - 1 byte: record type (0 = memory, 1 = relationship)
 * - 4 bytes: JSON length (uint32, big-endian)
 * - N bytes: JSON data (UTF-8)
 * - 4 bytes: embedding length (uint32, for memory only, 0 if null)
 * - M bytes: embedding data (float32 array)
 * - 32 bytes: content hash (raw bytes)
 *
 * @param {MemoryRecord|RelationshipRecord} record - Record to serialize
 * @returns {Buffer} Serialized record
 */
export function serializeRecord(record) {
  const isMemory = record.record_type === RecordType.MEMORY;

  // Prepare JSON data (excluding embedding and content_hash)
  const jsonData = { ...record };
  delete jsonData.embedding;
  delete jsonData.content_hash;

  const jsonBuffer = Buffer.from(JSON.stringify(jsonData), 'utf-8');
  const jsonLength = jsonBuffer.length;

  // Embedding (memory records only)
  let embeddingBuffer = Buffer.alloc(0);
  let embeddingLength = 0;

  if (isMemory && record.embedding) {
    embeddingBuffer = Buffer.from(record.embedding.buffer);
    embeddingLength = record.embedding.length;
  }

  // Content hash as raw bytes
  const hashBuffer = Buffer.from(record.content_hash, 'hex');

  // Calculate total length
  const totalLength =
    4 + // total length field
    1 + // record type
    4 + // JSON length
    jsonLength + // JSON data
    4 + // embedding length
    embeddingBuffer.length + // embedding data
    32; // content hash

  // Allocate and fill buffer
  const buffer = Buffer.alloc(totalLength);
  let offset = 0;

  // Total length
  buffer.writeUInt32BE(totalLength, offset);
  offset += 4;

  // Record type
  buffer.writeUInt8(isMemory ? 0 : 1, offset);
  offset += 1;

  // JSON length and data
  buffer.writeUInt32BE(jsonLength, offset);
  offset += 4;
  jsonBuffer.copy(buffer, offset);
  offset += jsonLength;

  // Embedding length and data
  buffer.writeUInt32BE(embeddingLength, offset);
  offset += 4;
  if (embeddingBuffer.length > 0) {
    embeddingBuffer.copy(buffer, offset);
    offset += embeddingBuffer.length;
  }

  // Content hash
  hashBuffer.copy(buffer, offset);

  return buffer;
}

/**
 * Deserialize a record from binary format
 *
 * @param {Buffer} buffer - Buffer to deserialize
 * @param {number} [startOffset=0] - Starting offset in buffer
 * @returns {{record: MemoryRecord|RelationshipRecord, bytesRead: number}} Deserialized record and bytes consumed
 */
export function deserializeRecord(buffer, startOffset = 0) {
  let offset = startOffset;

  // Total length
  const totalLength = buffer.readUInt32BE(offset);
  offset += 4;

  // Record type
  const recordTypeCode = buffer.readUInt8(offset);
  offset += 1;
  const isMemory = recordTypeCode === 0;

  // JSON length and data
  const jsonLength = buffer.readUInt32BE(offset);
  offset += 4;
  const jsonData = JSON.parse(
    buffer.slice(offset, offset + jsonLength).toString('utf-8')
  );
  offset += jsonLength;

  // Embedding length and data
  const embeddingLength = buffer.readUInt32BE(offset);
  offset += 4;

  let embedding = null;
  if (embeddingLength > 0) {
    const embeddingBytes = buffer.slice(offset, offset + embeddingLength * 4);
    // Copy to a new ArrayBuffer to ensure proper alignment
    const alignedBuffer = new ArrayBuffer(embeddingLength * 4);
    const alignedView = new Uint8Array(alignedBuffer);
    alignedView.set(embeddingBytes);
    embedding = new Float32Array(alignedBuffer);
    offset += embeddingLength * 4;
  }

  // Content hash
  const hashBuffer = buffer.slice(offset, offset + 32);
  const contentHashValue = hashBuffer.toString('hex');
  offset += 32;

  // Reconstruct record
  const record = {
    ...jsonData,
    content_hash: contentHashValue
  };

  if (isMemory) {
    record.embedding = embedding;
  }

  return {
    record: Object.freeze(record),
    bytesRead: totalLength
  };
}

/**
 * Verify a record's content hash
 *
 * @param {MemoryRecord|RelationshipRecord} record - Record to verify
 * @returns {boolean} True if hash is valid
 */
export function verifyRecordHash(record) {
  const isMemory = record.record_type === RecordType.MEMORY;

  const dataToHash = isMemory
    ? {
        memory_id: record.memory_id,
        version: record.version,
        store_id: record.store_id,
        category: record.category,
        type: record.type,
        content: record.content,
        tags: record.tags,
        importance: record.importance,
        cadence_type: record.cadence_type,
        cadence_value: record.cadence_value,
        context: record.context,
        deleted: record.deleted
      }
    : {
        relationship_id: record.relationship_id,
        version: record.version,
        store_id: record.store_id,
        memory_id: record.memory_id,
        related_memory_id: record.related_memory_id,
        relationship_type: record.relationship_type,
        deleted: record.deleted
      };

  const expectedHash = contentHash(dataToHash);
  return expectedHash === record.content_hash;
}

export default {
  RecordType,
  RelationshipTypes,
  generateUUID,
  contentHash,
  createMemoryRecord,
  createMemoryVersion,
  createRelationshipRecord,
  createRelationshipVersion,
  serializeRecord,
  deserializeRecord,
  verifyRecordHash
};
