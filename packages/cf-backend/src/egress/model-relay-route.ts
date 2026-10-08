import { Cause, Effect } from 'effect';
/** Codex and ChatGPT-plan model calls from the cloud: chatgpt.com refuses Workers, so the account's connected machine carries them. */
import {
  activeOperationProfile, asFetchFunction, WORKSPACE_RUN_ID, abortCause, EGRESS_ROUTE_HEADER,
  isDeviceNotConnectedError, DEVICE_ERRORS,
  type ActorReference, type OperationProfile, type RelayedProvider, type UserCaller,
} from '@kinu.run/core';
import { attempt, carriesCauseCode, detach, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';

/** The account's side of the device relay: which machine carries a provider, and one relayed call. */
export interface ModelRelayHub {
  relayDevice(caller: UserCaller, provider: RelayedProvider): Promise<{ readonly id: string; readonly label: string } | null>;
  relayModelCall(caller: UserCaller, deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelModelRelay(caller: UserCaller, callId: string): Promise<void>;
}

type DeviceRoute = { readonly kind: 'device'; readonly id: string; readonly label: string } | { readonly kind: 'none' };

const NONE: DeviceRoute = { kind: 'none' };

const PROVIDER_NAMES: Readonly<Record<RelayedProvider, string>> = { codex: 'Codex', chatgpt: 'ChatGPT' };

/** What a call with no machine to carry it is told, in the words a provider's own refusal would use. */
const NO_MACHINE: Readonly<Record<RelayedProvider, string>> = {
  codex: 'Codex calls from kinu.run go through your connected machine; connect one, or pick ChatGPT (Sign in with ChatGPT)',
  chatgpt: 'No connected machine holds a ChatGPT sign-in with plan usage',
};

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

function stoppedBy(signal: AbortSignal | undefined, cancel: () => Promise<void>): Promise<never> {
  const stopped = Promise.withResolvers<never>();

  signal?.addEventListener('abort', () => {
    stopped.reject(abortCause(signal));
    detach(Effect.catchCause(Effect.promise(cancel), (failed) => Effect.sync(() => diagnostics.failure('model_relay.cancel_failed', toKinuError({
      doing: 'cancelling a relayed model call', cause: Cause.squash(failed), otherwise: 'unavailable',
    })))));
  }, { once: true });

  return stopped.promise;
}

function deviceLost(failure: { readonly cause: unknown }): boolean {
  return isDeviceNotConnectedError(failure) || carriesCauseCode(failure, DEVICE_ERRORS.unresponsive);
}

function stamped(response: Response, route: string): Response {
  const headers = new Headers(response.headers);
  headers.set(EGRESS_ROUTE_HEADER, route);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** One machine per turn, and none is refused: no other route carries these calls. */
export function deviceRouteFetch(input: {
  readonly provider: RelayedProvider;
  readonly hub: ModelRelayHub;
  readonly caller: () => Promise<UserCaller>;
  readonly currentTurn?: (actor: ActorReference) => string | null;
}): typeof fetch {
  const { provider, hub, caller, currentTurn = () => null } = input;
  const name = PROVIDER_NAMES[provider];

  const pick = async (): Promise<DeviceRoute> => {
    const device = await hub.relayDevice(await caller(), provider);

    return device === null ? NONE : { kind: 'device', id: device.id, label: device.label };
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

  return asFetchFunction(async (request, init) => {
    const signal = init?.signal ?? undefined;
    const turn = liveTurnOf(provider, activeOperationProfile(), currentTurn);
    // Checked before anything is sent.
    const unstopped = Effect.suspend(() => (signal?.aborted === true ? Effect.die(abortCause(signal)) : Effect.void));

    return settle(Effect.gen(function* () {
      yield* unstopped;
      const route = yield* routeOf(turn);

      if (route.kind !== 'device') return yield* new KinuError('unavailable', NO_MACHINE[provider]);
      const who = yield* attempt({ doing: `reading who asks for ${name}`, otherwise: 'unavailable' }, () => caller());
      const callId = crypto.randomUUID();
      yield* unstopped;
      const stopped = stoppedBy(signal, () => hub.cancelModelRelay(who, callId));

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
            onFailure: (failure) => { controller.error(deviceLost(failure) ? lostDevice(failure) : new KinuError('unavailable', `${route.label}'s device relay was interrupted: ${renderThrownChain(failure)}`, failure)); },
          })),
          cancel: (reason) => reader.cancel(reason),
        });

        return stamped(new Response(body, response), `device ${route.id}`);
      });

      return yield* Effect.catch(named, (failure) => {
        if (signal?.aborted === true) return Effect.die(failure.cause);

        return Effect.fail(deviceLost(failure) ? lostDevice(failure) : toKinuError({ doing: `relaying a ${name} call through the owner's machine`, cause: failure.cause, otherwise: 'unavailable' }));
      });
    }));
  });
}
