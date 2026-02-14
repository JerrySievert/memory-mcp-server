#!/usr/bin/env node
/**
 * Memory Store CLI
 *
 * Command-line interface for managing memory stores.
 *
 * Usage:
 *   node src/cli.js stores                          # List all stores as ASCII tree
 *   node src/cli.js stores --json                   # List as JSON
 *   node src/cli.js stats [store_id]                # Show store statistics
 *   node src/cli.js snapshots [store_id]            # List named snapshots
 *   node src/cli.js fork --from <id> --note "text"  # Create a fork
 *   node src/cli.js verify [store_id]               # Verify store integrity
 *
 * @module cli
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { generateEmbedding } from './embeddings.js';
import {
  setEmbedFunction,
  initStore,
  getStore,
  listForks,
  listSnapshots,
  getStats,
  verifyIntegrity,
  closeStore,
  createFork
} from './store-adapter.js';

const CONFIG_FILE = join(homedir(), '.mcp', 'memory.json');

/**
 * Read user configuration
 */
function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Format timestamp as readable date
 */
function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Format bytes as human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Initialize store without loading embedding model (for read-only operations)
 */
async function initStoreReadOnly() {
  // Set a dummy embed function since we're not adding memories
  setEmbedFunction(async () => new Float32Array(384));
  await initStore();
}

/**
 * Build a tree structure from stores
 */
function buildStoreTree(stores) {
  const tree = { id: 'main', children: [] };
  const nodeMap = new Map();
  nodeMap.set('main', tree);

  // Find the main store data
  const mainStore = stores.find((s) => s.id === 'main');
  if (mainStore) {
    Object.assign(tree, mainStore);
  }
  tree.children = [];

  // Add all forks to the map
  for (const store of stores) {
    if (store.id !== 'main') {
      nodeMap.set(store.id, { ...store, children: [] });
    }
  }

  // Build parent-child relationships
  for (const store of stores) {
    if (store.id !== 'main' && store.sourceStoreId) {
      const parent = nodeMap.get(store.sourceStoreId);
      const node = nodeMap.get(store.id);
      if (parent && node) {
        parent.children.push(node);
      }
    }
  }

  return tree;
}

/**
 * Render tree as ASCII
 */
function renderTree(
  node,
  prefix = '',
  isLast = true,
  isRoot = true,
  config = null
) {
  const lines = [];

  // Determine the connector
  const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
  const marker = config?.store_id === node.id ? ' *' : '';

  // Format the node line
  const name = node.name || node.id;
  const date = node.createdAt ? formatDate(node.createdAt) : '';

  let line = `${prefix}${connector}${name}${marker}`;
  if (date) {
    line += ` - ${date}`;
  }
  lines.push(line);

  // Add store ID on its own line
  if (!isRoot) {
    const idPrefix = prefix + (isLast ? '    ' : '│   ');
    lines.push(`${idPrefix}ID: ${node.id}`);
  }

  // Add note if present
  if (node.note) {
    const notePrefix = isRoot ? '  ' : prefix + (isLast ? '    ' : '│   ');
    lines.push(`${notePrefix}📝 ${node.note}`);
  }

  // Add PITR info if present
  if (node.pitrTimestamp) {
    const pitrPrefix = isRoot ? '  ' : prefix + (isLast ? '    ' : '│   ');
    lines.push(`${pitrPrefix}⏱️  PITR from: ${formatDate(node.pitrTimestamp)}`);
  }

  // Render children
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
  const children = node.children || [];
  for (let i = 0; i < children.length; i++) {
    const childLines = renderTree(
      children[i],
      childPrefix,
      i === children.length - 1,
      false,
      config
    );
    lines.push(...childLines);
  }

  return lines;
}

/**
 * List all stores
 */
async function listStores(options = {}) {
  await initStoreReadOnly();

  const store = await getStore();
  const forks = await listForks();
  const config = readConfig();

  // Get main store info
  const stores = [
    {
      id: 'main',
      name: 'Main Store',
      note: store.metadata?.note || null,
      sourceStoreId: null,
      createdAt: store.metadata?.created || null,
      isCurrentUser: config?.store_id === 'main'
    },
    ...forks.map((f) => ({
      id: f.id,
      name: f.name || 'Unnamed Fork',
      note: f.note || null,
      sourceStoreId: f.sourceStoreId || 'main',
      createdAt: f.createdAt,
      pitrTimestamp: f.pitrTimestamp,
      isCurrentUser: config?.store_id === f.id
    }))
  ];

  if (options.json) {
    console.log(JSON.stringify(stores, null, 2));
  } else {
    console.log('\nMemory Stores');
    console.log('=============\n');

    if (config) {
      console.log(
        `Current user: ${config.user_id} (store: ${config.store_id})\n`
      );
    }

    // Build and render tree
    const tree = buildStoreTree(stores);
    const treeLines = renderTree(tree, '', true, true, config);

    for (const line of treeLines) {
      console.log(line);
    }

    console.log('\n* = current user store');
    console.log(`\nTotal: ${stores.length} store(s)`);
  }

  await closeStore();
}

/**
 * Show store statistics
 */
async function showStats(storeId = 'main', options = {}) {
  await initStoreReadOnly();

  try {
    const stats = await getStats(storeId);

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(`\nStore Statistics: ${storeId}`);
      console.log('='.repeat(40) + '\n');

      console.log(`Memories:      ${stats.memoryCount || 0}`);
      console.log(`Relationships: ${stats.relationshipCount || 0}`);
      console.log(`Versions:      ${stats.totalVersions || 'N/A'}`);
      console.log(`WAL Records:   ${stats.walRecordCount || 0}`);
      console.log(`Segments:      ${stats.segmentCount || 0}`);

      if (stats.merkleRoot) {
        console.log(`\nMerkle Root:   ${stats.merkleRoot.slice(0, 16)}...`);
      }
    }
  } catch (error) {
    console.error(
      `Error getting stats for store "${storeId}": ${error.message}`
    );
  }

  await closeStore();
}

/**
 * List snapshots for a store
 */
async function showSnapshots(storeId = 'main', options = {}) {
  await initStoreReadOnly();

  try {
    const snapshots = await listSnapshots(storeId);

    if (options.json) {
      console.log(JSON.stringify(snapshots, null, 2));
    } else {
      console.log(`\nSnapshots for: ${storeId}`);
      console.log('='.repeat(40) + '\n');

      if (snapshots.length === 0) {
        console.log('No snapshots found.');
      } else {
        console.log(
          'Name                      | Created                  | Merkle Root'
        );
        console.log(
          '--------------------------|--------------------------|------------------'
        );

        for (const snap of snapshots) {
          const name = (snap.name || 'Unnamed').slice(0, 24).padEnd(24);
          const created = snap.createdAt ? formatDate(snap.createdAt) : 'N/A';
          const root = snap.merkleRoot
            ? snap.merkleRoot.slice(0, 16) + '...'
            : 'N/A';

          console.log(`${name} | ${created.padEnd(24)} | ${root}`);
        }

        console.log(`\nTotal: ${snapshots.length} snapshot(s)`);
      }
    }
  } catch (error) {
    console.error(
      `Error getting snapshots for store "${storeId}": ${error.message}`
    );
  }

  await closeStore();
}

/**
 * Verify store integrity
 */
async function verifyStore(storeId = 'main', options = {}) {
  await initStoreReadOnly();

  try {
    console.log(`\nVerifying store: ${storeId}`);
    console.log('='.repeat(40) + '\n');

    const result = await verifyIntegrity(storeId);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.valid) {
        console.log('Status: VALID ✓');
        console.log(`\nMerkle Root: ${result.merkleRoot || 'N/A'}`);
        console.log(`Records Verified: ${result.recordCount || 'N/A'}`);
      } else {
        console.log('Status: INVALID ✗');
        console.log(`\nErrors:`);
        for (const error of result.errors || []) {
          console.log(`  - ${error}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error verifying store "${storeId}": ${error.message}`);
  }

  await closeStore();
}

/**
 * Create a fork of a store
 */
async function forkStore(sourceStoreId, options = {}) {
  if (!sourceStoreId) {
    console.error('Error: --from <store_id> is required');
    console.error(
      'Usage: node src/cli.js fork --from <store_id> [--note "note text"]'
    );
    process.exit(1);
  }

  await initStoreReadOnly();

  try {
    const forkOptions = {};
    if (options.note) {
      forkOptions.note = options.note;
    }
    if (options.name) {
      forkOptions.name = options.name;
    }

    console.log(`\nCreating fork from: ${sourceStoreId}`);
    if (options.note) {
      console.log(`Note: ${options.note}`);
    }
    console.log('');

    const fork = await createFork(sourceStoreId, forkOptions);

    if (options.json) {
      console.log(JSON.stringify(fork, null, 2));
    } else {
      console.log('Fork created successfully!');
      console.log('='.repeat(40) + '\n');
      console.log(`  ID:           ${fork.id}`);
      console.log(`  Name:         ${fork.name || 'Unnamed'}`);
      if (fork.note) {
        console.log(`  Note:         ${fork.note}`);
      }
      console.log(`  Source:       ${fork.sourceStoreId}`);
      console.log(`  Created:      ${formatDate(fork.createdAt)}`);
      console.log(
        `  Merkle Root:  ${fork.merkleRoot ? fork.merkleRoot.slice(0, 16) + '...' : '(empty store)'}`
      );
      console.log(`  Records:      ${fork.recordCount}`);
      console.log('');
    }
  } catch (error) {
    console.error(`Error creating fork: ${error.message}`);
    process.exit(1);
  }

  await closeStore();
}

/**
 * Print help
 */
function printHelp() {
  console.log(`
Memory Store CLI

Usage:
  node src/cli.js <command> [options]

Commands:
  stores                    List all stores as an ASCII tree (main + forks)
  stats [store_id]          Show statistics for a store (default: main)
  snapshots [store_id]      List named snapshots for a store (default: main)
  fork --from <store_id>    Create a fork from an existing store
  verify [store_id]         Verify store integrity (default: main)
  help                      Show this help message

Fork Options:
  --from <store_id>         Source store to fork from (required)
  --note "text"             Add a note describing the fork's purpose
  --name "name"             Set a display name for the fork

General Options:
  --json                    Output as JSON

What are Snapshots?
  Snapshots are named restore points that capture the current state of a store
  (merkle root + timestamp). They can be used for:
    - Creating a backup before risky operations
    - Marking stable versions of the memory store
    - Point-in-time recovery (PITR) to restore to a previous state

  Use the API's createSnapshot() to create snapshots and restoreSnapshot() to
  restore a store to a previously saved snapshot state.

Examples:
  node src/cli.js stores
  node src/cli.js stores --json
  node src/cli.js stats
  node src/cli.js stats abc-123-def
  node src/cli.js fork --from main --note "Testing new feature"
  node src/cli.js fork --from abc123 --name "Dev Fork" --note "Development"
  node src/cli.js snapshots main
  node src/cli.js verify

Environment Variables:
  DATA_DIR                  Data directory (default: ./data)
`);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const options = {
    json: false,
    storeId: null,
    from: null,
    note: null,
    name: null
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') {
      options.json = true;
    } else if (args[i] === '--from' && args[i + 1]) {
      options.from = args[++i];
    } else if (args[i] === '--note' && args[i + 1]) {
      options.note = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      options.name = args[++i];
    } else if (!args[i].startsWith('-')) {
      options.storeId = args[i];
    }
  }

  return { command, options };
}

/**
 * Main entry point
 */
async function main() {
  const { command, options } = parseArgs();

  try {
    switch (command) {
      case 'stores':
      case 'list':
        await listStores(options);
        break;

      case 'stats':
        await showStats(options.storeId || 'main', options);
        break;

      case 'snapshots':
        await showSnapshots(options.storeId || 'main', options);
        break;

      case 'fork':
        await forkStore(options.from, options);
        break;

      case 'verify':
        await verifyStore(options.storeId || 'main', options);
        break;

      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "node src/cli.js help" for usage.');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
