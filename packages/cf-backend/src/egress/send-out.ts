/**
 * Where every program's request leaves Kinu (the container's, a Nimbus workspace's, an eval program's, a slate's): the
 * secrets it names opened by the owner's object for its workspace, the `User-Agent` policy applied once, redirects handed
 * back to be judged, and anything coming back scrubbed of what was substituted.
 */

import { Cause, Effect } from 'effect';
import {
  closeReason, createScrubStream, egressPlaceholdersIn, kinuUserAgent, objectNamed, observeGitHub, OwnerCapabilityUnavailableError,
  ownerCaller, reoriginateRequest, revealHeader, scrubBytes, scrubText,
  type EgressInjection, type EgressInjectionResult, type EgressRequestFacts, type GitHubRecorder, type ObjectNamespace,
  type OwnerCapabilityEnv, type ScrubReplacement, type UserCaller,
} from '@kinu.run/core';
import { classifyErrorCode, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';

/** Narrow on purpose, like `runtime.ts`'s `RuntimeUserDOClient`. */
interface EgressVaultClient {
  resolveEgressInjection(caller: UserCaller, facts: EgressRequestFacts, workspace: string): Promise<EgressInjectionResult>;
}

/** Whose secrets a request may spend: a workspace, named by the egress's sealed props, and the account that grants them. */
export interface SecretVault {
  readonly ownerUserId: string;
  readonly workspaceName: string;
}

export interface ContainerEgressEnv<Id> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, EgressVaultClient>;
}

/**
 * `request` sent on, each placeholder it names opened by the owner's object for `vault`'s workspace, its grants and the
 * secret as they stand. A request naming none costs no round trip; with no `vault` (a program run for a share's viewer)
 * one naming a placeholder is refused. Every egress that carries a program's requests out sends them here.
 */
/** {@link sendOut} as a promise, for an egress whose own entry awaits it (`codemode-egress.ts`). */
export function sendOutRequest<Id>(request: Request, env: ContainerEgressEnv<Id>, vault: SecretVault | null): Promise<Response> {
  return settle(sendOut(request, env, vault, undefined));
}

export function sendOut<Id>(
  request: Request,
  env: ContainerEgressEnv<Id>,
  vault: SecretVault | null,
  github: GitHubRecorder | undefined,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const facts: EgressRequestFacts = { host: url.hostname, url: request.url, headers: [...request.headers] };

    if (egressPlaceholdersIn(facts).size === 0) return yield* forwarded(request, url, [], github);

    if (vault === null) return refusal(403, 'This program runs without the owner\'s secrets (a slate shared with others), so a request naming a secret placeholder is not sent.');

    // Use the stub, never copy it: `Object.assign` of a JSRPC stub yields `{}` (methods live behind a Proxy).
    const owner: EgressVaultClient = objectNamed(env.UserDO, vault.ownerUserId);

    const resolved = yield* Effect.matchCause(Effect.promise(async (): Promise<EgressInjectionResult> => owner.resolveEgressInjection(
      await ownerCaller(env), facts, vault.workspaceName,
    )), {
      onSuccess: (answer) => ({ answer }),
      onFailure: (failed) => ({ refused: authorityFailure({ cause: Cause.squash(failed), host: url.hostname }) }),
    });

    if ('refused' in resolved) return resolved.refused;

    if (resolved.answer.kind === 'refuse') return refusal(resolved.answer.status, resolved.answer.reason);

    return yield* forwarded(request, url, resolved.answer.substitutions, github);
  });
}

/** `request` sent on with `substitutions` made, GitHub's part of it recorded. */
function forwarded(request: Request, url: URL, substitutions: readonly EgressInjection[], github: GitHubRecorder | undefined): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const observed = yield* observeGitHub(request, url, github);
    const answer = yield* forwardUpstream(observed?.request ?? request, url, substitutions);

    return observed === null ? answer : observed.answered(answer);
  });
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

    for (const [name, value] of request.headers) {
      const revealed = revealHeader(value, reveal);

      headers.set(name, revealed.value);

      if (revealed.scrub !== undefined) injected.push(revealed.scrub);
    }

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
  else socket.close(code === 1006 || code === 1015 ? 1011 : code, closeReason(reason));
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

/** Marks Kinu's own answer, never the upstream's: an eval program's `fetch` throws it (codemode-node-shim.ts `createFetch`). */
export const EGRESS_FAILURE_HEADER = 'x-kinu-egress-failure';

/** Plain text, no secret, no placeholder it did not already hold. */
export function refusal(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', [EGRESS_FAILURE_HEADER]: '1' },
  });
}

