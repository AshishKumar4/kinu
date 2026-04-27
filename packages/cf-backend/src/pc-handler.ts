/**
 * PC executor — reverse-WebSocket tunnel from the user's laptop.
 *
 * Routes:
 *   GET  /pc/install                — one-line curl install script
 *   GET  /pc/daemon.js              — the Node daemon binary (JS)
 *   WS   /pc/connect?agent=X&token=Y — daemon WS upgrade
 *
 * Tokens are issued via `@callable() getPcInstallUrl()` on the orchestrator
 * (forthcoming). For now, the install endpoint returns a script that uses a
 * per-agent token embedded at runtime via the agent's @callable RPC.
 *
 * Per-agent WS registry: when a daemon connects with ?agent=<name>&token=<t>,
 * we look up the orchestrator DO for that agent and call its `attachPcSocket`
 * @callable RPC. The orchestrator's SSH executor handles the socket lifecycle.
 */

import { readFileSync } from "node:fs";

const DAEMON_JS_URL = "/pc/daemon.js";

export async function handlePcRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/pc/install") {
    return installScriptResponse(url.origin);
  }
  if (path === "/pc/daemon.js") {
    return daemonJsResponse();
  }
  if (path === "/pc/connect") {
    return handlePcConnect(request, env);
  }
  return new Response("Not found", { status: 404 });
}

function installScriptResponse(origin: string): Response {
  // Users run:  curl -fsSL <origin>/pc/install?agent=<name>&token=<t> | bash
  // The script downloads daemon.js, writes ~/.proteus/pc-agent.js and a
  // helper launcher. It reads agent+token from env vars so they don't leak
  // into shell history via the URL.
  const script = `#!/usr/bin/env bash
set -eu
: "\${PROTEUS_AGENT:?set PROTEUS_AGENT=<agent-name> before running}"
: "\${PROTEUS_TOKEN:?set PROTEUS_TOKEN=<one-shot-token> before running}"
PROTEUS_ORIGIN="\${PROTEUS_ORIGIN:-${origin}}"

DIR="\$HOME/.proteus"
mkdir -p "\$DIR"
chmod 700 "\$DIR"
echo "Downloading Proteus PC daemon…"
curl -fsSL "\$PROTEUS_ORIGIN${DAEMON_JS_URL}" -o "\$DIR/pc-agent.js"
cat > "\$DIR/config.json" <<EOF
{"agent":"\$PROTEUS_AGENT","token":"\$PROTEUS_TOKEN","origin":"\$PROTEUS_ORIGIN"}
EOF
chmod 600 "\$DIR/config.json"

if command -v node >/dev/null 2>&1; then
  echo "Starting daemon (node)…"
  nohup node "\$DIR/pc-agent.js" > "\$DIR/pc-agent.log" 2>&1 &
  echo "  PID=\$! log=\$DIR/pc-agent.log"
else
  echo "Node.js required. Install https://nodejs.org/ then re-run."
  exit 1
fi
echo "Proteus PC daemon installed. Check the Executors tab — Your PC should flip to connected within a few seconds."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

function daemonJsResponse(): Response {
  // The daemon source is bundled as a string at module load time via
  // `import daemonSource from "./pc-agent-daemon.js?raw"` in production.
  // For runtime simplicity we inline it here. The content is synced from
  // packages/pc-agent/index.js by the deploy script.
  return new Response(PC_AGENT_DAEMON_SOURCE, {
    status: 200,
    headers: { "content-type": "application/javascript; charset=utf-8" },
  });
}

async function handlePcConnect(request: Request, env: Env): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const url = new URL(request.url);
  const agentName = url.searchParams.get("agent");
  const token = url.searchParams.get("token");
  if (!agentName || !token) {
    return new Response("Missing ?agent or ?token", { status: 400 });
  }

  const ns = env.OrchestratorAgent;
  if (!ns) return new Response("No OrchestratorAgent binding", { status: 500 });
  const id = ns.idFromName(agentName);
  const stub = ns.get(id);

  // Verify token by RPC before upgrading.
  const verified = await (stub as unknown as { verifyPcToken(token: string): Promise<{ ok: boolean }> })
    .verifyPcToken(token);
  if (!verified?.ok) return new Response("unauthorized", { status: 401 });

  // Accept the WebSocket, then hand the server side to the DO.
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  (server as unknown as { accept(): void }).accept();
  await (stub as unknown as { attachPcSocket(ws: WebSocket): Promise<void> }).attachPcSocket(server);

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

// ── Daemon source (sync from packages/pc-agent/index.js) ─────────
// Kept inline to avoid a separate asset binding. Pure Node.js, no deps.
const PC_AGENT_DAEMON_SOURCE = `#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const AGENT = cfg.agent, TOKEN = cfg.token;
const ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/^http/, 'ws');
const WS_URL = \`\${ORIGIN}/pc/connect?agent=\${encodeURIComponent(AGENT)}&token=\${encodeURIComponent(TOKEN)}\`;

let WS;
try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

function log(...a) { console.log(new Date().toISOString(), ...a); }

function rpc(ws, id, result, error) {
  ws.send(JSON.stringify(error ? { id, error } : { id, result }));
}

function handle(msg, ws) {
  const { id, method, params } = msg;
  try {
    if (method === 'exec') {
      const cmd = params[0];
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => rpc(ws, id, { stdout, stderr, exitCode: code ?? 0 }));
      child.on('error', (e) => rpc(ws, id, null, e.message));
    } else if (method === 'readFile') {
      rpc(ws, id, fs.readFileSync(params[0], 'utf8'));
    } else if (method === 'writeFile') {
      fs.mkdirSync(path.dirname(params[0]), { recursive: true });
      fs.writeFileSync(params[0], params[1]);
      rpc(ws, id, 'ok');
    } else if (method === 'listFiles') {
      const p = params[0] || os.homedir();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      rpc(ws, id, entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })));
    } else if (method === 'listPorts') {
      rpc(ws, id, []); // PC-local port listing not implemented in v1
    } else {
      rpc(ws, id, null, 'unknown method: ' + method);
    }
  } catch (err) {
    rpc(ws, id, null, err instanceof Error ? err.message : String(err));
  }
}

let backoff = 1000;
function connect() {
  log('Connecting to', WS_URL);
  const ws = mkWs(WS_URL);
  ws.addEventListener('open', () => {
    log('Connected');
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'HELLO', agent: AGENT, os: os.platform(), hostname: os.hostname(), pid: process.pid }));
  });
  ws.addEventListener('message', (ev) => {
    try { handle(JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)), ws); }
    catch (err) { log('parse error:', err); }
  });
  ws.addEventListener('close', () => {
    log('Disconnected, reconnecting in', backoff, 'ms');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.addEventListener('error', (err) => log('WS error:', err.message || err));
}
connect();
`;
