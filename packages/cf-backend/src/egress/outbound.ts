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

/** Set by the owning DO; not readable or influenceable from the container. */
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

/** The suffix a workspace program's TLS socket names: the session is made here (`tlsDestination`). */
const TLS_SOCKET_SUFFIX = '.tls.nimbus-egress.invalid';

/**
 * Where a TLS socket asks to go: `<host>[.s.<servername>].tls.nimbus-egress.invalid:<port>`, each name as the hex of its
 * UTF-8 in labels of at most 62 characters (Kinu's Nimbus patch, NIMBUS-ASKS #37). Null for any other address.
 */
function tlsDestination(address: string): { readonly hostname: string; readonly port: number; readonly servername: string } | null {
  const plain = socketDestination(address);

  if (plain === null || !plain.hostname.endsWith(TLS_SOCKET_SUFFIX)) return null;
  const [host, sni, ...rest] = plain.hostname.slice(0, -TLS_SOCKET_SUFFIX.length).split('.s.');

  const named = (labels: string | undefined): string | null => {
    const hex = labels?.split('.').join('') ?? '';

    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;

    return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)));
  };

  const hostname = named(host);
  const servername = sni === undefined ? hostname : named(sni);

  return hostname === null || servername === null || rest.length > 0 ? null : { hostname, port: plain.port, servername };
}

/**
 * A workspace program's socket (its egress's `connect`): the destination judged as a request's host is, then the bytes
 * piped both ways. A TLS socket (`tlsDestination`) has its session made here, with Kinu's own trust, and its plaintext
 * carried; any other is carried as it is. Kinu reads none of it; a secret cannot be put into a stream it does not parse.
 * A refused or unnamed destination closes the socket before anything is sent.
 */
export function handleEgressConnect(socket: Socket, params: KinuEgressParams | undefined): Promise<void> {
  return settle(Effect.gen(function* () {
    const opened = yield* attempt({ doing: 'reading where a workspace socket goes', otherwise: 'io' }, () => socket.opened);
    const address = opened.localAddress ?? '';
    const tls = tlsDestination(address);
    const destination = tls ?? socketDestination(address);
    const refused = params === undefined || destination === null ? null : refusedHostname(destination.hostname);

    if (params === undefined || destination === null || refused !== null) {
      const reason = refused?.error ?? (params === undefined ? 'egress is not configured for this workspace yet' : `the socket names no usable destination (${address})`);

      diagnostics.failure('egress.socket_refused', new KinuError('denied', reason), { host: destination?.hostname ?? address, seam: 'workspace-connect' });

      return yield* attempt({ doing: `refusing a socket to ${address}`, otherwise: 'io' }, () => socket.close());
    }

    const { connect } = yield* Effect.promise(() => import('cloudflare:sockets'));
    const target = { hostname: destination.hostname, port: destination.port };

    // A server named other than its host is checked by that name (workerd's own node:tls does the same).
    const renamed = tls !== null && tls.servername !== tls.hostname;

    const upstream = renamed
      ? connect(target, { allowHalfOpen: true, secureTransport: 'starttls' }).startTls({ expectedServerHostname: tls.servername })
      : connect(target, { allowHalfOpen: true, secureTransport: tls === null ? 'off' : 'on' });

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

    // An accepted WebSocket upgrade keeps its socket; its frames are the program's, as a TLS stream's bytes are.
    if (upstream.status === 101) {
      return new Response(null, { status: 101, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders, webSocket: upstream.webSocket });
    }

    return new Response(
      upstream.body === null ? null : upstream.body.pipeThrough(createScrubStream(injected)),
      { status: upstream.status, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders },
    );
  });
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

