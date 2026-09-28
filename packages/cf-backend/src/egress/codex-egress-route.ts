import { Effect } from 'effect';
import {
  activeOperationProfile, asFetchFunction, WORKSPACE_RUN_ID, abortCause, EGRESS_REFUSAL_HEADER, EGRESS_ROUTE_HEADER, refusalError,
  isDeviceNotConnectedError, isDeviceUnknownMethodError, DEVICE_UNRESPONSIVE,
  type ActorReference, type OperationProfile, type UserCaller,
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

export interface CodexRelayHub {
  codexRelayDevice(caller: UserCaller): Promise<{ readonly id: string; readonly label: string } | null>;
  relayCodex(caller: UserCaller, deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelCodexRelay(caller: UserCaller, callId: string): Promise<void>;
}

type CodexRoute = { readonly kind: 'device'; readonly id: string; readonly label: string } | { readonly kind: 'container' };

const CONTAINER: CodexRoute = { kind: 'container' };

const PINNED = new Map<string, { readonly turn: string; readonly route: Promise<CodexRoute> }>();

interface TurnKey {
  readonly actor: string;
  readonly turn: string;
}

/** Only live-turn calls pin. */
function liveTurnOf(operation: OperationProfile | undefined, currentTurn: (actor: ActorReference) => string | null): TurnKey | null {
  if (operation === undefined || operation.turnId === WORKSPACE_RUN_ID || currentTurn(operation.actor) !== operation.turnId) return null;
  const { actor } = operation;

  return { actor: JSON.stringify([actor.workspaceId, actor.actorId, actor.parentActorId]), turn: JSON.stringify([operation.runId, operation.turnId]) };
}

function stoppedBy(signal: AbortSignal | undefined, cancel: () => Promise<void>, route: 'container' | 'device'): Promise<never> {
  const stopped = Promise.withResolvers<never>();

  signal?.addEventListener('abort', () => {
    stopped.reject(abortCause(signal));
    cancel().catch((...rejection: [unknown]) => diagnostics.failure('codex_egress.cancel_failed', toKinuError({
      doing: 'cancelling a Codex call', cause: rejection[0], otherwise: 'unavailable',
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

export function codexRouteFetch(input: {
  readonly container: typeof fetch;
  readonly hub: CodexRelayHub;
  readonly caller: () => Promise<UserCaller>;
  readonly currentTurn?: (actor: ActorReference) => string | null;
}): typeof fetch {
  const { container, hub, caller, currentTurn = () => null } = input;

  const pick = async (): Promise<CodexRoute> => {
    const device = await hub.codexRelayDevice(await caller());

    return device === null ? CONTAINER : { kind: 'device', id: device.id, label: device.label };
  };

  const routeOf = (turn: TurnKey | null): Effect.Effect<CodexRoute, KinuError> => {
    const asking = attempt({ doing: 'asking the account which machine carries Codex', otherwise: 'unavailable' }, () => pick());

    if (turn === null) return asking;
    const held = PINNED.get(turn.actor);

    if (held?.turn === turn.turn) return attempt({ doing: 'reading this turn\'s Codex route', otherwise: 'unavailable' }, () => held.route);

    const picking = pick();
    PINNED.set(turn.actor, { turn: turn.turn, route: picking });

    return attempt({ doing: 'asking the account which machine carries Codex', otherwise: 'unavailable' }, () => picking).pipe(
      Effect.tap((route) => Effect.sync(() => {
        diagnostics.event('codex.route_pinned', { route: route.kind, device: route.kind === 'device' ? route.id : '' });
      })),
      Effect.tapError(() => Effect.sync(() => {
        if (PINNED.get(turn.actor)?.turn === turn.turn) PINNED.delete(turn.actor);
      })),
    );
  };

  const viaContainer = (request: RequestInfo | URL, init: RequestInit | undefined): Effect.Effect<Response> =>
    Effect.promise(async () => stamped(await container(request, init), 'relay'));

  return asFetchFunction(async (request, init) => {
    const signal = init?.signal ?? undefined;
    const turn = liveTurnOf(activeOperationProfile(), currentTurn);
    // Checked before anything is sent.
    const unstopped = Effect.suspend(() => (signal?.aborted === true ? Effect.die(abortCause(signal)) : Effect.void));

    return settle(Effect.gen(function* () {
      yield* unstopped;
      const route = yield* routeOf(turn);

      if (route.kind === 'container') return yield* viaContainer(request, init);
      const who = yield* attempt({ doing: 'reading who asks for Codex', otherwise: 'unavailable' }, () => caller());
      const callId = crypto.randomUUID();
      yield* unstopped;
      const stopped = stoppedBy(signal, () => hub.cancelCodexRelay(who, callId), 'device');

      const lostDevice = (failure: { readonly cause: unknown }): KinuError => {
        const lost = new KinuError('unavailable', `${route.label} went offline during this turn, and Codex keeps one route per turn. Send again to continue`, failure);
        diagnostics.failure('codex.route_device_lost', lost, { device: route.id });

        return lost;
      };

      const relaying = Effect.tryPromise({
        try: () => Promise.race([hub.relayCodex(who, route.id, callId, new Request(request, { ...init, signal: null })), stopped]),
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
          if (turn !== null && PINNED.get(turn.actor)?.turn === turn.turn) PINNED.set(turn.actor, { turn: turn.turn, route: Promise.resolve(CONTAINER) });
          diagnostics.event('codex.route_pinned', { route: 'container', device: '', reason: 'daemon_without_relay' });

          return viaContainer(request, init);
        }

        return Effect.fail(deviceLost(failure) ? lostDevice(failure) : toKinuError({ doing: 'relaying a Codex call through the owner\'s machine', cause: failure.cause, otherwise: 'unavailable' }));
      });
    }));
  });
}
