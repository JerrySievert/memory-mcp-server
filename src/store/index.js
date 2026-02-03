/**
 * Store Module - Main Export
 *
 * This module exports all store components and provides the main
 * API for the append-only memory storage system.
 */

export { createConfig, getDefaultConfig, validateConfig, formatBytes } from './config.js';
export {
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
  verifyRecordHash,
} from './record.js';
export { WAL, openWAL } from './wal.js';
export { SegmentReader, SegmentManager, openSegment, createSegmentManager } from './segment.js';
export { MerkleTree, sha256, hashPair } from './merkle.js';
export { LatestIndex } from './latest-index.js';
export { VectorIndex, cosineSimilarity, euclideanDistance } from './vector-index.js';
export { TextIndex, tokenize, removeStopWords } from './text-index.js';
export { MemoryStore, createMemoryStore } from './memory-store.js';

// Default export is the createMemoryStore factory
import { createMemoryStore } from './memory-store.js';
export default createMemoryStore;
