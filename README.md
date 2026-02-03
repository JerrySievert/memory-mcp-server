# Memory MCP Server

A high-performance, append-only memory storage system for LLMs with semantic search, full-text search, versioning, forking, and point-in-time recovery.

## Features

### Core Memory Operations

- **Add memories** with automatic embedding generation for semantic search
- **Update memories** with full version history preserved
- **Delete memories** (soft delete - archived but recoverable)
- **Retrieve memories** by ID with O(1) lookup
- **List memories** with filtering by category, type, and pagination

### Search Capabilities

- **Semantic search** using HNSW (Hierarchical Navigable Small World) algorithm
- **Full-text search** with BM25 ranking
- **Hybrid search** combining semantic and text search with configurable weights
- Local embeddings using fastembed (all-MiniLM-L6-v2, 384 dimensions)

### Relationships

- Create relationships between memories (related_to, supersedes, contradicts, elaborates, references)
- Graph traversal to find related memories
- Relationship versioning and soft delete

### Cadence/Review System

- Schedule memory reviews with configurable cadence (daily, weekly, monthly, day_of_week, calendar_day)
- Get memories due for review based on last access time

### Versioning & History

- Every change creates a new version (append-only)
- Complete audit trail of all modifications
- Content-addressable storage using SHA-256 hashing
- Merkle tree for cryptographic integrity verification

### Forking & Branching

- **Create forks** from any store for experimentation
- **Copy-on-write semantics** - forks share history but evolve independently
- **Complete isolation** - changes in one fork never affect another
- **Multiple concurrent forks** supported

### Point-in-Time Recovery (PITR)

- Create forks from any historical timestamp
- Named snapshots for easy restoration points
- Restore snapshots to new forks

### Store Management

- **Integrity verification** using merkle tree proofs
- **Index rebuild** capability for recovery
- **WAL compaction** to segments
- **Graceful shutdown** with data persistence

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server / HTTP API                       │
├─────────────────────────────────────────────────────────────────┤
│                        Store Adapter                            │
├─────────────────────────────────────────────────────────────────┤
│                       Memory Store API                          │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│ Latest Index │ Vector Index │  Text Index  │   Merkle Tree      │
│   (HashMap)  │    (HNSW)    │  (Inverted)  │   (Integrity)      │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│                    Write-Ahead Log (WAL)                        │
├─────────────────────────────────────────────────────────────────┤
│                   Segment Files (Immutable)                     │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- [Bun](https://bun.sh/) v1.0 or later

### Install Dependencies

```bash
bun install
```

## Initial Setup

Before using the memory server, run the setup script to create your user store:

### Interactive Setup

```bash
bun run src/setup.js
```

This will prompt for your username and create:

1. A user-specific store (fork of main)
2. Configuration file at `~/.mcp/memory.json`

### Non-Interactive Setup

```bash
# Create store for a specific user
bun run src/setup.js --user jerry

# Reset an existing user's store
bun run src/setup.js --user jerry --reset

# Show current configuration
bun run src/setup.js --show
```

### Configuration File

The setup creates `~/.mcp/memory.json`:

```json
{
  "store_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "user_id": "jerry",
  "timezone": "America/Los_Angeles",
  "trust_levels": {
    "email": "sandbox",
    "calendar": "sandbox",
    "web_search": "autonomous",
    "notifications": "autonomous"
  },
  "daily_run_time": "06:00",
  "briefing_delivery": "memory",
  "weekly_review_day": "sunday",
  "monthly_review_day": "1",
  "created_at": "2024-01-31T12:00:00.000Z"
}
```

| Field                | Description                               |
| -------------------- | ----------------------------------------- |
| `store_id`           | UUID of your personal memory store (fork) |
| `user_id`            | Your username                             |
| `timezone`           | Auto-detected timezone                    |
| `trust_levels`       | Action permissions for Daily Runner agent |
| `daily_run_time`     | When Daily Runner executes                |
| `briefing_delivery`  | How daily briefing is delivered           |
| `weekly_review_day`  | Day for weekly reviews                    |
| `monthly_review_day` | Day for monthly reviews                   |

---

## CLI Tools

### List Stores

```bash
bun run src/cli.js stores
```

Output (ASCII tree view showing fork hierarchy):

```
Memory Stores
=============

Current user: Jerry (store: 377e6d5c-5733-461a-9504-e4ec00ef2744)

Main Store - 1/31/2026, 8:41:39 PM
├── User: alice (a1b2c3d4...) - 1/31/2026, 9:00:00 PM
│   📝 Alice's personal memory store
├── User: bob (e5f6g7h8...) - 1/31/2026, 9:15:00 PM
│   └── Experiment: bob-test (i9j0k1l2...) - 1/31/2026, 9:30:00 PM
│       📝 Testing new features
│       ⏱️  PITR from: 1/31/2026, 9:00:00 PM
└── User: Jerry * (377e6d5c...) - 1/31/2026, 8:52:12 PM

* = current user store

Total: 5 store(s)
```

### Creating Stores with Notes

```bash
# Create store with a note
bun run src/setup.js --user jerry --note "Personal memory store"

# Interactive mode also prompts for a note
bun run src/setup.js
```

### Other CLI Commands

```bash
# Show store statistics
bun run src/cli.js stats [store_id]

# List snapshots for a store
bun run src/cli.js snapshots [store_id]

# Verify store integrity
bun run src/cli.js verify [store_id]

# Output as JSON
bun run src/cli.js stores --json
```

---

## Running the Server

### MCP Server (stdio transport)

```bash
bun run src/index.js
# or explicitly:
bun run src/index.js --stdio
```

### REST HTTP Server

```bash
bun run src/index.js --http
# or with custom port:
bun run src/index.js --http --port 8080
```

The REST HTTP server runs on `http://localhost:3000` by default. It provides a standard REST API and a debug UI at `/debug`.

### MCP HTTP Server (Streamable HTTP)

```bash
bun run src/index.js --mcp-http
# or with custom port:
bun run src/index.js --mcp-http --mcp-port 8080
```

The MCP HTTP server runs on `http://localhost:3001/mcp` by default. It uses the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) for MCP clients that connect over the network instead of stdio.

MCP client configuration for HTTP transport:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Multiple Servers

```bash
# stdio + REST HTTP
bun run src/index.js --stdio --http

# REST HTTP + MCP HTTP
bun run src/index.js --http --mcp-http

# All three
bun run src/index.js --stdio --http --mcp-http
```

### Command Line Options

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `--stdio`           | Start stdio server for MCP clients (default if no mode specified) |
| `--http`            | Start REST HTTP server                                            |
| `--mcp-http`        | Start MCP server with Streamable HTTP transport                   |
| `--port <port>`     | REST HTTP server port (default: 3000)                             |
| `--mcp-port <port>` | MCP HTTP server port (default: 3001)                              |
| `--host <host>`     | Server hostname (default: localhost)                              |
| `--debug`           | Enable debug logging for MCP calls (outputs to stderr)            |
| `--help, -h`        | Show help message                                                 |

### Environment Variables

| Variable   | Default     | Description                    |
| ---------- | ----------- | ------------------------------ |
| `DATA_DIR` | `./data`    | Directory for storing all data |
| `PORT`     | `3000`      | REST HTTP server port          |
| `MCP_PORT` | `3001`      | MCP HTTP server port           |
| `HOST`     | `localhost` | Server hostname                |

## Testing

### Run All Tests

```bash
bun test
```

### Run Specific Test Files

```bash
# Core store tests (150 tests)
bun test src/store/store.test.js

# Integration tests (26 tests)
bun test src/integration.test.js

# Legacy memory tests (44 tests)
bun test src/memory.test.js
```

### Test Coverage

| Test Suite  | Tests   | Description                                        |
| ----------- | ------- | -------------------------------------------------- |
| Store Core  | 150     | WAL, segments, indexes, merkle tree, forking, PITR |
| Integration | 26      | End-to-end API tests, fork isolation               |
| Legacy      | 44      | Original memory/search/relationship tests          |
| **Total**   | **220** |                                                    |

## API Reference

### MCP Tools

#### Memory Operations

| Tool               | Description                                     |
| ------------------ | ----------------------------------------------- |
| `add_memory`       | Create a new memory with automatic embedding    |
| `get_memory`       | Retrieve a memory by ID                         |
| `update_memory`    | Update an existing memory (creates new version) |
| `delete_memory`    | Archive a memory (soft delete)                  |
| `list_memories`    | List memories with filters and pagination       |
| `search_memories`  | Search using semantic, text, or hybrid mode     |
| `get_due_memories` | Get memories due for review                     |
| `get_stats`        | Get store statistics                            |

#### Relationship Operations

| Tool                   | Description                            |
| ---------------------- | -------------------------------------- |
| `add_relationship`     | Create a relationship between memories |
| `remove_relationship`  | Remove a relationship                  |
| `get_relationships`    | Get all relationships for a memory     |
| `get_related_memories` | Traverse relationship graph            |

#### Fork Operations

| Tool                  | Description                                    |
| --------------------- | ---------------------------------------------- |
| `create_fork`         | Create a fork from current state               |
| `create_fork_at_time` | Create a fork from a specific timestamp (PITR) |
| `list_forks`          | List all forks                                 |
| `delete_fork`         | Delete a fork                                  |

#### Snapshot Operations

| Tool               | Description                                |
| ------------------ | ------------------------------------------ |
| `create_snapshot`  | Create a named snapshot                    |
| `list_snapshots`   | List all snapshots for a store             |
| `restore_snapshot` | Restore from a snapshot (creates new fork) |

#### Store Management

| Tool                 | Description                      |
| -------------------- | -------------------------------- |
| `get_store_snapshot` | Get merkle root for verification |
| `verify_integrity`   | Verify store integrity           |
| `rebuild_indexes`    | Rebuild all indexes              |

### HTTP Endpoints

#### Memories

| Method | Endpoint                      | Description          |
| ------ | ----------------------------- | -------------------- |
| POST   | `/memories`                   | Create memory        |
| GET    | `/memories/:id`               | Get memory by ID     |
| PUT    | `/memories/:id`               | Update memory        |
| DELETE | `/memories/:id`               | Delete memory        |
| GET    | `/memories`                   | List memories        |
| POST   | `/memories/search`            | Search memories      |
| GET    | `/memories/due`               | Get due memories     |
| GET    | `/memories/:id/relationships` | Get relationships    |
| GET    | `/memories/:id/related`       | Get related memories |

#### Relationships

| Method | Endpoint             | Description         |
| ------ | -------------------- | ------------------- |
| POST   | `/relationships`     | Create relationship |
| DELETE | `/relationships/:id` | Remove relationship |

#### Forks

| Method | Endpoint      | Description      |
| ------ | ------------- | ---------------- |
| POST   | `/forks`      | Create fork      |
| POST   | `/forks/pitr` | Create PITR fork |
| GET    | `/forks`      | List forks       |
| DELETE | `/forks/:id`  | Delete fork      |

#### Snapshots

| Method | Endpoint                 | Description      |
| ------ | ------------------------ | ---------------- |
| POST   | `/snapshots`             | Create snapshot  |
| GET    | `/snapshots`             | List snapshots   |
| POST   | `/snapshots/:id/restore` | Restore snapshot |

#### Store Management

| Method | Endpoint                 | Description      |
| ------ | ------------------------ | ---------------- |
| GET    | `/stats`                 | Get statistics   |
| GET    | `/health`                | Health check     |
| GET    | `/store/snapshot`        | Get merkle root  |
| POST   | `/store/verify`          | Verify integrity |
| POST   | `/store/rebuild-indexes` | Rebuild indexes  |
| POST   | `/store/compact`         | Compact WAL      |
| POST   | `/store/flush`           | Flush writes     |

### Store ID Parameter

All operations support a `store_id` parameter to specify which store/fork to operate on:

- `store_id = "main"` or omitted → Default main store
- `store_id = "<fork-uuid>"` → Specific fork

**Query parameter (GET requests):**

```
GET /memories?store_id=abc-123-def
```

**Body parameter (POST/PUT requests):**

```json
{
  "store_id": "abc-123-def",
  "category": "people",
  "content": "..."
}
```

## Data Model

### Memory Record

```javascript
{
  id: string,              // UUID, stable across versions
  category: string,        // e.g., "people", "work", "facts"
  type: string,            // e.g., "person", "fact", "experience"
  content: string,         // The memory content
  tags: string[],          // Flexible organization
  importance: number,      // 1-10 priority score
  cadenceType: string,     // "daily", "weekly", "monthly", etc.
  cadenceValue: string,    // Day name or number for cadence
  context: string,         // When/why created
  version: number,         // Incrementing version
  contentHash: string,     // SHA-256 of content
  createdAt: string,       // ISO timestamp
  archived: boolean,       // Soft delete flag
  storeId: string          // Fork/store ID
}
```

### Relationship Record

```javascript
{
  id: string,              // UUID
  memoryId: string,        // Source memory
  relatedMemoryId: string, // Target memory
  relationshipType: string,// "related_to", "supersedes", etc.
  version: number,
  createdAt: string,
  deleted: boolean
}
```

### Relationship Types

| Type          | Description                |
| ------------- | -------------------------- |
| `related_to`  | General relationship       |
| `supersedes`  | Newer info replaces older  |
| `contradicts` | Conflicting information    |
| `elaborates`  | Expands on existing memory |
| `references`  | Mentions another memory    |

## File Structure

```
data/
├── main/                      # Main store
│   ├── wal.log                # Write-ahead log
│   ├── segments/              # Immutable segment files
│   │   ├── 00000001.seg
│   │   └── ...
│   ├── indexes/               # Persisted indexes
│   │   ├── latest.idx
│   │   ├── vector.idx
│   │   ├── text.idx
│   │   └── merkle.idx
│   └── meta.json              # Store metadata
├── forks/                     # Fork stores
│   └── {fork-uuid}/           # Same structure as main
└── store.json                 # Global metadata
```

## Configuration

Default configuration (can be overridden):

```javascript
{
  dataDir: "./data",           // Root data directory
  segmentSizeBytes: 16777216,  // 16MB WAL rotation threshold
  persistEveryNWrites: 1,      // Persist indexes after N writes
  memoryBudgetBytes: 536870912,// 512MB memory budget
  hnswM: 16,                   // HNSW graph connections
  hnswEfConstruction: 200,     // HNSW build quality
  hnswEfSearch: 50             // HNSW search quality
}
```

## Performance

| Operation        | Target  | Notes                                 |
| ---------------- | ------- | ------------------------------------- |
| Add memory       | < 100ms | Includes embedding generation (~40ms) |
| Get memory       | < 1ms   | O(1) hash map lookup                  |
| Semantic search  | < 50ms  | For 10K memories                      |
| Full-text search | < 20ms  | For 10K memories                      |
| Create fork      | < 10ms  | Copy-on-write, metadata only          |
| Cold startup     | < 5s    | For 100K memories                     |
| Warm startup     | < 500ms | Indexes in memory                     |

## Examples

### Adding a Memory

```bash
curl -X POST http://localhost:3000/memories \
  -H "Content-Type: application/json" \
  -d '{
    "category": "people",
    "type": "person",
    "content": "Alice is a software engineer who loves hiking",
    "tags": ["friend", "engineer"],
    "importance": 7
  }'
```

### Searching Memories

```bash
curl -X POST http://localhost:3000/memories/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "software engineer hiking",
    "mode": "hybrid",
    "limit": 10
  }'
```

### Creating a Fork

```bash
curl -X POST http://localhost:3000/forks \
  -H "Content-Type: application/json" \
  -d '{
    "source_store_id": "main",
    "name": "experiment-branch"
  }'
```

### Point-in-Time Recovery

```bash
curl -X POST http://localhost:3000/forks/pitr \
  -H "Content-Type: application/json" \
  -d '{
    "source_store_id": "main",
    "timestamp": 1706745600000,
    "name": "restored-from-jan-31"
  }'
```

### Operating on a Fork

```bash
# Add memory to a specific fork
curl -X POST "http://localhost:3000/memories?store_id=abc-123" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "experiment",
    "type": "fact",
    "content": "This only exists in the fork"
  }'
```

## MCP Client Configuration

### Stdio Transport (recommended for local use)

```json
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "/path/to/memory/src/index.js"],
      "env": {
        "DATA_DIR": "/path/to/data"
      }
    }
  }
}
```

### HTTP Transport (for remote/network use)

Start the MCP HTTP server, then configure your client:

```bash
bun run src/index.js --mcp-http
```

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Development

### Project Structure

```
src/
├── index.js              # MCP server entry point
├── http-index.js         # HTTP server entry point
├── mcp-server.js         # MCP protocol implementation
├── http-server.js        # HTTP API implementation
├── store-adapter.js      # Bridge to store API
├── embeddings.js         # Local embedding generation
├── store/
│   ├── index.js          # Store exports
│   ├── config.js         # Configuration
│   ├── record.js         # Record serialization
│   ├── wal.js            # Write-ahead log
│   ├── segment.js        # Immutable segments
│   ├── merkle.js         # Merkle tree
│   ├── latest-index.js   # O(1) version lookup
│   ├── vector-index.js   # HNSW semantic search
│   ├── text-index.js     # Inverted index + BM25
│   ├── memory-store.js   # Main store API
│   └── store.test.js     # Store tests
├── integration.test.js   # Integration tests
└── memory.test.js        # Legacy tests
```

### Running in Development

```bash
# Run HTTP server with auto-reload
bun --watch src/index.js -- --http

# Run tests in watch mode
bun test --watch
```

## License

MIT
