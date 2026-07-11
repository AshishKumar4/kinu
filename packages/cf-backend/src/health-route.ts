// GET /api/health — build-info JSON. Useful for confirming a deploy went out:
// hit the URL, see the feature list + endpoint map. Public — no auth required.

import { ORCHESTRATOR_AGENT_SLUG } from '@proteus/core';

const FEATURES: ReadonlyArray<string> = [
  'd1-oauth-session-auth',
  'd1-read-replica-sessions',
  'd1-cli-auth-state',
  'user-do',
  'multi-tenant',
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
];

export function handleHealthRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/api/health') return null;
  if (request.method !== 'GET') return null;
  return Response.json({
    ok: true,
    features: FEATURES,
    endpoints: {
      // User-scoped (auth required)
      'GET /api/user/profile': 'caller identity',
      'GET/POST/DELETE /api/user/workspaces[/<name>]': 'agent registry',
      'GET/POST/DELETE /api/user/credentials[/<key>]': 'BYO API keys',
      'POST /api/user/codex/start | /codex/poll': 'ChatGPT device-flow',
      'GET/DELETE /api/user/codex': 'Codex status / disconnect',
      'GET /api/user/models': 'available models (union of connected providers)',
      // Per-agent (auth + ownership required)
      'GET /api/workspaces/<name>/runs': 'list recent runs',
      'GET /api/workspaces/<name>/runs/<id>/events': 'paginated event query',
      'GET /api/workspaces/<name>/runs/<id>/stream': 'SSE w/ Last-Event-ID resume',
      'POST/GET/DELETE /mcp/v1/<agentName>': 'MCP streamable-HTTP server',
      [`/agents/${ORCHESTRATOR_AGENT_SLUG}/<name>/...`]: 'chat WebSocket (Think SDK)',
      // Public
      '/_preview/<port>/<sandbox>/<token>/': 'sandbox container preview proxy',
      '/pc/connect': 'reverse-WebSocket tunnel',
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
  });
}
