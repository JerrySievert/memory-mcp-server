/**
 * Configuration Module
 *
 * Centralized configuration for the memory store with validation
 * and sensible defaults. All configurable options are defined here.
 *
 * @module store/config
 */

/**
 * Default configuration values
 */
const DEFAULTS = {
  // Storage paths
  dataDir: "./data",

  // Segment settings
  segmentSizeBytes: 16 * 1024 * 1024,  // 16MB - WAL rotation threshold

  // Index persistence
  persistEveryNWrites: 1,               // Persist indexes after N writes (0 = manual only)

  // Memory limits (for indexes)
  memoryBudgetBytes: 512 * 1024 * 1024, // 512MB default
  memoryBudgetMin: 128 * 1024 * 1024,   // 128MB minimum
  memoryBudgetMax: 4 * 1024 * 1024 * 1024, // 4GB maximum

  // Concurrency
  enableConcurrentAccess: true,

  // Vector index (HNSW) settings
  hnswM: 16,                            // Max connections per node
  hnswEfConstruction: 200,              // Size of dynamic candidate list during construction
  hnswEfSearch: 50,                     // Size of dynamic candidate list during search

  // Text index settings
  textIndexMinTokenLength: 2,           // Minimum token length to index
  textIndexStopWords: true,             // Filter common stop words

  // Merkle tree settings
  merkleHashAlgorithm: "sha256",        // Hash algorithm for merkle tree

  // WAL settings
  walSyncOnWrite: true,                 // Sync to disk on every write (durability vs performance)
  walMaxAge: 0,                         // Max age in ms before forcing rotation (0 = disabled)
};

/**
 * @typedef {Object} StoreConfig
 * @property {string} dataDir - Root directory for all store data
 * @property {number} segmentSizeBytes - WAL rotation threshold in bytes
 * @property {number} persistEveryNWrites - Persist indexes after N writes (0 = manual)
 * @property {number} memoryBudgetBytes - Memory budget for indexes in bytes
 * @property {number} memoryBudgetMin - Minimum allowed memory budget
 * @property {number} memoryBudgetMax - Maximum allowed memory budget
 * @property {boolean} enableConcurrentAccess - Enable multiple readers/writers
 * @property {number} hnswM - HNSW max connections per node
 * @property {number} hnswEfConstruction - HNSW construction parameter
 * @property {number} hnswEfSearch - HNSW search parameter
 * @property {number} textIndexMinTokenLength - Minimum token length for text index
 * @property {boolean} textIndexStopWords - Filter stop words in text index
 * @property {string} merkleHashAlgorithm - Hash algorithm for merkle tree
 * @property {boolean} walSyncOnWrite - Sync WAL to disk on every write
 * @property {number} walMaxAge - Max WAL age before rotation (0 = disabled)
 */

/**
 * Validate and normalize a configuration value
 *
 * @param {string} key - Configuration key
 * @param {any} value - Value to validate
 * @param {any} defaultValue - Default value if validation fails
 * @returns {any} Validated value
 * @throws {Error} If value is invalid and no default available
 */
function validateValue(key, value, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  switch (key) {
    case "dataDir":
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Config '${key}' must be a non-empty string`);
      }
      return value;

    case "segmentSizeBytes":
      const segSize = Number(value);
      if (isNaN(segSize) || segSize < 1024 * 1024) { // Min 1MB
        throw new Error(`Config '${key}' must be at least 1MB`);
      }
      return segSize;

    case "persistEveryNWrites":
      const persistN = Number(value);
      if (isNaN(persistN) || persistN < 0) {
        throw new Error(`Config '${key}' must be >= 0`);
      }
      return Math.floor(persistN);

    case "memoryBudgetBytes":
      const budget = Number(value);
      if (isNaN(budget)) {
        throw new Error(`Config '${key}' must be a number`);
      }
      // Clamp to min/max
      return Math.max(
        DEFAULTS.memoryBudgetMin,
        Math.min(DEFAULTS.memoryBudgetMax, budget)
      );

    case "memoryBudgetMin":
    case "memoryBudgetMax":
      // These are read-only, always use defaults
      return defaultValue;

    case "enableConcurrentAccess":
    case "textIndexStopWords":
    case "walSyncOnWrite":
      return Boolean(value);

    case "hnswM":
      const m = Number(value);
      if (isNaN(m) || m < 2 || m > 100) {
        throw new Error(`Config '${key}' must be between 2 and 100`);
      }
      return Math.floor(m);

    case "hnswEfConstruction":
    case "hnswEfSearch":
      const ef = Number(value);
      if (isNaN(ef) || ef < 10) {
        throw new Error(`Config '${key}' must be >= 10`);
      }
      return Math.floor(ef);

    case "textIndexMinTokenLength":
      const minLen = Number(value);
      if (isNaN(minLen) || minLen < 1) {
        throw new Error(`Config '${key}' must be >= 1`);
      }
      return Math.floor(minLen);

    case "merkleHashAlgorithm":
      const validAlgos = ["sha256", "sha384", "sha512"];
      if (!validAlgos.includes(value)) {
        throw new Error(`Config '${key}' must be one of: ${validAlgos.join(", ")}`);
      }
      return value;

    case "walMaxAge":
      const maxAge = Number(value);
      if (isNaN(maxAge) || maxAge < 0) {
        throw new Error(`Config '${key}' must be >= 0`);
      }
      return Math.floor(maxAge);

    default:
      return value !== undefined ? value : defaultValue;
  }
}

/**
 * Create a validated configuration object
 *
 * @param {Partial<StoreConfig>} [options={}] - Configuration overrides
 * @returns {StoreConfig} Validated configuration
 *
 * @example
 * const config = createConfig({
 *   dataDir: "/custom/path",
 *   memoryBudgetBytes: 1024 * 1024 * 1024, // 1GB
 * });
 */
export function createConfig(options = {}) {
  const config = {};

  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    config[key] = validateValue(key, options[key], defaultValue);
  }

  // Ensure memory budget is within bounds (after potential override)
  config.memoryBudgetBytes = Math.max(
    config.memoryBudgetMin,
    Math.min(config.memoryBudgetMax, config.memoryBudgetBytes)
  );

  // Freeze to prevent accidental mutation
  return Object.freeze(config);
}

/**
 * Get the default configuration
 *
 * @returns {StoreConfig} Default configuration
 */
export function getDefaultConfig() {
  return createConfig();
}

/**
 * Validate a full configuration object
 *
 * @param {StoreConfig} config - Configuration to validate
 * @returns {boolean} True if valid
 * @throws {Error} If configuration is invalid
 */
export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Configuration must be an object");
  }

  for (const key of Object.keys(DEFAULTS)) {
    validateValue(key, config[key], DEFAULTS[key]);
  }

  return true;
}

/**
 * Format bytes as human-readable string
 *
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "512 MB")
 */
export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/**
 * Log configuration summary
 *
 * @param {StoreConfig} config - Configuration to log
 */
export function logConfig(config) {
  console.log("Store Configuration:");
  console.log(`  Data directory: ${config.dataDir}`);
  console.log(`  Segment size: ${formatBytes(config.segmentSizeBytes)}`);
  console.log(`  Memory budget: ${formatBytes(config.memoryBudgetBytes)}`);
  console.log(`  Persist every: ${config.persistEveryNWrites} writes`);
  console.log(`  Concurrent access: ${config.enableConcurrentAccess}`);
  console.log(`  WAL sync on write: ${config.walSyncOnWrite}`);
  console.log(`  HNSW M: ${config.hnswM}, efConstruction: ${config.hnswEfConstruction}, efSearch: ${config.hnswEfSearch}`);
}

export default {
  createConfig,
  getDefaultConfig,
  validateConfig,
  formatBytes,
  logConfig,
  DEFAULTS,
};
