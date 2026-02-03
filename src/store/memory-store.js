/**
 * Memory Store Implementation
 *
 * Main API for the append-only memory storage system with:
 * - Versioned memories and relationships
 * - Semantic and full-text search
 * - Merkle tree for integrity verification
 * - Fork support via store_id
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

import { createConfig } from './config.js';
import {
  RecordType,
  createMemoryRecord,
  createMemoryVersion,
  createRelationshipRecord,
  createRelationshipVersion,
  serializeRecord,
  deserializeRecord,
  generateUUID
} from './record.js';
import { cpSync, readdirSync } from 'fs';
import { openWAL } from './wal.js';
import { createSegmentManager } from './segment.js';
import { MerkleTree } from './merkle.js';
import { LatestIndex } from './latest-index.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex } from './text-index.js';

/**
 * Normalize store ID to handle null/undefined/main
 * @param {string|null} storeId
 * @returns {string}
 */
function normalizeStoreId(storeId) {
  if (!storeId || storeId === 'main') {
    return 'main';
  }
  return storeId;
}

/**
 * MemoryStore class - main API for memory operations
 */
export class MemoryStore {
  /**
   * @param {Object} options
   * @param {Object} [options.config] - Configuration overrides
   * @param {Function} [options.embedFunction] - Function to generate embeddings
   */
  constructor(options = {}) {
    this.config = createConfig(options.config || {});
    this.embedFunction = options.embedFunction || null;

    // Store instances per store ID
    this.stores = new Map();

    // Global metadata
    this.metadata = {
      version: 1,
      created: Date.now(),
      forks: []
    };

    this.initialized = false;
    this.writeCount = 0;
  }

  /**
   * Initialize the store
   */
  async initialize() {
    if (this.initialized) return;

    // Ensure data directory exists
    if (!existsSync(this.config.dataDir)) {
      mkdirSync(this.config.dataDir, { recursive: true });
    }

    // Load or create global metadata
    const metaPath = join(this.config.dataDir, 'store.json');
    if (existsSync(metaPath)) {
      this.metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
    } else {
      this._saveMetadata();
    }

    // Initialize main store
    await this._initializeStoreInstance('main');

    this.initialized = true;
  }

  /**
   * Initialize a store instance (main or fork)
   * @param {string} storeId
   * @private
   */
  async _initializeStoreInstance(storeId) {
    if (this.stores.has(storeId)) return;

    const storeDir =
      storeId === 'main'
        ? join(this.config.dataDir, 'main')
        : join(this.config.dataDir, 'forks', storeId);

    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }

    const segmentsDir = join(storeDir, 'segments');
    const indexesDir = join(storeDir, 'indexes');

    if (!existsSync(segmentsDir)) {
      mkdirSync(segmentsDir, { recursive: true });
    }
    if (!existsSync(indexesDir)) {
      mkdirSync(indexesDir, { recursive: true });
    }

    // Initialize components
    const wal = await openWAL({
      path: join(storeDir, 'wal.log'),
      storeId,
      maxSizeBytes: this.config.segmentSizeBytes
    });

    const segmentManager = await createSegmentManager(segmentsDir, storeId);

    // Load or create indexes
    const latestIndexPath = join(indexesDir, 'latest.idx');
    const vectorIndexPath = join(indexesDir, 'vector.idx');
    const textIndexPath = join(indexesDir, 'text.idx');
    const merkleIndexPath = join(indexesDir, 'merkle.idx');

    let latestIndex, vectorIndex, textIndex, merkleTree;

    if (existsSync(latestIndexPath)) {
      latestIndex = LatestIndex.load(latestIndexPath);
    } else {
      latestIndex = new LatestIndex({ indexPath: latestIndexPath });
    }

    if (existsSync(vectorIndexPath)) {
      vectorIndex = VectorIndex.load(vectorIndexPath);
    } else {
      vectorIndex = new VectorIndex({
        indexPath: vectorIndexPath,
        M: this.config.hnswM,
        efConstruction: this.config.hnswEfConstruction,
        efSearch: this.config.hnswEfSearch
      });
    }

    if (existsSync(textIndexPath)) {
      textIndex = TextIndex.load(textIndexPath);
    } else {
      textIndex = new TextIndex({ indexPath: textIndexPath });
    }

    if (existsSync(merkleIndexPath)) {
      merkleTree = MerkleTree.load(merkleIndexPath);
    } else {
      merkleTree = new MerkleTree({ indexPath: merkleIndexPath });
    }

    // Rebuild indexes from WAL if needed
    if (wal.getRecordCount() > 0) {
      for (const record of wal.getRecords()) {
        this._updateIndexes(
          latestIndex,
          vectorIndex,
          textIndex,
          merkleTree,
          record,
          null,
          0
        );
      }
    }

    this.stores.set(storeId, {
      storeId,
      storeDir,
      wal,
      segmentManager,
      latestIndex,
      vectorIndex,
      textIndex,
      merkleTree
    });
  }

  /**
   * Get store instance, initializing if needed
   * @param {string} storeId
   * @returns {Object}
   * @private
   */
  async _getStore(storeId) {
    const normalized = normalizeStoreId(storeId);

    if (!this.stores.has(normalized)) {
      await this._initializeStoreInstance(normalized);
    }

    return this.stores.get(normalized);
  }

  /**
   * Update indexes with a new record
   * @private
   */
  _updateIndexes(
    latestIndex,
    vectorIndex,
    textIndex,
    merkleTree,
    record,
    segmentNumber,
    offset
  ) {
    // Update latest index
    latestIndex.update(record, segmentNumber, offset);

    // Update merkle tree
    merkleTree.addLeaf(record.content_hash);

    // Update search indexes (only for non-deleted memories)
    if (record.record_type === RecordType.MEMORY && !record.deleted) {
      // Vector index
      if (record.embedding) {
        vectorIndex.insert(record.memory_id, record.embedding);
      }

      // Text index
      textIndex.add(record.memory_id, record.content, {
        category: record.category,
        type: record.type,
        tags: record.tags,
        context: record.context
      });
    } else if (record.record_type === RecordType.MEMORY && record.deleted) {
      // Remove from search indexes when deleted
      vectorIndex.remove(record.memory_id);
      textIndex.remove(record.memory_id);
    }
  }

  /**
   * Persist indexes if needed based on configuration
   * @private
   */
  async _maybePersistIndexes(store) {
    this.writeCount++;

    if (
      this.config.persistEveryNWrites > 0 &&
      this.writeCount % this.config.persistEveryNWrites === 0
    ) {
      await this._persistIndexes(store);
    }
  }

  /**
   * Persist all indexes for a store
   * @private
   */
  async _persistIndexes(store) {
    if (store.latestIndex.isDirty()) {
      store.latestIndex.save();
    }
    if (store.vectorIndex.isDirty()) {
      store.vectorIndex.save();
    }
    if (store.textIndex.isDirty()) {
      store.textIndex.save();
    }
    if (store.merkleTree.isDirty()) {
      store.merkleTree.save();
    }
  }

  /**
   * Save global metadata
   * @private
   */
  _saveMetadata() {
    const metaPath = join(this.config.dataDir, 'store.json');
    writeFileSync(metaPath, JSON.stringify(this.metadata, null, 2));
  }

  /**
   * Add a new memory
   * @param {string|null} storeId - Store ID (null for main)
   * @param {Object} data - Memory data
   * @returns {Object} Created memory record
   */
  async addMemory(storeId, data) {
    const store = await this._getStore(storeId);

    // Generate embedding if function provided and not already present
    let embedding = data.embedding || null;
    if (!embedding && this.embedFunction && data.content) {
      embedding = await this.embedFunction(data.content);
    }

    const record = createMemoryRecord({
      ...data,
      store_id: store.storeId,
      embedding
    });

    // Append to WAL
    store.wal.append(record);

    // Update indexes
    this._updateIndexes(
      store.latestIndex,
      store.vectorIndex,
      store.textIndex,
      store.merkleTree,
      record,
      null, // In WAL, not segment
      0
    );

    await this._maybePersistIndexes(store);

    // Check if WAL needs rotation
    if (store.wal.shouldRotate()) {
      await this._rotateWAL(store);
    }

    return record;
  }

  /**
   * Get the latest version of a memory
   * @param {string|null} storeId
   * @param {string} memoryId
   * @returns {Object|null}
   */
  async getMemory(storeId, memoryId) {
    const store = await this._getStore(storeId);

    const entry = store.latestIndex.getMemory(memoryId);
    if (!entry) return null;

    // Read from WAL or segment
    if (entry.segmentNumber === null) {
      // In WAL
      const records = store.wal.getRecords();
      for (const record of records) {
        if (record.memory_id === memoryId && record.version === entry.version) {
          return record;
        }
      }
    } else {
      // In segment
      const segment = store.segmentManager.getSegment(entry.segmentNumber);
      if (segment) {
        return segment.readAt(entry.offset);
      }
    }

    return null;
  }

  /**
   * Update a memory (creates new version)
   * @param {string|null} storeId
   * @param {string} memoryId
   * @param {Object} updates
   * @returns {Object} New version record
   */
  async updateMemory(storeId, memoryId, updates) {
    const store = await this._getStore(storeId);

    // Get current version
    const current = await this.getMemory(storeId, memoryId);
    if (!current) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    // Check if content changed for embedding regeneration
    let embedding = current.embedding;
    if (updates.content && updates.content !== current.content) {
      if (this.embedFunction) {
        embedding = await this.embedFunction(updates.content);
      } else {
        embedding = null; // Clear embedding if content changed but no embed function
      }
    }

    const record = createMemoryVersion(current, {
      ...updates,
      embedding
    });

    // Append to WAL
    store.wal.append(record);

    // Update indexes
    this._updateIndexes(
      store.latestIndex,
      store.vectorIndex,
      store.textIndex,
      store.merkleTree,
      record,
      null,
      0
    );

    await this._maybePersistIndexes(store);

    if (store.wal.shouldRotate()) {
      await this._rotateWAL(store);
    }

    return record;
  }

  /**
   * Delete a memory (soft delete, creates new version)
   * @param {string|null} storeId
   * @param {string} memoryId
   * @returns {Object} Deleted version record
   */
  async deleteMemory(storeId, memoryId) {
    return this.updateMemory(storeId, memoryId, { deleted: true });
  }

  /**
   * List memories with optional filters
   * @param {string|null} storeId
   * @param {Object} options
   * @returns {Object[]}
   */
  async listMemories(storeId, options = {}) {
    const store = await this._getStore(storeId);
    const {
      category,
      type,
      includeDeleted = false,
      limit = 100,
      offset = 0
    } = options;

    const memories = [];
    let count = 0;

    for (const [memoryId, entry] of store.latestIndex.iterateMemories(
      includeDeleted
    )) {
      if (category || type) {
        const memory = await this.getMemory(storeId, memoryId);
        if (!memory) continue;
        if (category && memory.category !== category) continue;
        if (type && memory.type !== type) continue;

        if (count >= offset && memories.length < limit) {
          memories.push(memory);
        }
        count++;
      } else {
        if (count >= offset && memories.length < limit) {
          const memory = await this.getMemory(storeId, memoryId);
          if (memory) memories.push(memory);
        }
        count++;
      }
    }

    return memories;
  }

  /**
   * Search memories
   * @param {string|null} storeId
   * @param {Object} options
   * @returns {Object[]}
   */
  async search(storeId, options = {}) {
    const store = await this._getStore(storeId);
    const {
      query,
      mode = 'hybrid', // "semantic", "text", "hybrid"
      limit = 10,
      semanticWeight = 0.7
    } = options;

    if (!query) {
      return [];
    }

    let results = [];

    if (mode === 'semantic' || mode === 'hybrid') {
      // Generate query embedding
      let queryEmbedding;
      if (this.embedFunction) {
        queryEmbedding = await this.embedFunction(query);
      }

      if (queryEmbedding) {
        const semanticResults = store.vectorIndex.search(
          queryEmbedding,
          limit * 2
        );
        for (const result of semanticResults) {
          results.push({
            id: result.id,
            semanticScore: result.similarity,
            textScore: 0
          });
        }
      }
    }

    if (mode === 'text' || mode === 'hybrid') {
      const textResults = store.textIndex.search(query, limit * 2);

      for (const result of textResults) {
        const existing = results.find((r) => r.id === result.id);
        if (existing) {
          existing.textScore = result.score;
        } else {
          results.push({
            id: result.id,
            semanticScore: 0,
            textScore: result.score
          });
        }
      }
    }

    // Normalize and combine scores
    if (results.length > 0) {
      const maxSemantic = Math.max(...results.map((r) => r.semanticScore)) || 1;
      const maxText = Math.max(...results.map((r) => r.textScore)) || 1;

      for (const result of results) {
        const normalizedSemantic = result.semanticScore / maxSemantic;
        const normalizedText = result.textScore / maxText;

        if (mode === 'hybrid') {
          result.score =
            semanticWeight * normalizedSemantic +
            (1 - semanticWeight) * normalizedText;
        } else if (mode === 'semantic') {
          result.score = normalizedSemantic;
        } else {
          result.score = normalizedText;
        }
      }

      results.sort((a, b) => b.score - a.score);
    }

    // Fetch full memory records
    const memories = [];
    for (const result of results.slice(0, limit)) {
      const memory = await this.getMemory(storeId, result.id);
      if (memory) {
        memories.push({
          ...memory,
          _searchScore: result.score,
          _semanticScore: result.semanticScore,
          _textScore: result.textScore
        });
      }
    }

    return memories;
  }

  /**
   * Add a relationship between memories
   * @param {string|null} storeId
   * @param {Object} data
   * @returns {Object}
   */
  async addRelationship(storeId, data) {
    const store = await this._getStore(storeId);

    const record = createRelationshipRecord({
      ...data,
      store_id: store.storeId
    });

    store.wal.append(record);

    this._updateIndexes(
      store.latestIndex,
      store.vectorIndex,
      store.textIndex,
      store.merkleTree,
      record,
      null,
      0
    );

    await this._maybePersistIndexes(store);

    if (store.wal.shouldRotate()) {
      await this._rotateWAL(store);
    }

    return record;
  }

  /**
   * Remove a relationship (soft delete)
   * @param {string|null} storeId
   * @param {string} relationshipId
   * @returns {Object}
   */
  async removeRelationship(storeId, relationshipId) {
    const store = await this._getStore(storeId);

    const entry = store.latestIndex.getRelationship(relationshipId);
    if (!entry) {
      throw new Error(`Relationship not found: ${relationshipId}`);
    }

    // Get current version
    let current = null;
    if (entry.segmentNumber === null) {
      const records = store.wal.getRecords();
      for (const record of records) {
        if (
          record.relationship_id === relationshipId &&
          record.version === entry.version
        ) {
          current = record;
          break;
        }
      }
    } else {
      const segment = store.segmentManager.getSegment(entry.segmentNumber);
      if (segment) {
        current = segment.readAt(entry.offset);
      }
    }

    if (!current) {
      throw new Error(`Relationship not found: ${relationshipId}`);
    }

    const record = createRelationshipVersion(current, { deleted: true });

    store.wal.append(record);

    this._updateIndexes(
      store.latestIndex,
      store.vectorIndex,
      store.textIndex,
      store.merkleTree,
      record,
      null,
      0
    );

    await this._maybePersistIndexes(store);

    return record;
  }

  /**
   * Get relationships for a memory
   * @param {string|null} storeId
   * @param {string} memoryId
   * @param {Object} options
   * @returns {Object[]}
   */
  async getRelationships(storeId, memoryId, options = {}) {
    const store = await this._getStore(storeId);
    const { includeDeleted = false, type = null } = options;

    const relationships = [];

    for (const [
      relationshipId,
      entry
    ] of store.latestIndex.iterateRelationships(includeDeleted)) {
      // Read full record
      let record = null;
      if (entry.segmentNumber === null) {
        const records = store.wal.getRecords();
        for (const r of records) {
          if (
            r.relationship_id === relationshipId &&
            r.version === entry.version
          ) {
            record = r;
            break;
          }
        }
      } else {
        const segment = store.segmentManager.getSegment(entry.segmentNumber);
        if (segment) {
          record = segment.readAt(entry.offset);
        }
      }

      if (!record) continue;

      // Filter by memory ID
      if (
        record.memory_id !== memoryId &&
        record.related_memory_id !== memoryId
      ) {
        continue;
      }

      // Filter by type
      if (type && record.relationship_type !== type) {
        continue;
      }

      relationships.push(record);
    }

    return relationships;
  }

  /**
   * Get related memories
   * @param {string|null} storeId
   * @param {string} memoryId
   * @param {Object} options
   * @returns {Object[]}
   */
  async getRelatedMemories(storeId, memoryId, options = {}) {
    const relationships = await this.getRelationships(
      storeId,
      memoryId,
      options
    );

    const relatedIds = new Set();
    for (const rel of relationships) {
      if (rel.memory_id === memoryId) {
        relatedIds.add(rel.related_memory_id);
      } else {
        relatedIds.add(rel.memory_id);
      }
    }

    const memories = [];
    for (const id of relatedIds) {
      const memory = await this.getMemory(storeId, id);
      if (memory && !memory.deleted) {
        memories.push(memory);
      }
    }

    return memories;
  }

  /**
   * Get memories due for recall based on cadence
   * @param {string|null} storeId
   * @param {Date} [asOf=now]
   * @returns {Object[]}
   */
  async getDueMemories(storeId, asOf = new Date()) {
    const store = await this._getStore(storeId);
    const due = [];

    for (const [memoryId] of store.latestIndex.iterateMemories(false)) {
      const memory = await this.getMemory(storeId, memoryId);
      if (!memory || !memory.cadence_type) continue;

      if (this._isDue(memory, asOf)) {
        due.push(memory);
      }
    }

    return due;
  }

  /**
   * Check if a memory is due based on cadence
   * @private
   */
  _isDue(memory, asOf) {
    const created = new Date(memory.timestamp);
    const daysSinceCreation = Math.floor(
      (asOf - created) / (1000 * 60 * 60 * 24)
    );

    switch (memory.cadence_type) {
      case 'daily':
        return true;

      case 'weekly':
        return asOf.getDay() === 0; // Sunday

      case 'monthly':
        return asOf.getDate() === 1; // First of month

      case 'day_of_week': {
        const targetDay = parseInt(memory.cadence_value, 10);
        return asOf.getDay() === targetDay;
      }

      case 'day_of_month': {
        const targetDate = parseInt(memory.cadence_value, 10);
        return asOf.getDate() === targetDate;
      }

      default:
        return false;
    }
  }

  /**
   * Rotate WAL to segment
   * @private
   */
  async _rotateWAL(store) {
    const segmentPath = store.segmentManager.getNextSegmentPath();
    const result = await store.wal.rotate(segmentPath);

    if (result.recordCount > 0) {
      const segment = await store.segmentManager.registerSegment(segmentPath);
      const segmentNumber = segment.getInfo().segmentNumber;

      // Update index entries to point to segment instead of WAL
      for (const { record, offset } of segment.iterate()) {
        if (record.record_type === RecordType.MEMORY) {
          const entry = store.latestIndex.getMemory(record.memory_id);
          if (entry && entry.version === record.version) {
            store.latestIndex.updateMemory(record, segmentNumber, offset);
          }
        } else if (record.record_type === RecordType.RELATIONSHIP) {
          const entry = store.latestIndex.getRelationship(
            record.relationship_id
          );
          if (entry && entry.version === record.version) {
            store.latestIndex.updateRelationship(record, segmentNumber, offset);
          }
        }
      }
    }
  }

  /**
   * Get the current merkle root
   * @param {string|null} storeId
   * @returns {string|null}
   */
  async getMerkleRoot(storeId) {
    const store = await this._getStore(storeId);
    return store.merkleTree.getRoot();
  }

  /**
   * Get a snapshot of the store state
   * @param {string|null} storeId
   * @returns {Object}
   */
  async getSnapshot(storeId) {
    const store = await this._getStore(storeId);

    return {
      storeId: store.storeId,
      merkleRoot: store.merkleTree.getRoot(),
      recordCount: store.merkleTree.getLeafCount(),
      memoryCount: store.latestIndex.getMemoryCount(),
      relationshipCount: store.latestIndex.getRelationshipCount(),
      timestamp: Date.now()
    };
  }

  // =========================================================================
  // Forking and PITR Operations
  // =========================================================================

  /**
   * Create a fork of a store at its current state
   * @param {string|null} sourceStoreId - Store to fork from
   * @param {Object} options
   * @param {string} [options.forkId] - Optional fork ID (generates UUID if not provided)
   * @param {string} [options.name] - Optional human-readable name
   * @returns {Object} Fork metadata
   */
  async createFork(sourceStoreId, options = {}) {
    const source = await this._getStore(sourceStoreId);
    const forkId = options.forkId || generateUUID();
    const name = options.name || `Fork of ${source.storeId}`;

    // Persist source indexes before copying
    await this._persistIndexes(source);

    // Create fork directory structure
    const forkDir = join(this.config.dataDir, 'forks', forkId);
    if (existsSync(forkDir)) {
      throw new Error(`Fork already exists: ${forkId}`);
    }

    mkdirSync(forkDir, { recursive: true });
    mkdirSync(join(forkDir, 'segments'), { recursive: true });
    mkdirSync(join(forkDir, 'indexes'), { recursive: true });

    // Copy segments (they don't have store ID embedded in header)
    const sourceSegmentsDir = join(source.storeDir, 'segments');
    const forkSegmentsDir = join(forkDir, 'segments');
    if (existsSync(sourceSegmentsDir)) {
      for (const file of readdirSync(sourceSegmentsDir)) {
        cpSync(join(sourceSegmentsDir, file), join(forkSegmentsDir, file));
      }
    }

    // Copy indexes (they don't have store ID embedded)
    const sourceIndexesDir = join(source.storeDir, 'indexes');
    const forkIndexesDir = join(forkDir, 'indexes');
    if (existsSync(sourceIndexesDir)) {
      for (const file of readdirSync(sourceIndexesDir)) {
        cpSync(join(sourceIndexesDir, file), join(forkIndexesDir, file));
      }
    }

    // Create a new WAL with the fork's store ID and copy records
    const forkWal = await openWAL({
      path: join(forkDir, 'wal.log'),
      storeId: forkId,
      maxSizeBytes: this.config.segmentSizeBytes
    });

    // Copy WAL records to the new WAL
    for (const record of source.wal.getRecords()) {
      forkWal.append(record);
    }
    forkWal.close();

    // Update fork metadata
    const forkMeta = {
      forkId,
      name,
      note: options.note || null,
      sourceStoreId: source.storeId,
      createdAt: Date.now(),
      sourceMerkleRoot: source.merkleTree.getRoot(),
      sourceRecordCount: source.merkleTree.getLeafCount()
    };

    // Save fork metadata
    writeFileSync(
      join(forkDir, 'fork.json'),
      JSON.stringify(forkMeta, null, 2)
    );

    // Update global metadata
    this.metadata.forks.push({
      forkId,
      name,
      note: forkMeta.note,
      sourceStoreId: source.storeId,
      createdAt: forkMeta.createdAt
    });
    this._saveMetadata();

    // Initialize the fork store
    await this._initializeStoreInstance(forkId);

    return forkMeta;
  }

  /**
   * Create a fork at a specific point in time (PITR)
   * Only includes records up to the specified timestamp
   * @param {string|null} sourceStoreId
   * @param {number} timestamp - Unix timestamp (ms)
   * @param {Object} options
   * @returns {Object} Fork metadata
   */
  async createForkAtTime(sourceStoreId, timestamp, options = {}) {
    const source = await this._getStore(sourceStoreId);
    const forkId = options.forkId || generateUUID();
    const name =
      options.name ||
      `PITR Fork of ${source.storeId} at ${new Date(timestamp).toISOString()}`;

    // Create fork directory
    const forkDir = join(this.config.dataDir, 'forks', forkId);
    if (existsSync(forkDir)) {
      throw new Error(`Fork already exists: ${forkId}`);
    }

    mkdirSync(forkDir, { recursive: true });
    mkdirSync(join(forkDir, 'segments'), { recursive: true });
    mkdirSync(join(forkDir, 'indexes'), { recursive: true });

    // Create new WAL for fork
    const forkWal = await openWAL({
      path: join(forkDir, 'wal.log'),
      storeId: forkId,
      maxSizeBytes: this.config.segmentSizeBytes
    });

    // Create new indexes for fork
    const forkLatestIndex = new LatestIndex({
      indexPath: join(forkDir, 'indexes', 'latest.idx')
    });
    const forkVectorIndex = new VectorIndex({
      indexPath: join(forkDir, 'indexes', 'vector.idx'),
      M: this.config.hnswM,
      efConstruction: this.config.hnswEfConstruction,
      efSearch: this.config.hnswEfSearch
    });
    const forkTextIndex = new TextIndex({
      indexPath: join(forkDir, 'indexes', 'text.idx')
    });
    const forkMerkleTree = new MerkleTree({
      indexPath: join(forkDir, 'indexes', 'merkle.idx')
    });

    // Replay records up to timestamp
    let recordCount = 0;

    // First, iterate through segments
    for (const { record } of source.segmentManager.iterateAll()) {
      if (record.timestamp <= timestamp) {
        // Write to fork WAL
        forkWal.append(record);

        // Update fork indexes
        this._updateIndexes(
          forkLatestIndex,
          forkVectorIndex,
          forkTextIndex,
          forkMerkleTree,
          record,
          null,
          0
        );
        recordCount++;
      }
    }

    // Then, iterate through WAL
    for (const record of source.wal.getRecords()) {
      if (record.timestamp <= timestamp) {
        forkWal.append(record);

        this._updateIndexes(
          forkLatestIndex,
          forkVectorIndex,
          forkTextIndex,
          forkMerkleTree,
          record,
          null,
          0
        );
        recordCount++;
      }
    }

    // Persist fork indexes
    forkLatestIndex.save();
    forkVectorIndex.save();
    forkTextIndex.save();
    forkMerkleTree.save();
    forkWal.close();

    // Save fork metadata
    const forkMeta = {
      forkId,
      name,
      note: options.note || null,
      sourceStoreId: source.storeId,
      createdAt: Date.now(),
      pitrTimestamp: timestamp,
      sourceMerkleRoot: forkMerkleTree.getRoot(),
      sourceRecordCount: recordCount
    };
    writeFileSync(
      join(forkDir, 'fork.json'),
      JSON.stringify(forkMeta, null, 2)
    );

    // Update global metadata
    this.metadata.forks.push({
      forkId,
      name,
      note: forkMeta.note,
      sourceStoreId: source.storeId,
      createdAt: forkMeta.createdAt,
      pitrTimestamp: timestamp
    });
    this._saveMetadata();

    // Initialize the fork store
    await this._initializeStoreInstance(forkId);

    return forkMeta;
  }

  /**
   * List all forks
   * @returns {Object[]}
   */
  async listForks() {
    return this.metadata.forks.map((fork) => ({
      ...fork,
      isLoaded: this.stores.has(fork.forkId)
    }));
  }

  /**
   * Get fork metadata
   * @param {string} forkId
   * @returns {Object|null}
   */
  async getForkInfo(forkId) {
    const forkDir = join(this.config.dataDir, 'forks', forkId);
    const metaPath = join(forkDir, 'fork.json');

    if (!existsSync(metaPath)) {
      return null;
    }

    return JSON.parse(readFileSync(metaPath, 'utf8'));
  }

  /**
   * Delete a fork
   * @param {string} forkId
   */
  async deleteFork(forkId) {
    if (forkId === 'main') {
      throw new Error('Cannot delete main store');
    }

    // Close fork if loaded
    if (this.stores.has(forkId)) {
      const store = this.stores.get(forkId);
      store.wal.close();
      store.segmentManager.close();
      this.stores.delete(forkId);
    }

    // Delete fork directory
    const forkDir = join(this.config.dataDir, 'forks', forkId);
    if (existsSync(forkDir)) {
      const { rmSync } = await import('fs');
      rmSync(forkDir, { recursive: true });
    }

    // Update global metadata
    this.metadata.forks = this.metadata.forks.filter(
      (f) => f.forkId !== forkId
    );
    this._saveMetadata();
  }

  /**
   * Create a named snapshot (just records merkle root and timestamp)
   * @param {string|null} storeId
   * @param {string} name
   * @returns {Object}
   */
  async createNamedSnapshot(storeId, name) {
    const store = await this._getStore(storeId);

    const snapshot = {
      id: generateUUID(),
      name,
      storeId: store.storeId,
      merkleRoot: store.merkleTree.getRoot(),
      recordCount: store.merkleTree.getLeafCount(),
      memoryCount: store.latestIndex.getMemoryCount(),
      relationshipCount: store.latestIndex.getRelationshipCount(),
      timestamp: Date.now()
    };

    // Store snapshot in metadata
    if (!this.metadata.snapshots) {
      this.metadata.snapshots = [];
    }
    this.metadata.snapshots.push(snapshot);
    this._saveMetadata();

    return snapshot;
  }

  /**
   * List snapshots for a store
   * @param {string|null} storeId
   * @returns {Object[]}
   */
  async listSnapshots(storeId) {
    const normalized = normalizeStoreId(storeId);
    return (this.metadata.snapshots || []).filter(
      (s) => s.storeId === normalized
    );
  }

  /**
   * Restore a snapshot by creating a new fork at that point
   * @param {string} snapshotId
   * @param {Object} options
   * @returns {Object}
   */
  async restoreSnapshot(snapshotId, options = {}) {
    const snapshot = (this.metadata.snapshots || []).find(
      (s) => s.id === snapshotId
    );
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    return this.createForkAtTime(snapshot.storeId, snapshot.timestamp, {
      ...options,
      name: options.name || `Restored from ${snapshot.name}`
    });
  }

  /**
   * Close the store
   */
  async close() {
    for (const store of this.stores.values()) {
      await this._persistIndexes(store);
      store.wal.close();
      store.segmentManager.close();
    }

    this._saveMetadata();
    this.stores.clear();
    this.initialized = false;
  }

  /**
   * Get store statistics
   * @param {string|null} storeId
   * @returns {Object}
   */
  async getStats(storeId) {
    const store = await this._getStore(storeId);

    return {
      storeId: store.storeId,
      memoryCount: store.latestIndex.getMemoryCount(),
      deletedMemoryCount:
        store.latestIndex.getMemoryCount(true) -
        store.latestIndex.getMemoryCount(),
      relationshipCount: store.latestIndex.getRelationshipCount(),
      totalRecords: store.merkleTree.getLeafCount(),
      segmentCount: store.segmentManager.getSegmentInfos().length,
      walRecordCount: store.wal.getRecordCount(),
      vectorIndexSize: store.vectorIndex.size(),
      textIndexSize: store.textIndex.size()
    };
  }

  // =========================================================================
  // Recovery and Rebuild Operations
  // =========================================================================

  /**
   * Verify integrity of the store using merkle tree
   * @param {string|null} storeId
   * @returns {Object} Verification result
   */
  async verifyIntegrity(storeId) {
    const store = await this._getStore(storeId);

    const result = {
      valid: true,
      errors: [],
      recordCount: 0,
      merkleRoot: store.merkleTree.getRoot()
    };

    // Rebuild merkle tree from records and compare
    const rebuiltTree = new MerkleTree();

    // Add records from segments
    for (const { record } of store.segmentManager.iterateAll()) {
      rebuiltTree.addLeaf(record.content_hash);
      result.recordCount++;
    }

    // Add records from WAL
    for (const record of store.wal.getRecords()) {
      rebuiltTree.addLeaf(record.content_hash);
      result.recordCount++;
    }

    // Compare roots
    if (rebuiltTree.getRoot() !== store.merkleTree.getRoot()) {
      result.valid = false;
      result.errors.push({
        type: 'merkle_root_mismatch',
        expected: store.merkleTree.getRoot(),
        actual: rebuiltTree.getRoot()
      });
    }

    // Verify record count matches
    if (result.recordCount !== store.merkleTree.getLeafCount()) {
      result.valid = false;
      result.errors.push({
        type: 'record_count_mismatch',
        expected: store.merkleTree.getLeafCount(),
        actual: result.recordCount
      });
    }

    return result;
  }

  /**
   * Rebuild all indexes from segments and WAL
   * Use this to recover from corrupted indexes
   * @param {string|null} storeId
   * @returns {Object} Rebuild statistics
   */
  async rebuildIndexes(storeId) {
    const store = await this._getStore(storeId);

    const stats = {
      memoriesIndexed: 0,
      relationshipsIndexed: 0,
      vectorsIndexed: 0,
      termsIndexed: 0,
      merkleLeaves: 0
    };

    // Clear existing indexes
    store.latestIndex.clear();
    store.vectorIndex.clear();
    store.textIndex.clear();
    store.merkleTree.clear();

    // Rebuild from segments
    for (const { record, offset } of store.segmentManager.iterateAll()) {
      const segmentNumber = this._getSegmentNumberForOffset(store, offset);

      this._updateIndexes(
        store.latestIndex,
        store.vectorIndex,
        store.textIndex,
        store.merkleTree,
        record,
        segmentNumber,
        offset
      );

      if (record.record_type === RecordType.MEMORY) {
        stats.memoriesIndexed++;
        if (record.embedding && !record.deleted) {
          stats.vectorsIndexed++;
        }
      } else if (record.record_type === RecordType.RELATIONSHIP) {
        stats.relationshipsIndexed++;
      }
      stats.merkleLeaves++;
    }

    // Rebuild from WAL
    for (const record of store.wal.getRecords()) {
      this._updateIndexes(
        store.latestIndex,
        store.vectorIndex,
        store.textIndex,
        store.merkleTree,
        record,
        null,
        0
      );

      if (record.record_type === RecordType.MEMORY) {
        stats.memoriesIndexed++;
        if (record.embedding && !record.deleted) {
          stats.vectorsIndexed++;
        }
      } else if (record.record_type === RecordType.RELATIONSHIP) {
        stats.relationshipsIndexed++;
      }
      stats.merkleLeaves++;
    }

    stats.termsIndexed = store.textIndex.getTerms().length;

    // Persist rebuilt indexes
    await this._persistIndexes(store);

    return stats;
  }

  /**
   * Get segment number for a given offset (helper for rebuild)
   * @private
   */
  _getSegmentNumberForOffset(store, offset) {
    const infos = store.segmentManager.getSegmentInfos();
    for (const info of infos) {
      if (offset >= info.startOffset && offset < info.startOffset + info.size) {
        return info.segmentNumber;
      }
    }
    return infos.length > 0 ? infos[infos.length - 1].segmentNumber : 1;
  }

  /**
   * Compact WAL by rotating to segment
   * @param {string|null} storeId
   * @returns {Object} Compaction result
   */
  async compactWAL(storeId) {
    const store = await this._getStore(storeId);

    if (store.wal.getRecordCount() === 0) {
      return { rotated: false, recordCount: 0 };
    }

    await this._rotateWAL(store);

    return {
      rotated: true,
      recordCount: store.segmentManager.getTotalRecordCount()
    };
  }

  /**
   * Flush all pending writes and persist indexes
   * @param {string|null} storeId
   */
  async flush(storeId) {
    const store = await this._getStore(storeId);

    // Sync WAL to disk
    store.wal.sync();

    // Persist all indexes
    await this._persistIndexes(store);
  }

  /**
   * Check if store needs recovery (e.g., dirty shutdown)
   * @param {string|null} storeId
   * @returns {Object}
   */
  async checkRecoveryNeeded(storeId) {
    const store = await this._getStore(storeId);

    const result = {
      needsRecovery: false,
      issues: []
    };

    // Check if WAL has records not reflected in indexes
    const walRecordCount = store.wal.getRecordCount();
    const indexedRecordCount = store.merkleTree.getLeafCount();
    const segmentRecordCount = store.segmentManager.getTotalRecordCount();

    const expectedTotal = segmentRecordCount + walRecordCount;
    if (indexedRecordCount !== expectedTotal) {
      result.needsRecovery = true;
      result.issues.push({
        type: 'index_out_of_sync',
        indexed: indexedRecordCount,
        expected: expectedTotal
      });
    }

    return result;
  }

  /**
   * Perform automatic recovery if needed
   * @param {string|null} storeId
   * @returns {Object}
   */
  async recover(storeId) {
    const check = await this.checkRecoveryNeeded(storeId);

    if (!check.needsRecovery) {
      return { recovered: false, message: 'No recovery needed' };
    }

    // Rebuild indexes to recover
    const stats = await this.rebuildIndexes(storeId);

    return {
      recovered: true,
      issues: check.issues,
      rebuildStats: stats
    };
  }
}

/**
 * Create and initialize a memory store
 * @param {Object} options
 * @returns {MemoryStore}
 */
export async function createMemoryStore(options = {}) {
  const store = new MemoryStore(options);
  await store.initialize();
  return store;
}

export default MemoryStore;
