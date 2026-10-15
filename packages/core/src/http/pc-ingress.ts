/**
 * Device tunnel ingress, per user: POST /pc/connect-ticket exchanges the device token for a short-lived
 * ticket; WS /pc/connect upgrades with it, so long-lived secrets stay out of URLs. POST /pc/join spends the ticket a
 * browser's connect command carries for the machine's device token. Release bytes are trusted by signature, not by
 * this Worker (`http/release-signing.ts`, SECURITY-devices C1).
 */

import { Effect } from 'effect';
import { json, publicError, readBounded } from './http';
import { ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '../safety/workspace-capability';
import { authoredRefusal, diagnostics, KinuError, renderThrownChain, settle } from "../obs/index";
import { ingressAdmitted, ingressDenied, peerIp } from './ingress-budget';
import type { KvStore } from "@kinu.run/agent-utils";
import * as v from "valibot";

interface PcUserStub {
  issueDeviceConnectTicket(
    caller: UserCaller,
    token: string,
  ): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }>;
  recordDeviceUpdateRefusal(
    caller: UserCaller,
    token: string,
    refusal: { version: string; runtime: string; reason: string },
  ): Promise<boolean>;
  joinDevice(caller: UserCaller, ticket: string, label?: string, replaces?: string): Promise<{ deviceId: string; token: string; label: string }>;
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

// Unauthenticated rails pick a UserDO by caller-supplied name, so each spends a knock (`ingress-budget.ts`) and
// passes shape gates before `idFromName`: rate limiting, not route verification, until tokens carry a routing id.

/** Larger bodies are refused before parsing and never buffered past the limit. */
const PC_TICKET_BODY_MAX_BYTES = 4 * 1024;

/** Fits a build stamp, a runtime and a 1000-character error, escaped. */
const PC_REFUSAL_VERSION_MAX_LENGTH = 200;

const PC_REFUSAL_RUNTIME_MAX_LENGTH = 200;

const PC_REFUSAL_REASON_MAX_LENGTH = 2000;

const PC_REFUSAL_BODY_MAX_BYTES = 16 * 1024;

const PC_BODY_UNREADABLE = { ticket: 'pc.ticket.body_unreadable', refusal: 'pc.update_refused.body_unreadable', join: 'pc.join.body_unreadable' } as const;

const PC_BODY_MALFORMED = { ticket: 'pc.ticket.body_malformed', refusal: 'pc.update_refused.body_malformed', join: 'pc.join.body_malformed' } as const;

/** Self-imposed, not a platform number: covers daemon retries, far below a guessing attack. */
const PC_KNOCKS_PER_WINDOW = 30;

const USER_ID_PATTERN = /^[a-f0-9]{32}$/;

const DEVICE_TOKEN_PATTERN = /^pdt_[A-Za-z0-9_-]{32,}$/;

const CONNECT_TICKET_PATTERN = /^pct_[A-Za-z0-9_-]{32,}$/;

/** A browser's connect command's ticket: `pjt_<user id>_<secret>`. The user id finds its account; the secret claims. */
export const DEVICE_JOIN_TICKET_PREFIX = 'pjt_';

const DEVICE_JOIN_TICKET_PATTERN = /^pjt_([a-f0-9]{32})_[A-Za-z0-9_-]{32,}$/;

/** The account a join ticket was minted by, or null for a string that is no join ticket. */
export function deviceJoinTicketUser(ticket: string): string | null {
  return DEVICE_JOIN_TICKET_PATTERN.exec(ticket)?.[1] ?? null;
}

const JOIN_BODY_SCHEMA = v.object({
  ticket: v.string(),
  label: v.optional(v.pipe(v.string(), v.maxLength(PC_REFUSAL_RUNTIME_MAX_LENGTH))),
  replaces: v.optional(v.string()),
});

/** Said once, for a ticket that is not one: the way in that needs none. */
const JOIN_TICKET_MALFORMED = 'This connect command carries no valid ticket. Copy it again from Connect a machine, or run `kinu connect` signed in.';

const TICKET_BODY_SCHEMA = v.object({
  user: v.optional(v.string()),
  token: v.optional(v.string()),
});

const REFUSAL_BODY_SCHEMA = v.object({
  user: v.string(),
  token: v.string(),
  version: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PC_REFUSAL_VERSION_MAX_LENGTH)),
  runtime: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PC_REFUSAL_RUNTIME_MAX_LENGTH)),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(PC_REFUSAL_REASON_MAX_LENGTH)),
});

async function readPcBody(
  request: Request,
  limit: number,
  rail: keyof typeof PC_BODY_UNREADABLE,
): Promise<{ parsed: unknown } | Response> {
  const bounded = await readBounded(request, limit);

  if (bounded === "too_large") return json({ body: { error: "request body too large" } }, { status: 413 });

  if (bounded instanceof KinuError) {
    diagnostics.failure(PC_BODY_UNREADABLE[rail], bounded);

    return json({ body: { error: "could not read request body" } }, { status: 400 });
  }

  try {
    return { parsed: JSON.parse(new TextDecoder().decode(bounded)) };
  } catch (cause) {
    diagnostics.event(PC_BODY_MALFORMED[rail], {
      error: renderThrownChain({ cause }),
      bytesRead: bounded.byteLength,
    });

    return json({ body: { error: "malformed JSON body" } }, { status: 400 });
  }
}

export async function handlePcConnectTicket<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const kv = env.AUTH_KV;
  const ns = env.UserDO;

  if (!kv || !ns) return json({ body: { error: "device ingress not configured" } }, { status: 503 });

  if (!(await ingressAdmitted(kv, "ticket", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const input = await readPcBody(request, PC_TICKET_BODY_MAX_BYTES, 'ticket');

  if (input instanceof Response) return input;
  const body = v.safeParse(TICKET_BODY_SCHEMA, input.parsed);

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

/**
 * A machine with no session joins the account a browser's connect command names: the ticket it carries is spent for
 * the device the browser issued, whose token this answers once. Refusals are said in the product's words, since the
 * person reading them pasted the command.
 */
export async function handlePcJoin<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const kv = env.AUTH_KV;
  const ns = env.UserDO;

  if (!kv || !ns) return json({ body: { error: "device ingress not configured" } }, { status: 503 });

  if (!(await ingressAdmitted(kv, "join", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const input = await readPcBody(request, PC_TICKET_BODY_MAX_BYTES, 'join');

  if (input instanceof Response) return input;
  const body = v.safeParse(JOIN_BODY_SCHEMA, input.parsed);
  // Shape gates before idFromName: garbage never wakes a DO.
  const user = body.success ? deviceJoinTicketUser(body.output.ticket) : null;

  if (!body.success || user === null) return json({ body: { error: JOIN_TICKET_MALFORMED } }, { status: 400 });
  const { ticket, label, replaces } = body.output;

  const stub = ns.get(ns.idFromName(user));

  // A spent or expired ticket is refused in the account's own words, which name the way back.
  return await settle(Effect.tryPromise({
    try: async () => {
      const joined = await stub.joinDevice(await ownerCaller(env), ticket, label, replaces);

      return json({ body: { ...joined, userId: user, origin: new URL(request.url).origin } }, { status: 201 });
    },
    catch: (cause) => authoredRefusal({ doing: 'joining this machine to the account', cause }),
  }).pipe(Effect.catch((refused) => Effect.succeed(publicError(refused)))));
}

export async function handlePcUpdateRefused<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const kv = env.AUTH_KV;
  const ns = env.UserDO;

  if (!kv || !ns) return json({ body: { error: "device ingress not configured" } }, { status: 503 });

  if (!(await ingressAdmitted(kv, "update-refused", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const input = await readPcBody(request, PC_REFUSAL_BODY_MAX_BYTES, 'refusal');

  if (input instanceof Response) return input;
  const body = v.safeParse(REFUSAL_BODY_SCHEMA, input.parsed);

  if (!body.success || !body.output.user || !body.output.token) {
    return json({ body: { error: "user, token, version, runtime and reason required within their bounds" } }, { status: 400 });
  }

  if (!USER_ID_PATTERN.test(body.output.user)) return json({ body: { error: "invalid user" } }, { status: 400 });

  if (!DEVICE_TOKEN_PATTERN.test(body.output.token)) return json({ body: { error: "unauthorized" } }, { status: 401 });

  const recorded = await ns.get(ns.idFromName(body.output.user)).recordDeviceUpdateRefusal(
    await ownerCaller(env),
    body.output.token,
    { version: body.output.version, runtime: body.output.runtime, reason: body.output.reason },
  );

  if (!recorded) return json({ body: { error: "unauthorized" } }, { status: 401 });

  return json({ body: { ok: recorded } });
}

export async function handlePcConnect<Id>(
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
