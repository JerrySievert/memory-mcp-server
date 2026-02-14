#!/usr/bin/env node
/**
 * Test Client for Memory Store HTTP API
 *
 * Tests the HTTP interface by adding data and reading it back.
 * Run with: node src/test-client.js
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

/**
 * Make an HTTP request to the API
 */
async function api(method, path, body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `API error ${response.status}: ${data.error || JSON.stringify(data)}`
    );
  }

  return data;
}

/**
 * Test helper to log results
 */
function log_section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function log_result(label, data) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(data, null, 2));
}

function log_success(message) {
  console.log(`[OK] ${message}`);
}

function log_error(message) {
  console.error(`[FAIL] ${message}`);
}

/**
 * Main test sequence
 */
async function run_tests() {
  console.log('Memory Store HTTP API Test Client');
  console.log(`Connecting to: ${BASE_URL}`);

  // -------------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------------
  log_section('1. Health Check');

  const health = await api('GET', '/health');
  log_result('Health response', health);

  if (health.status === 'ok') {
    log_success('Server is healthy');
  } else {
    log_error('Server health check failed');
    return;
  }

  // -------------------------------------------------------------------------
  // Check Initial Stats
  // -------------------------------------------------------------------------
  log_section('2. Initial Stats');

  const initial_stats = await api('GET', '/stats');
  log_result('Initial store stats', initial_stats);

  // -------------------------------------------------------------------------
  // Add Memories
  // -------------------------------------------------------------------------
  log_section('3. Adding Memories');

  const memories_to_add = [
    {
      category: 'personal',
      type: 'preference',
      content: 'User prefers dark mode in all applications',
      tags: ['ui', 'preferences'],
      importance: 7
    },
    {
      category: 'work',
      type: 'project',
      content:
        'Working on a memory store project with append-only architecture',
      tags: ['development', 'architecture'],
      importance: 8
    },
    {
      category: 'personal',
      type: 'fact',
      content: 'User lives in San Francisco',
      tags: ['location', 'personal'],
      importance: 5
    }
  ];

  const added_memories = [];

  for (const memory_data of memories_to_add) {
    const memory = await api('POST', '/memories', memory_data);
    added_memories.push(memory);
    log_success(
      `Added memory: ${memory.id.slice(0, 8)}... - "${memory_data.content.slice(0, 40)}..."`
    );
  }

  log_result('First added memory (full)', added_memories[0]);

  // -------------------------------------------------------------------------
  // Read Back Memories
  // -------------------------------------------------------------------------
  log_section('4. Reading Back Memories');

  // Read individual memory
  const first_memory_id = added_memories[0].id;
  const fetched_memory = await api('GET', `/memories/${first_memory_id}`);
  log_result(
    `Fetched memory ${first_memory_id.slice(0, 8)}...`,
    fetched_memory
  );

  // Verify content matches
  if (fetched_memory.content === added_memories[0].content) {
    log_success('Memory content matches');
  } else {
    log_error('Memory content mismatch!');
    console.log('Expected:', added_memories[0].content);
    console.log('Got:', fetched_memory.content);
  }

  // List all memories
  const all_memories = await api('GET', '/memories');
  log_result(
    `Listed ${all_memories.length} memories`,
    all_memories.map((m) => ({
      id: m.id.slice(0, 8) + '...',
      category: m.category,
      content: m.content.slice(0, 50) + '...'
    }))
  );

  // -------------------------------------------------------------------------
  // Search Memories
  // -------------------------------------------------------------------------
  log_section('5. Searching Memories');

  // Text search
  const text_search = await api('POST', '/memories/search', {
    query: 'dark mode',
    mode: 'text',
    limit: 5
  });
  log_result(
    'Text search for "dark mode"',
    text_search.map((m) => ({
      id: m.id.slice(0, 8) + '...',
      content: m.content.slice(0, 50) + '...',
      score: m.score
    }))
  );

  // Hybrid search
  const hybrid_search = await api('POST', '/memories/search', {
    query: 'user preferences and settings',
    mode: 'hybrid',
    limit: 5
  });
  log_result(
    'Hybrid search for "user preferences and settings"',
    hybrid_search.map((m) => ({
      id: m.id.slice(0, 8) + '...',
      content: m.content.slice(0, 50) + '...',
      score: m.score,
      semanticScore: m.semanticScore,
      textScore: m.textScore
    }))
  );

  // -------------------------------------------------------------------------
  // Add Relationships
  // -------------------------------------------------------------------------
  log_section('6. Adding Relationships');

  // Create relationship between first two memories
  const relationship = await api('POST', '/relationships', {
    memory_id: added_memories[0].id,
    related_memory_id: added_memories[1].id,
    relationship_type: 'related_to'
  });
  log_result('Created relationship', relationship);

  // Get relationships for first memory
  const relationships = await api(
    'GET',
    `/memories/${added_memories[0].id}/relationships`
  );
  log_result('Relationships for first memory', relationships);

  // Get related memories
  const related = await api('GET', `/memories/${added_memories[0].id}/related`);
  log_result(
    'Related memories',
    related.map((m) => ({
      id: m.id.slice(0, 8) + '...',
      content: m.content.slice(0, 50) + '...'
    }))
  );

  // -------------------------------------------------------------------------
  // Update Memory
  // -------------------------------------------------------------------------
  log_section('7. Updating Memory');

  const updated_memory = await api('PUT', `/memories/${first_memory_id}`, {
    content:
      'User strongly prefers dark mode in all applications, especially IDEs',
    importance: 9
  });
  log_result('Updated memory', updated_memory);

  // Verify update
  const refetched = await api('GET', `/memories/${first_memory_id}`);
  if (
    refetched.content.includes('strongly prefers') &&
    refetched.importance === 9
  ) {
    log_success('Memory updated correctly');
  } else {
    log_error('Memory update verification failed');
  }

  // -------------------------------------------------------------------------
  // Check Stats After Operations
  // -------------------------------------------------------------------------
  log_section('8. Stats After Operations');

  const final_stats = await api('GET', '/stats');
  log_result('Final store stats', final_stats);

  console.log('\nComparison:');
  console.log(
    `  Memories: ${initial_stats.memoryCount} -> ${final_stats.memoryCount}`
  );
  console.log(
    `  Relationships: ${initial_stats.relationshipCount} -> ${final_stats.relationshipCount}`
  );

  // -------------------------------------------------------------------------
  // Debug Endpoints
  // -------------------------------------------------------------------------
  log_section('9. Debug Endpoints');

  const debug_stores = await api('GET', '/debug/stores');
  log_result(
    'Debug stores overview',
    debug_stores.stores.map((s) => ({
      id: s.id.slice(0, 8) + (s.id.length > 8 ? '...' : ''),
      name: s.name,
      type: s.type,
      memoryCount: s.memoryCount,
      relationshipCount: s.relationshipCount
    }))
  );

  // Get detailed memories from debug endpoint
  const debug_memories = await api(
    'GET',
    '/debug/stores/main/memories?limit=10'
  );
  log_result('Debug memories (main store)', {
    count: debug_memories.count,
    memories: debug_memories.memories.map((m) => ({
      id: m.id.slice(0, 8) + '...',
      version: m.version,
      content: m.content.slice(0, 40) + '...',
      hasEmbedding: m.hasEmbedding
    }))
  });

  // -------------------------------------------------------------------------
  // Delete Memory
  // -------------------------------------------------------------------------
  log_section('10. Delete Memory');

  const third_memory_id = added_memories[2].id;
  const delete_result = await api('DELETE', `/memories/${third_memory_id}`);
  log_result('Delete result', delete_result);

  // Verify deletion (should return 404)
  try {
    await api('GET', `/memories/${third_memory_id}`);
    log_error('Memory still accessible after deletion');
  } catch (e) {
    if (e.message.includes('404')) {
      log_success('Memory correctly deleted (404 on fetch)');
    } else {
      log_error(`Unexpected error: ${e.message}`);
    }
  }

  // Check it shows up with includeArchived
  const archived_memories = await api('GET', '/memories?includeArchived=true');
  const found_deleted = archived_memories.find((m) => m.id === third_memory_id);
  if (found_deleted && found_deleted.archived) {
    log_success('Deleted memory found in archived list');
  }

  // -------------------------------------------------------------------------
  // Final Stats
  // -------------------------------------------------------------------------
  log_section('11. Final Stats');

  const post_delete_stats = await api('GET', '/stats');
  log_result('Stats after deletion', post_delete_stats);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log_section('Test Summary');

  console.log(`
Operations performed:
  - Added ${memories_to_add.length} memories
  - Created 1 relationship
  - Updated 1 memory
  - Deleted 1 memory
  - Performed text and hybrid searches
  - Verified data through debug endpoints

Final state:
  - Active memories: ${post_delete_stats.memoryCount}
  - Deleted memories: ${post_delete_stats.deletedMemoryCount}
  - Relationships: ${post_delete_stats.relationshipCount}
  - Total records: ${post_delete_stats.totalRecords}
`);

  log_success('All tests completed!');
}

// Run tests
run_tests().catch((err) => {
  console.error('\nTest failed with error:', err.message);
  process.exit(1);
});
