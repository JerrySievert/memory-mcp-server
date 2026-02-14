/**
 * Integration Tests
 *
 * Tests the integration between the new store and MCP/HTTP servers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up test environment
let testDir;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'memory-integration-'));
  process.env.DATA_DIR = testDir;
});

afterAll(async () => {
  // Clean up
  const adapter = await import('./store-adapter.js');
  await adapter.closeStore();

  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

describe('Store Adapter Integration', () => {
  test('initializes store', async () => {
    const adapter = await import('./store-adapter.js');

    // Set a mock embed function
    adapter.setEmbedFunction(async (text) => {
      const arr = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        arr[i] = Math.sin(i + text.length);
      }
      return arr;
    });

    const store = await adapter.initStore();
    expect(store).toBeDefined();
  });

  test('adds and retrieves memory', async () => {
    const adapter = await import('./store-adapter.js');

    const memory = await adapter.addMemory({
      category: 'test',
      type: 'fact',
      content: 'Integration test memory',
      tags: ['test', 'integration'],
      importance: 7
    });

    expect(memory).toBeDefined();
    expect(memory.id).toBeDefined();
    expect(memory.category).toBe('test');
    expect(memory.type).toBe('fact');
    expect(memory.content).toBe('Integration test memory');
    expect(memory.tags.sort()).toEqual(['integration', 'test']);
    expect(memory.importance).toBe(7);
    expect(memory.version).toBe(1);

    // Retrieve by ID
    const retrieved = await adapter.getMemory(memory.id);
    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe(memory.id);
    expect(retrieved.content).toBe('Integration test memory');
  });

  test('updates memory', async () => {
    const adapter = await import('./store-adapter.js');

    const memory = await adapter.addMemory({
      category: 'test',
      type: 'fact',
      content: 'Original content'
    });

    const updated = await adapter.updateMemory(memory.id, {
      content: 'Updated content',
      importance: 9
    });

    expect(updated.content).toBe('Updated content');
    expect(updated.importance).toBe(9);
    expect(updated.version).toBe(2);
  });

  test('deletes memory', async () => {
    const adapter = await import('./store-adapter.js');

    const memory = await adapter.addMemory({
      category: 'test',
      type: 'fact',
      content: 'To be deleted'
    });

    const deleted = await adapter.deleteMemory(memory.id);
    expect(deleted).toBe(true);

    // Should not find in normal query
    const retrieved = await adapter.getMemory(memory.id);
    expect(retrieved).toBeNull();
  });

  test('lists memories', async () => {
    const adapter = await import('./store-adapter.js');

    // Add some memories
    await adapter.addMemory({
      category: 'list-test',
      type: 'a',
      content: 'Memory 1'
    });
    await adapter.addMemory({
      category: 'list-test',
      type: 'b',
      content: 'Memory 2'
    });
    await adapter.addMemory({
      category: 'list-test',
      type: 'a',
      content: 'Memory 3'
    });

    // List all
    const all = await adapter.listMemories({ category: 'list-test' });
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Filter by type
    const typeA = await adapter.listMemories({
      category: 'list-test',
      type: 'a'
    });
    expect(typeA.length).toBeGreaterThanOrEqual(2);
  });

  test('searches memories', async () => {
    const adapter = await import('./store-adapter.js');

    await adapter.addMemory({
      category: 'search-test',
      type: 'fact',
      content: 'The quick brown fox jumps over the lazy dog'
    });

    await adapter.addMemory({
      category: 'search-test',
      type: 'fact',
      content: 'A fast red fox leaps across the sleepy hound'
    });

    // Text search
    const results = await adapter.searchMemories('fox jumps', { mode: 'text' });
    expect(results.length).toBeGreaterThan(0);
  });

  test('adds and retrieves relationships', async () => {
    const adapter = await import('./store-adapter.js');

    const mem1 = await adapter.addMemory({
      category: 'rel-test',
      type: 'fact',
      content: 'First memory'
    });

    const mem2 = await adapter.addMemory({
      category: 'rel-test',
      type: 'fact',
      content: 'Second memory'
    });

    const rel = await adapter.addRelationship(mem1.id, mem2.id, 'related_to');

    expect(rel).toBeDefined();
    expect(rel.memoryId).toBe(mem1.id);
    expect(rel.relatedMemoryId).toBe(mem2.id);
    expect(rel.relationshipType).toBe('related_to');

    // Get relationships
    const rels = await adapter.getRelationships(mem1.id);
    expect(rels.length).toBeGreaterThan(0);
  });

  test('creates fork', async () => {
    const adapter = await import('./store-adapter.js');

    // Add some data to main
    await adapter.addMemory({
      category: 'fork-test',
      type: 'fact',
      content: 'Main store memory'
    });

    // Create fork
    const fork = await adapter.createFork('main', { name: 'test-fork' });
    expect(fork).toBeDefined();
    expect(fork.id).toBeDefined();

    // List forks (only includes non-main forks)
    const forks = await adapter.listForks();
    expect(forks.length).toBeGreaterThanOrEqual(1); // test-fork

    // Add memory to fork
    const forkMemory = await adapter.addMemory(
      {
        category: 'fork-test',
        type: 'fact',
        content: 'Fork-only memory'
      },
      fork.id
    );

    expect(forkMemory).toBeDefined();

    // Delete fork
    await adapter.deleteFork(fork.id);

    const forksAfter = await adapter.listForks();
    expect(forksAfter.find((f) => f.id === fork.id)).toBeUndefined();
  });

  test('creates and lists snapshots', async () => {
    const adapter = await import('./store-adapter.js');

    // Create snapshot
    const snapshot = await adapter.createSnapshot('test-snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot.name).toBe('test-snapshot');

    // List snapshots
    const snapshots = await adapter.listSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.find((s) => s.name === 'test-snapshot')).toBeDefined();
  });

  test('gets store stats', async () => {
    const adapter = await import('./store-adapter.js');

    const stats = await adapter.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.memoryCount).toBe('number');
  });

  test('gets store snapshot (merkle root)', async () => {
    const adapter = await import('./store-adapter.js');

    const snapshot = await adapter.getStoreSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.merkleRoot).toBeDefined();
  });

  test('verifies integrity', async () => {
    const adapter = await import('./store-adapter.js');

    const result = await adapter.verifyIntegrity();
    expect(result).toBeDefined();
    expect(result.valid).toBe(true);
  });
});

describe('MCP Server', () => {
  test('creates MCP server', async () => {
    const mcpModule = await import('./mcp-server.js');
    const { createMCPServer } = mcpModule;
    const TOOLS = mcpModule.TOOLS || mcpModule.default?.TOOLS;

    const server = createMCPServer();
    expect(server).toBeDefined();

    // Check tools are defined
    expect(TOOLS).toBeDefined();
    expect(TOOLS.length).toBeGreaterThan(0);

    // Check for key tools
    const toolNames = TOOLS.map((t) => t.name);
    expect(toolNames).toContain('add_memory');
    expect(toolNames).toContain('search_memories');
    expect(toolNames).toContain('create_fork');
    expect(toolNames).toContain('create_snapshot');
  });
});

describe('HTTP Server', () => {
  test('has API documentation', async () => {
    const { API_DOCS } = await import('./http-server.js');

    expect(API_DOCS).toBeDefined();
    expect(API_DOCS.name).toBe('Memory Server HTTP API');
    expect(API_DOCS.version).toBe('2.0.0');
    expect(API_DOCS.endpoints.length).toBeGreaterThan(0);

    // Check for key endpoints
    const endpoints = API_DOCS.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(endpoints).toContain('POST /memories');
    expect(endpoints).toContain('POST /memories/search');
    expect(endpoints).toContain('POST /forks');
    expect(endpoints).toContain('POST /snapshots');
  });
});

// =============================================================================
// End-to-End Fork Isolation Tests
// =============================================================================

describe('Fork Isolation - End to End', () => {
  test('fork inherits memories from parent at fork time', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memories in main store
    const mem1 = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Memory created before fork'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', { name: 'inheritance-test' });

    // The fork should have access to the memory created before forking
    const memInFork = await adapter.getMemory(mem1.id, fork.id);
    expect(memInFork).toBeDefined();
    expect(memInFork.content).toBe('Memory created before fork');

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('new memories in fork do not appear in main', async () => {
    const adapter = await import('./store-adapter.js');

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-new-mem'
    });

    // Add memory only in fork
    const forkOnlyMem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'This memory only exists in the fork'
      },
      fork.id
    );

    // Verify it exists in fork
    const inFork = await adapter.getMemory(forkOnlyMem.id, fork.id);
    expect(inFork).toBeDefined();
    expect(inFork.content).toBe('This memory only exists in the fork');

    // Verify it does NOT exist in main
    const inMain = await adapter.getMemory(forkOnlyMem.id, 'main');
    expect(inMain).toBeNull();

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('new memories in main do not appear in existing fork', async () => {
    const adapter = await import('./store-adapter.js');

    // Create a fork first
    const fork = await adapter.createFork('main', {
      name: 'isolation-main-mem'
    });

    // Add memory to main AFTER fork was created
    const mainOnlyMem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'This memory was added after the fork'
      },
      'main'
    );

    // Verify it exists in main
    const inMain = await adapter.getMemory(mainOnlyMem.id, 'main');
    expect(inMain).toBeDefined();
    expect(inMain.content).toBe('This memory was added after the fork');

    // Verify it does NOT exist in fork
    const inFork = await adapter.getMemory(mainOnlyMem.id, fork.id);
    expect(inFork).toBeNull();

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('updates in fork do not affect main', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memory in main
    const mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Original content in main',
        importance: 5
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-update-fork'
    });

    // Update the memory in the fork
    const updatedInFork = await adapter.updateMemory(
      mem.id,
      {
        content: 'Updated content in fork',
        importance: 10
      },
      fork.id
    );

    expect(updatedInFork.content).toBe('Updated content in fork');
    expect(updatedInFork.importance).toBe(10);
    expect(updatedInFork.version).toBe(2);

    // Verify main still has original content
    const inMain = await adapter.getMemory(mem.id, 'main');
    expect(inMain.content).toBe('Original content in main');
    expect(inMain.importance).toBe(5);
    expect(inMain.version).toBe(1);

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('updates in main do not affect existing fork', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memory in main
    const mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Content at fork time',
        importance: 5
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-update-main'
    });

    // Update the memory in main
    const updatedInMain = await adapter.updateMemory(
      mem.id,
      {
        content: 'Updated content in main after fork',
        importance: 8
      },
      'main'
    );

    expect(updatedInMain.content).toBe('Updated content in main after fork');
    expect(updatedInMain.importance).toBe(8);
    expect(updatedInMain.version).toBe(2);

    // Verify fork still has original content from fork time
    const inFork = await adapter.getMemory(mem.id, fork.id);
    expect(inFork.content).toBe('Content at fork time');
    expect(inFork.importance).toBe(5);
    expect(inFork.version).toBe(1);

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('deletes in fork do not affect main', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memory in main
    const mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Memory to be deleted in fork only'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-delete-fork'
    });

    // Delete in fork
    await adapter.deleteMemory(mem.id, fork.id);

    // Verify deleted in fork
    const inFork = await adapter.getMemory(mem.id, fork.id);
    expect(inFork).toBeNull();

    // Verify still exists in main
    const inMain = await adapter.getMemory(mem.id, 'main');
    expect(inMain).toBeDefined();
    expect(inMain.content).toBe('Memory to be deleted in fork only');

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('deletes in main do not affect existing fork', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memory in main
    const mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Memory to be deleted in main only'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-delete-main'
    });

    // Delete in main
    await adapter.deleteMemory(mem.id, 'main');

    // Verify deleted in main
    const inMain = await adapter.getMemory(mem.id, 'main');
    expect(inMain).toBeNull();

    // Verify still exists in fork
    const inFork = await adapter.getMemory(mem.id, fork.id);
    expect(inFork).toBeDefined();
    expect(inFork.content).toBe('Memory to be deleted in main only');

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('relationships in fork do not affect main', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memories in main
    const mem1 = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'First memory for relationship test'
      },
      'main'
    );

    const mem2 = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Second memory for relationship test'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'isolation-rel-fork'
    });

    // Add relationship only in fork
    const rel = await adapter.addRelationship(
      mem1.id,
      mem2.id,
      'related_to',
      fork.id
    );
    expect(rel).toBeDefined();

    // Verify relationship exists in fork
    const relsInFork = await adapter.getRelationships(mem1.id, {}, fork.id);
    expect(relsInFork.length).toBeGreaterThan(0);
    expect(relsInFork.some((r) => r.relatedMemoryId === mem2.id)).toBe(true);

    // Verify relationship does NOT exist in main
    const relsInMain = await adapter.getRelationships(mem1.id, {}, 'main');
    const hasRelInMain = relsInMain.some((r) => r.relatedMemoryId === mem2.id);
    expect(hasRelInMain).toBe(false);

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('multiple forks are completely isolated from each other', async () => {
    const adapter = await import('./store-adapter.js');

    // Create a base memory in main
    const baseMem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Base memory'
      },
      'main'
    );

    // Create two forks
    const fork1 = await adapter.createFork('main', { name: 'multi-fork-1' });
    const fork2 = await adapter.createFork('main', { name: 'multi-fork-2' });

    // Add unique memory to fork1
    const fork1Mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Only in fork 1'
      },
      fork1.id
    );

    // Add unique memory to fork2
    const fork2Mem = await adapter.addMemory(
      {
        category: 'isolation-test',
        type: 'fact',
        content: 'Only in fork 2'
      },
      fork2.id
    );

    // Update base memory differently in each fork
    await adapter.updateMemory(
      baseMem.id,
      {
        content: 'Updated in fork 1'
      },
      fork1.id
    );

    await adapter.updateMemory(
      baseMem.id,
      {
        content: 'Updated in fork 2'
      },
      fork2.id
    );

    // Verify fork1's unique memory not in fork2
    const fork1MemInFork2 = await adapter.getMemory(fork1Mem.id, fork2.id);
    expect(fork1MemInFork2).toBeNull();

    // Verify fork2's unique memory not in fork1
    const fork2MemInFork1 = await adapter.getMemory(fork2Mem.id, fork1.id);
    expect(fork2MemInFork1).toBeNull();

    // Verify each fork has its own version of base memory
    const baseInFork1 = await adapter.getMemory(baseMem.id, fork1.id);
    expect(baseInFork1.content).toBe('Updated in fork 1');

    const baseInFork2 = await adapter.getMemory(baseMem.id, fork2.id);
    expect(baseInFork2.content).toBe('Updated in fork 2');

    // Verify main still has original
    const baseInMain = await adapter.getMemory(baseMem.id, 'main');
    expect(baseInMain.content).toBe('Base memory');

    // Clean up
    await adapter.deleteFork(fork1.id);
    await adapter.deleteFork(fork2.id);
  });

  test('search results are isolated per store', async () => {
    const adapter = await import('./store-adapter.js');

    // Create a unique searchable memory in main
    const mainMem = await adapter.addMemory(
      {
        category: 'search-isolation',
        type: 'fact',
        content: 'Elephant migration patterns in Africa'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'search-isolation-fork'
    });

    // Add different searchable memory only in fork
    const forkMem = await adapter.addMemory(
      {
        category: 'search-isolation',
        type: 'fact',
        content: 'Penguin colonies in Antarctica'
      },
      fork.id
    );

    // Search in main - should find elephant, not penguin
    const mainResults = await adapter.searchMemories(
      'elephant migration',
      { mode: 'text' },
      'main'
    );
    const mainHasElephant = mainResults.some((r) =>
      r.content.includes('Elephant')
    );
    const mainHasPenguin = mainResults.some((r) =>
      r.content.includes('Penguin')
    );
    expect(mainHasElephant).toBe(true);
    expect(mainHasPenguin).toBe(false);

    // Search in fork - should find both (inherited elephant + new penguin)
    const forkElephantResults = await adapter.searchMemories(
      'elephant migration',
      { mode: 'text' },
      fork.id
    );
    const forkHasElephant = forkElephantResults.some((r) =>
      r.content.includes('Elephant')
    );
    expect(forkHasElephant).toBe(true);

    const forkPenguinResults = await adapter.searchMemories(
      'penguin colonies',
      { mode: 'text' },
      fork.id
    );
    const forkHasPenguin = forkPenguinResults.some((r) =>
      r.content.includes('Penguin')
    );
    expect(forkHasPenguin).toBe(true);

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('list memories returns only memories for specified store', async () => {
    const adapter = await import('./store-adapter.js');

    // Create a unique category for this test
    const category = `list-isolation-${Date.now()}`;

    // Create memories in main
    await adapter.addMemory(
      {
        category,
        type: 'fact',
        content: 'Main memory 1'
      },
      'main'
    );
    await adapter.addMemory(
      {
        category,
        type: 'fact',
        content: 'Main memory 2'
      },
      'main'
    );

    // Create a fork
    const fork = await adapter.createFork('main', {
      name: 'list-isolation-fork'
    });

    // Add memories only in fork
    await adapter.addMemory(
      {
        category,
        type: 'fact',
        content: 'Fork memory 1'
      },
      fork.id
    );
    await adapter.addMemory(
      {
        category,
        type: 'fact',
        content: 'Fork memory 2'
      },
      fork.id
    );

    // List in main - should have 2 memories
    const mainList = await adapter.listMemories({ category }, 'main');
    expect(mainList.length).toBe(2);
    expect(mainList.every((m) => m.content.startsWith('Main memory'))).toBe(
      true
    );

    // List in fork - should have 4 memories (2 inherited + 2 new)
    const forkList = await adapter.listMemories({ category }, fork.id);
    expect(forkList.length).toBe(4);

    // Clean up
    await adapter.deleteFork(fork.id);
  });

  test('version history is maintained separately per store', async () => {
    const adapter = await import('./store-adapter.js');

    // Create memory in main
    const mem = await adapter.addMemory(
      {
        category: 'version-test',
        type: 'fact',
        content: 'Version 1'
      },
      'main'
    );
    expect(mem.version).toBe(1);

    // Update in main
    const v2 = await adapter.updateMemory(
      mem.id,
      { content: 'Version 2 in main' },
      'main'
    );
    expect(v2.version).toBe(2);

    // Create fork (inherits version 2)
    const fork = await adapter.createFork('main', {
      name: 'version-history-fork'
    });

    // Update in main again
    const v3Main = await adapter.updateMemory(
      mem.id,
      { content: 'Version 3 in main' },
      'main'
    );
    expect(v3Main.version).toBe(3);

    // Update in fork (should be version 3 in fork, independent of main)
    const v3Fork = await adapter.updateMemory(
      mem.id,
      { content: 'Version 3 in fork' },
      fork.id
    );
    expect(v3Fork.version).toBe(3);

    // Verify versions are independent
    const mainLatest = await adapter.getMemory(mem.id, 'main');
    expect(mainLatest.content).toBe('Version 3 in main');
    expect(mainLatest.version).toBe(3);

    const forkLatest = await adapter.getMemory(mem.id, fork.id);
    expect(forkLatest.content).toBe('Version 3 in fork');
    expect(forkLatest.version).toBe(3);

    // Clean up
    await adapter.deleteFork(fork.id);
  });
});

// =============================================================================
// Server Options Tests (--store-id, --basic)
// =============================================================================

describe('Server Options - Basic Mode', () => {
  let mcp_module;

  beforeAll(async () => {
    mcp_module = (await import('./mcp-server.js')).default;
  });

  test('default mode returns all tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: false });
    const tools = mcp_module.build_tool_list();
    expect(tools.length).toBe(mcp_module.TOOLS.length);
  });

  test('basic mode returns only core tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();

    expect(tools.length).toBe(11);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_memory',
      'add_relationship',
      'delete_memory',
      'get_due_memories',
      'get_memory',
      'get_related_memories',
      'get_relationships',
      'list_memories',
      'remove_relationship',
      'search_memories',
      'update_memory'
    ]);

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode excludes fork tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('create_fork');
    expect(names).not.toContain('create_fork_at_time');
    expect(names).not.toContain('list_forks');
    expect(names).not.toContain('delete_fork');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode excludes snapshot tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('create_snapshot');
    expect(names).not.toContain('list_snapshots');
    expect(names).not.toContain('restore_snapshot');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode excludes store management tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('get_store_snapshot');
    expect(names).not.toContain('verify_integrity');
    expect(names).not.toContain('rebuild_indexes');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode includes relationship tools', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).toContain('add_relationship');
    expect(names).toContain('remove_relationship');
    expect(names).toContain('get_relationships');
    expect(names).toContain('get_related_memories');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode includes get_due_memories', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_due_memories');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('basic mode excludes stats tool', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const tools = mcp_module.build_tool_list();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('get_stats');

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });
});

describe('Server Options - Store ID Lock', () => {
  let mcp_module;

  beforeAll(async () => {
    mcp_module = (await import('./mcp-server.js')).default;
  });

  test('store_id lock removes store_id from all tool schemas', () => {
    mcp_module.set_server_options({ store_id: 'locked-store', basic: false });
    const tools = mcp_module.build_tool_list();

    for (const tool of tools) {
      const props = tool.inputSchema?.properties || {};
      expect(props.store_id).toBeUndefined();
    }

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('store_id lock removes source_store_id from fork tool schemas', () => {
    mcp_module.set_server_options({ store_id: 'locked-store', basic: false });
    const tools = mcp_module.build_tool_list();

    const create_fork = tools.find((t) => t.name === 'create_fork');
    const create_fork_at_time = tools.find(
      (t) => t.name === 'create_fork_at_time'
    );

    expect(create_fork.inputSchema.properties.source_store_id).toBeUndefined();
    expect(
      create_fork_at_time.inputSchema.properties.source_store_id
    ).toBeUndefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('store_id lock does not mutate original TOOLS array', () => {
    // Verify originals have store_id
    const original_add = mcp_module.TOOLS.find((t) => t.name === 'add_memory');
    expect(original_add.inputSchema.properties.store_id).toBeDefined();

    const original_fork = mcp_module.TOOLS.find(
      (t) => t.name === 'create_fork'
    );
    expect(original_fork.inputSchema.properties.source_store_id).toBeDefined();

    // Apply lock
    mcp_module.set_server_options({ store_id: 'locked-store', basic: false });
    mcp_module.build_tool_list();

    // Verify originals are still intact
    expect(original_add.inputSchema.properties.store_id).toBeDefined();
    expect(original_fork.inputSchema.properties.source_store_id).toBeDefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('without store_id lock, store_id properties are preserved', () => {
    mcp_module.set_server_options({ store_id: null, basic: false });
    const tools = mcp_module.build_tool_list();

    const add_memory = tools.find((t) => t.name === 'add_memory');
    expect(add_memory.inputSchema.properties.store_id).toBeDefined();
    expect(add_memory.inputSchema.properties.store_id.type).toBe('string');

    const create_fork = tools.find((t) => t.name === 'create_fork');
    expect(create_fork.inputSchema.properties.source_store_id).toBeDefined();
  });

  test('store_id lock preserves other tool properties', () => {
    mcp_module.set_server_options({ store_id: 'locked-store', basic: false });
    const tools = mcp_module.build_tool_list();

    const add_memory = tools.find((t) => t.name === 'add_memory');
    // Should still have all other properties
    expect(add_memory.inputSchema.properties.category).toBeDefined();
    expect(add_memory.inputSchema.properties.type).toBeDefined();
    expect(add_memory.inputSchema.properties.content).toBeDefined();
    expect(add_memory.inputSchema.properties.tags).toBeDefined();
    expect(add_memory.inputSchema.properties.importance).toBeDefined();
    // But not store_id
    expect(add_memory.inputSchema.properties.store_id).toBeUndefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });
});

describe('Server Options - Combined Modes', () => {
  let mcp_module;

  beforeAll(async () => {
    mcp_module = (await import('./mcp-server.js')).default;
  });

  test('basic + store_id lock returns 11 tools without store_id', () => {
    mcp_module.set_server_options({ store_id: 'my-fork', basic: true });
    const tools = mcp_module.build_tool_list();

    // Should have exactly 11 tools
    expect(tools.length).toBe(11);

    // None should have store_id
    for (const tool of tools) {
      const props = tool.inputSchema?.properties || {};
      expect(props.store_id).toBeUndefined();
      expect(props.source_store_id).toBeUndefined();
    }

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('createMCPServer works with basic mode', () => {
    mcp_module.set_server_options({ store_id: null, basic: true });
    const server = mcp_module.createMCPServer();
    expect(server).toBeDefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('createMCPServer works with store_id lock', () => {
    mcp_module.set_server_options({
      store_id: 'test-locked',
      basic: false
    });
    const server = mcp_module.createMCPServer();
    expect(server).toBeDefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });

  test('createMCPServer works with both options combined', () => {
    mcp_module.set_server_options({ store_id: 'test-locked', basic: true });
    const server = mcp_module.createMCPServer();
    expect(server).toBeDefined();

    // Reset
    mcp_module.set_server_options({ store_id: null, basic: false });
  });
});
