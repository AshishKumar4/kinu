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

import PC_AGENT_DAEMON_SOURCE from "../../pc-agent/src/index.js?raw";
import { DEVICE_CONNECT_PATH } from "@kinu/core";
import { json, safeJson } from "./lib/http";
import { ownerCaller } from "./user/workspace-capability";
import * as v from "valibot";

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
  if (path === DEVICE_CONNECT_PATH) {
    return handlePcConnect(request, env);
  }
  return new Response("Not found", { status: 404 });
}

function installScriptResponse(origin: string): Response {
  // `kinu connect` writes ~/.kinu/device.json with the device token over
  // an authenticated HTTPS API call. This script only updates/starts the daemon
  // for users who already have that local config.
  const script = `#!/usr/bin/env bash
set -eu
KINU_ORIGIN="\${KINU_ORIGIN:-${origin}}"

DIR="$HOME/.kinu"
mkdir -p "$DIR"
chmod 700 "$DIR"
if [ ! -f "$DIR/device.json" ]; then
  echo "No Kinu device config found at $DIR/device.json."
  echo "Run: kinu auth --origin $KINU_ORIGIN && kinu connect"
  exit 1
fi
echo "Downloading Kinu device daemon…"
curl -fsSL "$KINU_ORIGIN${DAEMON_JS_URL}" -o "$DIR/pc-agent.js"
chmod 600 "$DIR/device.json"

if command -v node >/dev/null 2>&1; then
  echo "Starting daemon (node)…"
  nohup node "$DIR/pc-agent.js" > "$DIR/pc-agent.log" 2>&1 &
  echo "  PID=$! log=$DIR/pc-agent.log"
else
  echo "Node.js required. Install https://nodejs.org/ then re-run."
  exit 1
fi
echo "Kinu device connected. Check the Environment tab. It should flip to connected within a few seconds."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

function daemonJsResponse(): Response {
  // The daemon source is packages/pc-agent/src/index.js, bundled as a string
  // at build time via vite's `?raw` import — one source of truth, no copies.
  return new Response(PC_AGENT_DAEMON_SOURCE, {
    status: 200,
    headers: { "content-type": "application/javascript; charset=utf-8" },
  });
}

async function handlePcConnectTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await safeJson(request, v.object({
    user: v.optional(v.string()),
    token: v.optional(v.string()),
  }));
  if (!body?.user || !body.token) return json({ error: "user and token required" }, { status: 400 });
  if (!/^[a-f0-9]{32}$/.test(body.user)) return json({ error: "invalid user" }, { status: 400 });

  const ns = env.UserDO;
  if (!ns) return json({ error: "No UserDO binding" }, { status: 500 });
  const issued = await ns.get(ns.idFromName(body.user)).issueDeviceConnectTicket(await ownerCaller(env), body.token);
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
  // A WebSocket cannot cross the DO RPC boundary (not serializable) — but the
  // upgrade Request can. Forward it to the UserDO, which verifies + consumes
  // the ticket and accepts the socket inside its own fetch().
  return ns.get(ns.idFromName(userId)).fetch(request);
}
