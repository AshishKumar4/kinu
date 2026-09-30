import { Effect } from 'effect';
import {
  activeOperationProfile, asFetchFunction, WORKSPACE_RUN_ID, abortCause, EGRESS_REFUSAL_HEADER, EGRESS_ROUTE_HEADER, refusalError,
  isDeviceNotConnectedError, isDeviceUnknownMethodError, DEVICE_UNRESPONSIVE,
  type ActorReference, type OperationProfile, type RelayedProvider, type UserCaller,
} from '@kinu.run/core';
import { attempt, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import type { CodexEgress } from './codex-egress';

export interface CodexEgressNamespace<Id = DurableObjectId> {
  idFromName(name: string): Id;
  get(id: Id): {
    forward(...args: Parameters<CodexEgress['forward']>): Promise<Response>;
    cancel(...args: Parameters<CodexEgress['cancel']>): Promise<void>;
  };
}

/** The account's side of the device relay: which machine carries a provider, and one relayed call. */
export interface ModelRelayHub {
  relayDevice(caller: UserCaller, provider: RelayedProvider): Promise<{ readonly id: string; readonly label: string } | null>;
  relayModelCall(caller: UserCaller, deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(caller: UserCaller, callId: string): Promise<void>;
}

type DeviceRoute = { readonly kind: 'device'; readonly id: string; readonly label: string } | { readonly kind: 'container' } | { readonly kind: 'none' };

const CONTAINER: DeviceRoute = { kind: 'container' };

const NONE: DeviceRoute = { kind: 'none' };

const PROVIDER_NAMES: Readonly<Record<RelayedProvider, string>> = { codex: 'Codex', chatgpt: 'ChatGPT' };

const PINNED = new Map<string, { readonly turn: string; readonly route: Promise<DeviceRoute> }>();

interface TurnKey {
  readonly actor: string;
  readonly turn: string;
}

/** Only live-turn calls pin. */
function liveTurnOf(
  provider: RelayedProvider, operation: OperationProfile | undefined, currentTurn: (actor: ActorReference) => string | null,
): TurnKey | null {
  if (operation === undefined || operation.turnId === WORKSPACE_RUN_ID || currentTurn(operation.actor) !== operation.turnId) return null;
  const { actor } = operation;

  return { actor: JSON.stringify([provider, actor.workspaceId, actor.actorId, actor.parentActorId]), turn: JSON.stringify([operation.runId, operation.turnId]) };
}

function stoppedBy(signal: AbortSignal | undefined, cancel: () => Promise<void>, route: 'container' | 'device'): Promise<never> {
  const stopped = Promise.withResolvers<never>();

  signal?.addEventListener('abort', () => {
    stopped.reject(abortCause(signal));
    cancel().catch((...rejection: [unknown]) => diagnostics.failure('codex_egress.cancel_failed', toKinuError({
      doing: 'cancelling a relayed model call', cause: rejection[0], otherwise: 'unavailable',
    }), { route }));
  }, { once: true });

  return stopped.promise;
}

function deviceLost(failure: { readonly cause: unknown }): boolean {
  return isDeviceNotConnectedError(failure) || renderThrownChain(failure).includes(DEVICE_UNRESPONSIVE);
}

function stamped(response: Response, route: string): Response {
  const headers = new Headers(response.headers);
  headers.set(EGRESS_ROUTE_HEADER, route);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function codexEgressFetch<Id>(namespace: CodexEgressNamespace<Id>, ownerUserId: string): typeof fetch {
  const stub = namespace.get(namespace.idFromName(ownerUserId));

  return asFetchFunction(async (input, init) => {
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw abortCause(signal);
    const callId = crypto.randomUUID();
    const request = new Request(input, { ...init, signal: null });
    const stopped = stoppedBy(signal, () => stub.cancel(callId), 'container');
    const response = await Promise.race([stub.forward(ownerUserId, callId, request), stopped]);
    const refusal = response.headers.get(EGRESS_REFUSAL_HEADER);

    if (refusal !== null) throw refusalError({ url: request.url, refusal, message: await response.text() });

    return response;
  });
}

/**
 * A provider's calls through the owner's own machine, one machine per turn. Codex falls back to its egress
 * container when no machine carries it; the ChatGPT plan has no fallback, since its token lives only on
 * the machine that signed in.
 */
export function deviceRouteFetch(input: {
  readonly provider: RelayedProvider;
  readonly container?: typeof fetch;
  readonly hub: ModelRelayHub;
  readonly caller: () => Promise<UserCaller>;
  readonly currentTurn?: (actor: ActorReference) => string | null;
}): typeof fetch {
  const { provider, container, hub, caller, currentTurn = () => null } = input;
  const name = PROVIDER_NAMES[provider];
  const fallback = container === undefined ? NONE : CONTAINER;

  const pick = async (): Promise<DeviceRoute> => {
    const device = await hub.relayDevice(await caller(), provider);

    return device === null ? fallback : { kind: 'device', id: device.id, label: device.label };
  };

  const routeOf = (turn: TurnKey | null): Effect.Effect<DeviceRoute, KinuError> => {
    const asking = attempt({ doing: `asking the account which machine carries ${name}`, otherwise: 'unavailable' }, () => pick());

    if (turn === null) return asking;
    const held = PINNED.get(turn.actor);

    if (held?.turn === turn.turn) return attempt({ doing: `reading this turn's ${name} route`, otherwise: 'unavailable' }, () => held.route);

    const picking = pick();
    PINNED.set(turn.actor, { turn: turn.turn, route: picking });

    return attempt({ doing: `asking the account which machine carries ${name}`, otherwise: 'unavailable' }, () => picking).pipe(
      Effect.tap((route) => Effect.sync(() => {
        diagnostics.event('codex.route_pinned', { provider, route: route.kind, device: route.kind === 'device' ? route.id : '' });
      })),
      Effect.tapError(() => Effect.sync(() => {
        if (PINNED.get(turn.actor)?.turn === turn.turn) PINNED.delete(turn.actor);
      })),
    );
  };

  const viaFallback = (request: RequestInfo | URL, init: RequestInit | undefined): Effect.Effect<Response, KinuError> => (container === undefined
    ? Effect.fail(new KinuError('unavailable', 'No connected machine holds a ChatGPT sign-in with plan usage'))
    : Effect.promise(async () => stamped(await container(request, init), 'relay')));

  return asFetchFunction(async (request, init) => {
    const signal = init?.signal ?? undefined;
    const turn = liveTurnOf(provider, activeOperationProfile(), currentTurn);
    // Checked before anything is sent.
    const unstopped = Effect.suspend(() => (signal?.aborted === true ? Effect.die(abortCause(signal)) : Effect.void));

    return settle(Effect.gen(function* () {
      yield* unstopped;
      const route = yield* routeOf(turn);

      if (route.kind !== 'device') return yield* viaFallback(request, init);
      const who = yield* attempt({ doing: `reading who asks for ${name}`, otherwise: 'unavailable' }, () => caller());
      const callId = crypto.randomUUID();
      yield* unstopped;
      const stopped = stoppedBy(signal, () => hub.cancelModelRelay(who, callId), 'device');

      const lostDevice = (failure: { readonly cause: unknown }): KinuError => {
        const lost = new KinuError('unavailable', `${route.label} went offline during this turn, and ${name} keeps one route per turn. Send again to continue`, failure);
        diagnostics.failure('codex.route_device_lost', lost, { provider, device: route.id });

        return lost;
      };

      const relaying = Effect.tryPromise({
        try: () => Promise.race([hub.relayModelCall(who, route.id, callId, new Request(request, { ...init, signal: null })), stopped]),
        catch: (cause) => ({ cause }),
      });

      // A machine lost mid-answer fails the body by name.
      const named = Effect.map(relaying, (response) => {
        const reader = response.body?.getReader();

        if (reader === undefined) return stamped(response, `device ${route.id}`);

        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => settle(Effect.match(Effect.tryPromise({ try: () => reader.read(), catch: (cause) => ({ cause }) }), {
            onSuccess: (next) => {
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            onFailure: (failure) => { controller.error(deviceLost(failure) ? lostDevice(failure) : failure.cause); },
          })),
          cancel: (reason) => reader.cancel(reason),
        });

        return stamped(new Response(body, response), `device ${route.id}`);
      });

      return yield* Effect.catch(named, (failure) => {
        if (signal?.aborted === true) return Effect.die(failure.cause);

        if (isDeviceUnknownMethodError(failure)) {
          const next = container === undefined ? NONE : CONTAINER;

          if (turn !== null && PINNED.get(turn.actor)?.turn === turn.turn) PINNED.set(turn.actor, { turn: turn.turn, route: Promise.resolve(next) });
          diagnostics.event('codex.route_pinned', { provider, route: next.kind, device: '', reason: 'daemon_without_relay' });

          return viaFallback(request, init);
        }

        return Effect.fail(deviceLost(failure) ? lostDevice(failure) : toKinuError({ doing: `relaying a ${name} call through the owner's machine`, cause: failure.cause, otherwise: 'unavailable' }));
      });
    }));
  });
}
