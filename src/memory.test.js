#!/usr/bin/env bun
/**
 * Test Suite for Memory MCP Server
 *
 * Comprehensive tests for all memory server functionality including:
 * - Memory CRUD operations
 * - Search (semantic and full-text)
 * - Relationships
 * - Cadence/due memories
 * - Archiving
 * - Merging
 *
 * Run with: bun run src/test.js
 *
 * @module test
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach
} from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';

// Set test database path
const TEST_DB_PATH = join(import.meta.dir, '..', 'data', 'test-memories.db');
process.env.DATA_DIR = join(import.meta.dir, '..', 'data');

// Clean up test database
function cleanupTestDb() {
  const testDbPath = TEST_DB_PATH;
  if (existsSync(testDbPath)) {
    unlinkSync(testDbPath);
  }
  if (existsSync(testDbPath + '-wal')) {
    unlinkSync(testDbPath + '-wal');
  }
  if (existsSync(testDbPath + '-shm')) {
    unlinkSync(testDbPath + '-shm');
  }
}

// Import modules after setting env
import { initDatabase, closeDatabase, query, execute } from './database.js';
import {
  addMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  archiveMemory,
  unarchiveMemory,
  getCategories,
  getTags,
  getTypes,
  getStats,
  listMemories
} from './memories.js';
import { searchMemories, findSimilarMemories } from './search.js';
import {
  addRelationship,
  removeRelationship,
  getRelationships,
  getRelatedMemories,
  mergeMemories,
  getMergeHistory,
  RELATIONSHIP_TYPES
} from './relationships.js';
import { isMemoryDue, getDueMemories, getNextReviewDate } from './cadence.js';
import {
  generateEmbedding,
  cosineSimilarity,
  preloadModel
} from './embeddings.js';

// ============================================================================
// Setup and Teardown
// ============================================================================

beforeAll(async () => {
  cleanupTestDb();
  initDatabase();
  console.log('Loading embedding model for tests...');
  await preloadModel();
  console.log('Embedding model loaded.');
});

afterAll(() => {
  closeDatabase();
  cleanupTestDb();
});

beforeEach(() => {
  // Clear all data between tests and reset autoincrement
  execute('DELETE FROM merge_history');
  execute('DELETE FROM relationships');
  execute('DELETE FROM memories');
  execute('DELETE FROM memories_fts');
  execute("DELETE FROM sqlite_sequence WHERE name='memories'");
  execute("DELETE FROM sqlite_sequence WHERE name='relationships'");
  execute("DELETE FROM sqlite_sequence WHERE name='merge_history'");
});

// ============================================================================
// Memory CRUD Tests
// ============================================================================

describe('Memory CRUD Operations', () => {
  test('addMemory creates a memory with all fields', async () => {
    const memory = await addMemory({
      category: 'people',
      type: 'person',
      content: 'Alice is a software engineer',
      tags: ['friend', 'engineer'],
      importance: 8,
      cadence_type: 'weekly',
      cadence_value: null,
      context: 'Met at conference'
    });

    expect(memory.id).toBe(1);
    expect(memory.category).toBe('people');
    expect(memory.type).toBe('person');
    expect(memory.content).toBe('Alice is a software engineer');
    expect(memory.tags).toEqual(['friend', 'engineer']);
    expect(memory.importance).toBe(8);
    expect(memory.cadence_type).toBe('weekly');
    expect(memory.context).toBe('Met at conference');
    expect(memory.archived).toBe(0);
  });

  test('addMemory applies default values', async () => {
    const memory = await addMemory({
      category: 'facts',
      type: 'fact',
      content: 'The sky is blue'
    });

    expect(memory.importance).toBe(5);
    expect(memory.cadence_type).toBe('monthly');
    expect(memory.tags).toEqual([]);
  });

  test('addMemory validates required fields', async () => {
    await expect(
      addMemory({ type: 'fact', content: 'test' })
    ).rejects.toThrow();
    await expect(
      addMemory({ category: 'test', content: 'test' })
    ).rejects.toThrow();
    await expect(
      addMemory({ category: 'test', type: 'fact' })
    ).rejects.toThrow();
  });

  test('addMemory normalizes importance to 1-10', async () => {
    const low = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Low importance',
      importance: -5
    });
    expect(low.importance).toBe(1);

    const high = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'High importance',
      importance: 100
    });
    expect(high.importance).toBe(10);
  });

  test('getMemory retrieves a memory and updates last_accessed', async () => {
    const created = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Test content'
    });

    expect(created.last_accessed).toBeNull();

    const retrieved = await getMemory(created.id);
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.last_accessed).not.toBeNull();
  });

  test('getMemory returns null for non-existent ID', async () => {
    const result = await getMemory(9999);
    expect(result).toBeNull();
  });

  test('updateMemory modifies fields', async () => {
    const created = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original content',
      importance: 5
    });

    const updated = await updateMemory(created.id, {
      content: 'Updated content',
      importance: 8,
      tags: ['updated']
    });

    expect(updated.content).toBe('Updated content');
    expect(updated.importance).toBe(8);
    expect(updated.tags).toEqual(['updated']);
  });

  test('updateMemory returns null for non-existent ID', async () => {
    const result = await updateMemory(9999, { content: 'test' });
    expect(result).toBeNull();
  });

  test('deleteMemory removes a memory', async () => {
    const created = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'To be deleted'
    });

    const deleted = deleteMemory(created.id);
    expect(deleted).toBe(true);

    const retrieved = await getMemory(created.id);
    expect(retrieved).toBeNull();
  });

  test('deleteMemory returns false for non-existent ID', () => {
    const result = deleteMemory(9999);
    expect(result).toBe(false);
  });

  test('archiveMemory soft-deletes a memory', async () => {
    const created = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'To be archived'
    });

    archiveMemory(created.id);

    // Should not appear in normal list
    const activeList = listMemories();
    expect(activeList.length).toBe(0);

    // Should appear with includeArchived
    const allList = listMemories({ includeArchived: true });
    expect(allList.length).toBe(1);
    expect(allList[0].archived).toBe(1);
  });

  test('unarchiveMemory restores an archived memory', async () => {
    const created = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'To be archived then restored'
    });

    archiveMemory(created.id);
    unarchiveMemory(created.id);

    const activeList = listMemories();
    expect(activeList.length).toBe(1);
    expect(activeList[0].archived).toBe(0);
  });
});

// ============================================================================
// List and Stats Tests
// ============================================================================

describe('List and Statistics', () => {
  test('listMemories returns paginated results', async () => {
    for (let i = 0; i < 5; i++) {
      await addMemory({
        category: 'test',
        type: 'fact',
        content: `Memory ${i}`
      });
    }

    const page1 = listMemories({ limit: 2, offset: 0 });
    expect(page1.length).toBe(2);

    const page2 = listMemories({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);

    const page3 = listMemories({ limit: 2, offset: 4 });
    expect(page3.length).toBe(1);
  });

  test('getCategories returns categories with counts', async () => {
    await addMemory({
      category: 'people',
      type: 'person',
      content: 'Person 1'
    });
    await addMemory({
      category: 'people',
      type: 'person',
      content: 'Person 2'
    });
    await addMemory({ category: 'facts', type: 'fact', content: 'Fact 1' });

    const categories = getCategories();
    expect(categories.length).toBe(2);

    const people = categories.find((c) => c.category === 'people');
    expect(people.count).toBe(2);
  });

  test('getTags returns tags with counts', async () => {
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Test 1',
      tags: ['a', 'b']
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Test 2',
      tags: ['b', 'c']
    });

    const tags = getTags();
    const tagB = tags.find((t) => t.tag === 'b');
    expect(tagB.count).toBe(2);
  });

  test('getStats returns correct statistics', async () => {
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Active 1',
      importance: 6
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Active 2',
      importance: 8
    });

    const toArchive = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Archived',
      importance: 4
    });
    archiveMemory(toArchive.id);

    const stats = getStats();
    expect(stats.total_memories).toBe(3);
    expect(stats.active_memories).toBe(2);
    expect(stats.archived_memories).toBe(1);
    expect(stats.average_importance).toBe(7); // (6+8)/2, archived not included
  });
});

// ============================================================================
// Search Tests
// ============================================================================

describe('Search Functionality', () => {
  test('searchMemories finds by semantic similarity', async () => {
    await addMemory({
      category: 'tech',
      type: 'fact',
      content: 'Python is a programming language used for data science'
    });
    await addMemory({
      category: 'tech',
      type: 'fact',
      content: 'JavaScript runs in web browsers'
    });
    await addMemory({
      category: 'food',
      type: 'fact',
      content: 'Pizza is a popular Italian dish'
    });

    const results = await searchMemories({
      query: 'machine learning and data analysis',
      searchMode: 'semantic'
    });

    // Python/data science should be most relevant
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('Python');
  });

  test('searchMemories filters by category', async () => {
    await addMemory({ category: 'work', type: 'fact', content: 'Work task 1' });
    await addMemory({
      category: 'personal',
      type: 'fact',
      content: 'Personal note 1'
    });

    const results = await searchMemories({ category: 'work' });
    expect(results.length).toBe(1);
    expect(results[0].category).toBe('work');
  });

  test('searchMemories filters by importance', async () => {
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Low',
      importance: 3
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Medium',
      importance: 5
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'High',
      importance: 8
    });

    const results = await searchMemories({ minImportance: 5 });
    expect(results.length).toBe(2);
  });

  test('searchMemories filters by tags', async () => {
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Tagged A',
      tags: ['a']
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Tagged B',
      tags: ['b']
    });
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Tagged AB',
      tags: ['a', 'b']
    });

    const results = await searchMemories({ tags: ['a'] });
    expect(results.length).toBe(2);
  });

  test('findSimilarMemories finds related content', async () => {
    const mem1 = await addMemory({
      category: 'tech',
      type: 'fact',
      content: 'React is a JavaScript library for building user interfaces'
    });
    await addMemory({
      category: 'tech',
      type: 'fact',
      content: 'Vue.js is another frontend JavaScript framework'
    });
    await addMemory({
      category: 'food',
      type: 'fact',
      content: 'Sushi is a Japanese dish with rice and fish'
    });

    const similar = await findSimilarMemories(mem1.id, { threshold: 0.5 });

    // Vue.js should be more similar to React than sushi
    expect(similar.length).toBeGreaterThan(0);
    if (similar.length > 0) {
      expect(similar[0].content).toContain('Vue');
    }
  });
});

// ============================================================================
// Relationship Tests
// ============================================================================

describe('Relationships', () => {
  test('addRelationship creates a relationship', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });

    const rel = addRelationship(mem1.id, mem2.id, 'related_to');
    expect(rel.memory_id).toBe(mem1.id);
    expect(rel.related_memory_id).toBe(mem2.id);
    expect(rel.relationship_type).toBe('related_to');
  });

  test('addRelationship validates relationship type', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });

    expect(() => addRelationship(mem1.id, mem2.id, 'invalid_type')).toThrow();
  });

  test('addRelationship prevents self-reference', async () => {
    const mem = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory'
    });
    expect(() => addRelationship(mem.id, mem.id, 'related_to')).toThrow();
  });

  test('addRelationship prevents duplicates', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });

    addRelationship(mem1.id, mem2.id, 'related_to');
    expect(() => addRelationship(mem1.id, mem2.id, 'related_to')).toThrow();
  });

  test('getRelationships returns outgoing and incoming', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });
    const mem3 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 3'
    });

    addRelationship(mem1.id, mem2.id, 'related_to');
    addRelationship(mem3.id, mem1.id, 'references');

    const rels = getRelationships(mem1.id);
    expect(rels.outgoing.length).toBe(1);
    expect(rels.incoming.length).toBe(1);
  });

  test('getRelatedMemories traverses relationship graph', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });
    const mem3 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 3'
    });

    addRelationship(mem1.id, mem2.id, 'related_to');
    addRelationship(mem2.id, mem3.id, 'related_to');

    const related = getRelatedMemories(mem1.id, { maxDepth: 2 });
    expect(related.length).toBe(2);

    const depths = related.map((r) => r.depth);
    expect(depths).toContain(1);
    expect(depths).toContain(2);
  });

  test('removeRelationship deletes a relationship', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Memory 2'
    });

    addRelationship(mem1.id, mem2.id, 'related_to');
    const removed = removeRelationship(mem1.id, mem2.id);
    expect(removed).toBe(true);

    const rels = getRelationships(mem1.id);
    expect(rels.outgoing.length).toBe(0);
  });
});

// ============================================================================
// Merge Tests
// ============================================================================

describe('Memory Merging', () => {
  test('mergeMemories creates new memory from two', async () => {
    const mem1 = await addMemory({
      category: 'people',
      type: 'person',
      content: 'John likes hiking',
      tags: ['friend'],
      importance: 6
    });
    const mem2 = await addMemory({
      category: 'people',
      type: 'person',
      content: 'John works at Acme',
      tags: ['work'],
      importance: 8
    });

    const merged = await mergeMemories(mem1.id, mem2.id, {
      mergedContent: 'John works at Acme and enjoys hiking'
    });

    expect(merged.content).toBe('John works at Acme and enjoys hiking');
    expect(merged.tags).toContain('friend');
    expect(merged.tags).toContain('work');
    expect(merged.importance).toBe(8); // Takes max
    expect(merged.merged_from).toEqual([mem1.id, mem2.id]);
  });

  test('mergeMemories archives original memories', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 2'
    });

    await mergeMemories(mem1.id, mem2.id, { mergedContent: 'Merged' });

    const active = listMemories();
    expect(active.length).toBe(1);
    expect(active[0].content).toBe('Merged');

    const all = listMemories({ includeArchived: true });
    expect(all.length).toBe(3);
  });

  test('mergeMemories creates supersedes relationships', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 2'
    });

    const merged = await mergeMemories(mem1.id, mem2.id, {
      mergedContent: 'Merged'
    });

    const rels = getRelationships(merged.id);
    expect(rels.outgoing.length).toBe(2);
    expect(
      rels.outgoing.every((r) => r.relationship_type === 'supersedes')
    ).toBe(true);
  });

  test('getMergeHistory returns original content', async () => {
    const mem1 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 1'
    });
    const mem2 = await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original 2'
    });

    const merged = await mergeMemories(mem1.id, mem2.id, {
      mergedContent: 'Merged'
    });

    const history = getMergeHistory(merged.id);
    expect(history.length).toBe(2);

    const contents = history.map((h) => h.original_content);
    expect(contents).toContain('Original 1');
    expect(contents).toContain('Original 2');
  });
});

// ============================================================================
// Cadence Tests
// ============================================================================

describe('Cadence System', () => {
  test('isMemoryDue returns true for never accessed memories', () => {
    const memory = {
      cadence_type: 'daily',
      cadence_value: null,
      last_accessed: null
    };
    expect(isMemoryDue(memory)).toBe(true);
  });

  test('isMemoryDue daily - due if accessed before today', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const memory = {
      cadence_type: 'daily',
      cadence_value: null,
      last_accessed: yesterday.toISOString()
    };
    expect(isMemoryDue(memory)).toBe(true);
  });

  test('isMemoryDue daily - not due if accessed today', () => {
    const memory = {
      cadence_type: 'daily',
      cadence_value: null,
      last_accessed: new Date().toISOString()
    };
    expect(isMemoryDue(memory)).toBe(false);
  });

  test('isMemoryDue weekly - due after 7 days', () => {
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

    const memory = {
      cadence_type: 'weekly',
      cadence_value: null,
      last_accessed: eightDaysAgo.toISOString()
    };
    expect(isMemoryDue(memory)).toBe(true);
  });

  test('isMemoryDue weekly - not due within 7 days', () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const memory = {
      cadence_type: 'weekly',
      cadence_value: null,
      last_accessed: threeDaysAgo.toISOString()
    };
    expect(isMemoryDue(memory)).toBe(false);
  });

  test('isMemoryDue day_of_week - due on correct day', () => {
    const now = new Date();
    const dayNames = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday'
    ];
    const todayName = dayNames[now.getDay()];

    // Last accessed yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const memory = {
      cadence_type: 'day_of_week',
      cadence_value: todayName,
      last_accessed: yesterday.toISOString()
    };
    expect(isMemoryDue(memory)).toBe(true);
  });

  test('getNextReviewDate calculates correctly for daily', () => {
    const now = new Date();
    const memory = {
      cadence_type: 'daily',
      cadence_value: null,
      last_accessed: now.toISOString()
    };

    const next = getNextReviewDate(memory);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    expect(next.getDate()).toBe(tomorrow.getDate());
  });

  test('getDueMemories includes never-accessed by default', async () => {
    await addMemory({
      category: 'test',
      type: 'fact',
      content: 'Never accessed'
    });

    // Access the memory to set last_accessed, then create another
    const list = listMemories(); // This triggers last_accessed update

    // Create fresh memory that won't be accessed
    execute(
      'INSERT INTO memories (category, type, content, tags, embedding) VALUES (?, ?, ?, ?, ?)',
      ['test', 'fact', 'Fresh memory', '[]', Buffer.alloc(384 * 4)]
    );

    const due = getDueMemories();
    const freshMemory = due.find((m) => m.content === 'Fresh memory');
    expect(freshMemory).toBeDefined();
    expect(freshMemory.due_reason).toBe('never_accessed');
  });
});

// ============================================================================
// Embedding Tests
// ============================================================================

describe('Embeddings', () => {
  test('generateEmbedding produces 384-dimensional vector', async () => {
    const embedding = await generateEmbedding('Hello world');
    expect(embedding.length).toBe(384);
    expect(embedding instanceof Float32Array).toBe(true);
  });

  test('generateEmbedding throws for empty input', async () => {
    await expect(generateEmbedding('')).rejects.toThrow();
    await expect(generateEmbedding(null)).rejects.toThrow();
  });

  test('cosineSimilarity returns 1 for identical vectors', () => {
    const vec = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
  });

  test('cosineSimilarity returns high value for similar text', async () => {
    const emb1 = await generateEmbedding('The cat sat on the mat');
    const emb2 = await generateEmbedding('A cat was sitting on a mat');
    const emb3 = await generateEmbedding(
      'Quantum physics explains subatomic particles'
    );

    const simSimilar = cosineSimilarity(emb1, emb2);
    const simDifferent = cosineSimilarity(emb1, emb3);

    expect(simSimilar).toBeGreaterThan(simDifferent);
    expect(simSimilar).toBeGreaterThan(0.7);
  });
});

// ============================================================================
// Run summary
// ============================================================================

console.log('\n=== Memory MCP Server Test Suite ===\n');
