/**
 * GET /api/v2/health — returns a v2 build-info JSON.
 *
 * Useful for confirming a deploy actually went out: hit the URL,
 * see the build sha + v2 feature flags + endpoint list.
 */

const V2_FEATURES: ReadonlyArray<string> = [
  'sandbox-api',
  'branching-heads',
  'scaffold-loop-closure',
  'scaffold-shadow-rollout',
  'run-event-log',
  'sse-resume',
  'mcp-server',
  'background-review-fork',
  'compaction',
  'approval-gate',
  'fiber-recovery-hook',
];

export function handleHealthRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/api/v2/health') return null;
  if (request.method !== 'GET') return null;
  return Response.json({
    ok: true,
    version: 'proteus-v2',
    features: V2_FEATURES,
    endpoints: {
      // Run events (Flue-style)
      'GET /api/agents/<name>/runs': 'list recent runs w/ event counts',
      'GET /api/agents/<name>/runs/<id>/events?since=&limit=&types=':
        'paginated event query',
      'GET /api/agents/<name>/runs/<id>/stream':
        'SSE w/ Last-Event-ID resume',
      // MCP
      'POST/GET/DELETE /mcp/v1/<agentName>':
        'MCP streamable-HTTP server (tools: search_memory, save_note, list_skills, run_scaffold_once, get_shadow_status, list_runs, list_run_events; resource: proteus://agent/<n>/memory)',
      // Chat (existing)
      '/agents/orchestrator-agent/<name>/...': 'Think chat WebSocket',
      // Preview (existing)
      '/_preview/<port>/<sandbox>/<token>/': 'sandbox container preview proxy',
      // PC tunnel (existing)
      '/pc/connect': 'reverse-WebSocket tunnel for SSH/laptop sandbox',
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    },
  });
}
