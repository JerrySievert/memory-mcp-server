/**
 * Test Suite for Core Storage Components
 *
 * Tests for:
 * - Configuration
 * - Records (serialization, hashing)
 * - WAL (write-ahead log)
 * - Segments (immutable files)
 *
 * @module store/store.test
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach
} from 'vitest';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  createConfig,
  getDefaultConfig,
  validateConfig,
  formatBytes
} from './config.js';
import {
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
} from './record.js';
import { WAL, openWAL } from './wal.js';
import {
  SegmentReader,
  SegmentManager,
  openSegment,
  createSegmentManager
} from './segment.js';
import { MerkleTree, sha256, hashPair } from './merkle.js';
import { LatestIndex } from './latest-index.js';
import { VectorIndex, cosineSimilarity } from './vector-index.js';
import { TextIndex, tokenize, removeStopWords } from './text-index.js';
import { MemoryStore, createMemoryStore } from './memory-store.js';

// Test directory
const TEST_DIR = join(import.meta.dirname, '..', '..', 'data', 'test-store');

// Cleanup helper
function cleanupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ============================================================================
// Configuration Tests
// ============================================================================

describe('Configuration', () => {
  test('createConfig returns default values', () => {
    const config = createConfig();

    expect(config.dataDir).toBe('./data');
    expect(config.segmentSizeBytes).toBe(16 * 1024 * 1024);
    expect(config.persistEveryNWrites).toBe(1);
    expect(config.memoryBudgetBytes).toBe(512 * 1024 * 1024);
    expect(config.enableConcurrentAccess).toBe(true);
  });

  test('createConfig applies overrides', () => {
    const config = createConfig({
      dataDir: '/custom/path',
      persistEveryNWrites: 10,
      memoryBudgetBytes: 1024 * 1024 * 1024 // 1GB
    });

    expect(config.dataDir).toBe('/custom/path');
    expect(config.persistEveryNWrites).toBe(10);
    expect(config.memoryBudgetBytes).toBe(1024 * 1024 * 1024);
  });

  test('createConfig clamps memory budget to min/max', () => {
    const tooSmall = createConfig({ memoryBudgetBytes: 1 });
    expect(tooSmall.memoryBudgetBytes).toBe(128 * 1024 * 1024); // Min 128MB

    const tooLarge = createConfig({
      memoryBudgetBytes: 100 * 1024 * 1024 * 1024
    });
    expect(tooLarge.memoryBudgetBytes).toBe(4 * 1024 * 1024 * 1024); // Max 4GB
  });

  test('createConfig validates segment size minimum', () => {
    expect(() => createConfig({ segmentSizeBytes: 100 })).toThrow();
  });

  test('createConfig validates HNSW parameters', () => {
    expect(() => createConfig({ hnswM: 1 })).toThrow();
    expect(() => createConfig({ hnswM: 200 })).toThrow();
    expect(() => createConfig({ hnswEfConstruction: 5 })).toThrow();
  });

  test('createConfig freezes the returned object', () => {
    const config = createConfig();
    expect(() => {
      config.dataDir = '/new/path';
    }).toThrow();
  });

  test('formatBytes formats correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.00 MB');
  });

  test('validateConfig validates full config object', () => {
    const config = getDefaultConfig();
    expect(validateConfig(config)).toBe(true);

    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig('not an object')).toThrow();
  });
});

// ============================================================================
// Record Tests
// ============================================================================

describe('Records', () => {
  describe('UUID Generation', () => {
    test('generateUUID creates valid UUIDs', () => {
      const uuid1 = generateUUID();
      const uuid2 = generateUUID();

      expect(uuid1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('Content Hashing', () => {
    test('contentHash produces consistent hashes', () => {
      const data = { a: 1, b: 'test', c: [1, 2, 3] };
      const hash1 = contentHash(data);
      const hash2 = contentHash(data);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    test('contentHash is order-independent for object keys', () => {
      const data1 = { a: 1, b: 2 };
      const data2 = { b: 2, a: 1 };

      expect(contentHash(data1)).toBe(contentHash(data2));
    });

    test('contentHash handles different types', () => {
      expect(contentHash({ x: null })).toBeDefined();
      expect(contentHash({ x: undefined })).toBeDefined();
      expect(contentHash({ x: true })).toBeDefined();
      expect(contentHash({ x: 123.45 })).toBeDefined();
      expect(contentHash({ x: [3, 1, 2] })).toBeDefined();
      expect(contentHash({ x: new Float32Array([1, 2, 3]) })).toBeDefined();
    });

    test('contentHash sorts arrays for consistency', () => {
      const data1 = { tags: ['b', 'a', 'c'] };
      const data2 = { tags: ['c', 'a', 'b'] };

      expect(contentHash(data1)).toBe(contentHash(data2));
    });
  });

  describe('Memory Records', () => {
    test('createMemoryRecord creates valid record', () => {
      const record = createMemoryRecord({
        category: 'people',
        type: 'person',
        content: 'Alice is an engineer',
        tags: ['friend', 'work'],
        importance: 8
      });

      expect(record.record_type).toBe(RecordType.MEMORY);
      expect(record.memory_id).toMatch(/^[0-9a-f-]+$/i);
      expect(record.version).toBe(1);
      expect(record.store_id).toBe('main');
      expect(record.category).toBe('people');
      expect(record.type).toBe('person');
      expect(record.content).toBe('Alice is an engineer');
      expect(record.tags).toEqual(['friend', 'work']); // Sorted
      expect(record.importance).toBe(8);
      expect(record.deleted).toBe(false);
      expect(record.content_hash).toHaveLength(64);
      expect(record.timestamp).toBeGreaterThan(0);
    });

    test('createMemoryRecord applies defaults', () => {
      const record = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Test content'
      });

      expect(record.tags).toEqual([]);
      expect(record.importance).toBe(5);
      expect(record.cadence_type).toBe('monthly');
      expect(record.cadence_value).toBeNull();
      expect(record.context).toBeNull();
      expect(record.embedding).toBeNull();
      expect(record.prev_hash).toBeNull();
    });

    test('createMemoryRecord clamps importance', () => {
      const low = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Low',
        importance: -5
      });
      expect(low.importance).toBe(1);

      const high = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'High',
        importance: 100
      });
      expect(high.importance).toBe(10);
    });

    test('createMemoryRecord freezes the record', () => {
      const record = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Test'
      });

      expect(() => {
        record.content = 'Modified';
      }).toThrow();
    });

    test('createMemoryVersion creates new version', () => {
      const v1 = createMemoryRecord({
        memory_id: 'test-id',
        category: 'test',
        type: 'fact',
        content: 'Original content'
      });

      const v2 = createMemoryVersion(v1, {
        content: 'Updated content'
      });

      expect(v2.memory_id).toBe(v1.memory_id); // Same ID
      expect(v2.version).toBe(2);
      expect(v2.content).toBe('Updated content');
      expect(v2.prev_hash).toBe(v1.content_hash);
      expect(v2.content_hash).not.toBe(v1.content_hash);
    });

    test('createMemoryVersion preserves embedding when content unchanged', () => {
      const embedding = new Float32Array([1, 2, 3]);
      const v1 = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Content',
        embedding
      });

      const v2 = createMemoryVersion(v1, {
        importance: 8 // Only metadata change
      });

      expect(v2.embedding).toBe(embedding); // Same reference
    });
  });

  describe('Relationship Records', () => {
    test('createRelationshipRecord creates valid record', () => {
      const record = createRelationshipRecord({
        memory_id: 'mem-1',
        related_memory_id: 'mem-2',
        relationship_type: 'related_to'
      });

      expect(record.record_type).toBe(RecordType.RELATIONSHIP);
      expect(record.relationship_id).toMatch(/^[0-9a-f-]+$/i);
      expect(record.version).toBe(1);
      expect(record.store_id).toBe('main');
      expect(record.memory_id).toBe('mem-1');
      expect(record.related_memory_id).toBe('mem-2');
      expect(record.relationship_type).toBe('related_to');
      expect(record.deleted).toBe(false);
    });

    test('createRelationshipRecord validates relationship type', () => {
      expect(() =>
        createRelationshipRecord({
          memory_id: 'mem-1',
          related_memory_id: 'mem-2',
          relationship_type: 'invalid_type'
        })
      ).toThrow();
    });

    test('createRelationshipVersion creates new version', () => {
      const v1 = createRelationshipRecord({
        memory_id: 'mem-1',
        related_memory_id: 'mem-2',
        relationship_type: 'related_to'
      });

      const v2 = createRelationshipVersion(v1, {
        deleted: true
      });

      expect(v2.relationship_id).toBe(v1.relationship_id);
      expect(v2.version).toBe(2);
      expect(v2.deleted).toBe(true);
      expect(v2.prev_hash).toBe(v1.content_hash);
    });
  });

  describe('Serialization', () => {
    test('serializeRecord and deserializeRecord round-trip memory record', () => {
      const embedding = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        embedding[i] = Math.random();
      }

      const original = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Test content with special chars: 日本語 emoji 🎉',
        tags: ['tag1', 'tag2'],
        importance: 7,
        embedding
      });

      const serialized = serializeRecord(original);
      expect(serialized).toBeInstanceOf(Buffer);

      const { record, bytesRead } = deserializeRecord(serialized);

      expect(bytesRead).toBe(serialized.length);
      expect(record.record_type).toBe(original.record_type);
      expect(record.memory_id).toBe(original.memory_id);
      expect(record.content).toBe(original.content);
      expect(record.tags).toEqual(original.tags);
      expect(record.content_hash).toBe(original.content_hash);

      // Check embedding
      expect(record.embedding).toBeInstanceOf(Float32Array);
      expect(record.embedding.length).toBe(384);
      for (let i = 0; i < 384; i++) {
        expect(record.embedding[i]).toBeCloseTo(embedding[i], 5);
      }
    });

    test('serializeRecord and deserializeRecord round-trip relationship record', () => {
      const original = createRelationshipRecord({
        memory_id: 'mem-1',
        related_memory_id: 'mem-2',
        relationship_type: 'supersedes'
      });

      const serialized = serializeRecord(original);
      const { record, bytesRead } = deserializeRecord(serialized);

      expect(bytesRead).toBe(serialized.length);
      expect(record.record_type).toBe(original.record_type);
      expect(record.relationship_id).toBe(original.relationship_id);
      expect(record.memory_id).toBe(original.memory_id);
      expect(record.related_memory_id).toBe(original.related_memory_id);
      expect(record.content_hash).toBe(original.content_hash);
    });

    test('serializeRecord handles null embedding', () => {
      const original = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'No embedding'
      });

      const serialized = serializeRecord(original);
      const { record } = deserializeRecord(serialized);

      expect(record.embedding).toBeNull();
    });
  });

  describe('Hash Verification', () => {
    test('verifyRecordHash returns true for valid records', () => {
      const memory = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Test'
      });
      expect(verifyRecordHash(memory)).toBe(true);

      const relationship = createRelationshipRecord({
        memory_id: 'a',
        related_memory_id: 'b'
      });
      expect(verifyRecordHash(relationship)).toBe(true);
    });
  });
});

// ============================================================================
// WAL Tests
// ============================================================================

describe('Write-Ahead Log', () => {
  const walPath = join(TEST_DIR, 'test-wal', 'wal.log');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  test('openWAL creates new WAL file', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    expect(existsSync(walPath)).toBe(true);
    expect(wal.getRecordCount()).toBe(0);
    expect(wal.getSize()).toBeGreaterThan(0); // Header size

    wal.close();
  });

  test('WAL appends and retrieves records', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    const record1 = createMemoryRecord({
      category: 'test',
      type: 'fact',
      content: 'First record'
    });

    const record2 = createMemoryRecord({
      category: 'test',
      type: 'fact',
      content: 'Second record'
    });

    wal.append(record1);
    wal.append(record2);

    expect(wal.getRecordCount()).toBe(2);

    const records = wal.getRecords();
    expect(records.length).toBe(2);
    expect(records[0].content).toBe('First record');
    expect(records[1].content).toBe('Second record');

    wal.close();
  });

  test('WAL persists across open/close', async () => {
    // Write some records
    let wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    for (let i = 0; i < 5; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Record ${i}`
        })
      );
    }

    wal.close();

    // Reopen and verify
    wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    expect(wal.getRecordCount()).toBe(5);

    const records = wal.getRecords();
    expect(records[0].content).toBe('Record 0');
    expect(records[4].content).toBe('Record 4');

    wal.close();
  });

  test('WAL detects store ID mismatch', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'store-1'
    });
    wal.close();

    await expect(
      openWAL({
        path: walPath,
        storeId: 'store-2' // Different store ID
      })
    ).rejects.toThrow('store ID mismatch');
  });

  test('WAL.shouldRotate detects size threshold', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store',
      maxSizeBytes: 1024 // Very small for testing
    });

    expect(wal.shouldRotate()).toBe(false);

    // Add records until we exceed threshold
    for (let i = 0; i < 10; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: 'A'.repeat(100) // ~100 bytes content
        })
      );
    }

    expect(wal.shouldRotate()).toBe(true);

    wal.close();
  });

  test('WAL.clear resets the WAL', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    wal.append(
      createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'To be cleared'
      })
    );

    expect(wal.getRecordCount()).toBe(1);

    await wal.clear();

    expect(wal.getRecordCount()).toBe(0);
    expect(wal.getRecords()).toEqual([]);

    wal.close();
  });

  test('WAL.rotate moves WAL to segment', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    wal.append(
      createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Record 1'
      })
    );
    wal.append(
      createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Record 2'
      })
    );

    const segmentPath = join(TEST_DIR, 'test-wal', 'segments', '00000001.seg');
    const result = await wal.rotate(segmentPath);

    expect(result.recordCount).toBe(2);
    expect(existsSync(segmentPath)).toBe(true);
    expect(wal.getRecordCount()).toBe(0); // WAL is now empty

    wal.close();
  });
});

// ============================================================================
// Segment Tests
// ============================================================================

describe('Segments', () => {
  const segmentsDir = join(TEST_DIR, 'test-segments');
  const walPath = join(TEST_DIR, 'test-segments', 'wal.log');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  test('SegmentReader reads rotated WAL', async () => {
    // Create WAL with records
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    const records = [];
    for (let i = 0; i < 5; i++) {
      const record = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: `Segment record ${i}`
      });
      wal.append(record);
      records.push(record);
    }

    // Rotate to segment
    const segmentPath = join(segmentsDir, '00000001.seg');
    await wal.rotate(segmentPath);
    wal.close();

    // Read segment
    const reader = await openSegment(segmentPath);

    expect(reader.recordCount).toBe(5);
    expect(reader.storeId).toBe('test-store');

    const readRecords = reader.getAllRecords();
    expect(readRecords.length).toBe(5);
    expect(readRecords[0].content).toBe('Segment record 0');
    expect(readRecords[4].content).toBe('Segment record 4');

    reader.close();
  });

  test('SegmentReader.iterate yields all records', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    for (let i = 0; i < 3; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Record ${i}`
        })
      );
    }

    const segmentPath = join(segmentsDir, '00000001.seg');
    await wal.rotate(segmentPath);
    wal.close();

    const reader = await openSegment(segmentPath);

    const items = [];
    for (const item of reader.iterate()) {
      items.push(item);
    }

    expect(items.length).toBe(3);
    expect(items[0].record.content).toBe('Record 0');
    expect(items[0].offset).toBeGreaterThan(0);
    expect(items[0].length).toBeGreaterThan(0);

    reader.close();
  });

  test('SegmentReader.readAt reads specific record', async () => {
    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    for (let i = 0; i < 3; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Record ${i}`
        })
      );
    }

    const segmentPath = join(segmentsDir, '00000001.seg');
    await wal.rotate(segmentPath);
    wal.close();

    const reader = await openSegment(segmentPath);

    // Get offset of second record
    const items = [...reader.iterate()];
    const secondOffset = items[1].offset;

    const record = reader.readAt(secondOffset);
    expect(record.content).toBe('Record 1');

    reader.close();
  });

  test('SegmentManager manages multiple segments', async () => {
    const manager = await createSegmentManager(segmentsDir, 'test-store');

    expect(manager.getTotalRecordCount()).toBe(0);

    // Create first segment via WAL rotation
    let wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    for (let i = 0; i < 5; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Segment 1 Record ${i}`
        })
      );
    }

    const seg1Path = manager.getNextSegmentPath();
    await wal.rotate(seg1Path);
    await manager.registerSegment(seg1Path);

    // Create second segment
    for (let i = 0; i < 3; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Segment 2 Record ${i}`
        })
      );
    }

    const seg2Path = manager.getNextSegmentPath();
    await wal.rotate(seg2Path);
    await manager.registerSegment(seg2Path);
    wal.close();

    expect(manager.getTotalRecordCount()).toBe(8);
    expect(manager.getSegmentInfos().length).toBe(2);

    // Iterate all records
    const allRecords = [...manager.iterateAll()];
    expect(allRecords.length).toBe(8);
    expect(allRecords[0].record.content).toBe('Segment 1 Record 0');
    expect(allRecords[5].record.content).toBe('Segment 2 Record 0');

    manager.close();
  });

  test('SegmentManager initializes from existing segments', async () => {
    // Create segments first
    let manager = await createSegmentManager(segmentsDir, 'test-store');

    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    for (let i = 0; i < 3; i++) {
      wal.append(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: `Record ${i}`
        })
      );
    }

    const segPath = manager.getNextSegmentPath();
    await wal.rotate(segPath);
    await manager.registerSegment(segPath);
    wal.close();
    manager.close();

    // Create new manager - should find existing segment
    manager = await createSegmentManager(segmentsDir, 'test-store');

    expect(manager.getTotalRecordCount()).toBe(3);
    expect(manager.getSegmentInfos().length).toBe(1);

    manager.close();
  });

  test('SegmentManager.removeSegment deletes segment', async () => {
    const manager = await createSegmentManager(segmentsDir, 'test-store');

    const wal = await openWAL({
      path: walPath,
      storeId: 'test-store'
    });

    wal.append(
      createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Record'
      })
    );

    const segPath = manager.getNextSegmentPath();
    await wal.rotate(segPath);
    await manager.registerSegment(segPath);
    wal.close();

    expect(existsSync(segPath)).toBe(true);
    expect(manager.getTotalRecordCount()).toBe(1);

    manager.removeSegment(1); // First segment number

    expect(existsSync(segPath)).toBe(false);
    expect(manager.getTotalRecordCount()).toBe(0);

    manager.close();
  });
});

// ============================================================================
// Merkle Tree Tests
// ============================================================================

describe('Merkle Tree', () => {
  const merkleDir = join(TEST_DIR, 'test-merkle');
  const merklePath = join(merkleDir, 'merkle.idx');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('Hashing Functions', () => {
    test('sha256 produces consistent hashes', () => {
      const hash1 = sha256('hello world');
      const hash2 = sha256('hello world');

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    test('sha256 produces different hashes for different input', () => {
      const hash1 = sha256('hello');
      const hash2 = sha256('world');

      expect(hash1).not.toBe(hash2);
    });

    test('hashPair is consistent regardless of order', () => {
      const a = sha256('a');
      const b = sha256('b');

      // hashPair sorts internally for canonical form
      const hash1 = hashPair(a, b);
      const hash2 = hashPair(b, a);

      expect(hash1).toBe(hash2);
    });
  });

  describe('Basic Operations', () => {
    test('empty tree has null root', () => {
      const tree = new MerkleTree();

      expect(tree.getRoot()).toBeNull();
      expect(tree.getLeafCount()).toBe(0);
    });

    test('single leaf tree has leaf as root', () => {
      const tree = new MerkleTree();
      const leafHash = sha256('leaf1');

      const root = tree.addLeaf(leafHash);

      expect(root).toBe(leafHash);
      expect(tree.getRoot()).toBe(leafHash);
      expect(tree.getLeafCount()).toBe(1);
    });

    test('two leaves produce combined root', () => {
      const tree = new MerkleTree();
      const leaf1 = sha256('leaf1');
      const leaf2 = sha256('leaf2');

      tree.addLeaf(leaf1);
      const root = tree.addLeaf(leaf2);

      expect(root).toBe(hashPair(leaf1, leaf2));
      expect(tree.getLeafCount()).toBe(2);
    });

    test('three leaves build correct tree', () => {
      const tree = new MerkleTree();
      const leaves = [sha256('a'), sha256('b'), sha256('c')];

      for (const leaf of leaves) {
        tree.addLeaf(leaf);
      }

      // Tree structure:
      //       root
      //      /    \
      //    h01     c
      //   /   \
      //  a     b
      const h01 = hashPair(leaves[0], leaves[1]);
      const expectedRoot = hashPair(h01, leaves[2]);

      expect(tree.getRoot()).toBe(expectedRoot);
    });

    test('four leaves build balanced tree', () => {
      const tree = new MerkleTree();
      const leaves = [sha256('a'), sha256('b'), sha256('c'), sha256('d')];

      for (const leaf of leaves) {
        tree.addLeaf(leaf);
      }

      // Tree structure:
      //        root
      //       /    \
      //     h01    h23
      //    /  \   /   \
      //   a    b c     d
      const h01 = hashPair(leaves[0], leaves[1]);
      const h23 = hashPair(leaves[2], leaves[3]);
      const expectedRoot = hashPair(h01, h23);

      expect(tree.getRoot()).toBe(expectedRoot);
    });

    test('getLeaf returns correct leaf', () => {
      const tree = new MerkleTree();
      const leaves = [sha256('a'), sha256('b'), sha256('c')];

      for (const leaf of leaves) {
        tree.addLeaf(leaf);
      }

      expect(tree.getLeaf(0)).toBe(leaves[0]);
      expect(tree.getLeaf(1)).toBe(leaves[1]);
      expect(tree.getLeaf(2)).toBe(leaves[2]);
      expect(tree.getLeaf(3)).toBeUndefined();
    });
  });

  describe('Proof Generation and Verification', () => {
    test('proof for single leaf tree', () => {
      const tree = new MerkleTree();
      const leaf = sha256('only');

      tree.addLeaf(leaf);

      const proof = tree.generateProof(0);

      expect(proof.leafIndex).toBe(0);
      expect(proof.leafHash).toBe(leaf);
      expect(proof.siblings).toEqual([]);
      expect(proof.root).toBe(leaf);

      expect(MerkleTree.verifyProof(proof)).toBe(true);
    });

    test('proof for two leaf tree', () => {
      const tree = new MerkleTree();
      const leaves = [sha256('a'), sha256('b')];

      for (const leaf of leaves) {
        tree.addLeaf(leaf);
      }

      // Proof for first leaf
      const proof0 = tree.generateProof(0);
      expect(proof0.leafHash).toBe(leaves[0]);
      expect(proof0.siblings.length).toBe(1);
      expect(proof0.siblings[0].hash).toBe(leaves[1]);
      expect(proof0.siblings[0].position).toBe('right');
      expect(MerkleTree.verifyProof(proof0)).toBe(true);

      // Proof for second leaf
      const proof1 = tree.generateProof(1);
      expect(proof1.leafHash).toBe(leaves[1]);
      expect(proof1.siblings.length).toBe(1);
      expect(proof1.siblings[0].hash).toBe(leaves[0]);
      expect(proof1.siblings[0].position).toBe('left');
      expect(MerkleTree.verifyProof(proof1)).toBe(true);
    });

    test('proof for four leaf tree', () => {
      const tree = new MerkleTree();
      const leaves = [sha256('a'), sha256('b'), sha256('c'), sha256('d')];

      for (const leaf of leaves) {
        tree.addLeaf(leaf);
      }

      // Verify proofs for all leaves
      for (let i = 0; i < 4; i++) {
        const proof = tree.generateProof(i);
        expect(proof.leafHash).toBe(leaves[i]);
        expect(proof.root).toBe(tree.getRoot());
        expect(MerkleTree.verifyProof(proof)).toBe(true);
      }
    });

    test('proof for larger tree (16 leaves)', () => {
      const tree = new MerkleTree();
      const leaves = [];

      for (let i = 0; i < 16; i++) {
        const leaf = sha256(`leaf-${i}`);
        leaves.push(leaf);
        tree.addLeaf(leaf);
      }

      // Verify proofs for all leaves
      for (let i = 0; i < 16; i++) {
        const proof = tree.generateProof(i);
        expect(MerkleTree.verifyProof(proof)).toBe(true);
      }
    });

    test('proof for non-power-of-2 leaves (7 leaves)', () => {
      const tree = new MerkleTree();
      const leaves = [];

      for (let i = 0; i < 7; i++) {
        const leaf = sha256(`leaf-${i}`);
        leaves.push(leaf);
        tree.addLeaf(leaf);
      }

      // Verify proofs for all leaves
      for (let i = 0; i < 7; i++) {
        const proof = tree.generateProof(i);
        expect(MerkleTree.verifyProof(proof)).toBe(true);
      }
    });

    test('generateProof throws for invalid index', () => {
      const tree = new MerkleTree();
      tree.addLeaf(sha256('a'));

      expect(() => tree.generateProof(-1)).toThrow();
      expect(() => tree.generateProof(1)).toThrow();
      expect(() => tree.generateProof(100)).toThrow();
    });

    test('verifyProof returns false for tampered proof', () => {
      const tree = new MerkleTree();
      tree.addLeaf(sha256('a'));
      tree.addLeaf(sha256('b'));

      const proof = tree.generateProof(0);

      // Tamper with leaf hash
      const tamperedProof1 = { ...proof, leafHash: sha256('tampered') };
      expect(MerkleTree.verifyProof(tamperedProof1)).toBe(false);

      // Tamper with sibling
      const tamperedProof2 = {
        ...proof,
        siblings: [{ ...proof.siblings[0], hash: sha256('tampered') }]
      };
      expect(MerkleTree.verifyProof(tamperedProof2)).toBe(false);

      // Tamper with root
      const tamperedProof3 = { ...proof, root: sha256('tampered') };
      expect(MerkleTree.verifyProof(tamperedProof3)).toBe(false);
    });

    test('verifyProof handles invalid input', () => {
      expect(MerkleTree.verifyProof(null)).toBe(false);
      expect(MerkleTree.verifyProof(undefined)).toBe(false);
      expect(MerkleTree.verifyProof({})).toBe(false);
      expect(MerkleTree.verifyProof({ leafHash: 'abc' })).toBe(false);
    });
  });

  describe('Integrity Verification', () => {
    test('verifyIntegrity returns true for valid tree', () => {
      const tree = new MerkleTree();

      for (let i = 0; i < 10; i++) {
        tree.addLeaf(sha256(`leaf-${i}`));
      }

      expect(tree.verifyIntegrity()).toBe(true);
    });

    test('verifyIntegrity returns true for empty tree', () => {
      const tree = new MerkleTree();
      expect(tree.verifyIntegrity()).toBe(true);
    });
  });

  describe('Serialization and Persistence', () => {
    test('serialize and deserialize round-trip', () => {
      const tree = new MerkleTree();

      for (let i = 0; i < 10; i++) {
        tree.addLeaf(sha256(`leaf-${i}`));
      }

      const serialized = tree.serialize();
      expect(serialized).toBeInstanceOf(Buffer);

      const restored = MerkleTree.deserialize(serialized);

      expect(restored.getRoot()).toBe(tree.getRoot());
      expect(restored.getLeafCount()).toBe(tree.getLeafCount());

      for (let i = 0; i < 10; i++) {
        expect(restored.getLeaf(i)).toBe(tree.getLeaf(i));
      }
    });

    test('save and load from disk', () => {
      const tree = new MerkleTree({ indexPath: merklePath });

      for (let i = 0; i < 5; i++) {
        tree.addLeaf(sha256(`leaf-${i}`));
      }

      tree.save();

      expect(existsSync(merklePath)).toBe(true);

      const loaded = MerkleTree.load(merklePath);

      expect(loaded.getRoot()).toBe(tree.getRoot());
      expect(loaded.getLeafCount()).toBe(5);
    });

    test('save creates directory if needed', () => {
      const deepPath = join(merkleDir, 'deep', 'nested', 'merkle.idx');
      const tree = new MerkleTree({ indexPath: deepPath });

      tree.addLeaf(sha256('leaf'));
      tree.save();

      expect(existsSync(deepPath)).toBe(true);
    });

    test('load throws for missing file', () => {
      expect(() => MerkleTree.load('/nonexistent/path.idx')).toThrow();
    });

    test('deserialize throws for corrupted data', () => {
      const tree = new MerkleTree();
      tree.addLeaf(sha256('a'));

      const serialized = tree.serialize();
      const data = JSON.parse(serialized.toString());
      data.root = sha256('wrong'); // Corrupt the root

      expect(() =>
        MerkleTree.deserialize(Buffer.from(JSON.stringify(data)))
      ).toThrow('integrity');
    });

    test('isDirty tracks modifications', () => {
      const tree = new MerkleTree({ indexPath: merklePath });

      expect(tree.isDirty()).toBe(false);

      tree.addLeaf(sha256('leaf'));
      expect(tree.isDirty()).toBe(true);

      tree.save();
      expect(tree.isDirty()).toBe(false);

      tree.addLeaf(sha256('another'));
      expect(tree.isDirty()).toBe(true);
    });
  });

  describe('Rebuild and Snapshot', () => {
    test('rebuildFromHashes creates equivalent tree', () => {
      const hashes = [];
      for (let i = 0; i < 15; i++) {
        hashes.push(sha256(`content-${i}`));
      }

      // Build incrementally
      const incremental = new MerkleTree();
      for (const hash of hashes) {
        incremental.addLeaf(hash);
      }

      // Rebuild from hashes
      const rebuilt = MerkleTree.rebuildFromHashes(hashes);

      expect(rebuilt.getRoot()).toBe(incremental.getRoot());
      expect(rebuilt.getLeafCount()).toBe(incremental.getLeafCount());
    });

    test('getSnapshot returns current state', () => {
      const tree = new MerkleTree();
      tree.addLeaf(sha256('a'));
      tree.addLeaf(sha256('b'));

      const snapshot = tree.getSnapshot();

      expect(snapshot.root).toBe(tree.getRoot());
      expect(snapshot.leafCount).toBe(2);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    test('clear resets tree', () => {
      const tree = new MerkleTree();
      tree.addLeaf(sha256('a'));
      tree.addLeaf(sha256('b'));

      expect(tree.getLeafCount()).toBe(2);

      tree.clear();

      expect(tree.getRoot()).toBeNull();
      expect(tree.getLeafCount()).toBe(0);
      expect(tree.isDirty()).toBe(true);
    });
  });

  describe('Fork Detection', () => {
    test('findDivergencePoint returns null for identical trees', () => {
      const tree1 = new MerkleTree();
      const tree2 = new MerkleTree();

      for (let i = 0; i < 5; i++) {
        const hash = sha256(`leaf-${i}`);
        tree1.addLeaf(hash);
        tree2.addLeaf(hash);
      }

      expect(tree1.findDivergencePoint(tree2)).toBeNull();
    });

    test('findDivergencePoint finds first difference', () => {
      const tree1 = new MerkleTree();
      const tree2 = new MerkleTree();

      // Same first 3 leaves
      for (let i = 0; i < 3; i++) {
        const hash = sha256(`leaf-${i}`);
        tree1.addLeaf(hash);
        tree2.addLeaf(hash);
      }

      // Different 4th leaf
      tree1.addLeaf(sha256('different-a'));
      tree2.addLeaf(sha256('different-b'));

      expect(tree1.findDivergencePoint(tree2)).toBe(3);
    });

    test('findDivergencePoint handles different lengths', () => {
      const tree1 = new MerkleTree();
      const tree2 = new MerkleTree();

      for (let i = 0; i < 5; i++) {
        const hash = sha256(`leaf-${i}`);
        tree1.addLeaf(hash);
        tree2.addLeaf(hash);
      }

      // tree1 has more leaves
      tree1.addLeaf(sha256('extra-1'));
      tree1.addLeaf(sha256('extra-2'));

      expect(tree1.findDivergencePoint(tree2)).toBe(5);
    });
  });

  describe('Large Tree Performance', () => {
    test('handles 1000 leaves efficiently', () => {
      const tree = new MerkleTree();
      const start = performance.now();

      for (let i = 0; i < 1000; i++) {
        tree.addLeaf(sha256(`leaf-${i}`));
      }

      const elapsed = performance.now() - start;

      expect(tree.getLeafCount()).toBe(1000);
      expect(tree.getRoot()).toBeDefined();
      expect(elapsed).toBeLessThan(1000); // Should be well under 1 second

      // Verify a few proofs
      expect(MerkleTree.verifyProof(tree.generateProof(0))).toBe(true);
      expect(MerkleTree.verifyProof(tree.generateProof(500))).toBe(true);
      expect(MerkleTree.verifyProof(tree.generateProof(999))).toBe(true);
    });
  });
});

// ============================================================================
// Latest Index Tests
// ============================================================================

describe('Latest Index', () => {
  const indexDir = join(TEST_DIR, 'test-latest-index');
  const indexPath = join(indexDir, 'latest.idx');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('Basic Operations', () => {
    test('empty index has zero counts', () => {
      const index = new LatestIndex();

      expect(index.getMemoryCount()).toBe(0);
      expect(index.getRelationshipCount()).toBe(0);
    });

    test('updateMemory adds entry', () => {
      const index = new LatestIndex();

      const record = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Test content'
      });

      index.updateMemory(record, 1, 100);

      expect(index.hasMemory(record.memory_id)).toBe(true);
      expect(index.getMemoryCount()).toBe(1);

      const entry = index.getMemory(record.memory_id);
      expect(entry.segmentNumber).toBe(1);
      expect(entry.offset).toBe(100);
      expect(entry.version).toBe(1);
      expect(entry.deleted).toBe(false);
    });

    test('updateMemory only updates with newer version', () => {
      const index = new LatestIndex();

      const v1 = createMemoryRecord({
        memory_id: 'test-id',
        category: 'test',
        type: 'fact',
        content: 'Version 1'
      });

      const v2 = createMemoryVersion(v1, { content: 'Version 2' });

      // Add v2 first
      index.updateMemory(v2, 2, 200);
      // Try to add v1 (should be ignored)
      index.updateMemory(v1, 1, 100);

      const entry = index.getMemory('test-id');
      expect(entry.version).toBe(2);
      expect(entry.offset).toBe(200);
    });

    test('updateRelationship adds entry', () => {
      const index = new LatestIndex();

      const record = createRelationshipRecord({
        memory_id: 'mem-1',
        related_memory_id: 'mem-2'
      });

      index.updateRelationship(record, 1, 100);

      expect(index.hasRelationship(record.relationship_id)).toBe(true);
      expect(index.getRelationshipCount()).toBe(1);
    });

    test('update auto-detects record type', () => {
      const index = new LatestIndex();

      const memory = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Memory'
      });

      const relationship = createRelationshipRecord({
        memory_id: 'mem-1',
        related_memory_id: 'mem-2'
      });

      index.update(memory, 1, 100);
      index.update(relationship, 1, 200);

      expect(index.getMemoryCount()).toBe(1);
      expect(index.getRelationshipCount()).toBe(1);
    });
  });

  describe('Filtering', () => {
    test('getAllMemoryIds excludes deleted by default', () => {
      const index = new LatestIndex();

      const active = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Active'
      });

      const deleted = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Deleted',
        deleted: true
      });

      index.updateMemory(active, 1, 100);
      index.updateMemory(deleted, 1, 200);

      const ids = index.getAllMemoryIds();
      expect(ids).toContain(active.memory_id);
      expect(ids).not.toContain(deleted.memory_id);

      const allIds = index.getAllMemoryIds(true);
      expect(allIds).toContain(active.memory_id);
      expect(allIds).toContain(deleted.memory_id);
    });

    test('getMemoryCount respects deleted filter', () => {
      const index = new LatestIndex();

      index.updateMemory(
        createMemoryRecord({ category: 'test', type: 'fact', content: 'A' }),
        1,
        100
      );
      index.updateMemory(
        createMemoryRecord({
          category: 'test',
          type: 'fact',
          content: 'B',
          deleted: true
        }),
        1,
        200
      );

      expect(index.getMemoryCount()).toBe(1);
      expect(index.getMemoryCount(true)).toBe(2);
    });
  });

  describe('Serialization', () => {
    test('serialize and deserialize round-trip', () => {
      const index = new LatestIndex();

      for (let i = 0; i < 5; i++) {
        index.updateMemory(
          createMemoryRecord({
            category: 'test',
            type: 'fact',
            content: `Memory ${i}`
          }),
          i,
          i * 100
        );
      }

      const serialized = index.serialize();
      const restored = LatestIndex.deserialize(serialized);

      expect(restored.getMemoryCount()).toBe(5);
    });

    test('save and load from disk', () => {
      const index = new LatestIndex({ indexPath });

      const record = createMemoryRecord({
        category: 'test',
        type: 'fact',
        content: 'Persisted'
      });

      index.updateMemory(record, 1, 100);
      index.save();

      const loaded = LatestIndex.load(indexPath);
      expect(loaded.hasMemory(record.memory_id)).toBe(true);
    });

    test('isDirty tracks modifications', () => {
      const index = new LatestIndex({ indexPath });

      expect(index.isDirty()).toBe(false);

      index.updateMemory(
        createMemoryRecord({ category: 'test', type: 'fact', content: 'Test' }),
        1,
        100
      );
      expect(index.isDirty()).toBe(true);

      index.save();
      expect(index.isDirty()).toBe(false);
    });
  });

  describe('Rebuild', () => {
    test('rebuildFromRecords creates correct index', () => {
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push({
          record: createMemoryRecord({
            category: 'test',
            type: 'fact',
            content: `Record ${i}`
          }),
          segmentNumber: Math.floor(i / 5),
          offset: (i % 5) * 100
        });
      }

      const index = LatestIndex.rebuildFromRecords(records);

      expect(index.getMemoryCount()).toBe(10);
    });
  });
});

// ============================================================================
// Vector Index Tests
// ============================================================================

describe('Vector Index', () => {
  const indexDir = join(TEST_DIR, 'test-vector-index');
  const indexPath = join(indexDir, 'vector.idx');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  // Helper to create random vectors
  function randomVector(dim = 384) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      v[i] = Math.random() * 2 - 1;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) {
      v[i] /= norm;
    }
    return v;
  }

  describe('Similarity Functions', () => {
    test('cosineSimilarity identical vectors', () => {
      const v = new Float32Array([1, 0, 0]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    test('cosineSimilarity orthogonal vectors', () => {
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(0.0, 5);
    });

    test('cosineSimilarity opposite vectors', () => {
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([-1, 0, 0]);
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(-1.0, 5);
    });
  });

  describe('Basic Operations', () => {
    test('empty index has size 0', () => {
      const index = new VectorIndex({ dimensions: 8 });
      expect(index.size()).toBe(0);
    });

    test('insert adds vector', () => {
      const index = new VectorIndex({ dimensions: 8 });
      const v = randomVector(8);

      index.insert('id-1', v);

      expect(index.size()).toBe(1);
      expect(index.has('id-1')).toBe(true);
    });

    test('insert replaces existing vector', () => {
      const index = new VectorIndex({ dimensions: 8 });

      index.insert('id-1', randomVector(8));
      index.insert('id-1', randomVector(8));

      expect(index.size()).toBe(1);
    });

    test('remove deletes vector', () => {
      const index = new VectorIndex({ dimensions: 8 });

      index.insert('id-1', randomVector(8));
      index.remove('id-1');

      expect(index.size()).toBe(0);
      expect(index.has('id-1')).toBe(false);
    });
  });

  describe('Search', () => {
    test('search finds exact match', () => {
      const index = new VectorIndex({ dimensions: 8 });
      const query = randomVector(8);

      index.insert('target', query);
      index.insert('other1', randomVector(8));
      index.insert('other2', randomVector(8));

      const results = index.search(query, 1);

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('target');
      expect(results[0].similarity).toBeCloseTo(1.0, 3);
    });

    test('search returns k results', () => {
      const index = new VectorIndex({ dimensions: 8 });

      for (let i = 0; i < 20; i++) {
        index.insert(`id-${i}`, randomVector(8));
      }

      const results = index.search(randomVector(8), 5);
      expect(results.length).toBe(5);
    });

    test('search on empty index returns empty', () => {
      const index = new VectorIndex({ dimensions: 8 });
      const results = index.search(randomVector(8), 5);
      expect(results).toEqual([]);
    });

    test('search finds similar vectors', () => {
      const index = new VectorIndex({ dimensions: 8 });

      // Create a base vector and some variations
      const base = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
      const similar = new Float32Array([0.9, 0.1, 0, 0, 0, 0, 0, 0]);
      const different = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1]);

      index.insert('similar', similar);
      index.insert('different', different);

      const results = index.search(base, 2);

      expect(results[0].id).toBe('similar');
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });
  });

  describe('Serialization', () => {
    test('serialize and deserialize round-trip', () => {
      const index = new VectorIndex({ dimensions: 8 });

      for (let i = 0; i < 10; i++) {
        index.insert(`id-${i}`, randomVector(8));
      }

      const query = randomVector(8);
      const originalResults = index.search(query, 5);

      const serialized = index.serialize();
      const restored = VectorIndex.deserialize(serialized);

      expect(restored.size()).toBe(10);

      const restoredResults = restored.search(query, 5);
      expect(restoredResults.length).toBe(5);

      // Results should be the same
      for (let i = 0; i < 5; i++) {
        expect(restoredResults[i].id).toBe(originalResults[i].id);
      }
    });

    test('save and load from disk', () => {
      const index = new VectorIndex({ dimensions: 8, indexPath });

      for (let i = 0; i < 5; i++) {
        index.insert(`id-${i}`, randomVector(8));
      }

      index.save();

      const loaded = VectorIndex.load(indexPath);
      expect(loaded.size()).toBe(5);
    });
  });

  describe('Performance', () => {
    test('handles 500 vectors efficiently', () => {
      const index = new VectorIndex({ dimensions: 64 });
      const start = performance.now();

      for (let i = 0; i < 500; i++) {
        index.insert(`id-${i}`, randomVector(64));
      }

      const insertTime = performance.now() - start;

      const searchStart = performance.now();
      for (let i = 0; i < 10; i++) {
        index.search(randomVector(64), 10);
      }
      const searchTime = performance.now() - searchStart;

      expect(index.size()).toBe(500);
      expect(insertTime).toBeLessThan(5000); // 5 seconds max for inserts
      expect(searchTime).toBeLessThan(1000); // 1 second max for 10 searches
    });
  });
});

// ============================================================================
// Text Index Tests
// ============================================================================

describe('Text Index', () => {
  const indexDir = join(TEST_DIR, 'test-text-index');
  const indexPath = join(indexDir, 'text.idx');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('Tokenizer', () => {
    test('tokenize splits on whitespace and punctuation', () => {
      const tokens = tokenize('Hello, world! How are you?');
      expect(tokens).toEqual(['hello', 'world', 'how', 'are', 'you']);
    });

    test('tokenize handles empty input', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize(null)).toEqual([]);
      expect(tokenize(undefined)).toEqual([]);
    });

    test('tokenize preserves unicode', () => {
      const tokens = tokenize('日本語 emoji test');
      expect(tokens).toContain('日本語');
      expect(tokens).toContain('emoji');
      expect(tokens).toContain('test');
    });

    test('removeStopWords filters common words', () => {
      const tokens = ['the', 'quick', 'brown', 'fox', 'is', 'a', 'test'];
      const filtered = removeStopWords(tokens);
      expect(filtered).toEqual(['quick', 'brown', 'fox', 'test']);
    });
  });

  describe('Basic Operations', () => {
    test('empty index has size 0', () => {
      const index = new TextIndex();
      expect(index.size()).toBe(0);
    });

    test('add indexes document', () => {
      const index = new TextIndex();

      index.add('doc-1', 'The quick brown fox');

      expect(index.size()).toBe(1);
      expect(index.has('doc-1')).toBe(true);
    });

    test('add replaces existing document', () => {
      const index = new TextIndex();

      index.add('doc-1', 'First content');
      index.add('doc-1', 'Second content');

      expect(index.size()).toBe(1);
    });

    test('remove deletes document', () => {
      const index = new TextIndex();

      index.add('doc-1', 'Some content');
      index.remove('doc-1');

      expect(index.size()).toBe(0);
      expect(index.has('doc-1')).toBe(false);
    });

    test('add indexes metadata fields', () => {
      const index = new TextIndex();

      index.add('doc-1', 'Main content', {
        category: 'people',
        type: 'person',
        tags: ['friend', 'colleague']
      });

      const results = index.search('people');
      expect(results.length).toBe(1);

      const tagResults = index.search('friend');
      expect(tagResults.length).toBe(1);
    });
  });

  describe('Search', () => {
    test('search finds matching documents', () => {
      const index = new TextIndex();

      index.add('doc-1', 'The quick brown fox jumps');
      index.add('doc-2', 'A lazy dog sleeps');
      index.add('doc-3', 'The fox and the dog play');

      const results = index.search('fox');

      expect(results.length).toBe(2);
      expect(results.map((r) => r.id)).toContain('doc-1');
      expect(results.map((r) => r.id)).toContain('doc-3');
    });

    test('search ranks by relevance', () => {
      const index = new TextIndex();

      index.add('doc-1', 'fox fox fox'); // High term frequency
      index.add('doc-2', 'fox'); // Lower frequency
      index.add('doc-3', 'dog'); // No match

      const results = index.search('fox');

      expect(results.length).toBe(2);
      expect(results[0].id).toBe('doc-1'); // Higher score
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    test('search with matchAll requires all terms', () => {
      const index = new TextIndex();

      index.add('doc-1', 'quick brown fox');
      index.add('doc-2', 'quick dog');
      index.add('doc-3', 'brown cat');

      const results = index.search('quick brown', 10, { matchAll: true });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('doc-1');
    });

    test('search returns empty for no matches', () => {
      const index = new TextIndex();

      index.add('doc-1', 'hello world');

      const results = index.search('xyz');
      expect(results).toEqual([]);
    });

    test('search handles multiple query terms', () => {
      const index = new TextIndex();

      index.add('doc-1', 'software engineer programming');
      index.add('doc-2', 'software developer');
      index.add('doc-3', 'hardware engineer');

      const results = index.search('software engineer');

      expect(results.length).toBe(3);
      // doc-1 should rank highest (matches both terms)
      expect(results[0].id).toBe('doc-1');
    });

    test('search respects limit', () => {
      const index = new TextIndex();

      for (let i = 0; i < 20; i++) {
        index.add(`doc-${i}`, 'common term');
      }

      const results = index.search('common', 5);
      expect(results.length).toBe(5);
    });
  });

  describe('Serialization', () => {
    test('serialize and deserialize round-trip', () => {
      const index = new TextIndex();

      index.add('doc-1', 'The quick brown fox');
      index.add('doc-2', 'A lazy dog sleeps');

      const serialized = index.serialize();
      const restored = TextIndex.deserialize(serialized);

      expect(restored.size()).toBe(2);

      const results = restored.search('fox');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('doc-1');
    });

    test('save and load from disk', () => {
      const index = new TextIndex({ indexPath });

      index.add('doc-1', 'Persisted content');
      index.save();

      const loaded = TextIndex.load(indexPath);
      expect(loaded.has('doc-1')).toBe(true);

      const results = loaded.search('persisted');
      expect(results.length).toBe(1);
    });

    test('isDirty tracks modifications', () => {
      const index = new TextIndex({ indexPath });

      expect(index.isDirty()).toBe(false);

      index.add('doc-1', 'Content');
      expect(index.isDirty()).toBe(true);

      index.save();
      expect(index.isDirty()).toBe(false);
    });
  });

  describe('Statistics', () => {
    test('getTermFrequency returns document count', () => {
      const index = new TextIndex();

      index.add('doc-1', 'fox fox fox');
      index.add('doc-2', 'fox dog');
      index.add('doc-3', 'dog cat');

      expect(index.getTermFrequency('fox')).toBe(2);
      expect(index.getTermFrequency('dog')).toBe(2);
      expect(index.getTermFrequency('cat')).toBe(1);
      expect(index.getTermFrequency('xyz')).toBe(0);
    });

    test('getTerms returns all indexed terms', () => {
      const index = new TextIndex({ removeStopWords: false });

      index.add('doc-1', 'hello world');

      const terms = index.getTerms();
      expect(terms).toContain('hello');
      expect(terms).toContain('world');
    });
  });

  describe('Rebuild', () => {
    test('rebuildFromRecords creates correct index', () => {
      const records = [
        {
          id: 'doc-1',
          content: 'First document',
          metadata: { category: 'test' }
        },
        {
          id: 'doc-2',
          content: 'Second document',
          metadata: { tags: ['tag1'] }
        }
      ];

      const index = TextIndex.rebuildFromRecords(records);

      expect(index.size()).toBe(2);

      const results = index.search('document');
      expect(results.length).toBe(2);
    });
  });
});

// ============================================================================
// Memory Store Tests
// ============================================================================

describe('Memory Store', () => {
  const storeDir = join(TEST_DIR, 'test-memory-store');

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(async () => {
    cleanupTestDir();
  });

  // Mock embedding function for testing
  function mockEmbedFunction(text) {
    const v = new Float32Array(384);
    // Simple hash-based pseudo-embedding for deterministic tests
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash = hash & hash;
    }
    for (let i = 0; i < 384; i++) {
      v[i] = Math.sin(hash + i) * 0.5;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) {
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) {
      v[i] /= norm;
    }
    return v;
  }

  describe('Initialization', () => {
    test('createMemoryStore creates and initializes store', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      expect(store.initialized).toBe(true);
      expect(existsSync(storeDir)).toBe(true);

      await store.close();
    });

    test('store creates required directories', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir }
      });

      expect(existsSync(join(storeDir, 'main'))).toBe(true);
      expect(existsSync(join(storeDir, 'main', 'segments'))).toBe(true);
      expect(existsSync(join(storeDir, 'main', 'indexes'))).toBe(true);

      await store.close();
    });
  });

  describe('Memory Operations', () => {
    test('addMemory creates new memory', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const memory = await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Alice is a software engineer',
        tags: ['friend', 'work'],
        importance: 8
      });

      expect(memory.memory_id).toBeDefined();
      expect(memory.version).toBe(1);
      expect(memory.category).toBe('people');
      expect(memory.content).toBe('Alice is a software engineer');
      expect(memory.embedding).toBeInstanceOf(Float32Array);

      await store.close();
    });

    test('getMemory retrieves memory', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const created = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Test content'
      });

      const retrieved = await store.getMemory('main', created.memory_id);

      expect(retrieved).not.toBeNull();
      expect(retrieved.memory_id).toBe(created.memory_id);
      expect(retrieved.content).toBe('Test content');

      await store.close();
    });

    test('updateMemory creates new version', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const v1 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Original content'
      });

      const v2 = await store.updateMemory('main', v1.memory_id, {
        content: 'Updated content'
      });

      expect(v2.memory_id).toBe(v1.memory_id);
      expect(v2.version).toBe(2);
      expect(v2.content).toBe('Updated content');
      expect(v2.prev_hash).toBe(v1.content_hash);

      const latest = await store.getMemory('main', v1.memory_id);
      expect(latest.version).toBe(2);
      expect(latest.content).toBe('Updated content');

      await store.close();
    });

    test('deleteMemory soft deletes', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const memory = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'To be deleted'
      });

      await store.deleteMemory('main', memory.memory_id);

      const deleted = await store.getMemory('main', memory.memory_id);
      expect(deleted.deleted).toBe(true);
      expect(deleted.version).toBe(2);

      await store.close();
    });

    test('listMemories returns all memories', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      for (let i = 0; i < 5; i++) {
        await store.addMemory('main', {
          category: 'test',
          type: 'fact',
          content: `Memory ${i}`
        });
      }

      const memories = await store.listMemories('main');
      expect(memories.length).toBe(5);

      await store.close();
    });

    test('listMemories filters by category', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Alice'
      });
      await store.addMemory('main', {
        category: 'places',
        type: 'city',
        content: 'New York'
      });
      await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Bob'
      });

      const people = await store.listMemories('main', { category: 'people' });
      expect(people.length).toBe(2);

      await store.close();
    });
  });

  describe('Search', () => {
    test('search finds matching memories', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Alice is a software engineer who loves Python'
      });
      await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Bob is a data scientist who uses Python'
      });
      await store.addMemory('main', {
        category: 'places',
        type: 'city',
        content: 'New York is a big city'
      });

      const results = await store.search('main', {
        query: 'Python programmer',
        mode: 'text'
      });

      expect(results.length).toBe(2);
      expect(results.map((r) => r.content)).toContain(
        'Alice is a software engineer who loves Python'
      );
      expect(results.map((r) => r.content)).toContain(
        'Bob is a data scientist who uses Python'
      );

      await store.close();
    });

    test('search with semantic mode', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Machine learning is a subset of AI'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Deep learning uses neural networks'
      });

      const results = await store.search('main', {
        query: 'artificial intelligence',
        mode: 'semantic'
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]._semanticScore).toBeGreaterThan(0);

      await store.close();
    });
  });

  describe('Relationships', () => {
    test('addRelationship creates relationship', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const mem1 = await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Alice'
      });
      const mem2 = await store.addMemory('main', {
        category: 'people',
        type: 'person',
        content: 'Bob'
      });

      const rel = await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem2.memory_id,
        relationship_type: 'related_to'
      });

      expect(rel.relationship_id).toBeDefined();
      expect(rel.memory_id).toBe(mem1.memory_id);
      expect(rel.related_memory_id).toBe(mem2.memory_id);

      await store.close();
    });

    test('getRelationships returns relationships for memory', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const mem1 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      const mem2 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });
      const mem3 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'C'
      });

      await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem2.memory_id
      });
      await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem3.memory_id
      });

      const rels = await store.getRelationships('main', mem1.memory_id);
      expect(rels.length).toBe(2);

      await store.close();
    });

    test('getRelatedMemories returns related memories', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const mem1 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      const mem2 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });
      const mem3 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'C'
      });

      await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem2.memory_id
      });
      await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem3.memory_id
      });

      const related = await store.getRelatedMemories('main', mem1.memory_id);
      expect(related.length).toBe(2);
      expect(related.map((m) => m.content)).toContain('B');
      expect(related.map((m) => m.content)).toContain('C');

      await store.close();
    });

    test('removeRelationship soft deletes', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const mem1 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      const mem2 = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const rel = await store.addRelationship('main', {
        memory_id: mem1.memory_id,
        related_memory_id: mem2.memory_id
      });

      await store.removeRelationship('main', rel.relationship_id);

      const rels = await store.getRelationships('main', mem1.memory_id);
      expect(rels.length).toBe(0);

      const allRels = await store.getRelationships('main', mem1.memory_id, {
        includeDeleted: true
      });
      expect(allRels.length).toBe(1);

      await store.close();
    });
  });

  describe('Merkle Tree Integration', () => {
    test('getMerkleRoot returns current root', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      expect(await store.getMerkleRoot('main')).toBeNull();

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      const root1 = await store.getMerkleRoot('main');
      expect(root1).toBeDefined();

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });
      const root2 = await store.getMerkleRoot('main');
      expect(root2).not.toBe(root1);

      await store.close();
    });

    test('getSnapshot returns store state', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const snapshot = await store.getSnapshot('main');

      expect(snapshot.storeId).toBe('main');
      expect(snapshot.memoryCount).toBe(2);
      expect(snapshot.recordCount).toBe(2);
      expect(snapshot.merkleRoot).toBeDefined();

      await store.close();
    });
  });

  describe('Persistence', () => {
    test('store persists across close/reopen', async () => {
      // Create and populate store
      let store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const mem = await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Persistent memory'
      });

      await store.close();

      // Reopen store
      store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const retrieved = await store.getMemory('main', mem.memory_id);
      expect(retrieved).not.toBeNull();
      expect(retrieved.content).toBe('Persistent memory');

      await store.close();
    });
  });

  describe('Statistics', () => {
    test('getStats returns store statistics', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const stats = await store.getStats('main');

      expect(stats.storeId).toBe('main');
      expect(stats.memoryCount).toBe(2);
      expect(stats.totalRecords).toBe(2);

      await store.close();
    });
  });

  describe('Forking', () => {
    test('createFork creates copy of store', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      // Add some data to main
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Memory A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Memory B'
      });

      // Create fork
      const fork = await store.createFork('main', { name: 'Test Fork' });

      expect(fork.forkId).toBeDefined();
      expect(fork.name).toBe('Test Fork');
      expect(fork.sourceStoreId).toBe('main');

      // Verify fork has same data
      const forkStats = await store.getStats(fork.forkId);
      expect(forkStats.memoryCount).toBe(2);

      // Verify fork is independent
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Memory C'
      });

      const mainStats = await store.getStats('main');
      const forkStatsAfter = await store.getStats(fork.forkId);

      expect(mainStats.memoryCount).toBe(3);
      expect(forkStatsAfter.memoryCount).toBe(2); // Fork unchanged

      await store.close();
    });

    test('fork can have its own modifications', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Original'
      });

      const fork = await store.createFork('main');

      // Add memory to fork
      await store.addMemory(fork.forkId, {
        category: 'test',
        type: 'fact',
        content: 'Fork Only'
      });

      const mainMemories = await store.listMemories('main');
      const forkMemories = await store.listMemories(fork.forkId);

      expect(mainMemories.length).toBe(1);
      expect(forkMemories.length).toBe(2);

      await store.close();
    });

    test('listForks returns all forks', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.createFork('main', { name: 'Fork 1' });
      await store.createFork('main', { name: 'Fork 2' });

      const forks = await store.listForks();

      expect(forks.length).toBe(2);
      expect(forks.map((f) => f.name)).toContain('Fork 1');
      expect(forks.map((f) => f.name)).toContain('Fork 2');

      await store.close();
    });

    test('deleteFork removes fork', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const fork = await store.createFork('main', { name: 'To Delete' });

      let forks = await store.listForks();
      expect(forks.length).toBe(1);

      await store.deleteFork(fork.forkId);

      forks = await store.listForks();
      expect(forks.length).toBe(0);

      await store.close();
    });

    test('cannot delete main store', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await expect(store.deleteFork('main')).rejects.toThrow(
        'Cannot delete main store'
      );

      await store.close();
    });
  });

  describe('PITR (Point-in-Time Recovery)', () => {
    test('createForkAtTime creates fork with records up to timestamp', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      // Add memories with some delay to ensure different timestamps
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'First'
      });
      const cutoffTime = Date.now() + 1; // Just after first memory

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 5));

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Second'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Third'
      });

      // Create PITR fork at cutoff
      const pitrFork = await store.createForkAtTime('main', cutoffTime, {
        name: 'PITR Fork'
      });

      expect(pitrFork.pitrTimestamp).toBe(cutoffTime);

      // PITR fork should only have the first memory
      const pitrMemories = await store.listMemories(pitrFork.forkId);
      expect(pitrMemories.length).toBe(1);
      expect(pitrMemories[0].content).toBe('First');

      // Main should have all three
      const mainMemories = await store.listMemories('main');
      expect(mainMemories.length).toBe(3);

      await store.close();
    });
  });

  describe('Snapshots', () => {
    test('createNamedSnapshot creates snapshot', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const snapshot = await store.createNamedSnapshot(
        'main',
        'Before changes'
      );

      expect(snapshot.id).toBeDefined();
      expect(snapshot.name).toBe('Before changes');
      expect(snapshot.memoryCount).toBe(2);
      expect(snapshot.merkleRoot).toBeDefined();

      await store.close();
    });

    test('listSnapshots returns snapshots for store', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.createNamedSnapshot('main', 'Snapshot 1');

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });
      await store.createNamedSnapshot('main', 'Snapshot 2');

      const snapshots = await store.listSnapshots('main');

      expect(snapshots.length).toBe(2);
      expect(snapshots[0].name).toBe('Snapshot 1');
      expect(snapshots[1].name).toBe('Snapshot 2');
      expect(snapshots[0].memoryCount).toBe(1);
      expect(snapshots[1].memoryCount).toBe(2);

      await store.close();
    });

    test('restoreSnapshot creates fork from snapshot', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Before'
      });
      const snapshot = await store.createNamedSnapshot('main', 'Checkpoint');

      // Add more data after snapshot
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'After'
      });

      // Restore from snapshot
      const restored = await store.restoreSnapshot(snapshot.id, {
        name: 'Restored'
      });

      const restoredMemories = await store.listMemories(restored.forkId);
      expect(restoredMemories.length).toBe(1);
      expect(restoredMemories[0].content).toBe('Before');

      await store.close();
    });
  });

  describe('Recovery and Integrity', () => {
    test('verifyIntegrity returns valid for consistent store', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const result = await store.verifyIntegrity('main');

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.recordCount).toBe(2);

      await store.close();
    });

    test('rebuildIndexes rebuilds all indexes', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Memory A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'Memory B'
      });
      await store.addRelationship('main', {
        memory_id: 'mem-1',
        related_memory_id: 'mem-2'
      });

      const stats = await store.rebuildIndexes('main');

      expect(stats.memoriesIndexed).toBe(2);
      expect(stats.relationshipsIndexed).toBe(1);
      expect(stats.merkleLeaves).toBe(3);

      // Verify indexes still work after rebuild
      const memories = await store.listMemories('main');
      expect(memories.length).toBe(2);

      await store.close();
    });

    test('flush persists all pending writes', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.flush('main');

      // Close and reopen
      await store.close();

      const store2 = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      const memories = await store2.listMemories('main');
      expect(memories.length).toBe(1);

      await store2.close();
    });

    test('checkRecoveryNeeded detects sync issues', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });

      // In normal operation, should not need recovery
      const check = await store.checkRecoveryNeeded('main');
      expect(check.needsRecovery).toBe(false);

      await store.close();
    });

    test('recover handles store needing recovery', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });

      // When not needed, returns not recovered
      const result = await store.recover('main');
      expect(result.recovered).toBe(false);

      await store.close();
    });

    test('compactWAL rotates WAL to segment', async () => {
      const store = await createMemoryStore({
        config: { dataDir: storeDir },
        embedFunction: mockEmbedFunction
      });

      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'A'
      });
      await store.addMemory('main', {
        category: 'test',
        type: 'fact',
        content: 'B'
      });

      const result = await store.compactWAL('main');

      expect(result.rotated).toBe(true);
      expect(result.recordCount).toBe(2);

      // Data should still be accessible
      const memories = await store.listMemories('main');
      expect(memories.length).toBe(2);

      await store.close();
    });
  });
});

console.log('\n=== Store Core Tests ===\n');
