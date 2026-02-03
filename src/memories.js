/**
 * Memories Module
 *
 * Provides CRUD operations for memories including creation, retrieval,
 * updating, deletion, and archiving. Handles automatic embedding generation
 * and last_accessed tracking.
 *
 * @module memories
 */

import { query, queryOne, execute, transaction } from "./database.js";
import { generateEmbedding, embeddingToBuffer } from "./embeddings.js";

/**
 * @typedef {Object} Memory
 * @property {number} id - Unique identifier
 * @property {string} category - Category for organization
 * @property {string} type - Type (person, fact, memory, experience, etc)
 * @property {string} content - The memory content
 * @property {string[]} tags - Array of tags
 * @property {number} importance - Priority score 1-10
 * @property {string} cadence_type - Cadence type (daily, weekly, monthly, day_of_week, calendar_day)
 * @property {string|null} cadence_value - Value for cadence
 * @property {string|null} context - Context of creation
 * @property {string} created_at - Creation timestamp
 * @property {string} updated_at - Last update timestamp
 * @property {string|null} last_accessed - Last retrieval timestamp
 * @property {number} archived - Archive status (0 or 1)
 */

/**
 * @typedef {Object} CreateMemoryInput
 * @property {string} category - Category for organization
 * @property {string} type - Type of memory
 * @property {string} content - The memory content
 * @property {string[]} [tags] - Optional array of tags
 * @property {number} [importance] - Priority score 1-10, default 5
 * @property {string} [cadence_type] - Cadence type, default 'monthly'
 * @property {string} [cadence_value] - Value for cadence
 * @property {string} [context] - Context of creation
 */

/**
 * Create a new memory with automatic embedding generation.
 *
 * @param {CreateMemoryInput} input - Memory data
 * @returns {Promise<Memory>} The created memory
 * @throws {Error} If required fields are missing
 *
 * @example
 * const memory = await addMemory({
 *   category: "people",
 *   type: "person",
 *   content: "John is a software engineer who loves hiking",
 *   tags: ["friend", "engineer"],
 *   importance: 7
 * });
 */
export async function addMemory(input) {
  const {
    category,
    type,
    content,
    tags = [],
    importance = 5,
    cadence_type = "monthly",
    cadence_value = null,
    context = null,
  } = input;

  // Validate required fields
  if (!category || typeof category !== "string") {
    throw new Error("Category is required and must be a string");
  }
  if (!type || typeof type !== "string") {
    throw new Error("Type is required and must be a string");
  }
  if (!content || typeof content !== "string") {
    throw new Error("Content is required and must be a string");
  }

  // Validate importance range
  const normalizedImportance = Math.max(1, Math.min(10, Math.round(importance)));

  // Validate cadence type
  const validCadenceTypes = ["daily", "weekly", "monthly", "day_of_week", "calendar_day"];
  if (!validCadenceTypes.includes(cadence_type)) {
    throw new Error(`Invalid cadence_type. Must be one of: ${validCadenceTypes.join(", ")}`);
  }

  // Generate embedding for semantic search
  const embedding = await generateEmbedding(content);
  const embeddingBuffer = embeddingToBuffer(embedding);

  // Insert into database
  const result = execute(
    `INSERT INTO memories (category, type, content, tags, importance, cadence_type, cadence_value, context, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      category,
      type,
      content,
      JSON.stringify(tags),
      normalizedImportance,
      cadence_type,
      cadence_value,
      context,
      embeddingBuffer,
    ]
  );

  // Return the created memory
  return getMemory(result.lastInsertRowid);
}

/**
 * Retrieve a memory by ID.
 * Updates the last_accessed timestamp automatically.
 *
 * @param {number} id - Memory ID
 * @param {boolean} [updateAccess=true] - Whether to update last_accessed
 * @returns {Memory|null} The memory or null if not found
 *
 * @example
 * const memory = await getMemory(1);
 * if (memory) {
 *   console.log(memory.content);
 * }
 */
export async function getMemory(id, updateAccess = true) {
  const memory = queryOne(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived
     FROM memories WHERE id = ?`,
    [id]
  );

  if (!memory) {
    return null;
  }

  // Update last_accessed
  if (updateAccess) {
    execute(
      "UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );
  }

  // Parse tags JSON
  return {
    ...memory,
    tags: JSON.parse(memory.tags || "[]"),
  };
}

/**
 * @typedef {Object} UpdateMemoryInput
 * @property {string} [category] - New category
 * @property {string} [type] - New type
 * @property {string} [content] - New content (triggers embedding regeneration)
 * @property {string[]} [tags] - New tags array
 * @property {number} [importance] - New importance score
 * @property {string} [cadence_type] - New cadence type
 * @property {string} [cadence_value] - New cadence value
 * @property {string} [context] - New context
 */

/**
 * Update an existing memory.
 * If content is changed, the embedding is regenerated automatically.
 *
 * @param {number} id - Memory ID to update
 * @param {UpdateMemoryInput} updates - Fields to update
 * @returns {Promise<Memory|null>} Updated memory or null if not found
 * @throws {Error} If update validation fails
 *
 * @example
 * const updated = await updateMemory(1, {
 *   content: "John is a senior software engineer",
 *   importance: 8
 * });
 */
export async function updateMemory(id, updates) {
  const existing = queryOne("SELECT * FROM memories WHERE id = ?", [id]);

  if (!existing) {
    return null;
  }

  const fields = [];
  const values = [];

  // Handle each updatable field
  if (updates.category !== undefined) {
    fields.push("category = ?");
    values.push(updates.category);
  }

  if (updates.type !== undefined) {
    fields.push("type = ?");
    values.push(updates.type);
  }

  if (updates.content !== undefined) {
    fields.push("content = ?");
    values.push(updates.content);

    // Regenerate embedding for new content
    const embedding = await generateEmbedding(updates.content);
    fields.push("embedding = ?");
    values.push(embeddingToBuffer(embedding));
  }

  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }

  if (updates.importance !== undefined) {
    const normalizedImportance = Math.max(1, Math.min(10, Math.round(updates.importance)));
    fields.push("importance = ?");
    values.push(normalizedImportance);
  }

  if (updates.cadence_type !== undefined) {
    const validCadenceTypes = ["daily", "weekly", "monthly", "day_of_week", "calendar_day"];
    if (!validCadenceTypes.includes(updates.cadence_type)) {
      throw new Error(`Invalid cadence_type. Must be one of: ${validCadenceTypes.join(", ")}`);
    }
    fields.push("cadence_type = ?");
    values.push(updates.cadence_type);
  }

  if (updates.cadence_value !== undefined) {
    fields.push("cadence_value = ?");
    values.push(updates.cadence_value);
  }

  if (updates.context !== undefined) {
    fields.push("context = ?");
    values.push(updates.context);
  }

  if (fields.length === 0) {
    return getMemory(id, false);
  }

  // Always update updated_at
  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  execute(
    `UPDATE memories SET ${fields.join(", ")} WHERE id = ?`,
    values
  );

  return getMemory(id, false);
}

/**
 * Permanently delete a memory.
 * This also removes all relationships to this memory.
 * Use archiveMemory for soft delete instead.
 *
 * @param {number} id - Memory ID to delete
 * @returns {boolean} True if deleted, false if not found
 *
 * @example
 * const deleted = deleteMemory(1);
 * if (deleted) {
 *   console.log("Memory permanently removed");
 * }
 */
export function deleteMemory(id) {
  const result = execute("DELETE FROM memories WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Archive a memory (soft delete).
 * The memory remains in the database but is excluded from normal queries.
 *
 * @param {number} id - Memory ID to archive
 * @returns {Memory|null} The archived memory or null if not found
 *
 * @example
 * const archived = archiveMemory(1);
 */
export function archiveMemory(id) {
  const result = execute(
    "UPDATE memories SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id]
  );

  if (result.changes === 0) {
    return null;
  }

  return getMemory(id, false);
}

/**
 * Unarchive a memory.
 * Restores a previously archived memory to active status.
 *
 * @param {number} id - Memory ID to unarchive
 * @returns {Memory|null} The restored memory or null if not found
 */
export function unarchiveMemory(id) {
  const result = execute(
    "UPDATE memories SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id]
  );

  if (result.changes === 0) {
    return null;
  }

  return getMemory(id, false);
}

/**
 * Get all unique categories with their memory counts.
 *
 * @param {boolean} [includeArchived=false] - Include archived memories in count
 * @returns {{category: string, count: number}[]} Array of categories with counts
 *
 * @example
 * const categories = getCategories();
 * // [{ category: "people", count: 10 }, { category: "facts", count: 5 }]
 */
export function getCategories(includeArchived = false) {
  const archivedClause = includeArchived ? "" : "WHERE archived = 0";

  return query(
    `SELECT category, COUNT(*) as count
     FROM memories
     ${archivedClause}
     GROUP BY category
     ORDER BY count DESC`
  );
}

/**
 * Get all unique tags with their usage counts.
 *
 * @param {boolean} [includeArchived=false] - Include archived memories
 * @returns {{tag: string, count: number}[]} Array of tags with counts
 */
export function getTags(includeArchived = false) {
  const archivedClause = includeArchived ? "" : "WHERE archived = 0";

  const memories = query(
    `SELECT tags FROM memories ${archivedClause}`
  );

  const tagCounts = {};

  for (const memory of memories) {
    const tags = JSON.parse(memory.tags || "[]");
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  return Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all unique memory types with their counts.
 *
 * @param {boolean} [includeArchived=false] - Include archived memories
 * @returns {{type: string, count: number}[]} Array of types with counts
 */
export function getTypes(includeArchived = false) {
  const archivedClause = includeArchived ? "" : "WHERE archived = 0";

  return query(
    `SELECT type, COUNT(*) as count
     FROM memories
     ${archivedClause}
     GROUP BY type
     ORDER BY count DESC`
  );
}

/**
 * Get statistics about the memory database.
 *
 * @returns {Object} Statistics object
 */
export function getStats() {
  const total = queryOne("SELECT COUNT(*) as count FROM memories");
  const active = queryOne("SELECT COUNT(*) as count FROM memories WHERE archived = 0");
  const archived = queryOne("SELECT COUNT(*) as count FROM memories WHERE archived = 1");
  const categories = queryOne("SELECT COUNT(DISTINCT category) as count FROM memories WHERE archived = 0");
  const types = queryOne("SELECT COUNT(DISTINCT type) as count FROM memories WHERE archived = 0");
  const relationships = queryOne("SELECT COUNT(*) as count FROM relationships");
  const avgImportance = queryOne("SELECT AVG(importance) as avg FROM memories WHERE archived = 0");
  const recentlyAccessed = queryOne(
    `SELECT COUNT(*) as count FROM memories
     WHERE archived = 0 AND last_accessed > datetime('now', '-7 days')`
  );

  return {
    total_memories: total.count,
    active_memories: active.count,
    archived_memories: archived.count,
    categories: categories.count,
    types: types.count,
    relationships: relationships.count,
    average_importance: avgImportance.avg ? Math.round(avgImportance.avg * 10) / 10 : 0,
    accessed_last_7_days: recentlyAccessed.count,
  };
}

/**
 * List memories with optional pagination.
 *
 * @param {Object} options - List options
 * @param {number} [options.limit=50] - Maximum results
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {boolean} [options.includeArchived=false] - Include archived
 * @param {string} [options.orderBy='created_at'] - Sort field
 * @param {string} [options.order='DESC'] - Sort direction
 * @returns {Memory[]} Array of memories
 */
export function listMemories(options = {}) {
  const {
    limit = 50,
    offset = 0,
    includeArchived = false,
    orderBy = "created_at",
    order = "DESC",
  } = options;

  const validOrderBy = ["created_at", "updated_at", "last_accessed", "importance", "category", "type"];
  const safeOrderBy = validOrderBy.includes(orderBy) ? orderBy : "created_at";
  const safeOrder = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

  const archivedClause = includeArchived ? "" : "WHERE archived = 0";

  const memories = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived
     FROM memories
     ${archivedClause}
     ORDER BY ${safeOrderBy} ${safeOrder}
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );

  return memories.map((m) => ({
    ...m,
    tags: JSON.parse(m.tags || "[]"),
  }));
}

export default {
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
  listMemories,
};
