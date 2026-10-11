/** HTTP and HTTPS leave the native container, and a Nimbus workspace's commands, through Worker entrypoints. The
 *  container's raw sockets stay disabled; a workspace's are judged by destination. Configuration props come only from
 *  the owning Durable Object. */

import { Cause, Effect } from 'effect';
import { getAgentByName } from 'agents';
import * as v from 'valibot';
import { Hono } from 'hono';
import { rawPath, rethrow, type FamilyEnv } from '../api/context';
import {
  createScrubStream,
  egressPlaceholdersIn,
  scrubBytes,
  refusedHostname,
  scrubText,
  JsonValueSchema,
  type ContainerEventResult,
  type JsonValue,
  type ApprovalGrant,
  type EgressRequestFacts,
  type ScrubReplacement,
} from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import { carryTls, TLS_CARRIER_HOST } from './tls-carrier';
import type { ObjectNamespace } from '@kinu.run/core';
import { OwnerCapabilityUnavailableError, ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '@kinu.run/core';
import type { EgressInjection, EgressInjectionResult } from '@kinu.run/core';
import { kinuUserAgent, observeGitHub, reoriginateRequest, type GitHubFact, type GitHubRecorder } from '@kinu.run/core';
import {
  attempt, classifyErrorCode, diagnostics, logged, renderThrownChain, toKinuError, tolerateAsync, KinuError, type Refusal, settle,
} from '@kinu.run/core/obs';

/** `.internal` resolves nowhere publicly, so a lapse in interception fails to connect rather than leaking activity. */
export const CONTAINER_EVENT_HOST = 'events.kinu.internal';

const CONTAINER_EVENT_PATH = '/v1/events';

/**
 * Set by the owning DO; not readable or influenceable from the container. Applied to a container by
 * `KinuDevbox.configureEgress` before any op that can start it (`sandbox-exec-lane.ts`), so until then it has no network;
 * minted for a workspace as it opens (`OrchestratorAgent.workspaceEgress`). Neither names a grant, binding or secret:
 * the egress reads the workspace's grants and the vault for a request that names a placeholder (`WorkspaceGrants`).
 */
export interface KinuEgressParams {
  readonly workspaceName: string;
  readonly ownerUserId: string;
}

/** Parsed although trusted: a container configured by an older build may carry fields this one no longer reads. */
const EgressParamsSchema = v.object({
  workspaceName: v.pipe(v.string(), v.minLength(1)),
  ownerUserId: v.pipe(v.string(), v.minLength(1)),
});

/** Undefined when the container is not configured yet; both handlers then refuse. */
export function parseEgressParams(ctx: { readonly props: unknown }): KinuEgressParams | undefined {
  const parsed = v.safeParse(EgressParamsSchema, ctx.props);

  return parsed.success ? parsed.output : undefined;
}

/** Narrow on purpose, like `runtime.ts`'s `RuntimeUserDOClient`. */
interface EgressVaultClient {
  resolveEgressInjection(
    caller: UserCaller,
    facts: EgressRequestFacts,
    grants: readonly ApprovalGrant[],
  ): Promise<EgressInjectionResult>;
}

/** Must be on `ORCHESTRATOR_METHODS` too, or it is silently unreachable over a stub (`unit-egress-interception.test.ts`). */
interface ContainerEventClient {
  acceptContainerEvent(body: JsonValue): Promise<ContainerEventResult>;
}

export interface ContainerEgressEnv<Id> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, EgressVaultClient>;
}

/**
 * A resolver, not the namespace: production uses the SDK's `getAgentByName`, which awaits `__unsafe_ensureInitialized`
 * under its own retry (agents@0.26.0 agent-routing.js:176-183, read 2026-10-06).
 */
export type ContainerEventResolver = (workspaceName: string) => Promise<ContainerEventClient>;

/**
 * The workspace's egress-secret grants as they stand (`OrchestratorAgent.egressGrants`): asked only for a request that
 * names a placeholder, so a grant made after the egress was minted is spent without a restart.
 */
export type WorkspaceGrants = (workspaceName: string) => Promise<readonly ApprovalGrant[]>;

export const workspaceGrants = (env: Env): WorkspaceGrants =>
  async (workspaceName) => await (await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, workspaceName)).egressGrants();

export const containerEventResolver = (env: Env): ContainerEventResolver =>
  async (workspaceName) => await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent, workspaceName,
  );

export class GitHubEgressRecorder implements GitHubRecorder {
  constructor(private readonly env: Env, private readonly execution: ExecutionContext, private readonly workspaceName: string) {}

  waitUntil(work: Promise<unknown>): void {
    this.execution.waitUntil(work);
  }

  record(facts: readonly GitHubFact[]): Promise<void> {
    return settle(logged('egress.github_record_failed', { doing: 'recording GitHub work in its workspace', otherwise: 'unavailable' }, async () => {
      if (facts.length === 0) return;
      const agent = await getAgentByName<Env, OrchestratorAgent>(this.env.OrchestratorAgent, this.workspaceName);

      await agent.recordGitHubEgress(facts);
    }));
  }
}

/** What the egress reads of the workspace it serves: its grants, asked for a placeholder; its GitHub work, recorded. */
export interface EgressWorkspace {
  readonly grants: WorkspaceGrants;
  readonly github?: GitHubRecorder | undefined;
}

/** Catch-all for every host except the event channel. Only a request that carries a placeholder pays for substitution. */
export function handleContainerEgress<Id>(
  request: Request,
  env: ContainerEgressEnv<Id>,
  params: KinuEgressParams | undefined,
  workspace: EgressWorkspace,
): Promise<Response> {
  return settle(Effect.gen(function* () {
    if (!params) {
      // Unconfigured: refuse, since forwarding cannot tell a placeholder from a secret.
      return refusal(503, 'Egress interception is not configured for this container yet.');
    }

    const url = new URL(request.url);
    // Judged before the vault call: a private destination is refused regardless.
    const destination = refusedHostname(url.hostname);

    if (destination !== null) return destinationRefusal(url.hostname, destination);

    const facts: EgressRequestFacts = {
      host: url.hostname,
      url: request.url,
      headers: [...request.headers],
    };

    // A request that names no placeholder needs nothing of the vault, so it costs no round trip.
    if (egressPlaceholdersIn(facts).size === 0) return yield* forwarded(request, url, [], workspace.github);

    // Use the stub, never copy it: `Object.assign` of a JSRPC stub yields `{}` (methods live behind a Proxy).
    const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(params.ownerUserId));

    // The workspace's grants and the vault's secrets as they stand; the vault plans, so an unbound placeholder is refused there.
    const resolved = yield* Effect.matchCause(Effect.promise(async (): Promise<EgressInjectionResult> => vault.resolveEgressInjection(
      await ownerCaller(env), facts, await workspace.grants(params.workspaceName),
    )), {
      onSuccess: (answer) => ({ answer }),
      onFailure: (failed) => ({ refused: authorityFailure({ cause: Cause.squash(failed), host: url.hostname }) }),
    });

    if ('refused' in resolved) return resolved.refused;

    if (resolved.answer.kind === 'refuse') return refusal(resolved.answer.status, resolved.answer.reason);

    return yield* forwarded(request, url, resolved.answer.substitutions, workspace.github);
  }));
}

/** `request` sent on with `substitutions` made, GitHub's part of it recorded. */
function forwarded(request: Request, url: URL, substitutions: readonly EgressInjection[], github: GitHubRecorder | undefined): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const observed = yield* observeGitHub(request, url, github);
    const answer = yield* forwardUpstream(observed?.request ?? request, url, substitutions);

    return observed === null ? answer : observed.answered(answer);
  });
}

/** `host:port` as a socket names its destination (`[v6]:port` for an IPv6 literal); null when it names none. */
function socketDestination(address: string): { readonly hostname: string; readonly port: number } | null {
  const cut = address.lastIndexOf(':');
  const port = Number(address.slice(cut + 1));

  if (cut <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;

  return { hostname: address.slice(0, cut), port };
}

/**
 * A workspace program's socket (its egress's `connect`): the destination judged as a request's host is, then the bytes
 * piped both ways. A TLS carrier (`TLS_CARRIER_HOST`) names its host in its request, and its session is made here, with
 * Kinu's own trust (`carryTls`); any other is carried as it is. Kinu reads none of the plaintext; a secret cannot be put
 * into a stream it does not parse. A refused or unnamed destination closes the socket before anything is sent.
 */
export function handleEgressConnect(socket: Socket, params: KinuEgressParams | undefined): Promise<void> {
  return settle(Effect.gen(function* () {
    const opened = yield* attempt({ doing: 'reading where a workspace socket goes', otherwise: 'io' }, () => socket.opened);
    const address = opened.localAddress ?? '';
    const destination = socketDestination(address);

    const refusedHere = (host: string, reason: string) => {
      diagnostics.failure('egress.socket_refused', new KinuError('denied', reason), { host, seam: 'workspace-connect' });
    };

    if (params === undefined || destination === null) {
      refusedHere(address, params === undefined ? 'egress is not configured for this workspace yet' : `the socket names no usable destination (${address})`);

      return yield* attempt({ doing: `refusing a socket to ${address}`, otherwise: 'io' }, () => socket.close());
    }

    const refused = destination.hostname === TLS_CARRIER_HOST ? null : refusedHostname(destination.hostname);

    if (refused !== null) {
      refusedHere(destination.hostname, refused.error);

      return yield* attempt({ doing: `refusing a socket to ${address}`, otherwise: 'io' }, () => socket.close());
    }

    const { connect } = yield* Effect.promise(() => import('cloudflare:sockets'));

    if (destination.hostname === TLS_CARRIER_HOST) {
      return yield* attempt({ doing: `carrying a TLS socket to port ${String(destination.port)}`, otherwise: 'io' }, () => carryTls(socket, {
        port: destination.port,
        refused: (host) => {
          const judged = refusedHostname(host);

          if (judged !== null) refusedHere(host, judged.error);

          return judged?.error ?? null;
        },
        connect: (target) => connect(target, { allowHalfOpen: true, secureTransport: 'starttls' }),
      }));
    }

    const upstream = connect({ hostname: destination.hostname, port: destination.port }, { allowHalfOpen: true, secureTransport: 'off' });

    // The program's end of input is not passed on: closing a workerd socket's writable ended its readable too, so a
    // client that half-closed after its request got no answer (scripts/egress-probe.ts, 2026-10-10). The server's own
    // close ends the socket.
    yield* Effect.all([
      attempt({ doing: `carrying a socket to ${address}`, otherwise: 'io' }, () => socket.readable.pipeTo(upstream.writable, { preventClose: true })),
      attempt({ doing: `carrying a socket from ${address}`, otherwise: 'io' }, () => upstream.readable.pipeTo(socket.writable)),
    ], { concurrency: 'unbounded' });
  }).pipe(
    // A socket either end resets is the program's to see; the egress has nothing left to answer.
    Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('egress.socket_ended', failure, { seam: 'workspace-connect' }); })),
  ));
}

/** One classifier refuses at three seams (container hop, `web.fetch`, codemode loopback); one event shape keeps them comparable. */
function destinationRefusal(host: string, payload: Refusal): Response {
  const error = new KinuError('denied', payload.error);
  diagnostics.failure('egress.private_destination', error, { host, seam: 'container' });

  return Response.json(payload, { status: 403 });
}

/**
 * One construction site for the outgoing request, so the `User-Agent` policy applies exactly once. Every redirect is
 * `manual` (except caller `error`): the runtime's follower never re-enters this handler, so each hop must come back to be judged.
 */
function forwardUpstream(
  request: Request,
  url: URL,
  substitutions: readonly EgressInjection[],
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const injected: ScrubReplacement[] = substitutions.map(
      (s) => ({ find: s.secret, replaceWith: s.placeholder }),
    );

    const reveal: ScrubReplacement[] = substitutions.map(
      (s) => ({ find: s.placeholder, replaceWith: s.secret }),
    );

    const headers = new Headers();

    for (const [name, value] of request.headers) headers.set(name, scrubText(value, reveal));
    headers.set('user-agent', kinuUserAgent(request.headers.get('user-agent')));
    const target = scrubText(url.toString(), reveal);

    const sent = yield* Effect.matchCause(Effect.promise(() => fetch(reoriginateRequest(request, target, {
      headers,
      redirect: request.redirect === 'error' ? 'error' : 'manual',
    }))), {
      onSuccess: (upstream) => ({ upstream }),
      onFailure: (failed) => ({ refused: upstreamFailure({ cause: Cause.squash(failed), host: url.hostname, injected }) }),
    });

    if ('refused' in sent) return sent.refused;
    const upstream = sent.upstream;

    if (substitutions.length === 0) return upstream;

    // Scrubbed with the same pairs reversed, so an upstream echo of the request cannot become an oracle for the secret.
    const responseHeaders = new Headers();

    for (const [name, value] of upstream.headers) responseHeaders.set(name, scrubText(value, injected));

    // An upgrade that spent a secret is relayed, so the server's frames and close reason reach the program scrubbed.
    if (upstream.status === 101 && upstream.webSocket !== null) {
      return new Response(null, {
        status: 101, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders, webSocket: scrubbedRelay(upstream.webSocket, injected),
      });
    }

    return new Response(
      upstream.body === null ? null : upstream.body.pipeThrough(createScrubStream(injected)),
      { status: upstream.status, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders },
    );
  });
}

/** Close `socket` as its peer closed: a code that names no frame sent (1005) or a lost connection (1006, 1015) cannot be sent. */
function closeAs(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;

  if (code === 1005) socket.close();
  else socket.close(code === 1006 || code === 1015 ? 1011 : code, reason);
}

/**
 * The program's end of a WebSocket whose upgrade spent a secret: the server's text, binary frames and close reason are
 * scrubbed with the request's pairs reversed, as a response body is; the program's frames go to the server as they are.
 */
function scrubbedRelay(server: WebSocket, injected: readonly ScrubReplacement[]): WebSocket {
  const pair = new WebSocketPair();
  const program = pair[0];
  const relay = pair[1];

  server.accept();
  relay.accept();
  server.addEventListener('message', (event) => {
    relay.send(typeof event.data === 'string' ? scrubText(event.data, injected) : scrubBytes(new Uint8Array(event.data), injected));
  });
  relay.addEventListener('message', (event) => { server.send(event.data); });
  server.addEventListener('close', (event) => { closeAs(relay, event.code, scrubText(event.reason, injected)); });
  relay.addEventListener('close', (event) => { closeAs(server, event.code, event.reason); });
  server.addEventListener('error', () => { closeAs(relay, 1011, 'the server\'s WebSocket failed'); });
  relay.addEventListener('error', () => { closeAs(server, 1011, 'the program\'s WebSocket failed'); });

  return program;
}

/**
 * An outbound handler that throws returns no HTTP response ("Empty reply from server"), so answer 503: the request was
 * not sent and a retry recovers. The cause chain stays in diagnostics only (operator detail).
 */
function authorityFailure(input: { cause: unknown; host: string }): Response {
  // A deployment that holds no root secret can open no vault: said as it is, since no retry will change it.
  if (input.cause instanceof OwnerCapabilityUnavailableError) {
    diagnostics.failure('egress.authority_unreachable', new KinuError('unavailable', input.cause.message), { host: input.host });

    return refusal(503, `${input.cause.message} This request to ${input.host} names a vault secret, so it was not sent.`);
  }

  const error = toKinuError({
    doing: 'asking the owner vault what this container may spend on its request',
    cause: input.cause,
    otherwise: 'unavailable',
  });

  diagnostics.failure('egress.authority_unreachable', error, { host: input.host });

  return refusal(
    error.code === 'timeout' ? 504 : 503,
    `Kinu could not reach the credential authority for this container (${error.code}); the request to ${input.host} was not sent.`,
  );
}

/**
 * Classified: a deadline and a refused connection imply opposite next moves. The chain is rebuilt scrubbed, since
 * workerd's `Fetch API cannot load: <url>` names the substituted URL and would put the secret in Workers Logs.
 */
function upstreamFailure(
  input: { cause: unknown; host: string; injected: readonly ScrubReplacement[] },
): Response {
  const { cause, host, injected } = input;
  const code = classifyErrorCode({ cause }) ?? 'io';
  const chain = scrubText(renderThrownChain({ cause }), injected);
  diagnostics.failure('egress.upstream_failed', new KinuError(code, chain), { host });

  return refusal(
    code === 'timeout' ? 504 : 502,
    `Kinu could not complete the request to ${host} (${code}).`,
  );
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

/** Plain text, no secret, no placeholder it did not already hold. */
function refusal(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

