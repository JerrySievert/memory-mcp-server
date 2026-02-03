/**
 * Relationships Module
 *
 * Manages relationships between memories including creation, deletion,
 * traversal, and memory merging. Supports different relationship types
 * to express how memories relate to each other.
 *
 * @module relationships
 */

import { query, queryOne, execute, transaction } from "./database.js";
import { generateEmbedding, embeddingToBuffer } from "./embeddings.js";

/**
 * Valid relationship types between memories.
 * - related_to: General relationship
 * - supersedes: New memory replaces old one
 * - contradicts: Memories contain conflicting information
 * - elaborates: Memory provides more detail on another
 * - references: Memory mentions or cites another
 */
export const RELATIONSHIP_TYPES = [
  "related_to",
  "supersedes",
  "contradicts",
  "elaborates",
  "references",
];

/**
 * @typedef {Object} Relationship
 * @property {number} id - Relationship ID
 * @property {number} memory_id - Source memory ID
 * @property {number} related_memory_id - Target memory ID
 * @property {string} relationship_type - Type of relationship
 * @property {string} created_at - Creation timestamp
 */

/**
 * Add a relationship between two memories.
 * Creates a directional relationship from memory_id to related_memory_id.
 *
 * @param {number} memoryId - Source memory ID
 * @param {number} relatedMemoryId - Target memory ID
 * @param {string} [relationshipType='related_to'] - Type of relationship
 * @returns {Relationship|null} The created relationship or null if memories don't exist
 * @throws {Error} If relationship type is invalid or relationship already exists
 *
 * @example
 * // Mark that memory 2 elaborates on memory 1
 * const rel = addRelationship(1, 2, "elaborates");
 */
export function addRelationship(memoryId, relatedMemoryId, relationshipType = "related_to") {
  // Validate relationship type
  if (!RELATIONSHIP_TYPES.includes(relationshipType)) {
    throw new Error(`Invalid relationship type. Must be one of: ${RELATIONSHIP_TYPES.join(", ")}`);
  }

  // Prevent self-referential relationships
  if (memoryId === relatedMemoryId) {
    throw new Error("Cannot create a relationship between a memory and itself");
  }

  // Verify both memories exist
  const memory1 = queryOne("SELECT id FROM memories WHERE id = ?", [memoryId]);
  const memory2 = queryOne("SELECT id FROM memories WHERE id = ?", [relatedMemoryId]);

  if (!memory1 || !memory2) {
    return null;
  }

  // Check if relationship already exists
  const existing = queryOne(
    "SELECT id FROM relationships WHERE memory_id = ? AND related_memory_id = ?",
    [memoryId, relatedMemoryId]
  );

  if (existing) {
    throw new Error("Relationship already exists between these memories");
  }

  const result = execute(
    `INSERT INTO relationships (memory_id, related_memory_id, relationship_type)
     VALUES (?, ?, ?)`,
    [memoryId, relatedMemoryId, relationshipType]
  );

  return queryOne("SELECT * FROM relationships WHERE id = ?", [result.lastInsertRowid]);
}

/**
 * Remove a relationship between two memories.
 *
 * @param {number} memoryId - Source memory ID
 * @param {number} relatedMemoryId - Target memory ID
 * @returns {boolean} True if relationship was removed, false if not found
 *
 * @example
 * const removed = removeRelationship(1, 2);
 */
export function removeRelationship(memoryId, relatedMemoryId) {
  const result = execute(
    "DELETE FROM relationships WHERE memory_id = ? AND related_memory_id = ?",
    [memoryId, relatedMemoryId]
  );

  return result.changes > 0;
}

/**
 * Get all relationships for a memory.
 * Returns both outgoing and incoming relationships.
 *
 * @param {number} memoryId - Memory ID
 * @returns {{outgoing: Relationship[], incoming: Relationship[]}} Relationships
 *
 * @example
 * const { outgoing, incoming } = getRelationships(1);
 */
export function getRelationships(memoryId) {
  const outgoing = query(
    `SELECT r.*, m.content as related_content, m.category as related_category, m.type as related_type
     FROM relationships r
     JOIN memories m ON r.related_memory_id = m.id
     WHERE r.memory_id = ?`,
    [memoryId]
  );

  const incoming = query(
    `SELECT r.*, m.content as source_content, m.category as source_category, m.type as source_type
     FROM relationships r
     JOIN memories m ON r.memory_id = m.id
     WHERE r.related_memory_id = ?`,
    [memoryId]
  );

  return { outgoing, incoming };
}

/**
 * Get all memories related to a given memory.
 * Traverses the relationship graph to find all connected memories.
 *
 * @param {number} memoryId - Starting memory ID
 * @param {Object} options - Traversal options
 * @param {number} [options.maxDepth=2] - Maximum traversal depth
 * @param {string[]} [options.relationshipTypes] - Filter by relationship types
 * @param {boolean} [options.includeArchived=false] - Include archived memories
 * @returns {Object[]} Array of related memories with relationship info
 *
 * @example
 * // Get all memories within 2 hops
 * const related = getRelatedMemories(1, { maxDepth: 2 });
 *
 * @example
 * // Get only memories that elaborate on this one
 * const elaborations = getRelatedMemories(1, { relationshipTypes: ["elaborates"] });
 */
export function getRelatedMemories(memoryId, options = {}) {
  const {
    maxDepth = 2,
    relationshipTypes = null,
    includeArchived = false,
  } = options;

  const visited = new Set([memoryId]);
  const results = [];

  // BFS traversal
  let currentLevel = [memoryId];
  let depth = 0;

  while (currentLevel.length > 0 && depth < maxDepth) {
    const nextLevel = [];

    for (const currentId of currentLevel) {
      // Get outgoing relationships
      let outgoingQuery = `
        SELECT r.related_memory_id as id, r.relationship_type, m.*
        FROM relationships r
        JOIN memories m ON r.related_memory_id = m.id
        WHERE r.memory_id = ?
      `;
      const outgoingParams = [currentId];

      if (!includeArchived) {
        outgoingQuery += " AND m.archived = 0";
      }

      if (relationshipTypes && relationshipTypes.length > 0) {
        outgoingQuery += ` AND r.relationship_type IN (${relationshipTypes.map(() => "?").join(", ")})`;
        outgoingParams.push(...relationshipTypes);
      }

      const outgoing = query(outgoingQuery, outgoingParams);

      // Get incoming relationships
      let incomingQuery = `
        SELECT r.memory_id as id, r.relationship_type, m.*
        FROM relationships r
        JOIN memories m ON r.memory_id = m.id
        WHERE r.related_memory_id = ?
      `;
      const incomingParams = [currentId];

      if (!includeArchived) {
        incomingQuery += " AND m.archived = 0";
      }

      if (relationshipTypes && relationshipTypes.length > 0) {
        incomingQuery += ` AND r.relationship_type IN (${relationshipTypes.map(() => "?").join(", ")})`;
        incomingParams.push(...relationshipTypes);
      }

      const incoming = query(incomingQuery, incomingParams);

      // Process results
      for (const rel of [...outgoing, ...incoming]) {
        if (!visited.has(rel.id)) {
          visited.add(rel.id);
          nextLevel.push(rel.id);

          results.push({
            id: rel.id,
            category: rel.category,
            type: rel.type,
            content: rel.content,
            tags: JSON.parse(rel.tags || "[]"),
            importance: rel.importance,
            relationship_type: rel.relationship_type,
            depth: depth + 1,
            created_at: rel.created_at,
            updated_at: rel.updated_at,
          });
        }
      }
    }

    currentLevel = nextLevel;
    depth++;
  }

  return results;
}

/**
 * Merge two memories into one.
 * Creates a new combined memory and preserves the originals in merge_history.
 * Original memories are archived.
 *
 * @param {number} memoryId1 - First memory ID
 * @param {number} memoryId2 - Second memory ID
 * @param {Object} options - Merge options
 * @param {string} options.mergedContent - The new combined content
 * @param {string} [options.category] - Category for merged memory (defaults to first memory's)
 * @param {string} [options.type] - Type for merged memory (defaults to first memory's)
 * @param {string[]} [options.tags] - Tags for merged memory (defaults to union of both)
 * @param {number} [options.importance] - Importance (defaults to max of both)
 * @returns {Promise<Object>} The newly created merged memory
 * @throws {Error} If memories don't exist or merge fails
 *
 * @example
 * const merged = await mergeMemories(1, 2, {
 *   mergedContent: "Combined information about John: He is a software engineer who enjoys hiking and photography."
 * });
 */
export async function mergeMemories(memoryId1, memoryId2, options) {
  const { mergedContent, category, type, tags, importance } = options;

  if (!mergedContent) {
    throw new Error("mergedContent is required");
  }

  // Get both memories
  const memory1 = queryOne("SELECT * FROM memories WHERE id = ?", [memoryId1]);
  const memory2 = queryOne("SELECT * FROM memories WHERE id = ?", [memoryId2]);

  if (!memory1 || !memory2) {
    throw new Error("One or both memories not found");
  }

  // Parse existing tags
  const tags1 = JSON.parse(memory1.tags || "[]");
  const tags2 = JSON.parse(memory2.tags || "[]");

  // Determine merged values
  const mergedCategory = category || memory1.category;
  const mergedType = type || memory1.type;
  const mergedTags = tags || [...new Set([...tags1, ...tags2])];
  const mergedImportance = importance || Math.max(memory1.importance, memory2.importance);

  // Generate embedding for merged content
  const embedding = await generateEmbedding(mergedContent);
  const embeddingBuffer = embeddingToBuffer(embedding);

  // Perform merge in transaction
  return transaction(() => {
    // Create new merged memory
    const result = execute(
      `INSERT INTO memories (category, type, content, tags, importance, cadence_type, cadence_value, context, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mergedCategory,
        mergedType,
        mergedContent,
        JSON.stringify(mergedTags),
        mergedImportance,
        memory1.cadence_type,
        memory1.cadence_value,
        `Merged from memories ${memoryId1} and ${memoryId2}`,
        embeddingBuffer,
      ]
    );

    const newMemoryId = result.lastInsertRowid;

    // Record merge history
    execute(
      `INSERT INTO merge_history (resulting_memory_id, source_memory_id, original_content)
       VALUES (?, ?, ?)`,
      [newMemoryId, memoryId1, memory1.content]
    );

    execute(
      `INSERT INTO merge_history (resulting_memory_id, source_memory_id, original_content)
       VALUES (?, ?, ?)`,
      [newMemoryId, memoryId2, memory2.content]
    );

    // Transfer relationships from both memories to the new one
    const relationships1 = query(
      "SELECT related_memory_id, relationship_type FROM relationships WHERE memory_id = ?",
      [memoryId1]
    );
    const relationships2 = query(
      "SELECT related_memory_id, relationship_type FROM relationships WHERE memory_id = ?",
      [memoryId2]
    );

    for (const rel of [...relationships1, ...relationships2]) {
      if (rel.related_memory_id !== memoryId1 && rel.related_memory_id !== memoryId2) {
        try {
          execute(
            `INSERT OR IGNORE INTO relationships (memory_id, related_memory_id, relationship_type)
             VALUES (?, ?, ?)`,
            [newMemoryId, rel.related_memory_id, rel.relationship_type]
          );
        } catch {
          // Ignore duplicate relationship errors
        }
      }
    }

    // Archive original memories
    execute("UPDATE memories SET archived = 1 WHERE id IN (?, ?)", [memoryId1, memoryId2]);

    // Create supersedes relationships
    execute(
      `INSERT INTO relationships (memory_id, related_memory_id, relationship_type)
       VALUES (?, ?, 'supersedes')`,
      [newMemoryId, memoryId1]
    );
    execute(
      `INSERT INTO relationships (memory_id, related_memory_id, relationship_type)
       VALUES (?, ?, 'supersedes')`,
      [newMemoryId, memoryId2]
    );

    // Return the new memory
    const newMemory = queryOne(
      `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
              context, created_at, updated_at, last_accessed, archived
       FROM memories WHERE id = ?`,
      [newMemoryId]
    );

    return {
      ...newMemory,
      tags: JSON.parse(newMemory.tags || "[]"),
      merged_from: [memoryId1, memoryId2],
    };
  });
}

/**
 * Get the merge history for a memory.
 * Shows what memories were merged to create this one.
 *
 * @param {number} memoryId - Memory ID
 * @returns {Object[]} Array of merge history records
 */
export function getMergeHistory(memoryId) {
  return query(
    `SELECT mh.*, m.content as current_content, m.category, m.type
     FROM merge_history mh
     LEFT JOIN memories m ON mh.source_memory_id = m.id
     WHERE mh.resulting_memory_id = ?
     ORDER BY mh.merged_at`,
    [memoryId]
  );
}

/**
 * Suggest potential relationships based on semantic similarity.
 * Finds memories that might be related but aren't explicitly linked.
 *
 * @param {number} memoryId - Memory ID to find suggestions for
 * @param {Object} options - Options
 * @param {number} [options.limit=5] - Maximum suggestions
 * @param {number} [options.threshold=0.7] - Minimum similarity
 * @returns {Promise<Object[]>} Suggested memories to relate
 */
export async function suggestRelationships(memoryId, options = {}) {
  const { limit = 5, threshold = 0.7 } = options;

  // Import here to avoid circular dependency
  const { findSimilarMemories } = await import("./search.js");

  // Get similar memories
  const similar = await findSimilarMemories(memoryId, {
    limit: limit + 10, // Get extra to filter
    threshold,
  });

  // Get existing relationships
  const { outgoing, incoming } = getRelationships(memoryId);
  const existingIds = new Set([
    ...outgoing.map((r) => r.related_memory_id),
    ...incoming.map((r) => r.memory_id),
  ]);

  // Filter out already related memories
  return similar
    .filter((m) => !existingIds.has(m.id))
    .slice(0, limit)
    .map((m) => ({
      ...m,
      suggested_type: m.similarity > 0.85 ? "related_to" : "references",
    }));
}

export default {
  RELATIONSHIP_TYPES,
  addRelationship,
  removeRelationship,
  getRelationships,
  getRelatedMemories,
  mergeMemories,
  getMergeHistory,
  suggestRelationships,
};
