/**
 * Vector Index Implementation (HNSW - Hierarchical Navigable Small World)
 *
 * Provides fast approximate nearest neighbor search for semantic queries.
 * Only indexes the latest version of each memory.
 *
 * HNSW Parameters:
 * - M: Maximum number of connections per node (default 16)
 * - efConstruction: Size of dynamic candidate list during construction (default 200)
 * - efSearch: Size of dynamic candidate list during search (default 50)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Calculate cosine similarity between two vectors
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} Similarity score between -1 and 1
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Calculate Euclidean distance between two vectors
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} Distance (0 = identical)
 */
export function euclideanDistance(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * HNSW Node representing a vector in the graph
 */
class HNSWNode {
  constructor(id, vector, level) {
    this.id = id;
    this.vector = vector;
    this.level = level;
    // Connections per level: Array<Set<id>>
    this.connections = [];
    for (let i = 0; i <= level; i++) {
      this.connections.push(new Set());
    }
  }
}

/**
 * Priority queue for HNSW search (min-heap by distance)
 */
class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this._bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    if (this.items.length === 1) return this.items.pop();

    const result = this.items[0];
    this.items[0] = this.items.pop();
    this._bubbleDown(0);
    return result;
  }

  peek() {
    return this.items[0] || null;
  }

  get size() {
    return this.items.length;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.items[index].distance >= this.items[parentIndex].distance) break;
      [this.items[index], this.items[parentIndex]] = [this.items[parentIndex], this.items[index]];
      index = parentIndex;
    }
  }

  _bubbleDown(index) {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.items.length &&
          this.items[leftChild].distance < this.items[smallest].distance) {
        smallest = leftChild;
      }
      if (rightChild < this.items.length &&
          this.items[rightChild].distance < this.items[smallest].distance) {
        smallest = rightChild;
      }

      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

/**
 * Priority queue (max-heap by distance)
 */
class MaxHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this._bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    if (this.items.length === 1) return this.items.pop();

    const result = this.items[0];
    this.items[0] = this.items.pop();
    this._bubbleDown(0);
    return result;
  }

  peek() {
    return this.items[0] || null;
  }

  get size() {
    return this.items.length;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.items[index].distance <= this.items[parentIndex].distance) break;
      [this.items[index], this.items[parentIndex]] = [this.items[parentIndex], this.items[index]];
      index = parentIndex;
    }
  }

  _bubbleDown(index) {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let largest = index;

      if (leftChild < this.items.length &&
          this.items[leftChild].distance > this.items[largest].distance) {
        largest = leftChild;
      }
      if (rightChild < this.items.length &&
          this.items[rightChild].distance > this.items[largest].distance) {
        largest = rightChild;
      }

      if (largest === index) break;
      [this.items[index], this.items[largest]] = [this.items[largest], this.items[index]];
      index = largest;
    }
  }
}

/**
 * VectorIndex class implementing HNSW algorithm
 */
export class VectorIndex {
  /**
   * @param {Object} options
   * @param {string} [options.indexPath] - Path to persist the index
   * @param {number} [options.M=16] - Max connections per node
   * @param {number} [options.efConstruction=200] - Construction search size
   * @param {number} [options.efSearch=50] - Search candidate list size
   * @param {number} [options.dimensions=384] - Vector dimensions
   */
  constructor(options = {}) {
    this.indexPath = options.indexPath || null;
    this.M = options.M || 16;
    this.efConstruction = options.efConstruction || 200;
    this.efSearch = options.efSearch || 50;
    this.dimensions = options.dimensions || 384;

    // Maximum connections at layer 0 (2 * M for better recall)
    this.M0 = this.M * 2;

    // Level multiplier for random level generation
    this.ml = 1 / Math.log(this.M);

    // Map<id, HNSWNode>
    this.nodes = new Map();

    // Entry point (node at highest level)
    this.entryPoint = null;
    this.maxLevel = -1;

    this.dirty = false;
  }

  /**
   * Generate random level for a new node
   * @returns {number}
   */
  _randomLevel() {
    let level = 0;
    while (Math.random() < 1 / this.M && level < 16) {
      level++;
    }
    return level;
  }

  /**
   * Get distance between query and a node (using cosine distance = 1 - similarity)
   * @param {Float32Array|number[]} query
   * @param {string} nodeId
   * @returns {number}
   */
  _distance(query, nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return Infinity;
    // Use cosine distance (1 - similarity) so lower is better
    return 1 - cosineSimilarity(query, node.vector);
  }

  /**
   * Search for nearest neighbors at a specific layer
   * @param {Float32Array|number[]} query
   * @param {string} entryId
   * @param {number} ef - Number of candidates to track
   * @param {number} layer
   * @returns {Array<{id: string, distance: number}>}
   */
  _searchLayer(query, entryId, ef, layer) {
    const visited = new Set([entryId]);
    const candidates = new MinHeap(); // Candidates to explore
    const results = new MaxHeap();    // Best results so far

    const entryDist = this._distance(query, entryId);
    candidates.push({ id: entryId, distance: entryDist });
    results.push({ id: entryId, distance: entryDist });

    while (candidates.size > 0) {
      const current = candidates.pop();

      // If current candidate is worse than our worst result, stop
      if (results.size >= ef && current.distance > results.peek().distance) {
        break;
      }

      const node = this.nodes.get(current.id);
      if (!node || layer >= node.connections.length) continue;

      // Explore neighbors at this layer
      for (const neighborId of node.connections[layer]) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const dist = this._distance(query, neighborId);

        // Add to results if better than worst, or if results not full
        if (results.size < ef || dist < results.peek().distance) {
          candidates.push({ id: neighborId, distance: dist });
          results.push({ id: neighborId, distance: dist });

          // Keep only top ef results
          if (results.size > ef) {
            results.pop();
          }
        }
      }
    }

    // Convert max heap to sorted array
    const resultArray = [];
    while (results.size > 0) {
      resultArray.push(results.pop());
    }
    return resultArray.reverse(); // Closest first
  }

  /**
   * Select neighbors using simple heuristic
   * @param {Array<{id: string, distance: number}>} candidates
   * @param {number} maxConnections
   * @returns {string[]}
   */
  _selectNeighbors(candidates, maxConnections) {
    // Sort by distance and take top maxConnections
    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxConnections)
      .map(c => c.id);
  }

  /**
   * Insert a vector into the index
   * @param {string} id - Memory ID
   * @param {Float32Array|number[]} vector - Embedding vector
   */
  insert(id, vector) {
    if (!vector || vector.length !== this.dimensions) {
      throw new Error(`Invalid vector: expected ${this.dimensions} dimensions, got ${vector?.length}`);
    }

    // If this ID already exists, remove it first
    if (this.nodes.has(id)) {
      this.remove(id);
    }

    const level = this._randomLevel();
    const node = new HNSWNode(id, vector, level);
    this.nodes.set(id, node);

    // If this is the first node
    if (!this.entryPoint) {
      this.entryPoint = id;
      this.maxLevel = level;
      this.dirty = true;
      return;
    }

    let currentId = this.entryPoint;
    const query = vector;

    // Navigate from top level down to level+1
    for (let l = this.maxLevel; l > level; l--) {
      const results = this._searchLayer(query, currentId, 1, l);
      if (results.length > 0) {
        currentId = results[0].id;
      }
    }

    // Insert at each level from level down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const results = this._searchLayer(query, currentId, this.efConstruction, l);
      const maxConn = l === 0 ? this.M0 : this.M;
      const neighbors = this._selectNeighbors(results, maxConn);

      // Add bidirectional connections
      for (const neighborId of neighbors) {
        node.connections[l].add(neighborId);

        const neighbor = this.nodes.get(neighborId);
        if (neighbor && l < neighbor.connections.length) {
          neighbor.connections[l].add(id);

          // Prune neighbor connections if needed
          if (neighbor.connections[l].size > maxConn) {
            const neighborNeighbors = [];
            for (const nnId of neighbor.connections[l]) {
              neighborNeighbors.push({
                id: nnId,
                distance: this._distance(neighbor.vector, nnId),
              });
            }
            const pruned = this._selectNeighbors(neighborNeighbors, maxConn);
            neighbor.connections[l] = new Set(pruned);
          }
        }
      }

      if (results.length > 0) {
        currentId = results[0].id;
      }
    }

    // Update entry point if new node is at higher level
    if (level > this.maxLevel) {
      this.entryPoint = id;
      this.maxLevel = level;
    }

    this.dirty = true;
  }

  /**
   * Remove a vector from the index
   * @param {string} id - Memory ID
   */
  remove(id) {
    const node = this.nodes.get(id);
    if (!node) return;

    // Remove from all neighbors' connections
    for (let l = 0; l <= node.level; l++) {
      for (const neighborId of node.connections[l]) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor && l < neighbor.connections.length) {
          neighbor.connections[l].delete(id);
        }
      }
    }

    this.nodes.delete(id);

    // If we removed the entry point, find a new one
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = -1;
      } else {
        // Find node with highest level
        let maxLevel = -1;
        let newEntry = null;
        for (const [nodeId, n] of this.nodes) {
          if (n.level > maxLevel) {
            maxLevel = n.level;
            newEntry = nodeId;
          }
        }
        this.entryPoint = newEntry;
        this.maxLevel = maxLevel;
      }
    }

    this.dirty = true;
  }

  /**
   * Search for k nearest neighbors
   * @param {Float32Array|number[]} query - Query vector
   * @param {number} [k=10] - Number of results
   * @param {number} [ef] - Search candidate list size (default: efSearch)
   * @returns {Array<{id: string, similarity: number}>}
   */
  search(query, k = 10, ef = null) {
    if (!query || query.length !== this.dimensions) {
      throw new Error(`Invalid query: expected ${this.dimensions} dimensions, got ${query?.length}`);
    }

    if (!this.entryPoint || this.nodes.size === 0) {
      return [];
    }

    ef = ef || this.efSearch;
    ef = Math.max(ef, k); // ef must be at least k

    let currentId = this.entryPoint;

    // Navigate from top level down to level 1
    for (let l = this.maxLevel; l > 0; l--) {
      const results = this._searchLayer(query, currentId, 1, l);
      if (results.length > 0) {
        currentId = results[0].id;
      }
    }

    // Search at level 0 with full ef
    const results = this._searchLayer(query, currentId, ef, 0);

    // Return top k with similarity scores
    return results.slice(0, k).map(r => ({
      id: r.id,
      similarity: 1 - r.distance, // Convert distance back to similarity
    }));
  }

  /**
   * Get the number of indexed vectors
   * @returns {number}
   */
  size() {
    return this.nodes.size;
  }

  /**
   * Check if an ID is in the index
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.nodes.has(id);
  }

  /**
   * Serialize the index to a buffer
   * @returns {Buffer}
   */
  serialize() {
    const nodesData = [];
    for (const [id, node] of this.nodes) {
      nodesData.push({
        id,
        vector: Array.from(node.vector),
        level: node.level,
        connections: node.connections.map(set => Array.from(set)),
      });
    }

    const data = {
      version: 1,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      dimensions: this.dimensions,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      nodes: nodesData,
    };

    return Buffer.from(JSON.stringify(data));
  }

  /**
   * Deserialize an index from a buffer
   * @param {Buffer} buffer
   * @returns {VectorIndex}
   */
  static deserialize(buffer) {
    const data = JSON.parse(buffer.toString());

    if (data.version !== 1) {
      throw new Error(`Unsupported vector index version: ${data.version}`);
    }

    const index = new VectorIndex({
      M: data.M,
      efConstruction: data.efConstruction,
      efSearch: data.efSearch,
      dimensions: data.dimensions,
    });

    index.entryPoint = data.entryPoint;
    index.maxLevel = data.maxLevel;

    for (const nodeData of data.nodes) {
      const node = new HNSWNode(
        nodeData.id,
        new Float32Array(nodeData.vector),
        nodeData.level
      );
      node.connections = nodeData.connections.map(arr => new Set(arr));
      index.nodes.set(nodeData.id, node);
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
      throw new Error("No index path specified for vector index persistence");
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
   * @returns {VectorIndex}
   */
  static load(path) {
    if (!existsSync(path)) {
      throw new Error(`Vector index file not found: ${path}`);
    }

    const buffer = readFileSync(path);
    const index = VectorIndex.deserialize(buffer);
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
    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = -1;
    this.dirty = true;
  }

  /**
   * Rebuild index from records
   * @param {Iterable<{id: string, vector: Float32Array}>} vectors
   * @param {Object} [options]
   * @returns {VectorIndex}
   */
  static rebuildFromVectors(vectors, options = {}) {
    const index = new VectorIndex(options);

    for (const { id, vector } of vectors) {
      if (vector) {
        index.insert(id, vector);
      }
    }

    return index;
  }
}

export default VectorIndex;
