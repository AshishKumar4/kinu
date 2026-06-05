/**
 * Device tunnel — reverse-WebSocket from the user's laptop, at the USER level.
 *
 * Routes:
 *   GET  /pc/install                — daemon updater/starter for an existing local config
 *   GET  /pc/daemon.js              — the Node daemon binary (JS)
 *   POST /pc/connect-ticket         — exchange local device token for short-lived WS ticket
 *   WS   /pc/connect?user=U&ticket=T — daemon WS upgrade
 *
 * A device links ONCE to the user (token minted by UserDO.registerDevice), and
 * every one of that user's agents can then reach it. The daemon stores that
 * token locally, exchanges it over HTTPS for a one-minute ticket, then connects
 * the WebSocket with the ticket so long-lived secrets do not appear in URLs.
 */

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
  if (path === "/pc/connect-ticket") {
    return handlePcConnectTicket(request, env);
  }
  if (path === "/pc/connect") {
    return handlePcConnect(request, env);
  }
  return new Response("Not found", { status: 404 });
}

function installScriptResponse(origin: string): Response {
  // `proteus connect` writes ~/.proteus/device.json with the device token over
  // an authenticated HTTPS API call. This script only updates/starts the daemon
  // for users who already have that local config.
  const script = `#!/usr/bin/env bash
set -eu
PROTEUS_ORIGIN="\${PROTEUS_ORIGIN:-${origin}}"

DIR="\$HOME/.proteus"
mkdir -p "\$DIR"
chmod 700 "\$DIR"
if [ ! -f "\$DIR/device.json" ]; then
  echo "No Proteus device config found at \$DIR/device.json."
  echo "Run: proteus auth --origin \$PROTEUS_ORIGIN && proteus connect"
  exit 1
fi
echo "Downloading Proteus device daemon…"
curl -fsSL "\$PROTEUS_ORIGIN${DAEMON_JS_URL}" -o "\$DIR/pc-agent.js"
chmod 600 "\$DIR/device.json"

if command -v node >/dev/null 2>&1; then
  echo "Starting daemon (node)…"
  nohup node "\$DIR/pc-agent.js" > "\$DIR/pc-agent.log" 2>&1 &
  echo "  PID=\$! log=\$DIR/pc-agent.log"
else
  echo "Node.js required. Install https://nodejs.org/ then re-run."
  exit 1
fi
echo "Proteus device connected. Check the Devices tab — it should flip to connected within a few seconds."
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

async function handlePcConnectTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await safeJson<{ user?: string; token?: string }>(request);
  if (!body?.user || !body.token) return json({ error: "user and token required" }, { status: 400 });
  if (!/^[a-f0-9]{32}$/.test(body.user)) return json({ error: "invalid user" }, { status: 400 });

  const ns = env.UserDO;
  if (!ns) return json({ error: "No UserDO binding" }, { status: 500 });
  const stub = ns.get(ns.idFromName(body.user)) as unknown as {
    issueDeviceConnectTicket(token: string): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }>;
  };
  const issued = await stub.issueDeviceConnectTicket(body.token);
  if (!issued.ok || !issued.ticket || !issued.expiresAt) return json({ error: "unauthorized" }, { status: 401 });
  return json({ ticket: issued.ticket, expiresAt: issued.expiresAt });
}

async function handlePcConnect(request: Request, env: Env): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const url = new URL(request.url);
  const userId = url.searchParams.get("user");
  const ticket = url.searchParams.get("ticket");
  if (!userId || !ticket) {
    return new Response("Missing ?user or ?ticket", { status: 400 });
  }
  if (!/^[a-f0-9]{32}$/.test(userId)) return new Response("invalid user", { status: 400 });

  const ns = env.UserDO;
  if (!ns) return new Response("No UserDO binding", { status: 500 });
  const stub = ns.get(ns.idFromName(userId)) as unknown as {
    verifyDeviceConnectTicket(ticket: string): Promise<{ ok: boolean; deviceId?: string }>;
    attachDeviceSocket(deviceId: string, ws: WebSocket): Promise<void>;
  };

  // Verify and consume the short-lived ticket before upgrading.
  const verified = await stub.verifyDeviceConnectTicket(ticket);
  if (!verified?.ok || !verified.deviceId) return new Response("unauthorized", { status: 401 });

  // Accept the WebSocket and hand the server side to the UserDO (it accepts +
  // wires the JSON-RPC tunnel; the agents forward calls to it).
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  await stub.attachDeviceSocket(verified.deviceId, server);

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
	const { spawn, execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'device.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const USER = cfg.user, TOKEN = cfg.token;
const HTTP_ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/\\/+$/, '');
const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');

let WS;
try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

function log(...a) { console.log(new Date().toISOString(), ...a); }

	function rpc(ws, id, result, error) {
	  ws.send(JSON.stringify(error ? { id, error } : { id, result }));
	}

	function runCommand(cmd, args) {
	  try {
	    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	  } catch {
	    return null;
	  }
	}

	function listListeningPorts() {
	  const rows = [];
	  const seen = new Set();
	  const add = (port, host, command, pid) => {
	    const n = Number(port);
	    if (!Number.isInteger(n) || n <= 0 || n > 65535) return;
	    const key = (host || '') + ':' + n + ':' + (pid || '') + ':' + (command || '');
	    if (seen.has(key)) return;
	    seen.add(key);
	    rows.push({ port: n, host: host || '0.0.0.0', protocol: 'tcp', command: command || null, pid: pid ? Number(pid) : null });
	  };

	  const lsof = runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
	  if (lsof) {
	    for (const line of lsof.split('\\n').slice(1)) {
	      const parts = line.trim().split(/\\s+/);
	      const name = parts.slice(8).join(' ');
	      const m = name.match(/(.+):(\\d+)\\s+\\(LISTEN\\)$/);
	      if (m) add(m[2], m[1].replace(/^\\[|\\]$/g, ''), parts[0], parts[1]);
	    }
	    if (rows.length) return rows;
	  }

	  const ss = runCommand('ss', ['-ltnp']);
	  if (ss) {
	    for (const line of ss.split('\\n').slice(1)) {
	      const parts = line.trim().split(/\\s+/);
	      const local = parts[3] || '';
	      const m = local.match(/^(.*):(\\d+)$/);
	      const proc = line.match(/users:\\(\\("([^"]+)",pid=(\\d+)/);
	      if (m) add(m[2], m[1].replace(/^\\[|\\]$/g, ''), proc?.[1], proc?.[2]);
	    }
	    if (rows.length) return rows;
	  }

	  const netstat = runCommand('netstat', ['-anv']);
	  if (netstat) {
	    for (const line of netstat.split('\\n')) {
	      if (!/\\bLISTEN\\b/i.test(line) || !/^tcp/i.test(line.trim())) continue;
	      const parts = line.trim().split(/\\s+/);
	      const local = parts[3] || parts[1] || '';
	      const m = local.match(/^(.*)\\.(\\d+)$/) || local.match(/^(.*):(\\d+)$/);
	      if (m) add(m[2], m[1].replace(/^\\[|\\]$/g, ''), null, null);
	    }
	  }
	  return rows;
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
      rpc(ws, id, { success: true });
    } else if (method === 'listFiles') {
      const p = params[0] || os.homedir();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      rpc(ws, id, entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })));
	    } else if (method === 'exists') {
	      rpc(ws, id, fs.existsSync(params[0]));
	    } else if (method === 'listPorts') {
	      rpc(ws, id, listListeningPorts());
    } else {
      rpc(ws, id, null, 'unknown method: ' + method);
    }
  } catch (err) {
    rpc(ws, id, null, err instanceof Error ? err.message : String(err));
  }
}

let backoff = 1000;
async function getTicket() {
  const res = await fetch(HTTP_ORIGIN + '/pc/connect-ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: USER, token: TOKEN }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* nop */ }
  if (!res.ok || !body.ticket) throw new Error(body.error || ('ticket exchange failed: HTTP ' + res.status));
  return body.ticket;
}

async function connect() {
  let ticket;
  try { ticket = await getTicket(); }
  catch (err) {
    log('Ticket exchange failed:', err.message || err);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
    return;
  }
  const WS_URL = \`\${WS_ORIGIN}/pc/connect?user=\${encodeURIComponent(USER)}&ticket=\${encodeURIComponent(ticket)}\`;
  log('Connecting to', WS_ORIGIN + '/pc/connect');
  const ws = mkWs(WS_URL);
  ws.addEventListener('open', () => {
    log('Connected');
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'HELLO', user: USER, os: os.platform(), hostname: os.hostname(), pid: process.pid }));
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

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
