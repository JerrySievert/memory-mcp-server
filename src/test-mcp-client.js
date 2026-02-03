#!/usr/bin/env bun
/**
 * Test Client for MCP HTTP Interface
 *
 * Tests the MCP protocol over HTTP by making tool calls and observing debug output.
 * Run with: bun run src/test-mcp-client.js
 *
 * Make sure the MCP HTTP server is running with --debug:
 *   bun run src/index.js --mcp-http --debug
 */

const MCP_URL = process.env.MCP_URL || 'http://localhost:3001/mcp';

let session_id = null;
let request_id = 0;

/**
 * Send a JSON-RPC request to the MCP server
 */
async function mcp_request(method, params = {}) {
  request_id++;

  const body = {
    jsonrpc: '2.0',
    id: request_id,
    method,
    params
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };

  if (session_id) {
    headers['mcp-session-id'] = session_id;
  }

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  // Capture session ID from response
  const new_session_id = response.headers.get('mcp-session-id');
  if (new_session_id) {
    session_id = new_session_id;
  }

  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
  }

  // Handle SSE response format
  const content_type = response.headers.get('content-type');
  let result;

  if (content_type && content_type.includes('text/event-stream')) {
    // Parse SSE response
    const text = await response.text();
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        result = JSON.parse(data);
        break;
      }
    }

    if (!result) {
      throw new Error('No data in SSE response');
    }
  } else {
    result = await response.json();
  }

  if (result.error) {
    throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
  }

  return result.result;
}

/**
 * Call an MCP tool
 */
async function call_tool(name, args = {}) {
  return mcp_request('tools/call', { name, arguments: args });
}

/**
 * List available tools
 */
async function list_tools() {
  return mcp_request('tools/list', {});
}

/**
 * Initialize the MCP session
 */
async function initialize() {
  return mcp_request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-mcp-client',
      version: '1.0.0'
    }
  });
}

function log_section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function log_result(label, data) {
  console.log(`\n${label}:`);
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

/**
 * Main test sequence
 */
async function run_tests() {
  console.log('MCP HTTP Client Test');
  console.log(`Connecting to: ${MCP_URL}`);
  console.log('\nNote: Watch the server output for debug logs!\n');

  try {
    // -------------------------------------------------------------------------
    // Initialize Session
    // -------------------------------------------------------------------------
    log_section('1. Initialize MCP Session');

    const init_result = await initialize();
    log_result('Initialize response', init_result);
    console.log(`Session ID: ${session_id}`);

    // -------------------------------------------------------------------------
    // List Tools
    // -------------------------------------------------------------------------
    log_section('2. List Available Tools');

    const tools = await list_tools();
    console.log(`Found ${tools.tools.length} tools:`);
    for (const tool of tools.tools.slice(0, 5)) {
      console.log(`  - ${tool.name}: ${tool.description.slice(0, 60)}...`);
    }
    console.log(`  ... and ${tools.tools.length - 5} more`);

    // -------------------------------------------------------------------------
    // Get Stats
    // -------------------------------------------------------------------------
    log_section('3. Call get_stats Tool');

    const stats_result = await call_tool('get_stats', {});
    log_result('get_stats result', stats_result);

    // -------------------------------------------------------------------------
    // Add Memory
    // -------------------------------------------------------------------------
    log_section('4. Call add_memory Tool');

    const add_result = await call_tool('add_memory', {
      category: 'test',
      type: 'mcp_test',
      content: 'This is a test memory added via the MCP HTTP interface',
      tags: ['test', 'mcp', 'http'],
      importance: 6
    });
    log_result('add_memory result', add_result);

    // Parse the result (it's returned as text content)
    const added_memory = JSON.parse(add_result.content[0].text);
    const memory_id = added_memory.id;
    console.log(`\nCreated memory with ID: ${memory_id}`);

    // -------------------------------------------------------------------------
    // Get Memory
    // -------------------------------------------------------------------------
    log_section('5. Call get_memory Tool');

    const get_result = await call_tool('get_memory', { id: memory_id });
    log_result('get_memory result', get_result);

    // -------------------------------------------------------------------------
    // Search Memories
    // -------------------------------------------------------------------------
    log_section('6. Call search_memories Tool');

    const search_result = await call_tool('search_memories', {
      query: 'MCP HTTP interface test',
      mode: 'hybrid',
      limit: 5
    });
    log_result('search_memories result', search_result);

    // -------------------------------------------------------------------------
    // List Forks
    // -------------------------------------------------------------------------
    log_section('7. Call list_forks Tool');

    const forks_result = await call_tool('list_forks', {});
    log_result('list_forks result', forks_result);

    // -------------------------------------------------------------------------
    // Update Memory
    // -------------------------------------------------------------------------
    log_section('8. Call update_memory Tool');

    const update_result = await call_tool('update_memory', {
      id: memory_id,
      content: 'This is an UPDATED test memory via MCP HTTP interface',
      importance: 8
    });
    log_result('update_memory result', update_result);

    // -------------------------------------------------------------------------
    // Delete Memory
    // -------------------------------------------------------------------------
    log_section('9. Call delete_memory Tool');

    const delete_result = await call_tool('delete_memory', { id: memory_id });
    log_result('delete_memory result', delete_result);

    // -------------------------------------------------------------------------
    // Final Stats
    // -------------------------------------------------------------------------
    log_section('10. Final Stats');

    const final_stats = await call_tool('get_stats', {});
    log_result('Final stats', final_stats);

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    log_section('Test Summary');

    console.log(`
MCP HTTP interface test completed successfully!

Operations performed:
  1. Initialized MCP session
  2. Listed ${tools.tools.length} available tools
  3. Got store statistics
  4. Added a test memory
  5. Retrieved the memory by ID
  6. Searched for memories
  7. Listed forks
  8. Updated the memory
  9. Deleted the memory
  10. Got final statistics

Session ID: ${session_id}

Check the server output (stderr) for detailed debug logs of each operation!
`);
  } catch (error) {
    console.error('\nTest failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run tests
run_tests();
