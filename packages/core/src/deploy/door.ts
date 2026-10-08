// Client for `/api/deploy/*`, shared by the page and `kinu deploy cloudflare`.
// The run key is never in a URL (history and invocation logs record URLs).
import { Effect } from 'effect';
import * as v from 'valibot';
import { settle } from '../obs/index';
import { jsonText } from '../utils/json';
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

interface DeployProviderKey {
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
  return settle(read(DeployOptionsSchema, new URL(`${DEPLOY_API}/options`, origin).href, {}, fetchImpl));
}

/** The key is returned once and is not recoverable. */
export function mintRun(origin: string, fetchImpl: typeof fetch = fetch): Promise<DeployRunTicket> {
  return settle(read(DeployTicketSchema, new URL(`${DEPLOY_API}/runs`, origin).href, { method: 'POST' }, fetchImpl));
}

export function deployDoor(run: DeployRunAddress, fetchImpl: typeof fetch = fetch): DeployDoor {
  function at(tail: string): string {
    return new URL(`${DEPLOY_API}/runs/${encodeURIComponent(run.runId)}${tail}`, run.origin).href;
  }

  const bearer = { authorization: `Bearer ${run.runKey}` };

  function get<Schema extends v.GenericSchema>(schema: Schema, tail: string): Effect.Effect<v.InferOutput<Schema>> {
    return read(schema, at(tail), { headers: bearer }, fetchImpl);
  }

  function post<Schema extends v.GenericSchema>(
    schema: Schema,
    tail: string,
    body?: DeployTokenPair | DeployProviderKey | DeployInputs,
  ): Effect.Effect<v.InferOutput<Schema>> {
    return read(schema, at(tail), {
      method: 'POST',
      headers: body === undefined ? bearer : { ...bearer, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, fetchImpl);
  }

  return {
    snapshot: () => settle(get(DeploySnapshotSchema, '')),
    accounts: () => settle(get(ChoicesSchema, '/accounts')),
    zones: () => settle(get(ChoicesSchema, '/zones')),
    holdToken: (token: DeployTokenPair): Promise<void> => settle(Effect.asVoid(post(AuthorizedSchema, '/token', token))),
    holdProviderKey: (name: string, value: string): Promise<string> =>
      settle(Effect.map(post(HeldSchema, '/keys', { name, value }), (answer) => answer.held)),
    start: (inputs: DeployInputs) => settle(post(DeploySnapshotSchema, '/start', inputs)),
    retry: (stepId: string) => settle(post(DeploySnapshotSchema, `/retry/${encodeURIComponent(stepId)}`)),
    authorize: (): Promise<string> => settle(Effect.map(post(HandoffSchema, '/authorize'), (answer) => answer.location)),
    socketUrl(): string {
      const url = new URL(at('/socket'));

      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

      return url.href;
    },
    socketProtocols: () => [DEPLOY_SOCKET_PROTOCOL, run.runKey],
  };
}

function read<Schema extends v.GenericSchema>(
  schema: Schema,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetchImpl(url, init));
    const text = yield* Effect.promise(() => response.text());

    if (!response.ok) {
      const said = v.safeParse(ErrorBody, yield* jsonText(text, `${url} did not answer JSON`));

      return yield* Effect.die(new Error(said.success && said.output.error !== undefined
        ? said.output.error
        : `${url} answered HTTP ${String(response.status)}`));
    }

    const body = yield* jsonText(text, `${url} did not answer JSON`);

    return v.parse(schema, body);
  });
}
