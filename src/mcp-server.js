/**
 * MCP Server Module
 *
 * Implements the Model Context Protocol server for the memory system.
 * Provides tools for memory management, search, and relationship handling.
 * Supports both stdio and HTTP transports.
 *
 * @module mcp-server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Debug logging configuration
 */
let debug_enabled = false;

/**
 * Enable or disable debug logging
 * @param {boolean} enabled
 */
export function set_debug(enabled) {
  debug_enabled = enabled;
}

/**
 * Check if debug logging is enabled
 * @returns {boolean}
 */
export function is_debug_enabled() {
  return debug_enabled;
}

/**
 * Format a value for debug output (truncate large objects)
 * @param {any} value
 * @param {number} max_length
 * @returns {string}
 */
function format_debug_value(value, max_length = 500) {
  if (value === null || value === undefined) {
    return String(value);
  }

  let str;
  if (typeof value === 'object') {
    try {
      str = JSON.stringify(value, null, 2);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  if (str.length > max_length) {
    return (
      str.slice(0, max_length) + `... [truncated, ${str.length} total chars]`
    );
  }
  return str;
}

/**
 * Log a debug message to stderr
 * @param {string} category - Log category (e.g., 'TOOL_CALL', 'TOOL_RESULT')
 * @param {string} message - Log message
 * @param {Object} [data] - Optional data to log
 */
function debug_log(category, message, data = null) {
  if (!debug_enabled) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [MCP:${category}]`;

  console.error(`${prefix} ${message}`);

  if (data !== null) {
    const formatted = format_debug_value(data);
    // Indent data lines for readability
    const indented = formatted
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    console.error(indented);
  }
}

import { generateEmbedding, preloadModel } from './embeddings.js';
import {
  initStore,
  closeStore,
  setEmbedFunction,
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
 * Relationship types for memory connections.
 */
const RELATIONSHIP_TYPES = [
  'related_to',
  'supersedes',
  'contradicts',
  'elaborates',
  'references'
];

/**
 * Tool definitions for the MCP server.
 * Each tool specifies its name, description, and input schema.
 */
const TOOLS = [
  {
    name: 'add_memory',
    description:
      'Create a new memory with automatic embedding generation for semantic search. Use this to store facts, experiences, information about people, or any knowledge you want to retain long-term.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        category: {
          type: 'string',
          description:
            "Category for organizing the memory (e.g., 'people', 'work', 'personal', 'facts')"
        },
        type: {
          type: 'string',
          description:
            'Type of memory: person, fact, memory, experience, preference, goal, or custom type'
        },
        content: {
          type: 'string',
          description: 'The memory content - what you want to remember'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for flexible organization'
        },
        importance: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description:
            'Priority score 1-10 (default 5). Higher importance memories are surfaced more prominently'
        },
        cadence_type: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly', 'day_of_week', 'calendar_day'],
          description: "How often to review this memory. Default is 'monthly'"
        },
        cadence_value: {
          type: 'string',
          description:
            "Value for cadence: day name for day_of_week (e.g., 'sunday'), or day number for calendar_day (e.g., '15' or 'last')"
        },
        context: {
          type: 'string',
          description: 'Optional context about when/why this memory was created'
        }
      },
      required: ['category', 'type', 'content']
    }
  },
  {
    name: 'get_memory',
    description: 'Retrieve a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        id: {
          type: 'string',
          description: 'The memory ID to retrieve'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'update_memory',
    description:
      'Update an existing memory. If content is changed, the embedding is automatically regenerated.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        id: {
          type: 'string',
          description: 'The memory ID to update'
        },
        category: { type: 'string', description: 'New category' },
        type: { type: 'string', description: 'New type' },
        content: {
          type: 'string',
          description: 'New content (triggers embedding regeneration)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags array'
        },
        importance: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'New importance score'
        },
        cadence_type: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly', 'day_of_week', 'calendar_day'],
          description: 'New cadence type'
        },
        cadence_value: { type: 'string', description: 'New cadence value' },
        context: { type: 'string', description: 'New context' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_memory',
    description:
      'Archive a memory (soft delete). The memory is preserved for history but excluded from normal searches.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        id: {
          type: 'string',
          description: 'The memory ID to delete'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'search_memories',
    description:
      'Search memories using semantic similarity, full-text search, or hybrid mode. Supports hybrid search combining both methods for best results.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        query: {
          type: 'string',
          description:
            'Text query for semantic/full-text search. Finds memories with similar meaning.'
        },
        mode: {
          type: 'string',
          enum: ['semantic', 'text', 'hybrid'],
          description:
            "Search mode: 'semantic' for meaning similarity, 'text' for keyword match, 'hybrid' for both (default)"
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 10)'
        },
        semanticWeight: {
          type: 'number',
          description:
            'Weight for semantic results in hybrid mode (0-1, default 0.7)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'list_memories',
    description: 'List memories with pagination and optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        category: {
          type: 'string',
          description: 'Filter by category'
        },
        type: {
          type: 'string',
          description: 'Filter by type'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 100)'
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination'
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived memories'
        }
      }
    }
  },
  {
    name: 'get_due_memories',
    description:
      'Get memories that are due for review based on their cadence settings. Useful for spaced repetition and regular memory refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        }
      }
    }
  },
  {
    name: 'get_stats',
    description:
      'Get statistics about the memory store including total counts, categories, and version info.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        }
      }
    }
  },
  {
    name: 'add_relationship',
    description:
      'Create a relationship between two memories. Relationships help organize and traverse related information.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        memory_id: {
          type: 'string',
          description: 'Source memory ID'
        },
        related_memory_id: {
          type: 'string',
          description: 'Target memory ID'
        },
        relationship_type: {
          type: 'string',
          enum: RELATIONSHIP_TYPES,
          description:
            'Type of relationship: related_to (general), supersedes (replaces), contradicts (conflicts), elaborates (expands on), references (mentions)'
        }
      },
      required: ['memory_id', 'related_memory_id']
    }
  },
  {
    name: 'remove_relationship',
    description: 'Remove a relationship between two memories.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        relationship_id: {
          type: 'string',
          description: 'Relationship ID to remove'
        }
      },
      required: ['relationship_id']
    }
  },
  {
    name: 'get_relationships',
    description:
      'Get all relationships for a memory, both outgoing and incoming.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        memory_id: {
          type: 'string',
          description: 'Memory ID to get relationships for'
        }
      },
      required: ['memory_id']
    }
  },
  {
    name: 'get_related_memories',
    description:
      'Get all memories related to a given memory by traversing the relationship graph.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store/fork ID (default 'main')"
        },
        memory_id: {
          type: 'string',
          description: 'Starting memory ID'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default 2)'
        },
        relationshipTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by relationship types'
        }
      },
      required: ['memory_id']
    }
  },

  // Fork and snapshot tools
  {
    name: 'create_fork',
    description:
      'Create a fork of a store. Forks are independent copies that share history with the parent but can evolve separately.',
    inputSchema: {
      type: 'object',
      properties: {
        source_store_id: {
          type: 'string',
          description: "Store to fork from (default 'main')"
        },
        name: {
          type: 'string',
          description: 'Optional name for the fork'
        }
      }
    }
  },
  {
    name: 'create_fork_at_time',
    description:
      'Create a fork from a store at a specific point in time (PITR - Point In Time Recovery).',
    inputSchema: {
      type: 'object',
      properties: {
        source_store_id: {
          type: 'string',
          description: "Store to fork from (default 'main')"
        },
        timestamp: {
          type: 'number',
          description: 'Unix timestamp (milliseconds) to fork from'
        },
        name: {
          type: 'string',
          description: 'Optional name for the fork'
        }
      },
      required: ['timestamp']
    }
  },
  {
    name: 'list_forks',
    description: 'List all forks/stores available.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'delete_fork',
    description: 'Delete a fork. Cannot delete the main store.',
    inputSchema: {
      type: 'object',
      properties: {
        fork_id: {
          type: 'string',
          description: 'Fork ID to delete'
        }
      },
      required: ['fork_id']
    }
  },
  {
    name: 'create_snapshot',
    description: 'Create a named snapshot of a store for later restoration.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store to snapshot (default 'main')"
        },
        name: {
          type: 'string',
          description: 'Name for the snapshot'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_snapshots',
    description: 'List all snapshots for a store.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store ID (default 'main')"
        }
      }
    }
  },
  {
    name: 'restore_snapshot',
    description:
      'Restore a store from a snapshot. Creates a new fork with the restored state.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: {
          type: 'string',
          description: 'Snapshot ID to restore from'
        },
        name: {
          type: 'string',
          description: 'Optional name for the restored fork'
        }
      },
      required: ['snapshot_id']
    }
  },

  // Store management tools
  {
    name: 'get_store_snapshot',
    description:
      'Get a cryptographic snapshot of the store state (merkle root) for verification.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store ID (default 'main')"
        }
      }
    }
  },
  {
    name: 'verify_integrity',
    description:
      'Verify the integrity of the store using merkle tree verification.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store ID (default 'main')"
        }
      }
    }
  },
  {
    name: 'rebuild_indexes',
    description:
      'Rebuild all indexes for a store. Useful after corruption or for optimization.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: {
          type: 'string',
          description: "Store ID (default 'main')"
        }
      }
    }
  }
];

/**
 * Handle tool execution requests.
 * Routes to appropriate handler based on tool name.
 *
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} Tool execution result
 */
async function handleToolCall(name, args) {
  const storeId = args.store_id || 'main';

  debug_log('TOOL_CALL', `Executing: ${name} [store: ${storeId}]`);

  switch (name) {
    case 'add_memory': {
      const { store_id, ...memoryData } = args;
      return await addMemory(memoryData, storeId);
    }

    case 'get_memory':
      return await getMemory(args.id, storeId);

    case 'update_memory': {
      const { id, store_id, ...updates } = args;
      return await updateMemory(id, updates, storeId);
    }

    case 'delete_memory':
      return { deleted: await deleteMemory(args.id, storeId) };

    case 'search_memories':
      return await searchMemories(
        args.query,
        {
          mode: args.mode,
          limit: args.limit,
          semanticWeight: args.semanticWeight
        },
        storeId
      );

    case 'list_memories':
      return await listMemories(
        {
          category: args.category,
          type: args.type,
          limit: args.limit,
          offset: args.offset,
          includeArchived: args.includeArchived
        },
        storeId
      );

    case 'get_due_memories':
      return await getDueMemories(new Date(), storeId);

    case 'get_stats':
      return await getStats(storeId);

    case 'add_relationship':
      return await addRelationship(
        args.memory_id,
        args.related_memory_id,
        args.relationship_type || 'related_to',
        storeId
      );

    case 'remove_relationship':
      return {
        removed: await removeRelationship(args.relationship_id, storeId)
      };

    case 'get_relationships':
      return await getRelationships(args.memory_id, {}, storeId);

    case 'get_related_memories':
      return await getRelatedMemories(
        args.memory_id,
        {
          maxDepth: args.maxDepth,
          relationshipTypes: args.relationshipTypes
        },
        storeId
      );

    // Fork operations
    case 'create_fork':
      return await createFork(args.source_store_id || 'main', {
        name: args.name
      });

    case 'create_fork_at_time':
      return await createForkAtTime(
        args.source_store_id || 'main',
        args.timestamp,
        { name: args.name }
      );

    case 'list_forks':
      return await listForks();

    case 'delete_fork':
      await deleteFork(args.fork_id);
      return { deleted: true };

    // Snapshot operations
    case 'create_snapshot':
      return await createSnapshot(args.name, storeId);

    case 'list_snapshots':
      return await listSnapshots(storeId);

    case 'restore_snapshot':
      return await restoreSnapshot(args.snapshot_id, { name: args.name });

    // Store management
    case 'get_store_snapshot':
      return await getStoreSnapshot(storeId);

    case 'verify_integrity':
      return await verifyIntegrity(storeId);

    case 'rebuild_indexes':
      return await rebuildIndexes(storeId);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Create and configure the MCP server instance.
 *
 * @returns {Server} Configured MCP server
 */
export function createMCPServer() {
  const server = new Server(
    {
      name: 'memory-server',
      version: '2.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    debug_log('REQUEST', 'ListTools request received');
    debug_log('RESULT', `Returning ${TOOLS.length} tools`);
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const call_start = Date.now();
    const store_id = args?.store_id || 'main';

    debug_log(
      'REQUEST',
      `Tool call received: ${name} [store: ${store_id}]`,
      args
    );

    try {
      const result = await handleToolCall(name, args || {});
      const duration = Date.now() - call_start;

      debug_log(
        'RESULT',
        `Tool ${name} [store: ${store_id}] completed in ${duration}ms`,
        result
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      const duration = Date.now() - call_start;

      debug_log(
        'ERROR',
        `Tool ${name} [store: ${store_id}] failed after ${duration}ms: ${error.message}`,
        {
          error: error.message,
          stack: error.stack
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: error.message })
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

/**
 * Start the MCP server with stdio transport.
 * This is the main entry point for MCP clients.
 *
 * @returns {Promise<void>}
 */
export async function startStdioServer() {
  // Set up embedding function for the store
  setEmbedFunction(generateEmbedding);

  // Preload embedding model
  console.error('Initializing memory server...');
  await preloadModel();

  // Initialize store
  await initStore();
  console.error('Memory server ready.');

  // Create and start server
  const server = createMCPServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

/**
 * Start the MCP server with StreamableHTTP transport.
 * This allows MCP clients to connect via HTTP.
 *
 * @param {Object} options - Server options
 * @param {number} [options.port=3001] - Port for MCP HTTP server
 * @param {string} [options.hostname='localhost'] - Hostname to bind to
 * @returns {Promise<Object>} HTTP server instance
 */
export async function startHttpMcpServer(options = {}) {
  const { port = 3001, hostname = 'localhost' } = options;

  // Set up embedding function for the store
  setEmbedFunction(generateEmbedding);

  // Preload embedding model
  console.error('Initializing memory MCP server (HTTP transport)...');
  await preloadModel();

  // Initialize store
  await initStore();
  console.error('Memory server ready.');

  // Create the MCP server
  const server = createMCPServer();

  // Track active transports by session ID
  const transports = new Map();

  // Create HTTP server using Bun
  const httpServer = Bun.serve({
    port,
    hostname,
    idleTimeout: 255, // Max timeout in seconds for long-lived MCP connections
    async fetch(req) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id'
          }
        });
      }

      // MCP endpoint
      if (url.pathname === '/mcp') {
        // Get or create session ID
        const sessionId =
          req.headers.get('mcp-session-id') || crypto.randomUUID();

        debug_log(
          'HTTP',
          `${req.method} /mcp - Session: ${sessionId.slice(0, 8)}...`
        );

        // Handle different methods
        if (req.method === 'GET') {
          // SSE connection for server-to-client messages
          let transport = transports.get(sessionId);

          if (!transport) {
            // Create new transport for this session
            debug_log(
              'SESSION',
              `Creating new transport for session ${sessionId.slice(0, 8)}...`
            );
            transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => sessionId,
              onsessioninitialized: (id) => {
                debug_log('SESSION', `Session initialized: ${id}`);
                console.error(`MCP session initialized: ${id}`);
              }
            });
            transports.set(sessionId, transport);

            // Connect server to transport
            server.connect(transport).catch((err) => {
              debug_log('ERROR', `Failed to connect transport: ${err.message}`);
              console.error('Failed to connect transport:', err);
            });
          }

          // Handle the SSE request
          const response = await transport.handleRequest(req);
          // Add session ID header to response
          response.headers.set('mcp-session-id', sessionId);
          response.headers.set('Access-Control-Allow-Origin', '*');
          response.headers.set(
            'Access-Control-Expose-Headers',
            'mcp-session-id'
          );
          return response;
        } else if (req.method === 'POST') {
          // Client-to-server messages
          let transport = transports.get(sessionId);

          if (!transport) {
            // Create new transport for this session
            debug_log(
              'SESSION',
              `Creating new transport for POST session ${sessionId.slice(0, 8)}...`
            );
            transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => sessionId,
              onsessioninitialized: (id) => {
                debug_log('SESSION', `Session initialized: ${id}`);
                console.error(`MCP session initialized: ${id}`);
              }
            });
            transports.set(sessionId, transport);

            // Connect server to transport
            await server.connect(transport);
          }

          // Clone request to read body for debugging without consuming it
          let request_to_handle = req;
          if (debug_enabled) {
            const body_text = await req.text();
            try {
              const body_json = JSON.parse(body_text);
              debug_log(
                'HTTP_REQUEST',
                `POST /mcp [session: ${sessionId.slice(0, 8)}...]`,
                {
                  method: body_json.method,
                  id: body_json.id,
                  params: body_json.params
                }
              );
            } catch {
              debug_log(
                'HTTP_REQUEST',
                `POST /mcp [session: ${sessionId.slice(0, 8)}...] - Raw body: ${body_text.slice(0, 200)}`
              );
            }
            // Reconstruct request with the body we consumed
            request_to_handle = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: body_text
            });
          }

          // Handle the POST request
          const response = await transport.handleRequest(request_to_handle);
          // Add session ID header to response
          response.headers.set('mcp-session-id', sessionId);
          response.headers.set('Access-Control-Allow-Origin', '*');
          response.headers.set(
            'Access-Control-Expose-Headers',
            'mcp-session-id'
          );
          return response;
        } else if (req.method === 'DELETE') {
          // Session termination
          debug_log(
            'SESSION',
            `Terminating session ${sessionId.slice(0, 8)}...`
          );
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.close();
            transports.delete(sessionId);
            debug_log(
              'SESSION',
              `Session ${sessionId.slice(0, 8)}... closed and removed`
            );
          } else {
            debug_log(
              'SESSION',
              `Session ${sessionId.slice(0, 8)}... not found for deletion`
            );
          }
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }

      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'memory-mcp-server',
            version: '2.0.0',
            transport: 'streamable-http',
            sessions: transports.size
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.error(`MCP HTTP server listening on http://${hostname}:${port}/mcp`);

  return httpServer;
}

export default {
  createMCPServer,
  startStdioServer,
  startHttpMcpServer,
  TOOLS
};
