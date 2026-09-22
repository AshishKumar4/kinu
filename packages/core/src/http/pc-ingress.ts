/**
 * Device tunnel ingress, per user: POST /pc/connect-ticket exchanges the device token for a short-lived
 * ticket; WS /pc/connect upgrades with it, so long-lived secrets stay out of URLs. Release bytes are
 * trusted by signature, not by this Worker (`http/release-signing.ts`, SECURITY-devices C1).
 */

import { DEVICE_CONNECT_PATH } from '../cloud-wire';
import { json, readBounded } from './http';
import { ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '../safety/workspace-capability';
import { diagnostics, KinuError, renderThrownChain } from "../obs/index";
import { ingressAdmitted, ingressDenied, peerIp } from './ingress-budget';
import type { KvStore } from "@kinu.run/agent-utils";
import * as v from "valibot";

export interface PcUserStub {
  issueDeviceConnectTicket(
    caller: UserCaller,
    token: string,
  ): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }>;
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object namespace port, generic in the id so callers minting their own names satisfy it. */
export interface ObjectNamespace<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id): Stub;
}

export type PcUserNamespace<Id> = ObjectNamespace<Id, PcUserStub>;

export interface PcIngressEnv<Id> extends OwnerCapabilityEnv {
  AUTH_KV?: KvStore;
  UserDO?: PcUserNamespace<Id>;
}

// Ingress guard: both unauthenticated rails choose a UserDO by caller-supplied name, so both spend a knock
// (`ingress-budget.ts` states the residuals) and pass shape gates before `idFromName`. This is rate limiting,
// not route verification: tokens carry no routing id until a token-format migration binds one.

/** Larger bodies are refused before parsing and never buffered past the limit. */
const PC_TICKET_BODY_MAX_BYTES = 4 * 1024;

/** Self-imposed, not a platform number: covers daemon retries, far below a guessing attack. */
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

  if (path === "/pc/connect-ticket") {
    return handlePcConnectTicket(request, env);
  }

  if (path === DEVICE_CONNECT_PATH) {
    return handlePcConnect(request, env);
  }

  return new Response("Not found", { status: 404 });
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

  if (!kv || !ns) return json({ body: { error: "device ingress not configured" } }, { status: 503 });

  if (!(await ingressAdmitted(kv, "ticket", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const bounded = await readBounded(request, PC_TICKET_BODY_MAX_BYTES);

  if (bounded === "too_large") return json({ body: { error: "request body too large" } }, { status: 413 });

  if (bounded instanceof KinuError) {
    diagnostics.failure("pc.ticket.body_unreadable", bounded);

    return json({ body: { error: "could not read request body" } }, { status: 400 });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(bounded));
  } catch (cause) {
    diagnostics.event("pc.ticket.body_malformed", {
      error: renderThrownChain({ cause }),
      bytesRead: bounded.byteLength,
    });

    return json({ body: { error: "malformed JSON body" } }, { status: 400 });
  }

  const body = v.safeParse(TICKET_BODY_SCHEMA, parsed);

  if (!body.success || !body.output.user || !body.output.token) {
    return json({ body: { error: "user and token required" } }, { status: 400 });
  }

  // Shape gates before idFromName: garbage never wakes a DO.
  if (!USER_ID_PATTERN.test(body.output.user)) return json({ body: { error: "invalid user" } }, { status: 400 });

  if (!DEVICE_TOKEN_PATTERN.test(body.output.token)) return json({ body: { error: "unauthorized" } }, { status: 401 });

  const issued = await ns.get(ns.idFromName(body.output.user)).issueDeviceConnectTicket(
    await ownerCaller(env),
    body.output.token,
  );

  if (!issued.ok || !issued.ticket || !issued.expiresAt) return json({ body: { error: "unauthorized" } }, { status: 401 });

  return json({ body: { ticket: issued.ticket, expiresAt: issued.expiresAt } });
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

  if (!USER_ID_PATTERN.test(userId)) return new Response("invalid user", { status: 400 });

  if (!CONNECT_TICKET_PATTERN.test(ticket)) return new Response("invalid ticket", { status: 400 });

  // A WebSocket cannot cross DO RPC, but the upgrade Request can; the UserDO consumes the ticket and accepts.
  return ns.get(ns.idFromName(userId)).fetch(request);
}
