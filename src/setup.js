#!/usr/bin/env bun
/**
 * Memory Store Setup Script
 *
 * Creates a user-specific store (fork) and writes configuration to ~/.mcp/memory.json
 *
 * Usage:
 *   bun run src/setup.js                    # Interactive setup
 *   bun run src/setup.js --user jerry       # Create store for user "jerry"
 *   bun run src/setup.js --user jerry --reset  # Reset existing store
 *   bun run src/setup.js --show             # Show current configuration
 *
 * @module setup
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

import { generateEmbedding, preloadModel } from './embeddings.js';
import {
  setEmbedFunction,
  initStore,
  createFork,
  listForks,
  getStore
} from './store-adapter.js';

const CONFIG_DIR = join(homedir(), '.mcp');
const CONFIG_FILE = join(CONFIG_DIR, 'memory.json');

/**
 * Default configuration template
 */
function getDefaultConfig(userId, storeId) {
  return {
    store_id: storeId,
    user_id: userId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trust_levels: {
      email: 'sandbox',
      calendar: 'sandbox',
      web_search: 'autonomous',
      notifications: 'autonomous'
    },
    daily_run_time: '06:00',
    briefing_delivery: 'memory',
    weekly_review_day: 'sunday',
    monthly_review_day: '1',
    created_at: new Date().toISOString()
  };
}

/**
 * Read existing configuration
 */
function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading config:', e.message);
    return null;
  }
}

/**
 * Write configuration to file
 */
function writeConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`Configuration written to ${CONFIG_FILE}`);
}

// Shared readline interface
let rl = null;

function getReadlineInterface() {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }
  return rl;
}

function closeReadlineInterface() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/**
 * Prompt for user input
 */
function promptUser(question) {
  return new Promise((resolve) => {
    const iface = getReadlineInterface();
    iface.question(question, (answer) => {
      resolve(answer ? answer.trim() : '');
    });
  });
}

/**
 * Show current configuration
 */
function showConfig() {
  const config = readConfig();
  if (!config) {
    console.log('No configuration found at', CONFIG_FILE);
    console.log('Run setup to create one: bun run src/setup.js');
    return;
  }

  console.log('\nCurrent Memory Configuration');
  console.log('============================');
  console.log(`Config file: ${CONFIG_FILE}`);
  console.log('');
  console.log(JSON.stringify(config, null, 2));
}

/**
 * Create a new user store
 */
async function createUserStore(userId, reset = false, note = null) {
  console.log('\nMemory Store Setup');
  console.log('==================\n');

  // Check existing config
  const existingConfig = readConfig();
  if (existingConfig && !reset) {
    console.log('Existing configuration found:');
    console.log(`  User: ${existingConfig.user_id}`);
    console.log(`  Store ID: ${existingConfig.store_id}`);
    console.log('');
    const overwrite = await promptUser('Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      return;
    }
  }

  // Initialize embedding model
  console.log('Loading embedding model...');
  setEmbedFunction(generateEmbedding);
  await preloadModel();

  // Initialize store
  console.log('Initializing memory store...');
  await initStore();

  // Check if user already has a fork
  const forks = await listForks();
  const existingFork = forks.find((f) => f.name === `User: ${userId}`);

  let storeId;
  if (existingFork && !reset) {
    console.log(`Found existing store for user "${userId}"`);
    storeId = existingFork.id;
  } else {
    // Create new fork for user
    console.log(`Creating new store for user "${userId}"...`);
    const fork = await createFork('main', {
      name: `User: ${userId}`,
      note: note
    });
    storeId = fork.id;
    console.log(`Created store: ${storeId}`);
  }

  // Create configuration
  const config = getDefaultConfig(userId, storeId);

  // Write configuration
  writeConfig(config);

  console.log('\nSetup complete!');
  console.log('');
  console.log('Your configuration:');
  console.log(`  User ID: ${config.user_id}`);
  console.log(`  Store ID: ${config.store_id}`);
  console.log(`  Timezone: ${config.timezone}`);
  console.log(`  Config file: ${CONFIG_FILE}`);
  console.log('');
  console.log('You can now start the memory server:');
  console.log('  bun run src/index.js --http');
  console.log('');

  // Close the store
  const store = await getStore();
  await store.close();
}

/**
 * Interactive setup
 */
async function interactiveSetup() {
  console.log('\nMemory Store Setup');
  console.log('==================\n');

  const userId = await promptUser('Enter your username: ');
  if (!userId) {
    console.log('Username is required.');
    closeReadlineInterface();
    process.exit(1);
  }

  const note = await promptUser('Enter a note (optional): ');

  await createUserStore(userId, false, note || null);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    user: null,
    note: null,
    reset: false,
    show: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user':
      case '-u':
        options.user = args[++i];
        break;
      case '--note':
      case '-n':
        options.note = args[++i];
        break;
      case '--reset':
      case '-r':
        options.reset = true;
        break;
      case '--show':
      case '-s':
        options.show = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

/**
 * Print help
 */
function printHelp() {
  console.log(`
Memory Store Setup

Creates a user-specific memory store and writes configuration to ~/.mcp/memory.json

Usage:
  bun run src/setup.js [options]

Options:
  --user, -u <name>   Username for the store
  --note, -n <text>   Note/description for the store
  --reset, -r         Reset existing store (create new)
  --show, -s          Show current configuration
  --help, -h          Show this help message

Examples:
  bun run src/setup.js                              # Interactive setup
  bun run src/setup.js --user jerry                 # Create store for "jerry"
  bun run src/setup.js --user jerry -n "Personal"   # With a note
  bun run src/setup.js --user jerry -r              # Reset jerry's store
  bun run src/setup.js --show                       # Show current config

Configuration File:
  Location: ~/.mcp/memory.json

  Structure:
  {
    "store_id": "<uuid>",           // Your unique store ID
    "user_id": "<username>",        // Your username
    "timezone": "America/New_York", // Auto-detected timezone
    "trust_levels": {               // For Daily Runner agent
      "email": "sandbox",
      "calendar": "sandbox",
      "web_search": "autonomous",
      "notifications": "autonomous"
    },
    "daily_run_time": "06:00",
    "briefing_delivery": "memory",
    "weekly_review_day": "sunday",
    "monthly_review_day": "1"
  }
`);
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.show) {
    showConfig();
    process.exit(0);
  }

  try {
    if (options.user) {
      await createUserStore(options.user, options.reset, options.note);
    } else {
      await interactiveSetup();
    }
  } catch (error) {
    console.error('Setup failed:', error.message);
    closeReadlineInterface();
    process.exit(1);
  }

  closeReadlineInterface();
  process.exit(0);
}

main();
