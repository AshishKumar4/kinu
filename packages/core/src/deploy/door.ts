/**
 * The door's client: one typed call layer over `/api/deploy/*`, used by the
 * guided page and by `kinu deploy cloudflare`.
 *
 * A run is addressed, not signed in. `origin + runId + runKey` is the whole
 * identity of a run, so the client takes those three and nothing else; it
 * never reads ambient state and never decides where the key is kept. The
 * browser keeps its key in the tab that minted it, the CLI keeps it in a local
 * variable, and both hand the same three fields here.
 *
 * THE KEY IS NEVER IN A URL. It rides `authorization: Bearer <key>` on every
 * call, and on the socket upgrade — which a browser cannot put a header on — as
 * the second subprotocol token. A URL is recorded in browser history and in
 * Cloudflare's own invocation logs, and this key writes into somebody's
 * Cloudflare account.
 *
 * `fetch` is injected because the same client runs in a page, in a terminal,
 * and in a test with no network.
 *
 * Every answer is parsed against its schema rather than cast: what these calls
 * return is the entire content of the page and of the terminal's rows, and a
 * drifted field must fail at the door instead of rendering as blank.
 */
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import {
  DeployOptionsSchema, DeploySnapshotSchema, DeployTicketSchema,
  type DeployOptions, type DeploySnapshot,
} from './frames';
import type { DeployInputs } from './inputs';
import { DEPLOY_API } from './paths';
import { DEPLOY_SOCKET_PROTOCOL, type DeployRunTicket } from './session';

const ChoicesSchema = v.array(v.object({ id: v.string(), name: v.string() }));

/** An account or a zone the authorization can reach, as the door lists it. */
export type DeployChoice = v.InferOutput<typeof ChoicesSchema>[number];

const HeldSchema = v.object({ held: v.string() });

const AuthorizedSchema = v.object({ authorized: v.boolean() });

const HandoffSchema = v.object({ location: v.pipe(v.string(), v.minLength(1)) });

const ErrorBody = v.object({ error: v.optional(v.string()) });

/** Where a run lives and what authorizes it. */
export interface DeployRunAddress {
  readonly origin: string;
  readonly runId: string;
  readonly runKey: string;
}

/** A provider key as the run receives it; only the name comes back. */
export interface DeployProviderKey {
  readonly name: string;
  readonly value: string;
}

export interface DeployTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** The access token's life, as the token endpoint stated it. The run needs
   *  it to know when to spend the refresh token instead. */
  readonly expiresInSeconds: number;
}

export interface DeployDoor {
  snapshot(): Promise<DeploySnapshot>;
  accounts(): Promise<readonly DeployChoice[]>;
  zones(): Promise<readonly DeployChoice[]>;
  /** The CLI's authorize leg ends here: the token pair goes to the run that
   *  will spend it, once, and this process keeps neither. */
  holdToken(token: DeployTokenPair): Promise<void>;
  /** Returns the name the run holds, never the value. */
  holdProviderKey(name: string, value: string): Promise<string>;
  start(inputs: DeployInputs): Promise<DeploySnapshot>;
  retry(stepId: string): Promise<DeploySnapshot>;
  /** Starts an authorization leg and answers where to send the browser. The
   *  key authorizes this call and stays in the header; the URL that comes back
   *  carries only the OAuth `state` and the PKCE challenge. */
  authorize(): Promise<string>;
  /** `wss` wherever the door is `https`: a run watched over plain ws from a
   *  secure page is a mixed-content error, not a fallback. */
  socketUrl(): string;
  /** What the upgrade offers: the protocol name, then the key. */
  socketProtocols(): readonly string[];
}

export function deployOptions(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployOptions> {
  return read(DeployOptionsSchema, new URL(`${DEPLOY_API}/options`, origin).href, {}, fetchImpl);
}

/** Mints a run. The key comes back once and is not recoverable, so the caller
 *  stores it before it does anything else with the id. */
export function mintRun(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployRunTicket> {
  return read(DeployTicketSchema, new URL(`${DEPLOY_API}/runs`, origin).href, { method: 'POST' }, fetchImpl);
}

export function deployDoor(run: DeployRunAddress, fetchImpl: typeof fetch = fetch): DeployDoor {
  function at(tail: string): string {
    return new URL(`${DEPLOY_API}/runs/${encodeURIComponent(run.runId)}${tail}`, run.origin).href;
  }

  const bearer = { authorization: `Bearer ${run.runKey}` };

  function get<Schema extends v.GenericSchema>(schema: Schema, tail: string): Promise<v.InferOutput<Schema>> {
    return read(schema, at(tail), { headers: bearer }, fetchImpl);
  }

  function post<Schema extends v.GenericSchema>(
    schema: Schema,
    tail: string,
    body?: DeployTokenPair | DeployProviderKey | DeployInputs,
  ): Promise<v.InferOutput<Schema>> {
    return read(schema, at(tail), {
      method: 'POST',
      headers: body === undefined ? bearer : { ...bearer, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, fetchImpl);
  }

  return {
    snapshot: () => get(DeploySnapshotSchema, ''),
    accounts: () => get(ChoicesSchema, '/accounts'),
    zones: () => get(ChoicesSchema, '/zones'),
    async holdToken(token: DeployTokenPair): Promise<void> {
      await post(AuthorizedSchema, '/token', token);
    },
    async holdProviderKey(name: string, value: string): Promise<string> {
      return (await post(HeldSchema, '/keys', { name, value })).held;
    },
    start: (inputs: DeployInputs) => post(DeploySnapshotSchema, '/start', inputs),
    retry: (stepId: string) => post(DeploySnapshotSchema, `/retry/${encodeURIComponent(stepId)}`),
    async authorize(): Promise<string> {
      return (await post(HandoffSchema, '/authorize')).location;
    },
    socketUrl(): string {
      const url = new URL(at('/socket'));

      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

      return url.href;
    },
    socketProtocols: () => [DEPLOY_SOCKET_PROTOCOL, run.runKey],
  };
}

async function read<Schema extends v.GenericSchema>(
  schema: Schema,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<v.InferOutput<Schema>> {
  const response = await fetchImpl(url, init);
  const text = await response.text();

  if (!response.ok) {
    const said = v.safeParse(ErrorBody, jsonOf(url, text));

    throw new Error(said.success && said.output.error !== undefined
      ? said.output.error
      : `${url} answered HTTP ${String(response.status)}`);
  }

  return v.parse(schema, jsonOf(url, text));
}

/** A body that is not JSON names the URL that sent it and keeps the parser's
 *  own failure as the cause: a door answering HTML is a door misrouted, and
 *  the text of the parse error is what says where. */
function jsonOf(url: string, text: string): JsonValue {
  try {
    return v.parse(JsonValueSchema, JSON.parse(text));
  } catch (cause) {
    throw new Error(`${url} did not answer JSON`, { cause });
  }
}
