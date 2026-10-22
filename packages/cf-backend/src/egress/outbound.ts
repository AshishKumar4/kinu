/** HTTP and HTTPS on ports 80 and 443 leave the native container, and every socket of a Nimbus workspace's commands,
 *  through Worker entrypoints, judged by destination. The container's other TCP and UDP go straight out (D82) and meet
 *  none of this. Configuration props come only from the owning Durable Object. */

import { Cause, Effect } from 'effect';
import { getAgentByName } from 'agents';
import * as v from 'valibot';
import { Hono } from 'hono';
import { rawPath, rethrow, type FamilyEnv } from '../api/context';
import {
  egressHost, JsonValueSchema, type ContainerEventResult, type EgressPrincipal, type JsonValue,
} from '@kinu.run/core';
import type { EgressStreams, EgressTlsTarget } from '@nimbus-sh/core/_shared/workspace-network.js';
import { carryKeyed, keyedHost } from './keyed-socket';
import { refusal } from './send-out';
import type { OrchestratorAgent } from '../orchestrator';
import {
  attempt, diagnostics, toKinuError, tolerateAsync, KinuError, settle,
} from '@kinu.run/core/obs';

/** `.internal` resolves nowhere publicly, so a lapse in interception fails to connect rather than leaking activity. */
export const CONTAINER_EVENT_HOST = 'events.kinu.internal';

const CONTAINER_EVENT_PATH = '/v1/events';

/**
 * Set by the owning DO; not readable or influenceable from the container. Applied to a container by
 * `KinuDevbox.configureEgress` before any op that can start it (`sandbox-exec-lane.ts`), so its first web request already
 * meets the vault (its raw sockets go straight out regardless, D82); minted for a workspace as it opens (`OrchestratorAgent.workspaceEgress`). Neither names a grant or a secret:
 * the owner's object reads the workspace's grants and opens a secret for a request that names its placeholder.
 */
export interface KinuEgressParams {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  /** The agent a workspace process acts for, where one is named (`OrchestratorAgent.workspaceEgress`); a container's names none. */
  readonly actorId?: string;
}

/** Parsed: `ctx.props` arrives untyped, and a configuration that is not this shape reads as unconfigured (both handlers refuse). */
const EgressParamsSchema = v.object({
  workspaceName: v.pipe(v.string(), v.minLength(1)),
  ownerUserId: v.pipe(v.string(), v.minLength(1)),
  actorId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** Undefined when the container is not configured yet; both handlers then refuse. */
export function parseEgressParams(ctx: { readonly props: unknown }): KinuEgressParams | undefined {
  const parsed = v.safeParse(EgressParamsSchema, ctx.props);

  return parsed.success ? parsed.output : undefined;
}

/**
 * A process a share's viewer started on the workspace's box (`OrchestratorAgent.viewerEgress`): it holds none of the
 * owner's secrets, so its egress names no owner, and a request naming a placeholder is refused before any vault.
 */
interface ViewerEgressParams {
  readonly principal: 'viewer';
  readonly workspaceName: string;
}

/** Whom an egress was minted for: the owner's (`KinuEgressParams`), or a share's viewer's. */
export type EgressParams = KinuEgressParams | ViewerEgressParams;

const ViewerEgressParamsSchema = v.object({ principal: v.literal('viewer'), workspaceName: v.pipe(v.string(), v.minLength(1)) });

/**
 * Whom the egress was minted for, as the one principal every egress reads (`egressAuthority`): a viewer's configuration
 * is read first, so one naming a viewer is never read as an owner's. Undefined: not configured yet.
 */
export function parseEgressPrincipal(ctx: { readonly props: unknown }): EgressPrincipal | undefined {
  const viewer = v.safeParse(ViewerEgressParamsSchema, ctx.props);

  if (viewer.success) return { as: 'viewer', workspace: viewer.output.workspaceName, actorId: null };
  const owner = parseEgressParams(ctx);

  return owner === undefined ? undefined : { as: 'owner', workspace: owner.workspaceName, actorId: owner.actorId ?? null, ownerUserId: owner.ownerUserId };
}

/** Must be on `ORCHESTRATOR_METHODS` too, or it is silently unreachable over a stub (`unit-egress-interception.test.ts`). */
interface ContainerEventClient {
  acceptContainerEvent(body: JsonValue): Promise<ContainerEventResult>;
}

/**
 * A resolver, not the namespace: production uses the SDK's `getAgentByName`, which awaits `__unsafe_ensureInitialized`
 * under its own retry (agents@0.26.0 agent-routing.js:176-183, read 2026-10-06).
 */
export type ContainerEventResolver = (workspaceName: string) => Promise<ContainerEventClient>;

export const containerEventResolver = (env: Env): ContainerEventResolver =>
  async (workspaceName) => await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent, workspaceName,
  );

/** `host:port` as a socket names its destination (`[v6]:port` for an IPv6 literal); null when it names none. */
function socketDestination(address: string): { readonly hostname: string; readonly port: number } | null {
  const cut = address.lastIndexOf(':');
  const port = Number(address.slice(cut + 1));

  if (cut <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;

  return { hostname: address.slice(0, cut), port };
}

/**
 * A workspace program's plain socket (its egress's `connect`): the destination judged as a request's host is, then the
 * bytes piped both ways; a keyed one as they are until the program asks for TLS over it (`carryKeyed`, STARTTLS), whose
 * session is made here on the same server connection. Kinu reads none of it; a secret cannot be put into a stream it
 * does not parse. A refused or
 * unnamed destination closes the socket before anything is sent. Kinu judges the name or literal the program gave; a name
 * that resolves to a private address is refused by Cloudflare at connect (PLATFORM_CATALOG 'worker.connect.private_address',
 * as fetch is by 'worker.fetch.private_address'), so the egress resolves nothing itself.
 */
export function handleEgressConnect(socket: Socket, params: EgressPrincipal | undefined): Promise<void> {
  return settle(Effect.gen(function* () {
    const opened = yield* attempt({ doing: 'reading where a workspace socket goes', otherwise: 'io' }, () => socket.opened);
    const address = opened.localAddress ?? '';
    const named = socketDestination(address);
    // A keyed socket (`keyedHost`) goes where its name says, and may ask for TLS over it later (`carryKeyed`).
    const keyed = named === null ? null : keyedHost(named.hostname);
    const destination = keyed === null || named === null ? named : { hostname: keyed.hostname, port: named.port };

    // A keyed socket's name carries its tags; what is logged is only where it goes.
    const shown = destination === null ? '(no usable destination)' : `${destination.hostname}:${String(destination.port)}`;

    const refusedHere = (reason: string) => {
      diagnostics.failure('egress.socket_refused', new KinuError('denied', reason), { host: shown, seam: 'workspace-connect' });
    };

    if (params === undefined || destination === null) {
      refusedHere(params === undefined ? 'egress is not configured for this workspace yet' : 'the socket names no usable destination');

      return yield* attempt({ doing: `refusing a socket to ${shown}`, otherwise: 'io' }, () => socket.close());
    }

    const judged = egressHost(destination.hostname);

    if ('refusal' in judged) {
      refusedHere(judged.refusal.error);

      return yield* attempt({ doing: `refusing a socket to ${shown}`, otherwise: 'io' }, () => socket.close());
    }

    const { connect } = yield* Effect.promise(() => import('cloudflare:sockets'));
    // The host reached is the one judged, in its canonical form: connect() reaches an IPv6 literal only bracketed, and an
    // IPv4 only as a dotted quad (PLATFORM_CATALOG 'worker.connect.address_forms').
    const reached = { hostname: judged.host, port: destination.port };

    if (keyed !== null) {
      const server = connect(reached, { allowHalfOpen: true, secureTransport: 'starttls' });

      return yield* attempt({ doing: `carrying a socket to ${shown}`, otherwise: 'io' }, () => carryKeyed(socket, server, judged.host, keyed.tags));
    }

    const upstream = connect(reached, { allowHalfOpen: true, secureTransport: 'off' });

    // The program's end of input is not passed on: closing a workerd socket's writable ended its readable too, so a
    // client that half-closed after its request got no answer (scripts/egress-probe.ts at 9a437a392, 2026-10-10).
    // The server's own close ends the socket.
    yield* Effect.all([
      attempt({ doing: `carrying a socket to ${shown}`, otherwise: 'io' }, () => socket.readable.pipeTo(upstream.writable, { preventClose: true })),
      attempt({ doing: `carrying a socket from ${shown}`, otherwise: 'io' }, () => upstream.readable.pipeTo(socket.writable)),
    ], { concurrency: 'unbounded' });
  }).pipe(
    // A socket either end resets is the program's to see; the egress has nothing left to answer.
    Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('egress.socket_ended', failure, { seam: 'workspace-connect' }); })),
  ));
}

/**
 * A workspace program's TLS socket (its egress's `connectTls`, which Nimbus calls since a Fetcher's `connect` carries
 * no TLS): the host judged as a request's is, the session made here with Kinu's own trust, presenting and checking the
 * program's servername where it named one other than the host, and its plaintext handed back. A refused host, or a
 * session that cannot be made, rejects with why: the program's socket fails with it.
 */
export function handleEgressTls(target: EgressTlsTarget, params: EgressPrincipal | undefined): Promise<EgressStreams> {
  return settle(Effect.gen(function* () {
    const judged = params === undefined ? { refusal: { error: 'egress is not configured for this workspace yet' } } : egressHost(target.hostname);

    if ('refusal' in judged) {
      diagnostics.failure('egress.socket_refused', new KinuError('denied', judged.refusal.error), { host: target.hostname, seam: 'workspace-tls' });

      return yield* new KinuError('denied', judged.refusal.error);
    }

    const { connect } = yield* Effect.promise(() => import('cloudflare:sockets'));
    const destination = { hostname: judged.host, port: target.port };

    const secure = target.servername === undefined
      ? connect(destination, { allowHalfOpen: true, secureTransport: 'on' })
      : connect(destination, { allowHalfOpen: true, secureTransport: 'starttls' }).startTls({ expectedServerHostname: target.servername });

    yield* attempt({ doing: `making the TLS session with ${target.servername ?? target.hostname}`, otherwise: 'io' }, () => secure.opened);

    return { readable: secure.readable, writable: secure.writable };
  }));
}

interface EventChannel {
  readonly resolveAgent: ContainerEventResolver;
  readonly params: KinuEgressParams | undefined;
}

const eventHost = new Hono<FamilyEnv<EventChannel, { params: KinuEgressParams }>>({ getPath: rawPath });

eventHost.use('*', async (c, next) => {
  if (!c.env.params) return refusal(503, 'The event channel is not configured for this container yet.');
  c.set('params', c.env.params);
  await next();
});

eventHost.post(CONTAINER_EVENT_PATH, (c) => settle(acceptContainerEvent(c.req.raw, c.env.resolveAgent, c.get('params'))));

eventHost.post('*', async () => refusal(404, `The only route on ${CONTAINER_EVENT_HOST} is POST ${CONTAINER_EVENT_PATH}.`));

eventHost.all('*', async () => refusal(405, `Use POST ${CONTAINER_EVENT_PATH}.`));

eventHost.onError(rethrow);

export async function handleContainerEvent(
  request: Request,
  resolveAgent: ContainerEventResolver,
  params: KinuEgressParams | undefined,
): Promise<Response> {
  return await eventHost.fetch(request, { resolveAgent, params });
}

/**
 * Addressed by `ctx.params.workspaceName`, never the request, so a container cannot post into another workspace.
 * Awaited, not deferred: `waitUntil` is a no-op in a DO; on eviction mid-write the container retries.
 */
function acceptContainerEvent(
  request: Request,
  resolveAgent: ContainerEventResolver,
  params: KinuEgressParams,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const body = v.safeParse(JsonValueSchema, yield* Effect.promise(() => tolerateAsync(() => request.json(), 'malformed-input')));

    if (!body.success) return refusal(400, 'Body is not JSON.');

    // Used, not copied (see `handleContainerEgress`). Classified because a throw here gives the container an empty reply;
    // 503 says the event was not recorded and retry recovers.
    const delivered = yield* Effect.matchCause(Effect.promise(async (): Promise<ContainerEventResult> => {
      const agent = await resolveAgent(params.workspaceName);

      return agent.acceptContainerEvent(body.output);
    }), {
      onSuccess: (result) => ({ result }),
      onFailure: (failed) => {
        const error = toKinuError({
          doing: 'delivering a container event to its workspace object',
          cause: Cause.squash(failed),
          otherwise: 'unavailable',
        });

        diagnostics.failure('egress.event_channel_unreachable', error, {
          workspace: params.workspaceName,
        });

        return {
          refused: refusal(
            error.code === 'timeout' ? 504 : 503,
            `Kinu could not record this event (${error.code}); it was not accepted, so send it again.`,
          ),
        };
      },
    });

    if ('refused' in delivered) return delivered.refused;
    const result = delivered.result;

    if (result.status === 'rejected') return refusal(result.http_status, result.reason);

    return Response.json(
      { accepted: true, event_id: result.event_id, admitted: result.admitted },
      { status: 202 },
    );
  });
}
