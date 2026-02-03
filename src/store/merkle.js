/**
 * Merkle Tree Implementation
 *
 * Provides integrity verification, snapshot hashing, and proof generation.
 * Uses SHA-256 for all hashing operations.
 *
 * Structure:
 * - Leaves are content hashes of records
 * - Internal nodes are hash(left_child || right_child)
 * - Tree is built incrementally as records are appended
 * - Supports proof generation and verification for any leaf
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/**
 * Compute SHA-256 hash of data
 * @param {Buffer|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute hash of two sibling nodes
 * @param {string} left - Left child hash
 * @param {string} right - Right child hash
 * @returns {string} Parent hash
 */
export function hashPair(left, right) {
  // Sort to ensure consistent ordering (canonical form)
  // This makes the tree order-independent for verification
  const combined = left < right ? left + right : right + left;
  return sha256(combined);
}

/**
 * MerkleTree class for append-only merkle tree operations
 */
export class MerkleTree {
  /**
   * @param {Object} options
   * @param {string} [options.indexPath] - Path to persist the tree
   */
  constructor(options = {}) {
    this.indexPath = options.indexPath || null;

    // Leaves are the content hashes of records (in order)
    this.leaves = [];

    // Cache of internal nodes: Map<level, Map<index, hash>>
    // Level 0 = leaves, Level 1 = first internal level, etc.
    this.nodes = new Map();
    this.nodes.set(0, new Map()); // Level 0 for leaves

    // Current root hash (null if tree is empty)
    this.root = null;

    // Dirty flag for persistence
    this.dirty = false;
  }

  /**
   * Get the current root hash
   * @returns {string|null} Root hash or null if empty
   */
  getRoot() {
    return this.root;
  }

  /**
   * Get the number of leaves in the tree
   * @returns {number}
   */
  getLeafCount() {
    return this.leaves.length;
  }

  /**
   * Add a new leaf to the tree
   * @param {string} contentHash - The content hash to add as a leaf
   * @returns {string} The new root hash
   */
  addLeaf(contentHash) {
    const leafIndex = this.leaves.length;
    this.leaves.push(contentHash);

    // Add to level 0
    this.nodes.get(0).set(leafIndex, contentHash);

    // Recalculate affected nodes up to the root
    this._recalculateFromLeaf(leafIndex);

    this.dirty = true;
    return this.root;
  }

  /**
   * Recalculate internal nodes from a leaf up to the root
   * @param {number} leafIndex - Index of the changed leaf
   * @private
   */
  _recalculateFromLeaf(leafIndex) {
    let index = leafIndex;
    let level = 0;
    const leafCount = this.leaves.length;

    // Calculate how many levels we need
    const maxLevel = leafCount <= 1 ? 0 : Math.ceil(Math.log2(leafCount));

    while (level <= maxLevel) {
      // Ensure this level exists
      if (!this.nodes.has(level)) {
        this.nodes.set(level, new Map());
      }

      const levelNodes = this.nodes.get(level);

      // Get sibling index
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      const parentIndex = Math.floor(index / 2);

      // Get current node value
      const currentValue = levelNodes.get(index);

      // Get sibling value (may not exist if we're at the edge)
      const siblingValue = levelNodes.get(siblingIndex);

      // Calculate parent value
      let parentValue;
      if (siblingValue === undefined) {
        // No sibling, promote this node up
        parentValue = currentValue;
      } else if (index % 2 === 0) {
        // Current is left child
        parentValue = hashPair(currentValue, siblingValue);
      } else {
        // Current is right child
        parentValue = hashPair(siblingValue, currentValue);
      }

      // Move to next level
      level++;
      if (!this.nodes.has(level)) {
        this.nodes.set(level, new Map());
      }
      this.nodes.get(level).set(parentIndex, parentValue);

      index = parentIndex;

      // If we're at index 0 at this level and there are no more nodes to combine,
      // we've reached the root
      const nodesAtLevel = this._countNodesAtLevel(level);
      if (nodesAtLevel <= 1) {
        this.root = parentValue;
        break;
      }
    }

    // Handle edge case: single leaf
    if (leafCount === 1) {
      this.root = this.leaves[0];
    }
  }

  /**
   * Count nodes at a given level
   * @param {number} level
   * @returns {number}
   * @private
   */
  _countNodesAtLevel(level) {
    if (!this.nodes.has(level)) return 0;
    return this.nodes.get(level).size;
  }

  /**
   * Generate a merkle proof for a leaf at the given index
   * @param {number} leafIndex - Index of the leaf to prove
   * @returns {Object} Proof object containing path and positions
   */
  generateProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Invalid leaf index: ${leafIndex}`);
    }

    const proof = {
      leafIndex,
      leafHash: this.leaves[leafIndex],
      siblings: [],
      root: this.root,
    };

    if (this.leaves.length === 1) {
      // Single leaf, no siblings needed
      return proof;
    }

    let index = leafIndex;
    let level = 0;
    const maxLevel = Math.ceil(Math.log2(this.leaves.length));

    while (level < maxLevel) {
      const levelNodes = this.nodes.get(level);
      if (!levelNodes) break;

      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      const siblingHash = levelNodes.get(siblingIndex);

      if (siblingHash !== undefined) {
        proof.siblings.push({
          hash: siblingHash,
          position: index % 2 === 0 ? "right" : "left",
        });
      }

      index = Math.floor(index / 2);
      level++;
    }

    return proof;
  }

  /**
   * Verify a merkle proof
   * @param {Object} proof - Proof object from generateProof
   * @returns {boolean} True if proof is valid
   */
  static verifyProof(proof) {
    if (!proof || !proof.leafHash || proof.root === undefined) {
      return false;
    }

    // Single leaf case
    if (proof.siblings.length === 0) {
      return proof.leafHash === proof.root;
    }

    let currentHash = proof.leafHash;

    for (const sibling of proof.siblings) {
      if (sibling.position === "right") {
        currentHash = hashPair(currentHash, sibling.hash);
      } else {
        currentHash = hashPair(sibling.hash, currentHash);
      }
    }

    return currentHash === proof.root;
  }

  /**
   * Verify integrity of the entire tree
   * @returns {boolean} True if tree is internally consistent
   */
  verifyIntegrity() {
    if (this.leaves.length === 0) {
      return this.root === null;
    }

    // Rebuild tree from leaves and compare root
    const rebuiltTree = new MerkleTree();
    for (const leaf of this.leaves) {
      rebuiltTree.addLeaf(leaf);
    }

    return rebuiltTree.root === this.root;
  }

  /**
   * Serialize the tree to a buffer for persistence
   * @returns {Buffer}
   */
  serialize() {
    const data = {
      version: 1,
      leafCount: this.leaves.length,
      leaves: this.leaves,
      root: this.root,
    };
    return Buffer.from(JSON.stringify(data));
  }

  /**
   * Deserialize a tree from a buffer
   * @param {Buffer} buffer
   * @returns {MerkleTree}
   */
  static deserialize(buffer) {
    const data = JSON.parse(buffer.toString());

    if (data.version !== 1) {
      throw new Error(`Unsupported merkle tree version: ${data.version}`);
    }

    const tree = new MerkleTree();

    // Rebuild tree from leaves
    for (const leaf of data.leaves) {
      tree.addLeaf(leaf);
    }

    // Verify root matches
    if (tree.root !== data.root) {
      throw new Error("Merkle tree integrity check failed: root mismatch");
    }

    tree.dirty = false;
    return tree;
  }

  /**
   * Save the tree to disk
   * @param {string} [path] - Optional path override
   */
  save(path = null) {
    const savePath = path || this.indexPath;
    if (!savePath) {
      throw new Error("No index path specified for merkle tree persistence");
    }

    // Ensure directory exists
    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(savePath, this.serialize());
    this.dirty = false;
  }

  /**
   * Load the tree from disk
   * @param {string} path - Path to load from
   * @returns {MerkleTree}
   */
  static load(path) {
    if (!existsSync(path)) {
      throw new Error(`Merkle tree file not found: ${path}`);
    }

    const buffer = readFileSync(path);
    const tree = MerkleTree.deserialize(buffer);
    tree.indexPath = path;
    return tree;
  }

  /**
   * Rebuild tree from an array of content hashes (e.g., from segment replay)
   * @param {string[]} contentHashes - Array of content hashes in order
   * @returns {MerkleTree}
   */
  static rebuildFromHashes(contentHashes) {
    const tree = new MerkleTree();
    for (const hash of contentHashes) {
      tree.addLeaf(hash);
    }
    return tree;
  }

  /**
   * Get the leaf hash at a given index
   * @param {number} index
   * @returns {string|undefined}
   */
  getLeaf(index) {
    return this.leaves[index];
  }

  /**
   * Check if tree needs to be persisted
   * @returns {boolean}
   */
  isDirty() {
    return this.dirty;
  }

  /**
   * Clear the tree
   */
  clear() {
    this.leaves = [];
    this.nodes = new Map();
    this.nodes.set(0, new Map());
    this.root = null;
    this.dirty = true;
  }

  /**
   * Get a snapshot of the tree state at current point
   * @returns {Object}
   */
  getSnapshot() {
    return {
      root: this.root,
      leafCount: this.leaves.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Find the first leaf index where the proof differs between two trees
   * Useful for finding fork points
   * @param {MerkleTree} other - Other tree to compare
   * @returns {number|null} Index of first difference, or null if identical
   */
  findDivergencePoint(other) {
    const minLength = Math.min(this.leaves.length, other.leaves.length);

    for (let i = 0; i < minLength; i++) {
      if (this.leaves[i] !== other.leaves[i]) {
        return i;
      }
    }

    // If one tree is longer, divergence starts at the end of the shorter
    if (this.leaves.length !== other.leaves.length) {
      return minLength;
    }

    return null; // Trees are identical
  }
}

export default MerkleTree;
