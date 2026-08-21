// GET /api/health — build-info JSON. Useful for confirming a deploy went out:
// hit the URL, see which build is live plus the feature list + endpoint map.
// Public — no auth required.
//
// `build` is read from the deployed asset bundle's build stamp, so one GET
// answers both "which commit is live?" and "did the asset half of the deploy
// land?". A deploy that skipped the CLI archive step has no stamp — its
// download endpoints are broken — so `ok` is false there rather than
// cheerfully true. (A `vite dev` server has no stamp either, correctly: it
// cannot serve the CLI downloads.)

import { BUILTIN_TOOLS, NAMED_SWARM_PRESETS, ORCHESTRATOR_AGENT_SLUG, SWARM_PRESETS } from '@kinu.run/core';
import { readBuildStamp } from './lib/deployed-assets';


export async function handleHealthRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/health') return null;
  if (request.method !== 'GET') return null;
  const build = await readBuildStamp(env, request.url);
  return Response.json({
    ok: build !== null,
    build,
    // Counted, not declared: each figure is read out of a registry the
    // compiler already holds to its own declaration (BUILTIN_TOOLS cannot name
    // a tool the reach table does not call native), so a feature that dies
    // leaves this list in the same commit that deletes it. The hand list this
    // replaces survived the D1 removal by a day.
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
