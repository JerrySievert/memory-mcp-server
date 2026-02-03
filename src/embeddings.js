/**
 * Embeddings Module
 *
 * Provides local embedding generation using fastembed with the
 * all-MiniLM-L6-v2 model. This enables semantic search without external API calls.
 *
 * The model produces 384-dimensional embeddings optimized for semantic similarity.
 * Embeddings are stored as Float32Array buffers in SQLite BLOB columns.
 *
 * @module embeddings
 */

import { EmbeddingModel, FlagEmbedding } from 'fastembed';

/** @type {FlagEmbedding|null} */
let embeddingModel = null;

/** Dimension of the embedding vectors (all-MiniLM-L6-v2) */
export const EMBEDDING_DIMENSION = 384;

/**
 * Initialize the embedding model.
 * Loads the model on first call and caches it for subsequent uses.
 *
 * @returns {Promise<FlagEmbedding>} The initialized embedding model
 */
async function getEmbeddingModel() {
  if (!embeddingModel) {
    console.log('Loading embedding model...');
    embeddingModel = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2
    });
    console.log('Embedding model loaded.');
  }
  return embeddingModel;
}

/**
 * Generate an embedding vector for the given text.
 *
 * @param {string} text - The text to embed
 * @returns {Promise<Float32Array>} 384-dimensional embedding vector
 * @throws {Error} If text is empty or embedding generation fails
 *
 * @example
 * const embedding = await generateEmbedding("Hello world");
 * console.log(embedding.length); // 384
 */
export async function generateEmbedding(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Text must be a non-empty string');
  }

  const model = await getEmbeddingModel();

  // fastembed returns an async generator, we need to get the first batch
  const embeddings = model.embed([text]);

  for await (const batch of embeddings) {
    // batch is an array of embeddings, we want the first one
    return new Float32Array(batch[0]);
  }

  throw new Error('Failed to generate embedding');
}

/**
 * Generate embeddings for multiple texts in batch.
 * More efficient than calling generateEmbedding multiple times.
 *
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<Float32Array[]>} Array of embedding vectors
 *
 * @example
 * const embeddings = await generateEmbeddings(["Hello", "World"]);
 */
export async function generateEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const validTexts = texts.filter((t) => t && typeof t === 'string');
  if (validTexts.length === 0) {
    return [];
  }

  const model = await getEmbeddingModel();
  const results = [];

  const embeddings = model.embed(validTexts);

  for await (const batch of embeddings) {
    for (const embedding of batch) {
      results.push(new Float32Array(embedding));
    }
  }

  return results;
}

/**
 * Calculate cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 *
 * @param {Float32Array|number[]} a - First embedding vector
 * @param {Float32Array|number[]} b - Second embedding vector
 * @returns {number} Cosine similarity score between -1 and 1
 *
 * @example
 * const sim = cosineSimilarity(embedding1, embedding2);
 * if (sim > 0.8) console.log("Very similar!");
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Convert a Float32Array embedding to a Buffer for SQLite storage.
 *
 * @param {Float32Array} embedding - The embedding to convert
 * @returns {Buffer} Buffer representation of the embedding
 */
export function embeddingToBuffer(embedding) {
  return Buffer.from(embedding.buffer);
}

/**
 * Convert a Buffer from SQLite back to a Float32Array.
 *
 * @param {Buffer|Uint8Array} buffer - The buffer to convert
 * @returns {Float32Array} The reconstructed embedding vector
 */
export function bufferToEmbedding(buffer) {
  if (!buffer) {
    return null;
  }
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4
  );
}

/**
 * Find the most similar embeddings from a list.
 * Returns matches sorted by similarity score in descending order.
 *
 * @param {Float32Array} queryEmbedding - The embedding to compare against
 * @param {{id: number, embedding: Buffer}[]} candidates - Array of candidate embeddings
 * @param {number} [threshold=0.5] - Minimum similarity threshold
 * @param {number} [limit=10] - Maximum number of results
 * @returns {{id: number, similarity: number}[]} Sorted array of matches
 *
 * @example
 * const matches = findSimilar(queryEmbed, candidates, 0.7, 5);
 */
export function findSimilar(
  queryEmbedding,
  candidates,
  threshold = 0.5,
  limit = 10
) {
  const results = [];

  for (const candidate of candidates) {
    const candidateEmbedding = bufferToEmbedding(candidate.embedding);

    if (!candidateEmbedding) {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding);

    if (similarity >= threshold) {
      results.push({
        id: candidate.id,
        similarity
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}

/**
 * Preload the embedding model.
 * Call this at startup to avoid latency on first embedding request.
 *
 * @returns {Promise<void>}
 */
export async function preloadModel() {
  await getEmbeddingModel();
}

export default {
  generateEmbedding,
  generateEmbeddings,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  findSimilar,
  preloadModel,
  EMBEDDING_DIMENSION
};
