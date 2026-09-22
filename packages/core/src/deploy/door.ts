// Client for `/api/deploy/*`, shared by the page and `kinu deploy cloudflare`.
// The run key is never in a URL (history and invocation logs record URLs).
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

export type DeployChoice = v.InferOutput<typeof ChoicesSchema>[number];

const HeldSchema = v.object({ held: v.string() });

const AuthorizedSchema = v.object({ authorized: v.boolean() });

const HandoffSchema = v.object({ location: v.pipe(v.string(), v.minLength(1)) });

const ErrorBody = v.object({ error: v.optional(v.string()) });

export interface DeployRunAddress {
  readonly origin: string;
  readonly runId: string;
  readonly runKey: string;
}

export interface DeployProviderKey {
  readonly name: string;
  readonly value: string;
}

export interface DeployTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export interface DeployDoor {
  snapshot(): Promise<DeploySnapshot>;
  accounts(): Promise<readonly DeployChoice[]>;
  zones(): Promise<readonly DeployChoice[]>;
  holdToken(token: DeployTokenPair): Promise<void>;
  holdProviderKey(name: string, value: string): Promise<string>;
  start(inputs: DeployInputs): Promise<DeploySnapshot>;
  retry(stepId: string): Promise<DeploySnapshot>;
  authorize(): Promise<string>;
  socketUrl(): string;
  socketProtocols(): readonly string[];
}

export function deployOptions(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployOptions> {
  return read(DeployOptionsSchema, new URL(`${DEPLOY_API}/options`, origin).href, {}, fetchImpl);
}

/** The key is returned once and is not recoverable. */
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

function jsonOf(url: string, text: string): JsonValue {
  try {
    return v.parse(JsonValueSchema, JSON.parse(text));
  } catch (cause) {
    throw new Error(`${url} did not answer JSON`, { cause });
  }
}
