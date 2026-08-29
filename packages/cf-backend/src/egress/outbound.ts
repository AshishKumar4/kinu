/**
 * Outbound interception — every HTTP and HTTPS request leaving an agent's
 * container passes through one of these two handlers, which run in the Workers
 * runtime, outside the container.
 *
 * ── What is intercepted, and what escapes ────────────────────────
 * Stated up front because a secret-injection design whose interception can be
 * bypassed is worse than none: it removes the secret from the container while
 * leaving a path that still needs one.
 *
 *   Ports 80 and 443, HTTP and HTTPS   — intercepted. HTTPS by TLS
 *     termination against an ephemeral CA the container is made to trust; this
 *     requires `interceptHttps = true`, which the SDK does NOT default to
 *     despite what its docs say (see {@link KinuSandbox}).
 *   Every other TCP port               — NEVER routed through a handler by the
 *     platform. Denied outright, because `enableInternet = false`. MEASURED, not
 *     just designed: from a real container on the deployed worker, TCP connects
 *     to 22, 2222, 3306, 5432, 6379 and 8080 all time out while 80 and 443
 *     connect — so the probe demonstrably distinguishes the two, and the denials
 *     are an observation rather than the absence of one.
 *   DNS                                — MEASURED CLOSED, correcting what this
 *     comment used to claim. Inside a real container on the deployed worker,
 *     raw UDP/53 and TCP/53 to 1.1.1.1 / 8.8.8.8 / 2606:4700:4700::1111 get no
 *     reply, and every name — `<random>.invalidtld-nothing-here` included —
 *     resolves to the same private ULA `fd00::119:1`. A public resolver cannot
 *     return an fd00::/8 address nor answer an impossible TLD, so resolution is
 *     synthesized by the platform to steer 80/443 into interception; the query
 *     never leaves. So there is no low-bandwidth label channel here. It is a
 *     PLATFORM property and can regress with no diff in this file —
 *     `scripts/egress-interception.ts` records the probe.
 *   A container that distrusts the CA  — fails the handshake. Fails CLOSED: no
 *     request, no secret, a visible error.
 *
 * The consequence of `enableInternet = false` is deliberate and worth saying
 * plainly: only HTTP/S and DNS leave an agent's container. Anything on another
 * port — git-over-SSH, a raw database socket — is refused. Total interception
 * and arbitrary outbound sockets are mutually exclusive, and interception is
 * the one the owner asked for.
 *
 * ── Why the handlers are configured at runtime, not statically ───
 * A static `outbound` handler receives no parameters, so it would have to
 * discover which workspace a container belongs to from inside the container's
 * own traffic — which is exactly the thing untrusted code must not get to
 * decide. `setOutboundHandler(name, params)` and `setOutboundByHost(host,
 * name, params)` attach parameters chosen by the Durable Object that owns the
 * container, carried in `ContainerProxy` props. `ctx.params` is therefore
 * trusted input and `ctx.containerId` is platform-supplied, while everything
 * in the request is not.
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
import { ownerCaller, type UserCaller } from '../user/workspace-capability';
import type { EgressInjection, EgressInjectionResult } from '../user/egress-vault';
import { kinuUserAgent, reoriginateRequest } from '../lib/http';
import {
  classifyErrorCode, diagnostics, renderThrownChain, toKinuError, KinuError,
  type Refusal,
} from '@kinu.run/core/obs';

/**
 * The virtual host a container posts its own events to.
 *
 * `.internal` is reserved and resolves nowhere on the public internet, so a
 * misconfiguration that stopped intercepting this host would fail to connect
 * rather than quietly ship the agent's activity to a real server. The port is
 * plain HTTP because the request never leaves the machine.
 */
export const CONTAINER_EVENT_HOST = 'events.kinu.internal';

/** The one path on that host. Anything else is a mistake worth naming. */
export const CONTAINER_EVENT_PATH = '/v1/events';

/** Named handlers, referenced by these keys from `setOutboundHandler` /
 *  `setOutboundByHost`. Kept as constants because the string is the contract
 *  between the class's registry and the DO that configures it — a typo would
 *  otherwise surface as a runtime "method not found in outboundHandlers". */
export const EGRESS_HANDLER = 'kinuEgress';
export const EVENT_HANDLER = 'kinuEvents';

/** What the owning Durable Object tells the handlers. Not readable or
 *  influenceable from inside the container. */
export interface KinuEgressParams {
  /** The workspace whose container this is — the event channel's addressing. */
  readonly workspaceName: string;
  /** Whose vault holds the secrets. */
  readonly ownerUserId: string;
  /**
   * The bindings this workspace has been GRANTED, carrying no secret material.
   * Computed by the DO as (the owner's vault) ∩ (this workspace's approval
   * grants), so consent is decided by the approval gate before a request is
   * ever made, and the hot path needs no approval round trip.
   */
  readonly bindings: readonly EgressSecretBinding[];
}

/** The shape, as a parser. `ctx.params` is trusted — only the owning DO writes
 *  it — but it arrives `unknown`, and parsing is both cheaper to justify than
 *  an assertion and honest about the one thing that can go wrong: a container
 *  configured by an older build, whose params predate a field. */
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

/** Trusted-but-unparsed handler parameters, or undefined when this container
 *  has not been configured yet. Undefined makes both handlers refuse. */
export function parseEgressParams(ctx: OutboundHandlerContext): KinuEgressParams | undefined {
  const parsed = v.safeParse(EgressParamsSchema, ctx.params);
  return parsed.success ? parsed.output : undefined;
}

/** The vault call an intercepted request makes. Narrow on purpose, following
 *  `runtime.ts`'s `RuntimeUserDOClient`: a handler that named the whole UserDO
 *  surface would instantiate every unrelated RPC signature at this call site. */
interface EgressVaultClient {
  resolveEgressInjection(
    caller: UserCaller,
    facts: EgressRequestFacts,
    active: readonly EgressSecretBinding[],
  ): Promise<EgressInjectionResult>;
}

/** The one ingress call the event channel makes on the workspace DO.
 *  `unit-egress-interception.test.ts` asserts this method is both present on
 *  `OrchestratorAgent.prototype` AND listed on `ORCHESTRATOR_METHODS` — a
 *  method missing from that allowlist is silently unreachable over a stub,
 *  which is exactly how five head-journal calls came to write nothing. */
interface ContainerEventClient {
  acceptContainerEvent(body: JsonValue): Promise<ContainerEventResult>;
}

/**
 * Catch-all: every request to every host except the event channel.
 *
 * Ordinary traffic carrying no placeholder is forwarded with one pure,
 * allocation-light scan and no scrub machinery on the way back. Only a request
 * that actually carries a placeholder pays for substitution.
 */
export async function handleContainerEgress(
  request: Request,
  env: Env,
  params: KinuEgressParams | undefined,
): Promise<Response> {
  if (!params) {
    // Interception is live but unconfigured. Refuse rather than forward: an
    // unconfigured handler cannot tell a placeholder from a secret, and
    // forwarding would be the one behaviour that leaks.
    return refusal(503, 'Egress interception is not configured for this container yet.');
  }
  const url = new URL(request.url);
  // Judged BEFORE the vault call: where a request may go is a transport fact
  // that costs no round trip, and a private destination is refused whether or
  // not the vault would have answered.
  const destination = refusedHostname(url.hostname);
  if (destination !== null) return destinationRefusal(url.hostname, destination);
  const facts: EgressRequestFacts = {
    host: url.hostname,
    url: request.url,
    headers: [...request.headers],
  };

  // The stub is USED, never COPIED. `Object.assign` transfers own enumerable
  // properties and a JSRPC stub's methods live behind a Proxy, so copying one
  // yields `{}`. This threw `vaultView.resolveEgressInjection is not a function`
  // on every intercepted request on production — and because an outbound handler
  // that throws returns no HTTP response at all, the container saw only
  // "Empty reply from server". That is why ALL container egress was dead while
  // every test passed: the tests asserted the method is on the RPC surface,
  // which it is, and nothing asserted the copy transferred it.
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

/** Refusal shape for a refused destination: the classified payload on the
 *  wire, the classification in diagnostics, host only in fields. */
function destinationRefusal(host: string, payload: Refusal): Response {
  const error = new KinuError('denied', payload.error);
  diagnostics.failure('egress.private_destination', error, { host });
  return Response.json(payload, { status: 403 });
}

/**
 * Substitute, forward, and scrub the way back.
 *
 * ONE construction site for the request that leaves. The no-substitution case
 * used to hand the intercepted `Request` straight to `fetch`, which meant the
 * `User-Agent` policy would have had to be applied twice or not at all; it now
 * runs through the same builder with an empty substitution set, where every
 * scrub is the identity and the response is returned untouched.
 *
 * Every redirect the container asked for is `manual`, not just the credentialed
 * case. The runtime's own follower never re-enters this handler, so a hop it
 * made would never be judged; handing every 3xx back means the container's
 * next request re-enters here and is judged like the first. The one mode kept
 * is `error`, which is the caller refusing redirects outright.
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

  // Everything the container can read, scrubbed with the SAME pairs reversed:
  // an upstream that quotes the request into an error body, or returns a
  // Location carrying the token as a query parameter, must not become an
  // oracle for the value we just attached.
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) responseHeaders.set(name, scrubText(value, injected));
  return new Response(
    upstream.body === null ? null : upstream.body.pipeThrough(createScrubStream(injected)),
    { status: upstream.status, statusText: scrubText(upstream.statusText, injected), headers: responseHeaders },
  );
}

/**
 * Kinu's own authority did not answer.
 *
 * A throw here reaches nobody: an outbound handler that raises returns no HTTP
 * response at all, so the container's client prints "Empty reply from server"
 * and no part of the message says whether the request was refused, delivered,
 * or never attempted. 503, because the vault call establishes nothing about
 * the upstream — the request was NOT sent, and a retry is the recovery.
 *
 * The cause chain is kept whole, and only in diagnostics: it can name the
 * owner's Durable Object and the binding ids, which is operator detail, not
 * something an agent's container is owed.
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
 * The upstream did not answer.
 *
 * Classified rather than collapsed: a deadline and a refused connection imply
 * opposite next moves, and a container that is told only "502" retries the one
 * it should not.
 *
 * THE CHAIN IS SCRUBBED BEFORE IT IS RECORDED, and rebuilt as a fresh
 * `KinuError` rather than wrapped: workerd's own failure reads
 * `Fetch API cannot load: <url>`, and that URL is the SUBSTITUTED one, so
 * keeping the native `cause` would put the owner's secret in Workers Logs.
 * `injected` maps every secret back to the placeholder the container already
 * holds, which is the same pairing the response body is scrubbed with.
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
 * The container→DO event channel.
 *
 * Addressing is `ctx.params.workspaceName`, not anything in the request: a
 * container that could name its own workspace could post into somebody else's.
 * The handler awaits the DO's answer and returns it — nothing is deferred past
 * the response, because `waitUntil` is a no-op in a Durable Object and a
 * floating promise there is cancelled on eviction with the cancellation
 * swallowed. If the DO is evicted mid-write the container sees a failure and
 * the retry is the recovery.
 */
export async function handleContainerEvent(
  request: Request,
  env: Env,
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
    // `request.json()` is typed `unknown`; JsonValueSchema is the parse that
    // makes it a named domain type before it crosses into the DO.
    body = v.parse(JsonValueSchema, await request.json());
  } catch (error) {
    return refusal(400, `Body is not JSON: ${renderThrownChain({ cause: error })}`);
  }

  // Used, not copied — same defect as `handleContainerEgress`, and it killed the
  // whole container→DO event channel the same way.
  //
  // The RPC is classified for the same reason the vault call above is: a throw
  // out of an outbound handler produces no HTTP response, so a container whose
  // workspace object was evicted mid-write would see an empty reply and could
  // not tell "not accepted" from "network gone". 503 says the event was not
  // recorded and the retry is the recovery.
  let result: ContainerEventResult;
  try {
    const agent: ContainerEventClient = await getAgentByName<Env, OrchestratorAgent>(
      env.OrchestratorAgent, params.workspaceName,
    );
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

/** A refusal the container reads. Plain text, no secret, no placeholder it did
 *  not already hold. */
function refusal(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
