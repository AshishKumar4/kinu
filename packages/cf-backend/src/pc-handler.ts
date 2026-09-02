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
 *
 * The two authenticated rails (`/pc/connect-ticket`, `/pc/connect`) are the
 * only unauthenticated paths here that choose a Durable Object by name, so
 * both are gated twice before any `idFromName`: an ingress guard bounds how
 * often each source may knock, and every presented identifier must match its
 * exact issued shape. See "Ingress guard" below for why this is rate limiting
 * rather than cryptographic route verification, and what that leaves open.
 */

import PC_AGENT_DAEMON_SOURCE from "../../pc-agent/src/index.js?raw";
import { DEVICE_CONNECT_PATH } from "@kinu.run/core";
import { json, readBounded } from "./lib/http";
import { sha256Hex } from "./lib/crypto";
import {
  ownerCaller,
  type OwnerCapabilityEnv,
  type UserCaller,
} from "./user/workspace-capability";
import { diagnostics, KinuError, renderThrownChain } from "@kinu.run/core/obs";
import { ingressAdmitted, ingressDenied, peerIp } from "./lib/ingress-budget";
import type { KvStore } from "./lib/kv";
import * as v from "valibot";

const DAEMON_JS_URL = "/pc/daemon.js";
export interface PcUserStub {
  issueDeviceConnectTicket(
    caller: UserCaller,
    token: string,
  ): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }>;
  fetch(request: Request): Promise<Response>;
}

export interface PcUserNamespace<Id> {
  idFromName(name: string): Id;
  get(id: Id): PcUserStub;
}

export interface PcIngressEnv<Id> extends OwnerCapabilityEnv {
  AUTH_KV?: KvStore;
  UserDO?: PcUserNamespace<Id>;
}

// ── Ingress guard ──────────────────────────────────────────────────────────
//
// Both unauthenticated rails here (`/pc/connect-ticket`, `/pc/connect`) choose
// a UserDO by a name the caller supplied, so both spend a knock from the shared
// budget in `lib/ingress-budget.ts` and pass strict shape gates before any
// `idFromName`. That module states the budget's exact residuals.
//
// The preferred architecture would bind an opaque routing id INTO the device
// token, so the edge could verify which UserDO a token belongs to before
// choosing one. It cannot be done here without a migration: deployed daemons
// hold tokens minted as opaque `pdt_<random>` whose only server-side trace is
// a bare SHA-256 hash inside the user's DO, so nothing about a live token can
// be checked from the Worker alone. Until UserDO mints — and devices re-register
// with — the bound format, the honest control on this rail is rate limiting
// plus shape gates, NOT a pretend verification. A distributed attacker rotating
// IPs stays under the per-source radar; only the token-format migration closes
// that, because then a wrong guess is rejected at the edge without waking any
// DO at all.

/** The ticket request body is two short strings. Anything past 4 KiB is not a
 *  ticket exchange: it is refused before parsing, counted off the stream, and
 *  never buffered whole past the limit. */
const PC_TICKET_BODY_MAX_BYTES = 4 * 1024;
/** Self-imposed budget, not a measured platform number: generous enough for a
 *  daemon retrying against jitter, far below what a guessing attack needs. */
const PC_KNOCKS_PER_WINDOW = 30;

const USER_ID_PATTERN = /^[a-f0-9]{32}$/;
const DEVICE_TOKEN_PATTERN = /^pdt_[A-Za-z0-9_-]{32,}$/;
const CONNECT_TICKET_PATTERN = /^pct_[A-Za-z0-9_-]{32,}$/;

export async function handlePcRequest<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
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
  //
  // The daemon starts on the same runtime the CLI itself requires: Kinu's own
  // managed Bun at $KINU_HOME/runtime/bin/bun, then a compatible Bun already on
  // PATH. A `node` on PATH is never consulted — the same PATH dependence that
  // broke `kinu connect` on machines whose Node lacks a global WebSocket. The
  // candidate must itself report a compatible version; presence is not
  // compatibility.
  const script = `#!/usr/bin/env bash
set -eu
KINU_HOME="\${KINU_HOME:-$HOME/.kinu}"
KINU_ORIGIN="\${KINU_ORIGIN:-${origin}}"

DIR="$KINU_HOME"
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

KINU_BUN=""
for candidate in "$DIR/runtime/bin/bun" "$(command -v bun 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
    KINU_BUN="$candidate"
    break
  fi
done
if [ -z "$KINU_BUN" ]; then
  echo "Bun required. Re-run the Kinu install command, or install https://bun.sh then re-run."
  exit 1
fi
echo "Starting daemon ($KINU_BUN)…"
nohup "$KINU_BUN" "$DIR/pc-agent.js" > "$DIR/pc-agent.log" 2>&1 &
echo "  PID=$! log=$DIR/pc-agent.log"
echo "Kinu device connected. Check the Environment tab. It should flip to connected within a few seconds."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

async function daemonJsResponse(): Promise<Response> {
  // The daemon source is packages/pc-agent/src/index.js, bundled as a string
  // at build time via vite's `?raw` import — one source of truth, no copies.
  // The digest pins the exact bytes this route serves, so a client (or the
  // install script's curl) can verify the download against this same Worker.
  const digest = await sha256Hex(PC_AGENT_DAEMON_SOURCE);
  return new Response(PC_AGENT_DAEMON_SOURCE, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "x-kinu-daemon-sha256": digest,
    },
  });
}
const TICKET_BODY_SCHEMA = v.object({
  user: v.optional(v.string()),
  token: v.optional(v.string()),
});

async function handlePcConnectTicket<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const kv = env.AUTH_KV;
  const ns = env.UserDO;
  if (!kv || !ns) return json({ error: "device ingress not configured" }, { status: 503 });
  if (!(await ingressAdmitted(kv, "ticket", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const bounded = await readBounded(request, PC_TICKET_BODY_MAX_BYTES);
  if (bounded === "too_large") return json({ error: "request body too large" }, { status: 413 });
  if (bounded instanceof KinuError) {
    diagnostics.failure("pc.ticket.body_unreadable", bounded);
    return json({ error: "could not read request body" }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bounded));
  } catch (cause) {
    diagnostics.event("pc.ticket.body_malformed", {
      error: renderThrownChain({ cause }),
      bytesRead: bounded.byteLength,
    });
    return json({ error: "malformed JSON body" }, { status: 400 });
  }
  const body = v.safeParse(TICKET_BODY_SCHEMA, parsed);
  if (!body.success || !body.output.user || !body.output.token) {
    return json({ error: "user and token required" }, { status: 400 });
  }
  // Shape gates BEFORE idFromName: a malformed identifier never reaches the
  // namespace, so garbage costs zero DO wake-ups.
  if (!USER_ID_PATTERN.test(body.output.user)) return json({ error: "invalid user" }, { status: 400 });
  if (!DEVICE_TOKEN_PATTERN.test(body.output.token)) return json({ error: "unauthorized" }, { status: 401 });

  const issued = await ns.get(ns.idFromName(body.output.user)).issueDeviceConnectTicket(
    await ownerCaller(env),
    body.output.token,
  );
  if (!issued.ok || !issued.ticket || !issued.expiresAt) return json({ error: "unauthorized" }, { status: 401 });
  return json({ ticket: issued.ticket, expiresAt: issued.expiresAt });
}

async function handlePcConnect<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const url = new URL(request.url);
  const userId = url.searchParams.get("user");
  const ticket = url.searchParams.get("ticket");
  if (!userId || !ticket) {
    return new Response("Missing ?user or ?ticket", { status: 400 });
  }
  const kv = env.AUTH_KV;
  const ns = env.UserDO;
  if (!kv || !ns) return new Response("Device ingress not configured", { status: 503 });
  if (!(await ingressAdmitted(kv, "connect", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();
  // Same gates as the ticket rail, same order: shape first, DO choice last.
  if (!USER_ID_PATTERN.test(userId)) return new Response("invalid user", { status: 400 });
  if (!CONNECT_TICKET_PATTERN.test(ticket)) return new Response("invalid ticket", { status: 400 });

  // A WebSocket cannot cross the DO RPC boundary (not serializable) — but the
  // upgrade Request can. Forward it to the UserDO, which verifies + consumes
  // the ticket and accepts the socket inside its own fetch().
  return ns.get(ns.idFromName(userId)).fetch(request);
}
