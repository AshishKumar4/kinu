/**
 * Device tunnel ingress, per user (device protocol 5): POST /pc/connect-challenge answers a single-use nonce; POST
 * /pc/connect-ticket trades the device key's signature over it for a short-lived ticket; WS /pc/connect upgrades with
 * no ticket and no account in its URL, and the socket's first frame carries the ticket. POST /pc/join spends the
 * ticket a browser's connect command carries to register the machine's public key. No secret the hub keeps connects a
 * machine. Release bytes are trusted by signature, not by this Worker (`http/release-signing.ts`, SECURITY-devices C1).
 */

import { Effect } from 'effect';
import { json, publicError, readBounded } from './http';
import { ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '../safety/workspace-capability';
import { authoredRefusal, diagnostics, KinuError, renderThrownChain, settle } from "../obs/index";
import { ingressAdmitted, ingressDenied, peerIp } from './ingress-budget';
import type { KvStore } from "@kinu.run/agent-utils";
import * as v from "valibot";
import { isDevicePublicKey } from '../execution/device-key';
import { DEVICE_CONNECT_ACCOUNT_HEADER } from '../execution/device-protocol';

/** What a daemon proves a request with: its device key's signature over a challenge the hub issued it. */
export interface DeviceChallengeProof {
  /** The hub's own origin, as the request reached it: a signature names the hub it was made for. */
  readonly origin: string;
  readonly device: string;
  readonly nonce: string;
  readonly signature: string;
}

/** A connect's proof: the challenge's, over the connect generation the machine's device.json holds too. */
export interface DeviceConnectProof extends DeviceChallengeProof {
  readonly generation: number;
}

/** Why a connect ticket was refused; the ingress says each in its own words. */
export type DeviceTicketRefusal = 'unauthorized' | 'challenge_spent' | 'cloned' | 'expired';

export type DeviceTicketIssue =
  | { readonly ok: true; readonly ticket: string; readonly expiresAt: number }
  | { readonly ok: false; readonly refusal: DeviceTicketRefusal };

export type DeviceChallengeIssue =
  | { readonly ok: true; readonly nonce: string; readonly expiresAt: number }
  | { readonly ok: false; readonly refusal: DeviceTicketRefusal };

/** The old key's signature over the registration replacing it, which `kinu connect` sends when it links the machine
 *  again (`deviceReplaceMessage`). */
export interface DeviceReplacement {
  readonly device: string;
  readonly signature: string;
}

/** A machine's public key as it enrols, on `origin`. */
export interface DeviceEnrolment {
  readonly publicKey: string;
  readonly origin: string;
  readonly label?: string | undefined;
  readonly replaces?: DeviceReplacement | undefined;
}

interface PcUserStub {
  issueDeviceConnectChallenge(caller: UserCaller, deviceId: string): Promise<DeviceChallengeIssue>;
  issueDeviceConnectTicket(caller: UserCaller, proof: DeviceConnectProof): Promise<DeviceTicketIssue>;
  recordDeviceUpdateRefusal(
    caller: UserCaller,
    proof: DeviceChallengeProof,
    refusal: { version: string; runtime: string; reason: string },
  ): Promise<boolean>;
  joinDevice(caller: UserCaller, ticket: string, enrolment: DeviceEnrolment): Promise<{ deviceId: string; label: string }>;
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object namespace port, generic in the id so callers minting their own names satisfy it. */
export interface ObjectNamespace<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id): Stub;
}

/** The object `name` names in `namespace`: the platform's `getByName`, spelled over the two calls every namespace port
 *  (a test's included) answers. */
export function objectNamed<Id, Stub>(namespace: ObjectNamespace<Id, Stub>, name: string): Stub {
  return namespace.get(namespace.idFromName(name));
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

const PC_BODY_UNREADABLE = {
  challenge: 'pc.challenge.body_unreadable', ticket: 'pc.ticket.body_unreadable', refusal: 'pc.update_refused.body_unreadable', join: 'pc.join.body_unreadable',
} as const;

const PC_BODY_MALFORMED = {
  challenge: 'pc.challenge.body_malformed', ticket: 'pc.ticket.body_malformed', refusal: 'pc.update_refused.body_malformed', join: 'pc.join.body_malformed',
} as const;

/** Self-imposed, not a platform number: covers daemon retries, far below a guessing attack. */
const PC_KNOCKS_PER_WINDOW = 30;

const USER_ID_PATTERN = /^[a-f0-9]{32}$/;

/** `dev-` and the id the hub minted (`nanoid`), which a signed message carries between colons. */
const DEVICE_ID_PATTERN = /^dev-[a-z0-9]{1,64}$/;

/** A connect challenge: `pcc_` and 32 url-safe characters or more. */
const CONNECT_CHALLENGE_PATTERN = /^pcc_[A-Za-z0-9_-]{32,}$/;

/** A connect ticket, which a socket's AUTH frame carries: `pct_` and 32 url-safe characters or more. */
export const CONNECT_TICKET_PATTERN = /^pct_[A-Za-z0-9_-]{32,}$/;

/** Said to a daemon of an earlier protocol, whose bearer no hub takes now: the update enrols the machine again. A Kinu
 *  command from before this protocol only updates itself, so it takes a second run. */
const DEVICE_CREDENTIAL_OUTDATED = 'This machine connects with a credential from an earlier Kinu, which this hub no longer accepts. '
  + 'Run `kinu update` on it, which connects it again; if that only updated the command, run it once more.';

/** Said when two machines were found holding one device's key: the hub revoked it, and cannot tell which is the owner's. */
const DEVICE_CLONED = 'Kinu revoked this device because two machines used its key, so a copy of its ~/.kinu exists somewhere else. '
  + 'Re-run `kinu connect` on the machine you trust.';

const DEVICE_LINK_EXPIRED = 'This machine has not connected for too long, and its link expired. Re-run `kinu connect` on it.';

const CHALLENGE_SPENT = 'the connect challenge expired or was already used; ask for a new one';

const TICKET_REFUSALS: Readonly<Record<DeviceTicketRefusal, { readonly status: 401 | 409; readonly error: string }>> = {
  unauthorized: { status: 401, error: 'unauthorized' },
  challenge_spent: { status: 409, error: CHALLENGE_SPENT },
  cloned: { status: 401, error: DEVICE_CLONED },
  expired: { status: 401, error: DEVICE_LINK_EXPIRED },
};

/** A browser's connect command's ticket: `pjt_<user id>_<secret>`. The user id finds its account; the secret claims. */
export const DEVICE_JOIN_TICKET_PREFIX = 'pjt_';

const DEVICE_JOIN_TICKET_PATTERN = /^pjt_([a-f0-9]{32})_[A-Za-z0-9_-]{32,}$/;

/** The account a join ticket was minted by, or null for a string that is no join ticket. */
export function deviceJoinTicketUser(ticket: string): string | null {
  return DEVICE_JOIN_TICKET_PATTERN.exec(ticket)?.[1] ?? null;
}

/** The old key's proof that a connect replaces its registration; the hub checks it against that device's key. */
export const DeviceReplacementSchema = v.object({ device: v.pipe(v.string(), v.regex(DEVICE_ID_PATTERN)), signature: v.string() });

const JOIN_BODY_SCHEMA = v.object({
  ticket: v.string(),
  publicKey: v.string(),
  label: v.optional(v.pipe(v.string(), v.maxLength(PC_REFUSAL_RUNTIME_MAX_LENGTH))),
  replaces: v.optional(DeviceReplacementSchema),
});

/** Said once, for a ticket that is not one: the way in that needs none. */
const JOIN_TICKET_MALFORMED = 'This connect command carries no valid ticket. Copy it again from Connect a machine, or run `kinu connect` signed in.';

/** Said for a public key that is not 32 bytes as base64url: the CLI that sent it is not this hub's. */
export const DEVICE_KEY_MALFORMED = 'This machine sent no valid device key. Update the Kinu command (`kinu update`) and connect again.';

/** Who asks: an account and one of its devices, each in the shape the hub mints it, checked before any object wakes. */
const DEVICE_ASKING = {
  user: v.pipe(v.string(), v.regex(USER_ID_PATTERN)),
  device: v.pipe(v.string(), v.regex(DEVICE_ID_PATTERN)),
};

const CHALLENGE_BODY_SCHEMA = v.object(DEVICE_ASKING);

const SIGNED_CHALLENGE = {
  ...DEVICE_ASKING,
  nonce: v.pipe(v.string(), v.regex(CONNECT_CHALLENGE_PATTERN)),
  // An Ed25519 signature's 64 bytes as base64url.
  signature: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
};

const TICKET_BODY_SCHEMA = v.object({
  ...SIGNED_CHALLENGE,
  generation: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/** What a daemon of an earlier protocol posts: its bearer, which is refused here in words naming the way back. */
const BEARER_BODY_SCHEMA = v.object({ token: v.string() });

const REFUSAL_BODY_SCHEMA = v.object({
  ...SIGNED_CHALLENGE,
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

/**
 * A daemon's challenge: a single-use nonce, a minute long, for one live device of the account. Unauthenticated, as a
 * nonce proves nothing until a signature over it does; a device that is gone or revoked is refused here already.
 */
export async function handlePcConnectChallenge<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const kv = env.AUTH_KV;
  const ns = env.UserDO;

  if (!kv || !ns) return json({ body: { error: "device ingress not configured" } }, { status: 503 });

  if (!(await ingressAdmitted(kv, "challenge", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  const input = await readPcBody(request, PC_TICKET_BODY_MAX_BYTES, 'challenge');

  if (input instanceof Response) return input;
  // Shape gates before idFromName: garbage never wakes a DO.
  const body = v.safeParse(CHALLENGE_BODY_SCHEMA, input.parsed);

  if (!body.success) return json({ body: { error: "user and device required" } }, { status: 400 });
  const issued = await ns.get(ns.idFromName(body.output.user)).issueDeviceConnectChallenge(await ownerCaller(env), body.output.device);

  if (!issued.ok) return json({ body: { error: TICKET_REFUSALS[issued.refusal].error } }, { status: TICKET_REFUSALS[issued.refusal].status });

  return json({ body: { nonce: issued.nonce, expiresAt: issued.expiresAt } });
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

  // A daemon of an earlier protocol posting its bearer, refused before any object wakes, in words naming the way back.
  if (v.is(BEARER_BODY_SCHEMA, input.parsed)) return json({ body: { error: DEVICE_CREDENTIAL_OUTDATED } }, { status: 401 });
  // Shape gates before idFromName: garbage never wakes a DO.
  const body = v.safeParse(TICKET_BODY_SCHEMA, input.parsed);

  if (!body.success) return json({ body: { error: "user, device, generation, nonce and signature required" } }, { status: 400 });
  const { user, device, generation, nonce, signature } = body.output;

  const issued = await ns.get(ns.idFromName(user)).issueDeviceConnectTicket(
    await ownerCaller(env),
    { origin: new URL(request.url).origin, device, generation, nonce, signature },
  );

  if (!issued.ok) return json({ body: { error: TICKET_REFUSALS[issued.refusal].error } }, { status: TICKET_REFUSALS[issued.refusal].status });

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
  const { ticket, publicKey, label, replaces } = body.output;

  if (!isDevicePublicKey(publicKey)) return json({ body: { error: DEVICE_KEY_MALFORMED } }, { status: 400 });
  const stub = ns.get(ns.idFromName(user));
  const origin = new URL(request.url).origin;

  // A spent or expired ticket is refused in the account's own words, which name the way back.
  return await settle(Effect.tryPromise({
    try: async () => {
      const joined = await stub.joinDevice(await ownerCaller(env), ticket, { publicKey, origin, label, replaces });

      return json({ body: { ...joined, userId: user, origin } }, { status: 201 });
    },
    catch: (cause) => authoredRefusal({ doing: 'joining this machine to the account', cause }),
  }).pipe(Effect.catch((refused) => Effect.succeed(publicError(refused)))));
}

/** A daemon that cannot run the build it was pushed says why, signed by its key over a challenge of its own. */
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

  if (v.is(BEARER_BODY_SCHEMA, input.parsed)) return json({ body: { error: DEVICE_CREDENTIAL_OUTDATED } }, { status: 401 });
  const body = v.safeParse(REFUSAL_BODY_SCHEMA, input.parsed);

  if (!body.success) {
    return json({ body: { error: "user, device, nonce, signature, version, runtime and reason required within their bounds" } }, { status: 400 });
  }

  const { user, device, nonce, signature, version, runtime, reason } = body.output;

  const recorded = await ns.get(ns.idFromName(user)).recordDeviceUpdateRefusal(
    await ownerCaller(env),
    { origin: new URL(request.url).origin, device, nonce, signature },
    { version, runtime, reason },
  );

  if (!recorded) return json({ body: { error: "unauthorized" } }, { status: 401 });

  return json({ body: { ok: recorded } });
}

/**
 * The device socket's upgrade. Its URL carries neither the account nor a ticket, which edge and proxy logs keep: the
 * account comes in {@link DEVICE_CONNECT_ACCOUNT_HEADER}, and the ticket in the socket's first frame, which the
 * account's object reads before it serves anything.
 */
export async function handlePcConnect<Id>(
  request: Request,
  env: PcIngressEnv<Id>,
): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");

  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const userId = request.headers.get(DEVICE_CONNECT_ACCOUNT_HEADER);

  if (!userId) return new Response(`Missing ${DEVICE_CONNECT_ACCOUNT_HEADER}`, { status: 400 });

  const kv = env.AUTH_KV;
  const ns = env.UserDO;

  if (!kv || !ns) return new Response("Device ingress not configured", { status: 503 });

  if (!(await ingressAdmitted(kv, "connect", peerIp(request), PC_KNOCKS_PER_WINDOW))) return ingressDenied();

  if (!USER_ID_PATTERN.test(userId)) return new Response("invalid user", { status: 400 });

  // A WebSocket cannot cross DO RPC, but the upgrade Request can; the UserDO accepts it and reads AUTH first.
  return ns.get(ns.idFromName(userId)).fetch(request);
}
