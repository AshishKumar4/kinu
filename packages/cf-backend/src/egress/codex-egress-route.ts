import { APICallError } from 'ai';
import {
  activeOperationProfile, asFetchFunction, WORKSPACE_RUN_ID, abortCause, EGRESS_REFUSAL_HEADER, EGRESS_ROUTE_HEADER, refusalError,
  isDeviceNotConnectedError, isDeviceUnknownMethodError, DEVICE_UNRESPONSIVE,
  type OperationProfile, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
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

interface ActorPin {
  turn: string;
  route: Promise<CodexRoute> | null;
  /** Late calls pick unwritten. */
  readonly replaced: Set<string>;
}

const PINNED = new Map<string, ActorPin>();

interface TurnKey {
  readonly actor: string;
  readonly turn: string;
}

function turnOf(operation: OperationProfile | undefined): TurnKey | null {
  if (operation === undefined || operation.turnId === WORKSPACE_RUN_ID) return null;
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

function namingLoss(response: Response, lost: (failure: { readonly cause: unknown }) => Error): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();

        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        controller.error(deviceLost({ cause }) ? lost({ cause }) : cause);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });

  return new Response(body, response);
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
}): typeof fetch {
  const { container, hub, caller } = input;

  const pick = async (): Promise<CodexRoute> => {
    const device = await hub.codexRelayDevice(await caller());

    return device === null ? CONTAINER : { kind: 'device', id: device.id, label: device.label };
  };

  const routeOf = (turn: TurnKey | null): Promise<CodexRoute> => {
    if (turn === null) return pick();
    const held = PINNED.get(turn.actor);

    if (held?.turn === turn.turn && held.route !== null) return held.route;

    if (held?.replaced.has(turn.turn) === true) return pick();
    const pin = held ?? { turn: turn.turn, route: null, replaced: new Set<string>() };

    if (pin.turn !== turn.turn) pin.replaced.add(pin.turn);
    pin.turn = turn.turn;

    const picking = (async () => {
      try {
        const route = await pick();
        diagnostics.event('codex.route_pinned', { route: route.kind, device: route.kind === 'device' ? route.id : '' });

        return route;
      } catch (cause) {
        if (pin.turn === turn.turn) pin.route = null;
        throw new KinuError('unavailable', 'could not ask the account which machine carries Codex', { cause });
      }
    })();

    pin.route = picking;
    PINNED.set(turn.actor, pin);

    return picking;
  };

  const viaContainer = async (request: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> => stamped(await container(request, init), 'relay');

  return asFetchFunction(async (request, init) => {
    const turn = turnOf(activeOperationProfile());
    const route = await routeOf(turn);

    if (route.kind === 'container') return viaContainer(request, init);
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw abortCause(signal);
    const callId = crypto.randomUUID();
    const who = await caller();
    const stopped = stoppedBy(signal, () => hub.cancelCodexRelay(who, callId), 'device');

    const lostDevice = (failure: { readonly cause: unknown }): APICallError => {
      const lost = new KinuError('unavailable', `${route.label} went offline during this turn`, failure);
      diagnostics.failure('codex.route_device_lost', lost, { device: route.id });

      return new APICallError({
        message: `${route.label} went offline during this turn, and Codex keeps one route per turn. Send again to continue.`,
        url: request instanceof Request ? request.url : request.toString(),
        requestBodyValues: undefined,
        statusCode: 503,
        isRetryable: false,
        cause: lost,
      });
    };

    let response: Response;

    try {
      response = await Promise.race([hub.relayCodex(who, route.id, callId, new Request(request, { ...init, signal: null })), stopped]);
    } catch (cause) {
      // Nothing left: re-pinned, not switched.
      if (isDeviceUnknownMethodError({ cause })) {
        const pin = turn === null ? undefined : PINNED.get(turn.actor);

        if (pin !== undefined && pin.turn === turn?.turn) pin.route = Promise.resolve(CONTAINER);
        diagnostics.event('codex.route_pinned', { route: 'container', device: '', reason: 'daemon_without_relay' });

        return viaContainer(request, init);
      }

      throw deviceLost({ cause }) ? lostDevice({ cause }) : cause;
    }

    return stamped(namingLoss(response, lostDevice), `device ${route.id}`);
  });
}
