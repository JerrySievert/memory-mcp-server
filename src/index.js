#!/usr/bin/env bun
/**
 * Memory MCP Server - Main Entry Point
 *
 * An MCP server for LLM long-term memory storage and recall.
 * Supports both stdio transport (for MCP clients) and HTTP transport.
 *
 * Usage:
 *   bun run src/index.js          # Start stdio server (default)
 *   bun run src/index.js --stdio  # Start only stdio server
 *   bun run src/index.js --http   # Start only HTTP server
 *   bun run src/index.js --http --port 8080  # HTTP on custom port
 *
 * Environment Variables:
 *   DATA_DIR  - Directory for data storage (default: ./data)
 *   PORT      - HTTP server port (default: 3000)
 *   HOST      - HTTP server hostname (default: localhost)
 *
 * @module index
 */

import {
  startStdioServer,
  startHttpMcpServer,
  set_debug
} from './mcp-server.js';
import { startHttpServer } from './http-server.js';

/**
 * Parse command line arguments.
 *
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);

  const options = {
    stdio: false,
    http: false,
    mcpHttp: false,
    debug: false,
    port: parseInt(process.env.PORT) || 3000,
    mcpPort: parseInt(process.env.MCP_PORT) || 3001,
    host: process.env.HOST || 'localhost'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--stdio':
        options.stdio = true;
        break;
      case '--http':
        options.http = true;
        break;
      case '--mcp-http':
        options.mcpHttp = true;
        break;
      case '--port':
        options.port = parseInt(args[++i]) || 3000;
        break;
      case '--mcp-port':
        options.mcpPort = parseInt(args[++i]) || 3001;
        break;
      case '--host':
        options.host = args[++i] || 'localhost';
        break;
      case '--debug':
        options.debug = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  // Default to stdio if no mode specified
  if (!options.stdio && !options.http && !options.mcpHttp) {
    options.stdio = true;
  }

  return options;
}

/**
 * Print help message.
 */
function printHelp() {
  console.log(`
Memory MCP Server - LLM Long-term Memory Storage

Usage:
  bun run src/index.js [options]

Options:
  --stdio               Start stdio server for MCP clients (default if no mode specified)
  --http                Start REST HTTP server
  --mcp-http            Start MCP server with HTTP transport (StreamableHTTP)
  --port <port>         REST HTTP server port (default: 3000, or PORT env var)
  --mcp-port <port>     MCP HTTP server port (default: 3001, or MCP_PORT env var)
  --host <host>         Server hostname (default: localhost, or HOST env var)
  --debug               Enable debug logging for MCP calls (outputs to stderr)
  --help, -h            Show this help message

Environment Variables:
  DATA_DIR              Directory for data storage (default: ./data)
  PORT                  REST HTTP server port (default: 3000)
  MCP_PORT              MCP HTTP server port (default: 3001)
  HOST                  Server hostname (default: localhost)

Examples:
  bun run src/index.js                      # Start stdio server (for Claude Desktop)
  bun run src/index.js --http               # Start REST HTTP server on port 3000
  bun run src/index.js --mcp-http           # Start MCP HTTP server on port 3001
  bun run src/index.js --http --mcp-http    # Start both HTTP servers
  bun run src/index.js --mcp-http --mcp-port 8080  # MCP HTTP on custom port

MCP Configuration (claude_desktop_config.json):

  Stdio transport (recommended for local use):
  {
    "mcpServers": {
      "memory": {
        "command": "bun",
        "args": ["run", "/path/to/memory/src/index.js"]
      }
    }
  }

  HTTP transport (for remote/network use):
  {
    "mcpServers": {
      "memory": {
        "url": "http://localhost:3001/mcp"
      }
    }
  }
`);
}

/**
 * Main entry point.
 * Starts the appropriate server(s) based on command line arguments.
 */
async function main() {
  const options = parseArgs();

  // Enable debug mode if requested
  if (options.debug) {
    set_debug(true);
    console.error('[DEBUG] Debug logging enabled for MCP calls');
  }

  try {
    // Start REST HTTP server if requested
    if (options.http) {
      console.error('Starting REST HTTP server...');
      await startHttpServer({
        port: options.port,
        hostname: options.host
      });
    }

    // Start MCP HTTP server if requested
    if (options.mcpHttp) {
      console.error('Starting MCP HTTP server...');
      await startHttpMcpServer({
        port: options.mcpPort,
        hostname: options.host
      });
    }

    // Start stdio server if requested (or as default)
    if (options.stdio) {
      console.error('Starting stdio server...');
      await startStdioServer();
    }

    // If only HTTP servers are running, keep process alive
    if (!options.stdio && (options.http || options.mcpHttp)) {
      await new Promise(() => {});
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Run main
main();
