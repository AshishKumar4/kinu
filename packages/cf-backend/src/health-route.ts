// GET /api/health — build-info JSON. Useful for confirming a deploy went out:
// hit the URL, see the feature list + endpoint map.

const FEATURES: ReadonlyArray<string> = [
  'multi-provider-registry',
  'codex-oauth',
  'branching-heads',
  'scaffold-loop-closure',
  'scaffold-shadow-rollout',
  'run-event-log',
  'sse-resume',
  'mcp-server',
  'background-review',
  'compaction',
  'approval-gate',
  'fiber-recovery',
];

export function handleHealthRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/api/health') return null;
  if (request.method !== 'GET') return null;
  return Response.json({
    ok: true,
    features: FEATURES,
    endpoints: {
      // Run events
      'GET /api/agents/<name>/runs': 'list recent runs w/ event counts',
      'GET /api/agents/<name>/runs/<id>/events?since=&limit=&types=': 'paginated event query',
      'GET /api/agents/<name>/runs/<id>/stream': 'SSE w/ Last-Event-ID resume',
      // Auth / credentials
      'POST /api/agents/<name>/auth/codex/start | /codex/poll': 'ChatGPT OAuth device-code flow',
      'GET/DELETE /api/agents/<name>/auth/codex': 'Codex connection status / disconnect',
      'POST/DELETE /api/agents/<name>/auth/credentials/<key>': 'BYO API key for openai / openrouter / openai-compat',
      // MCP
      'POST/GET/DELETE /mcp/v1/<agentName>': 'MCP streamable-HTTP server',
      // Chat (Think SDK)
      '/agents/orchestrator-agent/<name>/...': 'chat WebSocket',
      // Preview
      '/_preview/<port>/<sandbox>/<token>/': 'sandbox container preview proxy',
      // PC tunnel
      '/pc/connect': 'reverse-WebSocket tunnel for SSH/laptop sandbox',
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
  });
}
