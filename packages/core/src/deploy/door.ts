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
import type { DeployRunTicket } from './session';

const API = '/api/deploy';

const ChoicesSchema = v.array(v.object({ id: v.string(), name: v.string() }));

/** An account or a zone the authorization can reach, as the door lists it. */
export type DeployChoice = v.InferOutput<typeof ChoicesSchema>[number];

const HeldSchema = v.object({ held: v.string() });

const AuthorizedSchema = v.object({ authorized: v.boolean() });

const ErrorBody = v.object({ error: v.optional(v.string()) });

/** Where a run lives and what authorizes it. */
export interface DeployRunAddress {
  readonly origin: string;
  readonly runId: string;
  readonly runKey: string;
}

export interface DeployTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
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
  /** `wss` wherever the door is `https`: a run watched over plain ws from a
   *  secure page is a mixed-content error, not a fallback. */
  socketUrl(): string;
}

export function deployOptions(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployOptions> {
  return read(DeployOptionsSchema, new URL(`${API}/options`, origin).href, {}, fetchImpl);
}

/** Mints a run. The key comes back once and is not recoverable, so the caller
 *  stores it before it does anything else with the id. */
export function mintRun(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployRunTicket> {
  return read(DeployTicketSchema, new URL(`${API}/runs`, origin).href, { method: 'POST' }, fetchImpl);
}

export function deployDoor(run: DeployRunAddress, fetchImpl: typeof fetch = fetch): DeployDoor {
  function at(tail: string): URL {
    const url = new URL(`${API}/runs/${encodeURIComponent(run.runId)}${tail}`, run.origin);

    url.searchParams.set('key', run.runKey);

    return url;
  }

  function get<Schema extends v.GenericSchema>(schema: Schema, tail: string): Promise<v.InferOutput<Schema>> {
    return read(schema, at(tail).href, {}, fetchImpl);
  }

  function post<Schema extends v.GenericSchema, Body>(
    schema: Schema,
    tail: string,
    body?: Body,
  ): Promise<v.InferOutput<Schema>> {
    return read(schema, at(tail).href, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
    socketUrl(): string {
      const url = at('/socket');

      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

      return url.href;
    },
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
