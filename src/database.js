/**
 * Database Module
 *
 * Handles SQLite database initialization, connection management, and schema setup.
 * Uses better-sqlite3 for high performance synchronous access.
 *
 * @module database
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';

/** @type {Database|null} */
let db = null;

/**
 * Get the database file path.
 * Uses DATA_DIR environment variable or defaults to ./data directory.
 *
 * @returns {string} Full path to the SQLite database file
 */
function getDatabasePath() {
  const dataDir =
    process.env.DATA_DIR || join(import.meta.dirname, '..', 'data');
  // Ensure data directory exists
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    // Directory already exists, ignore
  }
  return join(dataDir, 'memories.db');
}

/**
 * Initialize the SQLite database with required tables and indexes.
 * Creates the database file if it doesn't exist.
 * Sets up FTS5 virtual table for full-text search.
 *
 * @returns {Database} The initialized database connection
 * @throws {Error} If database initialization fails
 */
export function initDatabase() {
  if (db) {
    return db;
  }

  const dbPath = getDatabasePath();
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      importance INTEGER DEFAULT 5 CHECK (importance >= 1 AND importance <= 10),
      cadence_type TEXT DEFAULT 'monthly' CHECK (cadence_type IN ('daily', 'weekly', 'monthly', 'day_of_week', 'calendar_day')),
      cadence_value TEXT,
      context TEXT,
      embedding BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed DATETIME,
      archived INTEGER DEFAULT 0 CHECK (archived IN (0, 1))
    )
  `);

  // Create relationships table
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      related_memory_id INTEGER NOT NULL,
      relationship_type TEXT DEFAULT 'related_to',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (related_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      UNIQUE(memory_id, related_memory_id)
    )
  `);

  // Create merge history table for tracking merged memories
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resulting_memory_id INTEGER NOT NULL,
      source_memory_id INTEGER NOT NULL,
      original_content TEXT NOT NULL,
      merged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (resulting_memory_id) REFERENCES memories(id) ON DELETE CASCADE
    )
  `);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      type,
      tags,
      context,
      content='memories',
      content_rowid='id'
    )
  `);

  // Create triggers to keep FTS index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, type, tags, context)
      VALUES (new.id, new.content, new.category, new.type, new.tags, new.context);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, type, tags, context)
      VALUES ('delete', old.id, old.content, old.category, old.type, old.tags, old.context);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, type, tags, context)
      VALUES ('delete', old.id, old.content, old.category, old.type, old.tags, old.context);
      INSERT INTO memories_fts(rowid, content, category, type, tags, context)
      VALUES (new.id, new.content, new.category, new.type, new.tags, new.context);
    END
  `);

  // Create indexes for common queries
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_cadence ON memories(cadence_type, cadence_value)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_relationships_memory ON relationships(memory_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_relationships_related ON relationships(related_memory_id)'
  );

  return db;
}

/**
 * Get the current database connection.
 * Initializes the database if not already connected.
 *
 * @returns {Database} The database connection
 */
export function getDatabase() {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close the database connection.
 * Should be called when shutting down the server.
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run a database query and return all results.
 *
 * @param {string} sql - The SQL query to execute
 * @param {any[]} [params=[]] - Parameters for the prepared statement
 * @returns {any[]} Array of result rows
 */
export function query(sql, params = []) {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  return stmt.all(...params);
}

/**
 * Run a database query and return the first result.
 *
 * @param {string} sql - The SQL query to execute
 * @param {any[]} [params=[]] - Parameters for the prepared statement
 * @returns {any|null} The first result row or null
 */
export function queryOne(sql, params = []) {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  return stmt.get(...params);
}

/**
 * Execute a database statement (INSERT, UPDATE, DELETE).
 *
 * @param {string} sql - The SQL statement to execute
 * @param {any[]} [params=[]] - Parameters for the prepared statement
 * @returns {{changes: number, lastInsertRowid: number}} Execution result
 */
export function execute(sql, params = []) {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  return stmt.run(...params);
}

/**
 * Execute multiple statements in a transaction.
 * Rolls back on any error.
 *
 * @param {Function} fn - Function containing database operations
 * @returns {any} Result of the transaction function
 */
export function transaction(fn) {
  const database = getDatabase();
  return database.transaction(fn)();
}

export default {
  initDatabase,
  getDatabase,
  closeDatabase,
  query,
  queryOne,
  execute,
  transaction
};
