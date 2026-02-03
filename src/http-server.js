/**
 * HTTP Server Module
 *
 * Provides a simple HTTP API for the memory system.
 * Designed for local use with a modular architecture to support
 * authentication middleware in the future.
 *
 * All endpoints accept and return JSON.
 * Uses Bun's built-in HTTP server for high performance.
 *
 * @module http-server
 */

import { generateEmbedding, preloadModel } from './embeddings.js';
import {
  initStore,
  closeStore,
  setEmbedFunction,
  getStore,
  // Memory operations
  addMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  getDueMemories,
  // Relationship operations
  addRelationship,
  removeRelationship,
  getRelationships,
  getRelatedMemories,
  // Fork and snapshot operations
  createFork,
  createForkAtTime,
  listForks,
  deleteFork,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  // Store operations
  getStats,
  getStoreSnapshot,
  verifyIntegrity,
  rebuildIndexes,
  compactWAL,
  flush
} from './store-adapter.js';

/**
 * Debug UI HTML Template
 * A simple web interface for browsing memory stores
 */
const DEBUG_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memory Store Debug Interface</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #1a1a2e;
      color: #eee;
      line-height: 1.6;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      background: #16213e;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { color: #00d9ff; font-size: 1.5rem; }
    h2 { color: #00d9ff; font-size: 1.2rem; margin-bottom: 15px; }
    h3 { color: #7dd3fc; font-size: 1rem; margin-bottom: 10px; }
    .status { color: #4ade80; font-size: 0.9rem; }
    .status.error { color: #f87171; }

    .layout {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 20px;
    }

    .sidebar {
      background: #16213e;
      border-radius: 8px;
      padding: 15px;
      height: fit-content;
      position: sticky;
      top: 20px;
    }

    .store-list {
      list-style: none;
    }
    .store-item {
      padding: 12px;
      margin-bottom: 8px;
      background: #1a1a2e;
      border-radius: 6px;
      cursor: pointer;
      border: 2px solid transparent;
      transition: all 0.2s;
    }
    .store-item:hover { border-color: #00d9ff; }
    .store-item.active { border-color: #00d9ff; background: #0f3460; }
    .store-item .name { font-weight: 600; margin-bottom: 4px; }
    .store-item .meta { font-size: 0.8rem; color: #94a3b8; }
    .store-item .type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      text-transform: uppercase;
      margin-left: 8px;
    }
    .store-item .type-badge.main { background: #065f46; color: #6ee7b7; }
    .store-item .type-badge.fork { background: #7c2d12; color: #fdba74; }

    .main-content {
      background: #16213e;
      border-radius: 8px;
      padding: 20px;
    }

    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 2px solid #1a1a2e;
      padding-bottom: 10px;
    }
    .tab {
      padding: 8px 16px;
      background: #1a1a2e;
      border: none;
      border-radius: 6px;
      color: #94a3b8;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.2s;
    }
    .tab:hover { color: #eee; background: #0f3460; }
    .tab.active { background: #00d9ff; color: #1a1a2e; font-weight: 600; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: #1a1a2e;
      padding: 15px;
      border-radius: 6px;
      text-align: center;
    }
    .stat-value { font-size: 2rem; font-weight: 700; color: #00d9ff; }
    .stat-label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; }

    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .search-box input {
      flex: 1;
      padding: 10px 15px;
      background: #1a1a2e;
      border: 2px solid #334155;
      border-radius: 6px;
      color: #eee;
      font-size: 0.9rem;
    }
    .search-box input:focus { outline: none; border-color: #00d9ff; }
    .search-box button {
      padding: 10px 20px;
      background: #00d9ff;
      border: none;
      border-radius: 6px;
      color: #1a1a2e;
      font-weight: 600;
      cursor: pointer;
    }
    .search-box button:hover { background: #22d3ee; }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 15px;
      font-size: 0.9rem;
      color: #94a3b8;
    }
    .checkbox-group input { width: 18px; height: 18px; cursor: pointer; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #334155;
    }
    th {
      background: #1a1a2e;
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      position: sticky;
      top: 0;
    }
    tr:hover { background: #1a1a2e; }
    td.content {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    td.content:hover {
      white-space: normal;
      word-break: break-word;
    }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      background: #334155;
      border-radius: 4px;
      font-size: 0.75rem;
      margin-right: 4px;
      margin-bottom: 4px;
    }

    .deleted { color: #f87171; text-decoration: line-through; opacity: 0.7; }

    .memory-detail {
      background: #1a1a2e;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
    }
    .memory-detail pre {
      background: #0f172a;
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
      line-height: 1.5;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: #94a3b8;
    }
    .loading::after {
      content: '';
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid #334155;
      border-top-color: #00d9ff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-left: 10px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #94a3b8;
    }
    .empty-state h3 { color: #64748b; margin-bottom: 10px; }

    .hash { font-family: monospace; font-size: 0.75rem; color: #64748b; }

    .clickable { cursor: pointer; color: #00d9ff; }
    .clickable:hover { text-decoration: underline; }

    .refresh-btn {
      padding: 8px 16px;
      background: transparent;
      border: 2px solid #00d9ff;
      border-radius: 6px;
      color: #00d9ff;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .refresh-btn:hover { background: #00d9ff; color: #1a1a2e; }

    .error-box {
      background: #450a0a;
      border: 1px solid #dc2626;
      color: #fca5a5;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 15px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Memory Store Debug Interface</h1>
        <div class="status" id="connectionStatus">Connecting...</div>
      </div>
      <button class="refresh-btn" onclick="refreshAll()">Refresh All</button>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <h2>Stores</h2>
        <ul class="store-list" id="storeList">
          <li class="loading">Loading stores</li>
        </ul>
      </aside>

      <main class="main-content">
        <div id="storeContent">
          <div class="empty-state">
            <h3>Select a Store</h3>
            <p>Choose a store from the sidebar to view its contents</p>
          </div>
        </div>
      </main>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin;
    let currentStore = null;
    let currentTab = 'memories';
    let includeDeleted = false;

    // Fetch helpers
    async function fetchJson(url) {
      const res = await fetch(API_BASE + url);
      if (!res.ok) throw new Error(\`HTTP \${res.status}: \${res.statusText}\`);
      return res.json();
    }

    // Load stores list
    async function loadStores() {
      try {
        const data = await fetchJson('/debug/stores');
        document.getElementById('connectionStatus').textContent = 'Connected';
        document.getElementById('connectionStatus').className = 'status';
        renderStoreList(data.stores);
      } catch (e) {
        document.getElementById('connectionStatus').textContent = 'Error: ' + e.message;
        document.getElementById('connectionStatus').className = 'status error';
        document.getElementById('storeList').innerHTML = '<li class="error-box">Failed to load stores: ' + e.message + '</li>';
      }
    }

    function renderStoreList(stores) {
      const list = document.getElementById('storeList');
      if (!stores.length) {
        list.innerHTML = '<li class="empty-state"><h3>No Stores Found</h3></li>';
        return;
      }
      list.innerHTML = stores.map(store => \`
        <li class="store-item \${currentStore === store.id ? 'active' : ''}" onclick="selectStore('\${store.id}')">
          <div class="name">
            \${store.name}
            <span class="type-badge \${store.type}">\${store.type}</span>
          </div>
          <div class="meta">
            \${store.memoryCount ?? 0} memories, \${store.relationshipCount ?? 0} relationships
            \${store.error ? '<br><span style="color:#f87171">Error: ' + store.error + '</span>' : ''}
          </div>
        </li>
      \`).join('');
    }

    // Select and load a store
    async function selectStore(storeId) {
      currentStore = storeId;
      document.querySelectorAll('.store-item').forEach(el => el.classList.remove('active'));
      document.querySelector(\`.store-item[onclick="selectStore('\${storeId}')"]\`)?.classList.add('active');
      await loadStoreContent();
    }

    async function loadStoreContent() {
      if (!currentStore) return;

      const content = document.getElementById('storeContent');
      content.innerHTML = '<div class="loading">Loading store data</div>';

      try {
        // Load stats and index info
        const [stats, indexes] = await Promise.all([
          fetchJson(\`/stats?store_id=\${currentStore}\`),
          fetchJson(\`/debug/stores/\${currentStore}/indexes\`)
        ]);

        let html = \`
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value">\${stats.memoryCount ?? 0}</div>
              <div class="stat-label">Memories</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${stats.deletedMemoryCount ?? 0}</div>
              <div class="stat-label">Deleted</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${stats.relationshipCount ?? 0}</div>
              <div class="stat-label">Relationships</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${indexes.vectorIndex?.size ?? 0}</div>
              <div class="stat-label">Vector Index</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${indexes.textIndex?.size ?? 0}</div>
              <div class="stat-label">Text Index</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">\${indexes.merkleTree?.leafCount ?? 0}</div>
              <div class="stat-label">Merkle Leaves</div>
            </div>
          </div>

          <div class="tabs">
            <button class="tab \${currentTab === 'memories' ? 'active' : ''}" onclick="switchTab('memories')">Memories</button>
            <button class="tab \${currentTab === 'relationships' ? 'active' : ''}" onclick="switchTab('relationships')">Relationships</button>
            <button class="tab \${currentTab === 'wal' ? 'active' : ''}" onclick="switchTab('wal')">WAL Records</button>
            <button class="tab \${currentTab === 'indexes' ? 'active' : ''}" onclick="switchTab('indexes')">Index Details</button>
          </div>

          <div class="checkbox-group">
            <input type="checkbox" id="includeDeleted" \${includeDeleted ? 'checked' : ''} onchange="toggleDeleted()">
            <label for="includeDeleted">Include deleted/archived items</label>
          </div>

          <div id="tabContent"></div>
        \`;

        content.innerHTML = html;
        await loadTabContent();
      } catch (e) {
        content.innerHTML = '<div class="error-box">Error loading store: ' + e.message + '</div>';
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.querySelector(\`.tab[onclick="switchTab('\${tab}')"]\`)?.classList.add('active');
      loadTabContent();
    }

    function toggleDeleted() {
      includeDeleted = document.getElementById('includeDeleted').checked;
      loadTabContent();
    }

    async function loadTabContent() {
      const container = document.getElementById('tabContent');
      if (!container) return;

      container.innerHTML = '<div class="loading">Loading</div>';

      try {
        switch (currentTab) {
          case 'memories':
            await loadMemories(container);
            break;
          case 'relationships':
            await loadRelationships(container);
            break;
          case 'wal':
            await loadWAL(container);
            break;
          case 'indexes':
            await loadIndexDetails(container);
            break;
        }
      } catch (e) {
        container.innerHTML = '<div class="error-box">Error: ' + e.message + '</div>';
      }
    }

    async function loadMemories(container) {
      const data = await fetchJson(\`/debug/stores/\${currentStore}/memories?includeDeleted=\${includeDeleted}&limit=500\`);

      if (!data.memories.length) {
        container.innerHTML = '<div class="empty-state"><h3>No Memories</h3><p>This store has no memories.</p></div>';
        return;
      }

      container.innerHTML = \`
        <div style="margin-bottom:10px;color:#94a3b8;">Showing \${data.memories.length} of \${data.count} memories</div>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Ver</th>
                <th>Category</th>
                <th>Type</th>
                <th>Content</th>
                <th>Tags</th>
                <th>Importance</th>
                <th>Created</th>
                <th>Embedding</th>
              </tr>
            </thead>
            <tbody>
              \${data.memories.map(m => \`
                <tr class="\${m.deleted ? 'deleted' : ''}">
                  <td class="clickable hash" onclick="showMemoryDetail('\${m.id}')" title="\${m.id}">\${m.id.slice(0,8)}...</td>
                  <td>\${m.version}</td>
                  <td>\${m.category || '-'}</td>
                  <td>\${m.type || '-'}</td>
                  <td class="content" title="\${escapeHtml(m.content)}">\${escapeHtml(m.content)}</td>
                  <td>\${(m.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('')}</td>
                  <td>\${m.importance}</td>
                  <td>\${formatDate(m.createdAt)}</td>
                  <td>\${m.hasEmbedding ? 'Yes' : 'No'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    async function loadRelationships(container) {
      const data = await fetchJson(\`/debug/stores/\${currentStore}/relationships?includeDeleted=\${includeDeleted}\`);

      if (!data.relationships.length) {
        container.innerHTML = '<div class="empty-state"><h3>No Relationships</h3><p>This store has no relationships.</p></div>';
        return;
      }

      container.innerHTML = \`
        <div style="margin-bottom:10px;color:#94a3b8;">Showing \${data.relationships.length} relationships</div>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Ver</th>
                <th>From Memory</th>
                <th>Relationship</th>
                <th>To Memory</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              \${data.relationships.map(r => \`
                <tr class="\${r.deleted ? 'deleted' : ''}">
                  <td class="hash" title="\${r.id}">\${r.id.slice(0,8)}...</td>
                  <td>\${r.version}</td>
                  <td class="clickable hash" onclick="showMemoryDetail('\${r.memoryId}')" title="\${r.memoryId}">\${r.memoryId.slice(0,8)}...</td>
                  <td><span class="tag">\${r.relationshipType}</span></td>
                  <td class="clickable hash" onclick="showMemoryDetail('\${r.relatedMemoryId}')" title="\${r.relatedMemoryId}">\${r.relatedMemoryId.slice(0,8)}...</td>
                  <td>\${formatDate(r.createdAt)}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    async function loadWAL(container) {
      const data = await fetchJson(\`/debug/stores/\${currentStore}/wal\`);

      if (!data.records.length) {
        container.innerHTML = '<div class="empty-state"><h3>WAL Empty</h3><p>The Write-Ahead Log has no pending records (all records may have been compacted to segments).</p></div>';
        return;
      }

      container.innerHTML = \`
        <div style="margin-bottom:10px;color:#94a3b8;">WAL contains \${data.recordCount} records</div>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>ID</th>
                <th>Version</th>
                <th>Timestamp</th>
                <th>Content Hash</th>
                <th>Deleted</th>
              </tr>
            </thead>
            <tbody>
              \${data.records.map(r => \`
                <tr class="\${r.deleted ? 'deleted' : ''}">
                  <td><span class="tag">\${r.type}</span></td>
                  <td class="hash" title="\${r.id}">\${r.id?.slice(0,8) || '-'}...</td>
                  <td>\${r.version}</td>
                  <td>\${formatDate(new Date(r.timestamp).toISOString())}</td>
                  <td class="hash" title="\${r.contentHash}">\${r.contentHash?.slice(0,12) || '-'}...</td>
                  <td>\${r.deleted ? 'Yes' : 'No'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    async function loadIndexDetails(container) {
      const data = await fetchJson(\`/debug/stores/\${currentStore}/indexes\`);

      container.innerHTML = \`
        <div class="memory-detail">
          <h3>Index Statistics</h3>
          <pre>\${JSON.stringify(data, null, 2)}</pre>
        </div>
      \`;
    }

    async function showMemoryDetail(memoryId) {
      try {
        const data = await fetchJson(\`/debug/stores/\${currentStore}/memories/\${memoryId}\`);

        const detailHtml = \`
          <div class="memory-detail">
            <h3>Memory Details</h3>
            <button onclick="this.parentElement.remove()" style="float:right;background:#334155;border:none;color:#eee;padding:5px 10px;border-radius:4px;cursor:pointer;">Close</button>
            <pre>\${JSON.stringify(data, null, 2)}</pre>
          </div>
        \`;

        const existing = document.querySelector('.memory-detail');
        if (existing) existing.remove();

        document.getElementById('tabContent').insertAdjacentHTML('beforeend', detailHtml);
      } catch (e) {
        alert('Error loading memory: ' + e.message);
      }
    }

    function formatDate(isoString) {
      if (!isoString) return '-';
      const d = new Date(isoString);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function refreshAll() {
      loadStores();
      if (currentStore) loadStoreContent();
    }

    // Initialize
    loadStores();
  </script>
</body>
</html>`;

/**
 * Parse JSON body from request.
 *
 * @param {Request} request - Incoming request
 * @returns {Promise<Object>} Parsed JSON body
 */
async function parseBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Create a JSON response.
 *
 * @param {any} data - Response data
 * @param {number} [status=200] - HTTP status code
 * @returns {Response} HTTP response
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

/**
 * Create an error response.
 *
 * @param {string} message - Error message
 * @param {number} [status=400] - HTTP status code
 * @returns {Response} HTTP error response
 */
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Get store ID from query params or body.
 *
 * @param {Request} request - HTTP request
 * @param {Object} [body] - Parsed body
 * @returns {string} Store ID
 */
function getStoreId(request, body = {}) {
  const url = new URL(request.url);
  return url.searchParams.get('store_id') || body.store_id || 'main';
}

/**
 * Route definitions for the HTTP API.
 * Each route specifies method, path pattern, and handler.
 */
const routes = [
  // Health check
  {
    method: 'GET',
    path: '/health',
    handler: () =>
      jsonResponse({ status: 'ok', service: 'memory-server', version: '2.0.0' })
  },

  // Memory CRUD - specific paths MUST come before parameterized paths
  {
    method: 'POST',
    path: '/memories',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const { store_id, ...memoryData } = body;
      const memory = await addMemory(memoryData, storeId);
      return jsonResponse(memory, 201);
    }
  },
  // Due memories - must be before /memories/:id
  {
    method: 'GET',
    path: '/memories/due',
    handler: async (request) => {
      const storeId = getStoreId(request);
      const memories = await getDueMemories(new Date(), storeId);
      return jsonResponse(memories);
    }
  },
  // Search - must be before /memories/:id
  {
    method: 'POST',
    path: '/memories/search',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const results = await searchMemories(
        body.query,
        {
          mode: body.mode,
          limit: body.limit,
          semanticWeight: body.semanticWeight
        },
        storeId
      );
      return jsonResponse(results);
    }
  },
  {
    method: 'GET',
    path: '/memories/:id',
    handler: async (request, params) => {
      const storeId = getStoreId(request);
      const memory = await getMemory(params.id, storeId);
      if (!memory) {
        return errorResponse('Memory not found', 404);
      }
      return jsonResponse(memory);
    }
  },
  {
    method: 'PUT',
    path: '/memories/:id',
    handler: async (request, params) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const { store_id, ...updates } = body;
      const memory = await updateMemory(params.id, updates, storeId);
      if (!memory) {
        return errorResponse('Memory not found', 404);
      }
      return jsonResponse(memory);
    }
  },
  {
    method: 'DELETE',
    path: '/memories/:id',
    handler: async (request, params) => {
      const storeId = getStoreId(request);
      const deleted = await deleteMemory(params.id, storeId);
      return jsonResponse({ deleted });
    }
  },

  // List memories
  {
    method: 'GET',
    path: '/memories',
    handler: async (request) => {
      const url = new URL(request.url);
      const storeId = getStoreId(request);
      const options = {
        category: url.searchParams.get('category') || undefined,
        type: url.searchParams.get('type') || undefined,
        limit: parseInt(url.searchParams.get('limit')) || 100,
        offset: parseInt(url.searchParams.get('offset')) || 0,
        includeArchived: url.searchParams.get('includeArchived') === 'true'
      };
      const memories = await listMemories(options, storeId);
      return jsonResponse(memories);
    }
  },

  // Stats
  {
    method: 'GET',
    path: '/stats',
    handler: async (request) => {
      const storeId = getStoreId(request);
      const stats = await getStats(storeId);
      return jsonResponse(stats);
    }
  },

  // Relationships
  {
    method: 'POST',
    path: '/relationships',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const relationship = await addRelationship(
        body.memory_id,
        body.related_memory_id,
        body.relationship_type || 'related_to',
        storeId
      );
      return jsonResponse(relationship, 201);
    }
  },
  {
    method: 'DELETE',
    path: '/relationships/:id',
    handler: async (request, params) => {
      const storeId = getStoreId(request);
      const removed = await removeRelationship(params.id, storeId);
      return jsonResponse({ removed });
    }
  },
  {
    method: 'GET',
    path: '/memories/:id/relationships',
    handler: async (request, params) => {
      const storeId = getStoreId(request);
      const relationships = await getRelationships(params.id, {}, storeId);
      return jsonResponse(relationships);
    }
  },
  {
    method: 'GET',
    path: '/memories/:id/related',
    handler: async (request, params) => {
      const url = new URL(request.url);
      const storeId = getStoreId(request);
      const options = {
        maxDepth: parseInt(url.searchParams.get('maxDepth')) || 2
      };
      const relationshipTypes = url.searchParams.get('relationshipTypes');
      if (relationshipTypes) {
        options.relationshipTypes = relationshipTypes.split(',');
      }
      const related = await getRelatedMemories(params.id, options, storeId);
      return jsonResponse(related);
    }
  },

  // Fork operations
  {
    method: 'POST',
    path: '/forks',
    handler: async (request) => {
      const body = await parseBody(request);
      const sourceStoreId = body.source_store_id || 'main';
      const fork = await createFork(sourceStoreId, { name: body.name });
      return jsonResponse(fork, 201);
    }
  },
  {
    method: 'POST',
    path: '/forks/pitr',
    handler: async (request) => {
      const body = await parseBody(request);
      const sourceStoreId = body.source_store_id || 'main';
      const fork = await createForkAtTime(sourceStoreId, body.timestamp, {
        name: body.name
      });
      return jsonResponse(fork, 201);
    }
  },
  {
    method: 'GET',
    path: '/forks',
    handler: async () => {
      const forks = await listForks();
      return jsonResponse(forks);
    }
  },
  {
    method: 'DELETE',
    path: '/forks/:id',
    handler: async (request, params) => {
      await deleteFork(params.id);
      return jsonResponse({ deleted: true });
    }
  },

  // Snapshot operations
  {
    method: 'POST',
    path: '/snapshots',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const snapshot = await createSnapshot(body.name, storeId);
      return jsonResponse(snapshot, 201);
    }
  },
  {
    method: 'GET',
    path: '/snapshots',
    handler: async (request) => {
      const storeId = getStoreId(request);
      const snapshots = await listSnapshots(storeId);
      return jsonResponse(snapshots);
    }
  },
  {
    method: 'POST',
    path: '/snapshots/:id/restore',
    handler: async (request, params) => {
      const body = await parseBody(request);
      const result = await restoreSnapshot(params.id, { name: body.name });
      return jsonResponse(result, 201);
    }
  },

  // Store management
  {
    method: 'GET',
    path: '/store/snapshot',
    handler: async (request) => {
      const storeId = getStoreId(request);
      const snapshot = await getStoreSnapshot(storeId);
      return jsonResponse(snapshot);
    }
  },
  {
    method: 'POST',
    path: '/store/verify',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const result = await verifyIntegrity(storeId);
      return jsonResponse(result);
    }
  },
  {
    method: 'POST',
    path: '/store/rebuild-indexes',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const result = await rebuildIndexes(storeId);
      return jsonResponse(result);
    }
  },
  {
    method: 'POST',
    path: '/store/compact',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      const result = await compactWAL(storeId);
      return jsonResponse(result);
    }
  },
  {
    method: 'POST',
    path: '/store/flush',
    handler: async (request) => {
      const body = await parseBody(request);
      const storeId = getStoreId(request, body);
      await flush(storeId);
      return jsonResponse({ flushed: true });
    }
  },

  // ============================================================================
  // Debug UI Endpoints
  // ============================================================================

  // Debug UI - serve the HTML interface
  {
    method: 'GET',
    path: '/debug',
    handler: () => {
      return new Response(DEBUG_UI_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  },

  // Debug API - get all stores overview
  {
    method: 'GET',
    path: '/debug/stores',
    handler: async () => {
      const s = await getStore();

      // Get main store stats
      const mainStats = await s.getStats('main');
      const mainSnapshot = await s.getSnapshot('main');

      // Get all forks
      const forks = await s.listForks();

      // Build stores list
      const stores = [
        {
          id: 'main',
          name: 'Main Store',
          type: 'main',
          ...mainStats,
          merkleRoot: mainSnapshot.merkleRoot
        }
      ];

      // Add fork details
      for (const fork of forks) {
        try {
          const forkStats = await s.getStats(fork.forkId || fork.id);
          const forkSnapshot = await s.getSnapshot(fork.forkId || fork.id);
          stores.push({
            id: fork.forkId || fork.id,
            name: fork.name || `Fork ${fork.forkId || fork.id}`,
            type: 'fork',
            sourceStoreId: fork.sourceStoreId,
            createdAt: fork.createdAt,
            ...forkStats,
            merkleRoot: forkSnapshot.merkleRoot
          });
        } catch (e) {
          // Fork may not be fully initialized
          stores.push({
            id: fork.forkId || fork.id,
            name: fork.name || `Fork ${fork.forkId || fork.id}`,
            type: 'fork',
            sourceStoreId: fork.sourceStoreId,
            createdAt: fork.createdAt,
            error: e.message
          });
        }
      }

      return jsonResponse({ stores });
    }
  },

  // Debug API - get all memories from a store (with full details)
  {
    method: 'GET',
    path: '/debug/stores/:id/memories',
    handler: async (request, params) => {
      const url = new URL(request.url);
      const storeId = params.id === 'main' ? 'main' : params.id;
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
      const limit = parseInt(url.searchParams.get('limit')) || 1000;
      const offset = parseInt(url.searchParams.get('offset')) || 0;

      const s = await getStore();
      const records = await s.listMemories(storeId, {
        includeDeleted,
        limit,
        offset
      });

      // Format records with all details
      const memories = records.map((r) => ({
        id: r.memory_id,
        version: r.version,
        category: r.category,
        type: r.type,
        content: r.content,
        tags: r.tags || [],
        importance: r.importance,
        cadenceType: r.cadence_type,
        cadenceValue: r.cadence_value,
        context: r.context,
        timestamp: r.timestamp,
        createdAt: new Date(r.timestamp).toISOString(),
        contentHash: r.content_hash,
        prevHash: r.prev_hash,
        deleted: r.deleted || false,
        storeId: r.store_id,
        hasEmbedding: !!r.embedding
      }));

      return jsonResponse({
        storeId,
        count: memories.length,
        offset,
        limit,
        includeDeleted,
        memories
      });
    }
  },

  // Debug API - get all relationships from a store
  {
    method: 'GET',
    path: '/debug/stores/:id/relationships',
    handler: async (request, params) => {
      const url = new URL(request.url);
      const storeId = params.id === 'main' ? 'main' : params.id;
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

      const s = await getStore();

      // Get all relationships by iterating through all memories
      const memories = await s.listMemories(storeId, {
        includeDeleted: true,
        limit: 10000
      });

      const allRelationships = [];
      const seenIds = new Set();

      for (const memory of memories) {
        const rels = await s.getRelationships(storeId, memory.memory_id, {
          includeDeleted
        });
        for (const r of rels) {
          if (!seenIds.has(r.relationship_id)) {
            seenIds.add(r.relationship_id);
            allRelationships.push({
              id: r.relationship_id,
              version: r.version,
              memoryId: r.memory_id,
              relatedMemoryId: r.related_memory_id,
              relationshipType: r.relationship_type,
              timestamp: r.timestamp,
              createdAt: new Date(r.timestamp).toISOString(),
              contentHash: r.content_hash,
              deleted: r.deleted || false
            });
          }
        }
      }

      return jsonResponse({
        storeId,
        count: allRelationships.length,
        includeDeleted,
        relationships: allRelationships
      });
    }
  },

  // Debug API - get a single memory with full history
  {
    method: 'GET',
    path: '/debug/stores/:storeId/memories/:memoryId',
    handler: async (request, params) => {
      const storeId = params.storeId === 'main' ? 'main' : params.storeId;
      const memoryId = params.memoryId;

      const s = await getStore();
      const memory = await s.getMemory(storeId, memoryId, {
        includeDeleted: true
      });

      if (!memory) {
        return errorResponse('Memory not found', 404);
      }

      // Get relationships for this memory
      const relationships = await s.getRelationships(storeId, memoryId, {
        includeDeleted: true
      });

      return jsonResponse({
        memory: {
          id: memory.memory_id,
          version: memory.version,
          category: memory.category,
          type: memory.type,
          content: memory.content,
          tags: memory.tags || [],
          importance: memory.importance,
          cadenceType: memory.cadence_type,
          cadenceValue: memory.cadence_value,
          context: memory.context,
          timestamp: memory.timestamp,
          createdAt: new Date(memory.timestamp).toISOString(),
          contentHash: memory.content_hash,
          prevHash: memory.prev_hash,
          deleted: memory.deleted || false,
          storeId: memory.store_id,
          hasEmbedding: !!memory.embedding,
          embeddingDimensions: memory.embedding ? memory.embedding.length : 0
        },
        relationships: relationships.map((r) => ({
          id: r.relationship_id,
          relatedMemoryId: r.related_memory_id,
          relationshipType: r.relationship_type,
          deleted: r.deleted || false
        }))
      });
    }
  },

  // Debug API - get WAL contents for a store
  {
    method: 'GET',
    path: '/debug/stores/:id/wal',
    handler: async (request, params) => {
      const storeId = params.id === 'main' ? 'main' : params.id;

      const s = await getStore();
      const storeInstance = await s._getStore(storeId);

      if (!storeInstance || !storeInstance.wal) {
        return errorResponse('Store or WAL not found', 404);
      }

      const walRecords = [];
      for (const record of storeInstance.wal.getRecords()) {
        walRecords.push({
          type: record.record_type,
          id: record.memory_id || record.relationship_id,
          version: record.version,
          timestamp: record.timestamp,
          contentHash: record.content_hash,
          deleted: record.deleted || false
        });
      }

      return jsonResponse({
        storeId,
        recordCount: walRecords.length,
        records: walRecords
      });
    }
  },

  // Debug API - get index stats for a store
  {
    method: 'GET',
    path: '/debug/stores/:id/indexes',
    handler: async (request, params) => {
      const storeId = params.id === 'main' ? 'main' : params.id;

      const s = await getStore();
      const storeInstance = await s._getStore(storeId);

      if (!storeInstance) {
        return errorResponse('Store not found', 404);
      }

      const indexStats = {
        storeId,
        latestIndex: {
          memoryCount: 0,
          relationshipCount: 0
        },
        vectorIndex: {
          size: 0
        },
        textIndex: {
          size: 0
        },
        merkleTree: {
          leafCount: 0,
          root: null
        }
      };

      // Get latest index stats
      if (storeInstance.latestIndex) {
        let memCount = 0;
        let relCount = 0;
        for (const [, entry] of storeInstance.latestIndex.iterateMemories(
          true
        )) {
          memCount++;
        }
        for (const [, entry] of storeInstance.latestIndex.iterateRelationships(
          true
        )) {
          relCount++;
        }
        indexStats.latestIndex.memoryCount = memCount;
        indexStats.latestIndex.relationshipCount = relCount;
      }

      // Get vector index size
      if (storeInstance.vectorIndex) {
        indexStats.vectorIndex.size = storeInstance.vectorIndex.size();
      }

      // Get text index size
      if (storeInstance.textIndex) {
        indexStats.textIndex.size = storeInstance.textIndex.size();
      }

      // Get merkle tree info
      if (storeInstance.merkleTree) {
        indexStats.merkleTree.leafCount = storeInstance.merkleTree.leafCount;
        indexStats.merkleTree.root = storeInstance.merkleTree.root;
      }

      return jsonResponse(indexStats);
    }
  }
];

/**
 * Match a URL path to a route pattern.
 * Extracts path parameters like :id.
 *
 * @param {string} pattern - Route pattern (e.g., "/memories/:id")
 * @param {string} path - Actual URL path
 * @returns {Object|null} Extracted parameters or null if no match
 */
function matchRoute(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params = {};

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return params;
}

/**
 * Handle incoming HTTP requests.
 * Routes to appropriate handler or returns 404.
 *
 * @param {Request} request - Incoming HTTP request
 * @returns {Promise<Response>} HTTP response
 */
async function handleRequest(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Find matching route
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const params = matchRoute(route.path, path);
    if (params !== null) {
      try {
        return await route.handler(request, params);
      } catch (error) {
        console.error(`Error handling ${method} ${path}:`, error);
        return errorResponse(error.message, 500);
      }
    }
  }

  return errorResponse('Not found', 404);
}

/**
 * Start the HTTP server using Bun.serve.
 *
 * @param {Object} options - Server options
 * @param {number} [options.port=3000] - Port to listen on
 * @param {string} [options.hostname='localhost'] - Hostname to bind to
 * @returns {Promise<void>}
 */
export async function startHttpServer(options = {}) {
  const { port = 3000, hostname = 'localhost' } = options;

  // Set up embedding function for the store
  setEmbedFunction(generateEmbedding);

  // Preload embedding model
  console.log('Initializing memory server...');
  await preloadModel();

  // Initialize store
  await initStore();
  console.log('Memory server ready.');

  // Start server using Bun.serve
  const server = Bun.serve({
    port,
    hostname,
    fetch: handleRequest
  });

  console.log(`HTTP server listening on http://${hostname}:${port}`);

  return server;
}

/**
 * API endpoint documentation.
 * Can be used to generate API docs or OpenAPI spec.
 */
export const API_DOCS = {
  name: 'Memory Server HTTP API',
  version: '2.0.0',
  baseUrl: 'http://localhost:3000',
  endpoints: routes.map((r) => ({
    method: r.method,
    path: r.path
  }))
};

export default {
  startHttpServer,
  API_DOCS
};
