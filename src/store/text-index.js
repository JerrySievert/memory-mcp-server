/**
 * Text Index Implementation (Inverted Index with BM25 Ranking)
 *
 * Provides full-text search with BM25 ranking for memory content.
 * Only indexes the latest version of each memory.
 *
 * BM25 Parameters:
 * - k1: Term frequency saturation (default 1.2)
 * - b: Length normalization (default 0.75)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Simple tokenizer that handles Unicode and common patterns
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  // Convert to lowercase and split on non-word characters
  // Keep Unicode letters and numbers
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_.,!?;:'"()\[\]{}|\\/<>@#$%^&*+=~`]+/)
    .filter(token => token.length > 0);

  return tokens;
}

/**
 * Common English stop words to optionally filter out
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "that", "the",
  "to", "was", "were", "will", "with", "the", "this", "but", "they",
  "have", "had", "what", "when", "where", "who", "which", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "can", "should", "now", "i", "you", "we", "me", "my",
]);

/**
 * Remove stop words from tokens
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function removeStopWords(tokens) {
  return tokens.filter(token => !STOP_WORDS.has(token));
}

/**
 * Posting entry for a term in a document
 * @typedef {Object} Posting
 * @property {string} id - Document/memory ID
 * @property {number} frequency - Term frequency in document
 * @property {number[]} positions - Position indices where term occurs
 */

/**
 * TextIndex class implementing inverted index with BM25
 */
export class TextIndex {
  /**
   * @param {Object} options
   * @param {string} [options.indexPath] - Path to persist the index
   * @param {number} [options.k1=1.2] - BM25 k1 parameter
   * @param {number} [options.b=0.75] - BM25 b parameter
   * @param {boolean} [options.removeStopWords=true] - Whether to filter stop words
   */
  constructor(options = {}) {
    this.indexPath = options.indexPath || null;
    this.k1 = options.k1 || 1.2;
    this.b = options.b || 0.75;
    this.filterStopWords = options.removeStopWords !== false;

    // Inverted index: Map<term, Map<id, Posting>>
    this.index = new Map();

    // Document metadata: Map<id, { length: number, terms: string[] }>
    this.documents = new Map();

    // Total document count
    this.docCount = 0;

    // Average document length
    this.avgDocLength = 0;

    // Total tokens across all documents
    this.totalTokens = 0;

    this.dirty = false;
  }

  /**
   * Process text into tokens for indexing
   * @param {string} text
   * @returns {string[]}
   */
  _processText(text) {
    let tokens = tokenize(text);
    if (this.filterStopWords) {
      tokens = removeStopWords(tokens);
    }
    return tokens;
  }

  /**
   * Index a document
   * @param {string} id - Memory ID
   * @param {string} content - Text content to index
   * @param {Object} [metadata] - Optional additional fields to index
   */
  add(id, content, metadata = {}) {
    // If already indexed, remove first
    if (this.documents.has(id)) {
      this.remove(id);
    }

    // Combine content with metadata fields
    const textParts = [content];
    if (metadata.category) textParts.push(metadata.category);
    if (metadata.type) textParts.push(metadata.type);
    if (metadata.tags && Array.isArray(metadata.tags)) {
      textParts.push(...metadata.tags);
    }
    if (metadata.context) textParts.push(metadata.context);

    const fullText = textParts.join(" ");
    const tokens = this._processText(fullText);

    if (tokens.length === 0) {
      // Still track the document even if empty
      this.documents.set(id, { length: 0, terms: [] });
      this.docCount++;
      this._updateAvgDocLength();
      this.dirty = true;
      return;
    }

    // Build term frequencies and positions
    const termFreq = new Map();
    const termPositions = new Map();

    for (let i = 0; i < tokens.length; i++) {
      const term = tokens[i];
      termFreq.set(term, (termFreq.get(term) || 0) + 1);

      if (!termPositions.has(term)) {
        termPositions.set(term, []);
      }
      termPositions.get(term).push(i);
    }

    // Update inverted index
    for (const [term, freq] of termFreq) {
      if (!this.index.has(term)) {
        this.index.set(term, new Map());
      }
      this.index.get(term).set(id, {
        id,
        frequency: freq,
        positions: termPositions.get(term),
      });
    }

    // Store document metadata
    this.documents.set(id, {
      length: tokens.length,
      terms: Array.from(termFreq.keys()),
    });

    this.docCount++;
    this.totalTokens += tokens.length;
    this._updateAvgDocLength();
    this.dirty = true;
  }

  /**
   * Remove a document from the index
   * @param {string} id
   */
  remove(id) {
    const doc = this.documents.get(id);
    if (!doc) return;

    // Remove from inverted index
    for (const term of doc.terms) {
      const postings = this.index.get(term);
      if (postings) {
        postings.delete(id);
        if (postings.size === 0) {
          this.index.delete(term);
        }
      }
    }

    this.totalTokens -= doc.length;
    this.docCount--;
    this.documents.delete(id);
    this._updateAvgDocLength();
    this.dirty = true;
  }

  /**
   * Update average document length
   * @private
   */
  _updateAvgDocLength() {
    this.avgDocLength = this.docCount > 0 ? this.totalTokens / this.docCount : 0;
  }

  /**
   * Calculate IDF (Inverse Document Frequency) for a term
   * @param {string} term
   * @returns {number}
   */
  _idf(term) {
    const postings = this.index.get(term);
    if (!postings || postings.size === 0) {
      return 0;
    }

    const df = postings.size;
    // Standard BM25 IDF formula
    return Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * Calculate BM25 score for a term in a document
   * @param {string} term
   * @param {string} id
   * @returns {number}
   */
  _bm25Score(term, id) {
    const postings = this.index.get(term);
    if (!postings) return 0;

    const posting = postings.get(id);
    if (!posting) return 0;

    const doc = this.documents.get(id);
    if (!doc) return 0;

    const tf = posting.frequency;
    const docLength = doc.length;
    const idf = this._idf(term);

    // BM25 formula
    const numerator = tf * (this.k1 + 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));

    return idf * (numerator / denominator);
  }

  /**
   * Search for documents matching a query
   * @param {string} query - Search query
   * @param {number} [limit=10] - Maximum results
   * @param {Object} [options] - Search options
   * @param {boolean} [options.matchAll=false] - Require all terms to match
   * @returns {Array<{id: string, score: number, highlights: string[]}>}
   */
  search(query, limit = 10, options = {}) {
    const { matchAll = false } = options;
    const queryTerms = this._processText(query);

    if (queryTerms.length === 0) {
      return [];
    }

    // Find all matching documents
    const scores = new Map();
    const matchedTerms = new Map(); // Track which terms each doc matches

    for (const term of queryTerms) {
      const postings = this.index.get(term);
      if (!postings) continue;

      for (const [id, posting] of postings) {
        const score = this._bm25Score(term, id);
        scores.set(id, (scores.get(id) || 0) + score);

        if (!matchedTerms.has(id)) {
          matchedTerms.set(id, new Set());
        }
        matchedTerms.get(id).add(term);
      }
    }

    // If matchAll, filter to documents matching all terms
    let results = [];
    for (const [id, score] of scores) {
      if (matchAll && matchedTerms.get(id).size < queryTerms.length) {
        continue;
      }
      results.push({
        id,
        score,
        matchedTerms: Array.from(matchedTerms.get(id)),
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit results
    return results.slice(0, limit);
  }

  /**
   * Get term frequency in the index
   * @param {string} term
   * @returns {number}
   */
  getTermFrequency(term) {
    const normalizedTerm = term.toLowerCase();
    const postings = this.index.get(normalizedTerm);
    return postings ? postings.size : 0;
  }

  /**
   * Get all unique terms in the index
   * @returns {string[]}
   */
  getTerms() {
    return Array.from(this.index.keys());
  }

  /**
   * Get the number of indexed documents
   * @returns {number}
   */
  size() {
    return this.docCount;
  }

  /**
   * Check if a document is in the index
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.documents.has(id);
  }

  /**
   * Serialize the index to a buffer
   * @returns {Buffer}
   */
  serialize() {
    const indexData = [];
    for (const [term, postings] of this.index) {
      const postingsArray = [];
      for (const [id, posting] of postings) {
        postingsArray.push([id, posting.frequency, posting.positions]);
      }
      indexData.push([term, postingsArray]);
    }

    const documentsData = [];
    for (const [id, doc] of this.documents) {
      documentsData.push([id, doc.length, doc.terms]);
    }

    const data = {
      version: 1,
      k1: this.k1,
      b: this.b,
      filterStopWords: this.filterStopWords,
      docCount: this.docCount,
      totalTokens: this.totalTokens,
      avgDocLength: this.avgDocLength,
      index: indexData,
      documents: documentsData,
    };

    return Buffer.from(JSON.stringify(data));
  }

  /**
   * Deserialize an index from a buffer
   * @param {Buffer} buffer
   * @returns {TextIndex}
   */
  static deserialize(buffer) {
    const data = JSON.parse(buffer.toString());

    if (data.version !== 1) {
      throw new Error(`Unsupported text index version: ${data.version}`);
    }

    const index = new TextIndex({
      k1: data.k1,
      b: data.b,
      removeStopWords: data.filterStopWords,
    });

    index.docCount = data.docCount;
    index.totalTokens = data.totalTokens;
    index.avgDocLength = data.avgDocLength;

    // Rebuild inverted index
    for (const [term, postingsArray] of data.index) {
      const postings = new Map();
      for (const [id, frequency, positions] of postingsArray) {
        postings.set(id, { id, frequency, positions });
      }
      index.index.set(term, postings);
    }

    // Rebuild documents
    for (const [id, length, terms] of data.documents) {
      index.documents.set(id, { length, terms });
    }

    index.dirty = false;
    return index;
  }

  /**
   * Save the index to disk
   * @param {string} [path] - Optional path override
   */
  save(path = null) {
    const savePath = path || this.indexPath;
    if (!savePath) {
      throw new Error("No index path specified for text index persistence");
    }

    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(savePath, this.serialize());
    this.dirty = false;
  }

  /**
   * Load the index from disk
   * @param {string} path
   * @returns {TextIndex}
   */
  static load(path) {
    if (!existsSync(path)) {
      throw new Error(`Text index file not found: ${path}`);
    }

    const buffer = readFileSync(path);
    const index = TextIndex.deserialize(buffer);
    index.indexPath = path;
    return index;
  }

  /**
   * Check if index needs to be persisted
   * @returns {boolean}
   */
  isDirty() {
    return this.dirty;
  }

  /**
   * Clear the index
   */
  clear() {
    this.index.clear();
    this.documents.clear();
    this.docCount = 0;
    this.totalTokens = 0;
    this.avgDocLength = 0;
    this.dirty = true;
  }

  /**
   * Rebuild index from records
   * @param {Iterable<{id: string, content: string, metadata?: Object}>} records
   * @param {Object} [options]
   * @returns {TextIndex}
   */
  static rebuildFromRecords(records, options = {}) {
    const index = new TextIndex(options);

    for (const { id, content, metadata } of records) {
      index.add(id, content, metadata);
    }

    return index;
  }
}

export default TextIndex;
