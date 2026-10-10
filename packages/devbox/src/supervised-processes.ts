import { processScope, supervisedScope, type ResourceLane, type ResourceScope } from './operation-lanes';
import type { SupervisedProcessSpec } from './lifecycle';
import { isProcessLive, type ProcessRecord, type Processes } from './processes';
import { DEVBOX_WORKDIR } from './storage';
import { Effect, Result } from 'effect';
import { attempt, settle, type DevboxError } from './errors';

const SUPERVISED_SPEC_PREFIX = 'devbox:proc:';

export type SupervisedStart =
  | { readonly kind: 'start'; readonly command: string; readonly cwd: string }
  | { readonly kind: 'restore'; readonly spec: SupervisedProcessSpec }
  | { readonly kind: 'native-start'; readonly processId: string; readonly command: string; readonly cwd: string };

export type SupervisedStop =
  | { readonly kind: 'stop'; readonly processId: string }
  | { readonly kind: 'native-stop'; readonly processId: string };

type Request = SupervisedStart | SupervisedStop;

type Started = { readonly kind: 'started'; readonly process: ProcessRecord };

type Stopped = { readonly kind: 'stopped'; readonly stopped: boolean };

const STALE = { kind: 'stale' } as const;

const REBIND = { kind: 'rebind' } as const;

type Outcome = Started | Stopped | typeof STALE;

export interface ReservationContext {
  readonly generation: number;
  readonly current: () => boolean;
}

interface Ports {
  readonly generation: () => number;
  readonly storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  readonly lane: ResourceLane;
  readonly native: () => Processes;
  readonly failedStop: (processId: string, cause: DevboxError) => Promise<void>;
}

/** Native id plus the durable request's generation. A new request with the same command is not the old owner. */
function sameReservation(left: SupervisedProcessSpec | undefined, right: SupervisedProcessSpec | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;

  return left.processId === right.processId && left.command === right.command
    && (left.cwd ?? DEVBOX_WORKDIR) === (right.cwd ?? DEVBOX_WORKDIR) && left.createdAt === right.createdAt;
}

/** One reservation operation for all launches, restores and removals. Readiness belongs to the caller and is
 * awaited before entry, never while holding these scopes. A late continuation retains its claim until actual
 * native work settles, but its validity is revoked immediately and checked before each following mutation.
 * Claim namespaces use the actual kernel incarnation: a controller change in the same kernel cannot
 * release destructive work against its successor, while confirmed replacement cannot inherit old claims. */
export class SupervisedProcesses {
  constructor(readonly ports: Ports) {}

  async list(): Promise<readonly SupervisedProcessSpec[]> {
    return [...(await this.ports.storage.list<SupervisedProcessSpec>({ prefix: SUPERVISED_SPEC_PREFIX })).values()];
  }

  run(request: SupervisedStart, context?: ReservationContext): Promise<Started | typeof STALE>;
  run(request: SupervisedStop, context?: ReservationContext): Promise<Stopped | typeof STALE>;
  run(request: Request, context?: ReservationContext): Promise<Outcome> {
    return settle(Effect.gen({ self: this }, function* () {
      const generation = context === undefined ? this.ports.generation() : context.generation;
      const current = () => this.ports.generation() === generation && (context === undefined || context.current());
      const native = this.ports.native();
      const kernel = yield* attempt('process', () => native.incarnation());

      if (!current()) return STALE;
      const operation = native.inIncarnation(kernel);

      for (;;) {
        if (!current()) return STALE;

        let seen: SupervisedProcessSpec | undefined;

        if (request.kind === 'restore') seen = request.spec;
        else if (request.kind !== 'start') seen = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${request.processId}`));

        if (!current()) return STALE;

        let scopes: readonly ResourceScope[];

        if (request.kind === 'start') scopes = supervisedScope(request.command, request.cwd, kernel);
        else {
          const processId = request.kind === 'restore' ? request.spec.processId : request.processId;

          scopes = seen === undefined ? processScope(processId, kernel) : [
            ...processScope(seen.processId, kernel), ...supervisedScope(seen.command, seen.cwd ?? DEVBOX_WORKDIR, kernel),
          ];
        }

        const release = yield* attempt('io', () => this.ports.lane.hold(scopes));
        const outcome = yield* Effect.ensuring(this.claimed(request, seen, current, operation), Effect.sync(release));

        if (outcome.kind !== 'rebind') return outcome;
      }
    }));
  }

  private claimed(request: Request, seen: SupervisedProcessSpec | undefined, current: () => boolean, native: Processes): Effect.Effect<Outcome | typeof REBIND, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      if (!current()) return STALE;
      let owner: SupervisedProcessSpec | undefined;
      let known = true;

      if (request.kind === 'start') {
        owner = (yield* attempt('io', () => this.list())).find((spec) => spec.command === request.command && (spec.cwd ?? DEVBOX_WORKDIR) === request.cwd);

        if (!current()) return STALE;

        if (owner === undefined) {
          known = false;
          owner = { processId: crypto.randomUUID(), command: request.command, cwd: request.cwd, createdAt: Date.now() };
          const reserved = owner;

          yield* attempt('io', () => this.ports.storage.put(`${SUPERVISED_SPEC_PREFIX}${reserved.processId}`, reserved));
        }
      } else {
        const processId = request.kind === 'restore' ? request.spec.processId : request.processId;

        owner = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`));

        if (!current()) return STALE;

        if (!sameReservation(seen, owner)) return request.kind === 'restore' ? STALE : REBIND;
      }

      if (!current()) return STALE;

      return yield* (request.kind === 'stop' || request.kind === 'native-stop'
        ? this.stop(request, owner, current, native) : this.start(request, owner, current, { known, native }));
    });
  }

  private start(request: SupervisedStart, owner: SupervisedProcessSpec | undefined, current: () => boolean, options: { readonly known: boolean; readonly native: Processes }): Effect.Effect<Started | typeof STALE, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const processId = request.kind === 'native-start' ? request.processId : owner?.processId;

      if (processId === undefined) return STALE;
      const { known, native } = options;
      const existing = known && request.kind !== 'native-start' ? yield* attempt('process', () => native.get(processId)) : null;

      if (!current()) return STALE;

      if (known && owner !== undefined) {
        const held = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`));

        if (!current() || !sameReservation(owner, held)) return STALE;
      }

      if (existing !== null && isProcessLive(existing.status)) return { kind: 'started', process: existing };
      const command = request.kind === 'restore' ? request.spec.command : request.command;
      const cwd = request.kind === 'restore' ? request.spec.cwd ?? DEVBOX_WORKDIR : request.cwd;
      const started = yield* Effect.result(attempt('process', () => native.start(command, { cwd, processId, current })));

      if (Result.isFailure(started)) {
        if (!current()) return STALE;

        return yield* Effect.fail(started.failure);
      }

      return current() ? { kind: 'started', process: started.success } : STALE;
    });
  }

  private stop(request: SupervisedStop, owner: SupervisedProcessSpec | undefined, current: () => boolean, native: Processes): Effect.Effect<Stopped | typeof STALE, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const killed = yield* Effect.result(attempt('process', () => native.kill(request.processId, { current })));

      if (Result.isFailure(killed)) {
        if (!current()) return STALE;

        if (request.kind === 'native-stop') return yield* Effect.fail(killed.failure);

        yield* attempt('io', () => this.ports.failedStop(request.processId, killed.failure));

        return { kind: 'stopped', stopped: false };
      }

      if (!current()) return STALE;

      if (request.kind === 'stop') {
        const held = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${request.processId}`));

        if (!current() || !sameReservation(owner, held)) return STALE;
        yield* attempt('io', () => this.ports.storage.delete(`${SUPERVISED_SPEC_PREFIX}${request.processId}`));
      }

      return current() ? { kind: 'stopped', stopped: true } : STALE;
    });
  }
}
