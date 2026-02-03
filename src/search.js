/**
 * Search Module
 *
 * Provides comprehensive search functionality including semantic search
 * using embeddings, full-text search using FTS5, and filtered queries.
 *
 * @module search
 */

import { query, queryOne } from "./database.js";
import {
  generateEmbedding,
  bufferToEmbedding,
  cosineSimilarity,
} from "./embeddings.js";

/**
 * @typedef {Object} SearchOptions
 * @property {string} [query] - Text query for semantic/full-text search
 * @property {string} [category] - Filter by category
 * @property {string} [type] - Filter by type
 * @property {string[]} [tags] - Filter by tags (any match)
 * @property {number} [minImportance] - Minimum importance score
 * @property {number} [maxImportance] - Maximum importance score
 * @property {string} [cadence_type] - Filter by cadence type
 * @property {boolean} [includeArchived] - Include archived memories
 * @property {number} [limit] - Maximum results (default 20)
 * @property {number} [offset] - Offset for pagination
 * @property {'semantic'|'fulltext'|'hybrid'} [searchMode] - Search mode (default 'hybrid')
 * @property {number} [semanticThreshold] - Minimum similarity for semantic search (default 0.5)
 */

/**
 * @typedef {Object} SearchResult
 * @property {number} id - Memory ID
 * @property {string} category - Category
 * @property {string} type - Type
 * @property {string} content - Content
 * @property {string[]} tags - Tags
 * @property {number} importance - Importance score
 * @property {number} [similarity] - Semantic similarity score (if semantic search used)
 * @property {number} [fts_rank] - Full-text search rank (if FTS used)
 * @property {number} score - Combined relevance score
 */

/**
 * Perform a comprehensive search across memories.
 * Combines semantic search (embedding similarity) with full-text search (FTS5).
 *
 * @param {SearchOptions} options - Search options
 * @returns {Promise<SearchResult[]>} Array of search results sorted by relevance
 *
 * @example
 * // Semantic search for similar content
 * const results = await searchMemories({
 *   query: "software development best practices",
 *   searchMode: "semantic",
 *   limit: 10
 * });
 *
 * @example
 * // Filtered search
 * const results = await searchMemories({
 *   category: "people",
 *   type: "person",
 *   minImportance: 7
 * });
 *
 * @example
 * // Hybrid search with filters
 * const results = await searchMemories({
 *   query: "project management",
 *   category: "work",
 *   tags: ["important"],
 *   searchMode: "hybrid"
 * });
 */
export async function searchMemories(options = {}) {
  const {
    query: searchQuery,
    category,
    type,
    tags,
    minImportance,
    maxImportance,
    cadence_type,
    includeArchived = false,
    limit = 20,
    offset = 0,
    searchMode = "hybrid",
    semanticThreshold = 0.5,
  } = options;

  // If no search query, just do filtered retrieval
  if (!searchQuery) {
    return filteredSearch(options);
  }

  let results = [];

  // Semantic search
  if (searchMode === "semantic" || searchMode === "hybrid") {
    const semanticResults = await semanticSearch(searchQuery, {
      category,
      type,
      tags,
      minImportance,
      maxImportance,
      cadence_type,
      includeArchived,
      threshold: semanticThreshold,
      limit: limit * 2, // Get more for merging
    });
    results = semanticResults;
  }

  // Full-text search
  if (searchMode === "fulltext" || searchMode === "hybrid") {
    const ftsResults = await fullTextSearch(searchQuery, {
      category,
      type,
      tags,
      minImportance,
      maxImportance,
      cadence_type,
      includeArchived,
      limit: limit * 2,
    });

    if (searchMode === "hybrid") {
      // Merge results, combining scores for items found in both
      results = mergeSearchResults(results, ftsResults);
    } else {
      results = ftsResults;
    }
  }

  // Sort by combined score and apply pagination
  results.sort((a, b) => b.score - a.score);

  return results.slice(offset, offset + limit);
}

/**
 * Perform semantic search using embedding similarity.
 *
 * @param {string} searchQuery - The text to search for
 * @param {Object} filters - Additional filters
 * @returns {Promise<SearchResult[]>} Results with similarity scores
 */
async function semanticSearch(searchQuery, filters = {}) {
  const {
    category,
    type,
    tags,
    minImportance,
    maxImportance,
    cadence_type,
    includeArchived = false,
    threshold = 0.5,
    limit = 50,
  } = filters;

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(searchQuery);

  // Build filter conditions
  const conditions = [];
  const params = [];

  if (!includeArchived) {
    conditions.push("archived = 0");
  }

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (minImportance !== undefined) {
    conditions.push("importance >= ?");
    params.push(minImportance);
  }

  if (maxImportance !== undefined) {
    conditions.push("importance <= ?");
    params.push(maxImportance);
  }

  if (cadence_type) {
    conditions.push("cadence_type = ?");
    params.push(cadence_type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get all candidate memories with embeddings
  const candidates = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived, embedding
     FROM memories ${whereClause}`,
    params
  );

  // Calculate similarities
  const results = [];

  for (const candidate of candidates) {
    const candidateEmbedding = bufferToEmbedding(candidate.embedding);

    if (!candidateEmbedding) {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding);

    if (similarity >= threshold) {
      // Filter by tags if specified
      const memoryTags = JSON.parse(candidate.tags || "[]");
      if (tags && tags.length > 0) {
        const hasMatchingTag = tags.some((t) => memoryTags.includes(t));
        if (!hasMatchingTag) {
          continue;
        }
      }

      results.push({
        id: candidate.id,
        category: candidate.category,
        type: candidate.type,
        content: candidate.content,
        tags: memoryTags,
        importance: candidate.importance,
        cadence_type: candidate.cadence_type,
        cadence_value: candidate.cadence_value,
        context: candidate.context,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
        last_accessed: candidate.last_accessed,
        archived: candidate.archived,
        similarity,
        score: similarity, // Initial score is similarity
      });
    }
  }

  // Sort by similarity
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}

/**
 * Perform full-text search using SQLite FTS5.
 *
 * @param {string} searchQuery - The text to search for
 * @param {Object} filters - Additional filters
 * @returns {Promise<SearchResult[]>} Results with FTS rank scores
 */
async function fullTextSearch(searchQuery, filters = {}) {
  const {
    category,
    type,
    tags,
    minImportance,
    maxImportance,
    cadence_type,
    includeArchived = false,
    limit = 50,
  } = filters;

  // Escape special FTS5 characters and build query
  const ftsQuery = searchQuery
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word}"*`)
    .join(" OR ");

  if (!ftsQuery) {
    return [];
  }

  // Build filter conditions for join
  const conditions = [];
  const params = [ftsQuery];

  if (!includeArchived) {
    conditions.push("m.archived = 0");
  }

  if (category) {
    conditions.push("m.category = ?");
    params.push(category);
  }

  if (type) {
    conditions.push("m.type = ?");
    params.push(type);
  }

  if (minImportance !== undefined) {
    conditions.push("m.importance >= ?");
    params.push(minImportance);
  }

  if (maxImportance !== undefined) {
    conditions.push("m.importance <= ?");
    params.push(maxImportance);
  }

  if (cadence_type) {
    conditions.push("m.cadence_type = ?");
    params.push(cadence_type);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  params.push(limit);

  try {
    const results = query(
      `SELECT m.id, m.category, m.type, m.content, m.tags, m.importance,
              m.cadence_type, m.cadence_value, m.context, m.created_at,
              m.updated_at, m.last_accessed, m.archived,
              bm25(memories_fts) as fts_rank
       FROM memories_fts
       JOIN memories m ON memories_fts.rowid = m.id
       WHERE memories_fts MATCH ? ${whereClause}
       ORDER BY fts_rank
       LIMIT ?`,
      params
    );

    return results.map((r) => {
      const memoryTags = JSON.parse(r.tags || "[]");

      // Filter by tags if specified
      if (tags && tags.length > 0) {
        const hasMatchingTag = tags.some((t) => memoryTags.includes(t));
        if (!hasMatchingTag) {
          return null;
        }
      }

      // Normalize FTS rank to 0-1 scale (BM25 returns negative scores, lower is better)
      const normalizedRank = Math.min(1, Math.max(0, 1 + r.fts_rank / 10));

      return {
        id: r.id,
        category: r.category,
        type: r.type,
        content: r.content,
        tags: memoryTags,
        importance: r.importance,
        cadence_type: r.cadence_type,
        cadence_value: r.cadence_value,
        context: r.context,
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_accessed: r.last_accessed,
        archived: r.archived,
        fts_rank: r.fts_rank,
        score: normalizedRank,
      };
    }).filter(Boolean);
  } catch (error) {
    // FTS query might fail with certain inputs, fall back to empty results
    console.error("FTS search error:", error.message);
    return [];
  }
}

/**
 * Merge semantic and full-text search results.
 * Combines scores for items found in both result sets.
 *
 * @param {SearchResult[]} semanticResults - Results from semantic search
 * @param {SearchResult[]} ftsResults - Results from full-text search
 * @returns {SearchResult[]} Merged results with combined scores
 */
function mergeSearchResults(semanticResults, ftsResults) {
  const merged = new Map();

  // Add semantic results
  for (const result of semanticResults) {
    merged.set(result.id, {
      ...result,
      score: result.similarity * 0.6, // Weight semantic at 60%
    });
  }

  // Merge in FTS results
  for (const result of ftsResults) {
    if (merged.has(result.id)) {
      // Combine scores
      const existing = merged.get(result.id);
      existing.fts_rank = result.fts_rank;
      existing.score += result.score * 0.4; // Weight FTS at 40%
    } else {
      merged.set(result.id, {
        ...result,
        score: result.score * 0.4, // FTS only
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Perform a filtered search without text query.
 * Simply retrieves memories matching the specified filters.
 *
 * @param {SearchOptions} options - Filter options
 * @returns {SearchResult[]} Filtered results
 */
function filteredSearch(options) {
  const {
    category,
    type,
    tags,
    minImportance,
    maxImportance,
    cadence_type,
    includeArchived = false,
    limit = 20,
    offset = 0,
  } = options;

  const conditions = [];
  const params = [];

  if (!includeArchived) {
    conditions.push("archived = 0");
  }

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (minImportance !== undefined) {
    conditions.push("importance >= ?");
    params.push(minImportance);
  }

  if (maxImportance !== undefined) {
    conditions.push("importance <= ?");
    params.push(maxImportance);
  }

  if (cadence_type) {
    conditions.push("cadence_type = ?");
    params.push(cadence_type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const results = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived
     FROM memories ${whereClause}
     ORDER BY importance DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    params
  );

  return results
    .map((r) => {
      const memoryTags = JSON.parse(r.tags || "[]");

      // Filter by tags if specified
      if (tags && tags.length > 0) {
        const hasMatchingTag = tags.some((t) => memoryTags.includes(t));
        if (!hasMatchingTag) {
          return null;
        }
      }

      return {
        ...r,
        tags: memoryTags,
        score: r.importance / 10, // Use importance as score for filtered results
      };
    })
    .filter(Boolean);
}

/**
 * Find memories similar to a given memory.
 * Uses the memory's embedding to find semantically similar content.
 *
 * @param {number} memoryId - ID of the memory to find similar content for
 * @param {Object} options - Search options
 * @param {number} [options.limit=10] - Maximum results
 * @param {number} [options.threshold=0.6] - Minimum similarity
 * @param {boolean} [options.includeArchived=false] - Include archived
 * @returns {Promise<SearchResult[]>} Similar memories
 *
 * @example
 * const similar = await findSimilarMemories(1, { limit: 5, threshold: 0.7 });
 */
export async function findSimilarMemories(memoryId, options = {}) {
  const { limit = 10, threshold = 0.6, includeArchived = false } = options;

  // Get the source memory's embedding
  const source = queryOne(
    "SELECT embedding FROM memories WHERE id = ?",
    [memoryId]
  );

  if (!source || !source.embedding) {
    return [];
  }

  const sourceEmbedding = bufferToEmbedding(source.embedding);

  // Get all other memories with embeddings
  const archivedClause = includeArchived ? "" : "AND archived = 0";

  const candidates = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived, embedding
     FROM memories
     WHERE id != ? ${archivedClause}`,
    [memoryId]
  );

  const results = [];

  for (const candidate of candidates) {
    const candidateEmbedding = bufferToEmbedding(candidate.embedding);

    if (!candidateEmbedding) {
      continue;
    }

    const similarity = cosineSimilarity(sourceEmbedding, candidateEmbedding);

    if (similarity >= threshold) {
      results.push({
        id: candidate.id,
        category: candidate.category,
        type: candidate.type,
        content: candidate.content,
        tags: JSON.parse(candidate.tags || "[]"),
        importance: candidate.importance,
        cadence_type: candidate.cadence_type,
        cadence_value: candidate.cadence_value,
        context: candidate.context,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
        last_accessed: candidate.last_accessed,
        archived: candidate.archived,
        similarity,
        score: similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}

export default {
  searchMemories,
  findSimilarMemories,
};
