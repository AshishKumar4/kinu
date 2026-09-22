// GET /api/health: public build-info JSON. `ok` is false without a build stamp
// (the CLI download endpoints are then broken).

import { BUILTIN_TOOLS } from '../tools/registry';
import { NAMED_SWARM_PRESETS, SWARM_PRESETS } from '../types/swarm';
import { ORCHESTRATOR_AGENT_SLUG } from '../cloud-wire';
import { readBuildStamp } from './deployed-assets';


export async function handleHealthRequest(
  request: Request,
  env: Parameters<typeof readBuildStamp>[0],
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== '/api/health') return null;

  if (request.method !== 'GET') return null;
  const build = await readBuildStamp(env, request.url);

  return Response.json({
    ok: build !== null,
    build,
    // Counted from registries so a removed feature cannot stay advertised.
    features: {
      builtinTools: BUILTIN_TOOLS.length,
      swarmPresets: SWARM_PRESETS.length,
      namedSearches: NAMED_SWARM_PRESETS.length,
    },
    endpoints: {
      // User-scoped (auth required)
      'GET /api/user/profile': 'caller identity',
      'GET/POST/DELETE /api/user/workspaces[/<name>]': 'agent registry',
      'GET/POST/DELETE /api/user/credentials[/<key>]': 'BYO API keys',
      'POST /api/user/codex/start | /codex/poll': 'ChatGPT device-flow',
      'GET/DELETE /api/user/codex': 'Codex status / disconnect',
      'GET /api/user/models': 'available models (union of connected providers)',
      'POST /api/client-errors': 'browser render-failure reports',
      // Per-agent (auth + ownership required)
      'GET /api/workspaces/<name>/runs': 'list recent runs',
      'GET /api/workspaces/<name>/runs/<id>/events': 'paginated event query',
      'GET /api/workspaces/<name>/runs/<id>/stream': 'SSE w/ Last-Event-ID resume',
      'POST/GET/DELETE /mcp/v1/<agentName>': 'MCP streamable-HTTP server',
      [`/agents/${ORCHESTRATOR_AGENT_SLUG}/<name>/...`]: 'chat WebSocket (Think SDK)',
      // Public
      'https://<capability-host>.<preview-host-suffix>/': 'Workspace or Sandbox port preview',
      '/pc/connect': 'reverse-WebSocket tunnel',
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
  });
}
