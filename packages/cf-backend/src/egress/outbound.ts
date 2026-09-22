/**
 * Outbound interception: every HTTP/HTTPS request leaving an agent's container passes through these handlers, in the
 * Workers runtime. HTTPS needs `interceptHttps = true` (SDK does not default it; see {@link KinuSandbox}). Other TCP ports
 * are denied (`enableInternet = false`); measured on the deployed worker, as is DNS being platform-synthesized
 * (every name resolves to `fd00::119:1`, no label channel). Platform property: `scripts/egress-interception.ts` probes it.
 * `ctx.params` is trusted (set by the owning DO); `ctx.containerId` is platform-supplied; the request is not.
 */

import { getAgentByName } from 'agents';
import * as v from 'valibot';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import {
  createScrubStream,
  refusedHostname,
  scrubText,
  JsonValueSchema,
  type ContainerEventResult,
  type JsonValue,
  type EgressRequestFacts,
  type EgressSecretBinding,
  type ScrubReplacement,
} from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import type { ObjectNamespace } from '@kinu.run/core';
import { ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '@kinu.run/core';
import type { EgressInjection, EgressInjectionResult } from '@kinu.run/core';
import { kinuUserAgent, reoriginateRequest } from '@kinu.run/core';
import {
  classifyErrorCode, diagnostics, renderThrownChain, toKinuError, KinuError,
  type Refusal,
} from '@kinu.run/core/obs';

/** `.internal` resolves nowhere publicly, so a lapse in interception fails to connect rather than leaking activity. */
export const CONTAINER_EVENT_HOST = 'events.kinu.internal';

const CONTAINER_EVENT_PATH = '/v1/events';

/** The string is the contract between the class's registry and the configuring DO. */
export const EGRESS_HANDLER = 'kinuEgress';

export const EVENT_HANDLER = 'kinuEvents';

/** Set by the owning DO; not readable or influenceable from the container. */
export interface KinuEgressParams {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  /** Owner's vault ∩ this workspace's approval grants, carrying no secret material; the hot path needs no approval round trip. */
  readonly bindings: readonly EgressSecretBinding[];
}

/** Parsed although trusted: a container configured by an older build may predate a field. */
const EgressParamsSchema = v.object({
  workspaceName: v.pipe(v.string(), v.minLength(1)),
  ownerUserId: v.pipe(v.string(), v.minLength(1)),
  bindings: v.array(v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    label: v.string(),
    host: v.pipe(v.string(), v.minLength(1)),
    placeholder: v.pipe(v.string(), v.minLength(1)),
  })),
});

/** Undefined when the container is not configured yet; both handlers then refuse. */
export function parseEgressParams(ctx: OutboundHandlerContext): KinuEgressParams | undefined {
  const parsed = v.safeParse(EgressParamsSchema, ctx.params);

  return parsed.success ? parsed.output : undefined;
}

/** Narrow on purpose, like `runtime.ts`'s `RuntimeUserDOClient`. */
interface EgressVaultClient {
  resolveEgressInjection(
    caller: UserCaller,
    facts: EgressRequestFacts,
    active: readonly EgressSecretBinding[],
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
 * under its own retry (agents@0.22.0 agent-routing.js:176-183, read 2026-09-22).
 */
export type ContainerEventResolver = (workspaceName: string) => Promise<ContainerEventClient>;

export const containerEventResolver = (env: Env): ContainerEventResolver =>
  async (workspaceName) => await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent, workspaceName,
  );

/** Catch-all for every host except the event channel. Only a request that carries a placeholder pays for substitution. */
export async function handleContainerEgress<Id>(
  request: Request,
  env: ContainerEgressEnv<Id>,
  params: KinuEgressParams | undefined,
): Promise<Response> {
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

  // Use the stub, never copy it: `Object.assign` of a JSRPC stub yields `{}` (methods live behind a Proxy).
  const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(params.ownerUserId));
  let resolved: EgressInjectionResult;

  try {
    resolved = await vault.resolveEgressInjection(
      await ownerCaller(env), facts, params.bindings,
    );
  } catch (cause) {
    return authorityFailure({ cause, host: url.hostname });
  }

  if (resolved.kind === 'refuse') return refusal(resolved.status, resolved.reason);

  return forwardUpstream(request, url, resolved.substitutions);
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
async function forwardUpstream(
  request: Request,
  url: URL,
  substitutions: readonly EgressInjection[],
): Promise<Response> {
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

  let upstream: Response;

  try {
    upstream = await fetch(reoriginateRequest(request, target, {
      headers,
      redirect: request.redirect === 'error' ? 'error' : 'manual',
    }));
  } catch (cause) {
    return upstreamFailure({ cause, host: url.hostname, injected });
  }

  if (substitutions.length === 0) return upstream;

  // Scrubbed with the same pairs reversed, so an upstream echo of the request cannot become an oracle for the secret.
  const responseHeaders = new Headers();

  for (const [name, value] of upstream.headers) responseHeaders.set(name, scrubText(value, injected));

  return new Response(
    upstream.body === null ? null : upstream.body.pipeThrough(createScrubStream(injected)),
    { status: upstream.status, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders },
  );
}

/**
 * An outbound handler that throws returns no HTTP response ("Empty reply from server"), so answer 503: the request was
 * not sent and a retry recovers. The cause chain stays in diagnostics only (operator detail).
 */
function authorityFailure(input: { cause: unknown; host: string }): Response {
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

/**
 * Addressed by `ctx.params.workspaceName`, never the request, so a container cannot post into another workspace.
 * Awaited, not deferred: `waitUntil` is a no-op in a DO; on eviction mid-write the container retries.
 */
export async function handleContainerEvent(
  request: Request,
  resolveAgent: ContainerEventResolver,
  params: KinuEgressParams | undefined,
): Promise<Response> {
  if (!params) return refusal(503, 'The event channel is not configured for this container yet.');
  const url = new URL(request.url);

  if (request.method !== 'POST') return refusal(405, `Use POST ${CONTAINER_EVENT_PATH}.`);

  if (url.pathname !== CONTAINER_EVENT_PATH) {
    return refusal(404, `The only route on ${CONTAINER_EVENT_HOST} is POST ${CONTAINER_EVENT_PATH}.`);
  }

  let body: JsonValue;

  try {
    body = v.parse(JsonValueSchema, await request.json());
  } catch (error) {
    return refusal(400, `Body is not JSON: ${renderThrownChain({ cause: error })}`);
  }

  // Used, not copied (see `handleContainerEgress`). Classified because a throw here gives the container an empty reply;
  // 503 says the event was not recorded and retry recovers.
  let result: ContainerEventResult;

  try {
    const agent = await resolveAgent(params.workspaceName);

    result = await agent.acceptContainerEvent(body);
  } catch (cause) {
    const error = toKinuError({
      doing: 'delivering a container event to its workspace object',
      cause,
      otherwise: 'unavailable',
    });

    diagnostics.failure('egress.event_channel_unreachable', error, {
      workspace: params.workspaceName,
    });

    return refusal(
      error.code === 'timeout' ? 504 : 503,
      `Kinu could not record this event (${error.code}); it was not accepted, so send it again.`,
    );
  }

  if (result.status === 'rejected') return refusal(result.http_status, result.reason);

  return Response.json(
    { accepted: true, event_id: result.event_id, admitted: result.admitted },
    { status: 202 },
  );
}

/** Plain text, no secret, no placeholder it did not already hold. */
function refusal(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
