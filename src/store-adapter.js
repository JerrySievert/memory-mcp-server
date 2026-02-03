/**
 * Store Adapter Module
 *
 * Provides a bridge between the new append-only MemoryStore and the
 * existing API interface used by MCP server and HTTP endpoints.
 *
 * This adapter translates between the old SQLite-style API and the new
 * versioned, append-only store API.
 */

import { join } from 'path';
import { createMemoryStore } from './store/index.js';

/** @type {import('./store/memory-store.js').MemoryStore|null} */
let store = null;

/** @type {Function|null} */
let embedFunction = null;

/**
 * Set the embedding function to use for semantic search
 * @param {Function} fn - Function that takes text and returns Float32Array embedding
 */
export function setEmbedFunction(fn) {
  embedFunction = fn;
}

/**
 * Initialize the store
 * @returns {Promise<import('./store/memory-store.js').MemoryStore>}
 */
export async function initStore() {
  if (store) {
    return store;
  }

  const dataDir = process.env.DATA_DIR || join(import.meta.dir, '..', 'data');

  store = await createMemoryStore({
    config: { dataDir },
    embedFunction: embedFunction || undefined
  });

  return store;
}

/**
 * Get the store instance
 * @returns {Promise<import('./store/memory-store.js').MemoryStore>}
 */
export async function getStore() {
  if (!store) {
    return initStore();
  }
  return store;
}

/**
 * Close the store
 */
export async function closeStore() {
  if (store) {
    await store.close();
    store = null;
  }
}

// ============================================================================
// Memory Operations (compatible with existing API)
// ============================================================================

/**
 * Add a new memory
 * @param {Object} data - Memory data
 * @param {string} [storeId='main'] - Store/fork ID
 * @returns {Promise<Object>}
 */
export async function addMemory(data, storeId = 'main') {
  const s = await getStore();
  const record = await s.addMemory(storeId, {
    category: data.category,
    type: data.type,
    content: data.content,
    tags: data.tags || [],
    importance: data.importance || 5,
    cadence_type: data.cadence_type || data.cadenceType || 'monthly',
    cadence_value: data.cadence_value || data.cadenceValue || null,
    context: data.context || null,
    embedding: data.embedding || null
  });

  return formatMemoryForApi(record);
}

/**
 * Get a memory by ID
 * @param {string} memoryId
 * @param {string} [storeId='main']
 * @param {Object} [options]
 * @param {boolean} [options.includeArchived=false]
 * @returns {Promise<Object|null>}
 */
export async function getMemory(memoryId, storeId = 'main', options = {}) {
  const s = await getStore();
  const record = await s.getMemory(storeId, memoryId);

  if (!record) return null;

  // Filter out archived unless specifically requested
  if (record.deleted && !options.includeArchived) {
    return null;
  }

  return formatMemoryForApi(record);
}

/**
 * Update a memory
 * @param {string} memoryId
 * @param {Object} updates
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function updateMemory(memoryId, updates, storeId = 'main') {
  const s = await getStore();

  const updateData = {};
  if (updates.content !== undefined) updateData.content = updates.content;
  if (updates.category !== undefined) updateData.category = updates.category;
  if (updates.type !== undefined) updateData.type = updates.type;
  if (updates.tags !== undefined) updateData.tags = updates.tags;
  if (updates.importance !== undefined)
    updateData.importance = updates.importance;
  if (updates.cadence_type !== undefined || updates.cadenceType !== undefined) {
    updateData.cadence_type = updates.cadence_type || updates.cadenceType;
  }
  if (
    updates.cadence_value !== undefined ||
    updates.cadenceValue !== undefined
  ) {
    updateData.cadence_value = updates.cadence_value || updates.cadenceValue;
  }
  if (updates.context !== undefined) updateData.context = updates.context;

  const record = await s.updateMemory(storeId, memoryId, updateData);

  return formatMemoryForApi(record);
}

/**
 * Delete (archive) a memory
 * @param {string} memoryId
 * @param {string} [storeId='main']
 * @returns {Promise<boolean>}
 */
export async function deleteMemory(memoryId, storeId = 'main') {
  const s = await getStore();
  await s.deleteMemory(storeId, memoryId);
  return true;
}

/**
 * List memories with optional filters
 * @param {Object} options
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function listMemories(options = {}, storeId = 'main') {
  const s = await getStore();

  const records = await s.listMemories(storeId, {
    category: options.category,
    type: options.type,
    includeDeleted: options.includeArchived || options.includeDeleted || false,
    limit: options.limit || 100,
    offset: options.offset || 0
  });

  return records.map(formatMemoryForApi);
}

/**
 * Search memories
 * @param {string} query
 * @param {Object} options
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function searchMemories(query, options = {}, storeId = 'main') {
  const s = await getStore();

  const records = await s.search(storeId, {
    query,
    mode: options.mode || 'hybrid',
    limit: options.limit || 10,
    semanticWeight: options.semanticWeight || 0.7
  });

  return records.map((r) => ({
    ...formatMemoryForApi(r),
    score: r._searchScore,
    semanticScore: r._semanticScore,
    textScore: r._textScore
  }));
}

/**
 * Get memories due for recall
 * @param {Date} [asOf=now]
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function getDueMemories(asOf = new Date(), storeId = 'main') {
  const s = await getStore();
  const records = await s.getDueMemories(storeId, asOf);
  return records.map(formatMemoryForApi);
}

// ============================================================================
// Relationship Operations
// ============================================================================

/**
 * Add a relationship between memories
 * @param {string} memoryId
 * @param {string} relatedMemoryId
 * @param {string} [relationshipType='related_to']
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function addRelationship(
  memoryId,
  relatedMemoryId,
  relationshipType = 'related_to',
  storeId = 'main'
) {
  const s = await getStore();

  const record = await s.addRelationship(storeId, {
    memory_id: memoryId,
    related_memory_id: relatedMemoryId,
    relationship_type: relationshipType
  });

  return formatRelationshipForApi(record);
}

/**
 * Remove a relationship
 * @param {string} relationshipId
 * @param {string} [storeId='main']
 * @returns {Promise<boolean>}
 */
export async function removeRelationship(relationshipId, storeId = 'main') {
  const s = await getStore();
  await s.removeRelationship(storeId, relationshipId);
  return true;
}

/**
 * Get relationships for a memory
 * @param {string} memoryId
 * @param {Object} options
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function getRelationships(
  memoryId,
  options = {},
  storeId = 'main'
) {
  const s = await getStore();

  const records = await s.getRelationships(storeId, memoryId, {
    type: options.type,
    includeDeleted: options.includeDeleted || false
  });

  return records.map(formatRelationshipForApi);
}

/**
 * Get related memories
 * @param {string} memoryId
 * @param {Object} options
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function getRelatedMemories(
  memoryId,
  options = {},
  storeId = 'main'
) {
  const s = await getStore();
  const records = await s.getRelatedMemories(storeId, memoryId, options);
  return records.map(formatMemoryForApi);
}

// ============================================================================
// Fork and Snapshot Operations
// ============================================================================

/**
 * Format fork metadata for API response
 * @param {Object} forkMeta
 * @returns {Object}
 */
function formatForkForApi(forkMeta) {
  return {
    id: forkMeta.forkId || forkMeta.storeId || forkMeta.id,
    name: forkMeta.name,
    note: forkMeta.note || null,
    sourceStoreId: forkMeta.sourceStoreId,
    createdAt: forkMeta.createdAt
      ? new Date(forkMeta.createdAt).toISOString()
      : null,
    pitrTimestamp: forkMeta.pitrTimestamp,
    merkleRoot: forkMeta.sourceMerkleRoot,
    recordCount: forkMeta.sourceRecordCount
  };
}

/**
 * Create a fork of a store
 * @param {string} [sourceStoreId='main']
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function createFork(sourceStoreId = 'main', options = {}) {
  const s = await getStore();
  const result = await s.createFork(sourceStoreId, options);
  return formatForkForApi(result);
}

/**
 * Create a fork at a specific point in time
 * @param {string} sourceStoreId
 * @param {number} timestamp
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function createForkAtTime(sourceStoreId, timestamp, options = {}) {
  const s = await getStore();
  const result = await s.createForkAtTime(sourceStoreId, timestamp, options);
  return formatForkForApi(result);
}

/**
 * List all forks
 * @returns {Promise<Object[]>}
 */
export async function listForks() {
  const s = await getStore();
  const forks = await s.listForks();
  return forks.map(formatForkForApi);
}

/**
 * Delete a fork
 * @param {string} forkId
 * @returns {Promise<void>}
 */
export async function deleteFork(forkId) {
  const s = await getStore();
  return s.deleteFork(forkId);
}

/**
 * Create a named snapshot
 * @param {string} name
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function createSnapshot(name, storeId = 'main') {
  const s = await getStore();
  return s.createNamedSnapshot(storeId, name);
}

/**
 * List snapshots
 * @param {string} [storeId='main']
 * @returns {Promise<Object[]>}
 */
export async function listSnapshots(storeId = 'main') {
  const s = await getStore();
  return s.listSnapshots(storeId);
}

/**
 * Restore from a snapshot
 * @param {string} snapshotId
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function restoreSnapshot(snapshotId, options = {}) {
  const s = await getStore();
  return s.restoreSnapshot(snapshotId, options);
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Get store statistics
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function getStats(storeId = 'main') {
  const s = await getStore();
  return s.getStats(storeId);
}

/**
 * Get store snapshot (merkle root, counts)
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function getStoreSnapshot(storeId = 'main') {
  const s = await getStore();
  return s.getSnapshot(storeId);
}

/**
 * Verify store integrity
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function verifyIntegrity(storeId = 'main') {
  const s = await getStore();
  return s.verifyIntegrity(storeId);
}

/**
 * Rebuild indexes
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function rebuildIndexes(storeId = 'main') {
  const s = await getStore();
  return s.rebuildIndexes(storeId);
}

/**
 * Compact WAL to segment
 * @param {string} [storeId='main']
 * @returns {Promise<Object>}
 */
export async function compactWAL(storeId = 'main') {
  const s = await getStore();
  return s.compactWAL(storeId);
}

/**
 * Flush pending writes
 * @param {string} [storeId='main']
 * @returns {Promise<void>}
 */
export async function flush(storeId = 'main') {
  const s = await getStore();
  return s.flush(storeId);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a memory record for API response
 * @param {Object} record
 * @returns {Object}
 */
function formatMemoryForApi(record) {
  return {
    id: record.memory_id,
    category: record.category,
    type: record.type,
    content: record.content,
    tags: record.tags || [],
    importance: record.importance,
    cadenceType: record.cadence_type,
    cadenceValue: record.cadence_value,
    context: record.context,
    version: record.version,
    contentHash: record.content_hash,
    createdAt: new Date(record.timestamp).toISOString(),
    archived: record.deleted || false,
    storeId: record.store_id
  };
}

/**
 * Format a relationship record for API response
 * @param {Object} record
 * @returns {Object}
 */
function formatRelationshipForApi(record) {
  return {
    id: record.relationship_id,
    memoryId: record.memory_id,
    relatedMemoryId: record.related_memory_id,
    relationshipType: record.relationship_type,
    version: record.version,
    createdAt: new Date(record.timestamp).toISOString(),
    deleted: record.deleted || false
  };
}

export default {
  // Initialization
  initStore,
  getStore,
  closeStore,
  setEmbedFunction,

  // Memory operations
  addMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  getDueMemories,

  // Relationship operations
  addRelationship,
  removeRelationship,
  getRelationships,
  getRelatedMemories,

  // Fork and snapshot operations
  createFork,
  createForkAtTime,
  listForks,
  deleteFork,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,

  // Store operations
  getStats,
  getStoreSnapshot,
  verifyIntegrity,
  rebuildIndexes,
  compactWAL,
  flush
};
