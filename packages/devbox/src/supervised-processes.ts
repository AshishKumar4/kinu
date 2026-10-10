import { processScope, supervisedScope, type ResourceLane, type ResourceScope } from './operation-lanes';
import type { SupervisedProcessSpec } from './lifecycle';
import { isProcessLive, type ProcessRecord, type Processes } from './processes';
import { DEVBOX_WORKDIR } from './storage';
import { Effect, Result } from 'effect';
import { attempt, settle, type DevboxError } from './errors';

export const SUPERVISED_SPEC_PREFIX = 'devbox:proc:';

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
  readonly native: () => Pick<Processes, 'get' | 'start' | 'kill'>;
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
 * native work settles, but its validity is revoked immediately and checked before each following mutation. */
export class SupervisedProcesses {
  constructor(readonly ports: Ports) {}

  async list(): Promise<readonly SupervisedProcessSpec[]> {
    return [...(await this.ports.storage.list<SupervisedProcessSpec>({ prefix: SUPERVISED_SPEC_PREFIX })).values()];
  }

  run(request: SupervisedStart, context?: ReservationContext): Promise<Started | typeof STALE>;
  run(request: SupervisedStop, context?: ReservationContext): Promise<Stopped | typeof STALE>;
  async run(request: Request, context?: ReservationContext): Promise<Outcome> {
    const generation = context === undefined ? this.ports.generation() : context.generation;
    const current = () => this.ports.generation() === generation && (context === undefined || context.current());

    for (;;) {
      if (!current()) return STALE;

      let seen: SupervisedProcessSpec | undefined;

      if (request.kind === 'restore') seen = request.spec;
      else if (request.kind !== 'start') seen = await this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${request.processId}`);

      if (!current()) return STALE;

      let scopes: readonly ResourceScope[];

      if (request.kind === 'start') scopes = supervisedScope(request.command, request.cwd, generation);
      else {
        const processId = request.kind === 'restore' ? request.spec.processId : request.processId;

        scopes = seen === undefined ? processScope(processId, generation) : [
          ...processScope(seen.processId, generation), ...supervisedScope(seen.command, seen.cwd ?? DEVBOX_WORKDIR, generation),
        ];
      }

      const outcome = await this.ports.lane.run(scopes, () => this.claimed(request, seen, current));

      if (outcome.kind !== 'rebind') return outcome;
    }
  }

  private async claimed(request: Request, seen: SupervisedProcessSpec | undefined, current: () => boolean): Promise<Outcome | typeof REBIND> {
    if (!current()) return STALE;
    let owner: SupervisedProcessSpec | undefined;
    let known = true;

    if (request.kind === 'start') {
      owner = (await this.list()).find((spec) => spec.command === request.command && (spec.cwd ?? DEVBOX_WORKDIR) === request.cwd);

      if (!current()) return STALE;

      if (owner === undefined) {
        known = false;
        owner = { processId: crypto.randomUUID(), command: request.command, cwd: request.cwd, createdAt: Date.now() };
        await this.ports.storage.put(`${SUPERVISED_SPEC_PREFIX}${owner.processId}`, owner);
      }
    } else {
      const processId = request.kind === 'restore' ? request.spec.processId : request.processId;

      owner = await this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`);

      if (!current()) return STALE;

      if (!sameReservation(seen, owner)) return request.kind === 'restore' ? STALE : REBIND;
    }

    if (!current()) return STALE;

    return request.kind === 'stop' || request.kind === 'native-stop'
      ? this.stop(request, owner, current) : this.start(request, owner, current, known);
  }

  private async start(request: SupervisedStart, owner: SupervisedProcessSpec | undefined, current: () => boolean, known: boolean): Promise<Started | typeof STALE> {
    const processId = request.kind === 'native-start' ? request.processId : owner?.processId;

    if (processId === undefined) return STALE;
    const native = this.ports.native();
    const existing = known && request.kind !== 'native-start' ? await native.get(processId) : null;

    if (!current()) return STALE;

    if (known && owner !== undefined) {
      const held = await this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`);

      if (!current() || !sameReservation(owner, held)) return STALE;
    }

    if (existing !== null && isProcessLive(existing.status)) return { kind: 'started', process: existing };
    const command = request.kind === 'restore' ? request.spec.command : request.command;
    const cwd = request.kind === 'restore' ? request.spec.cwd ?? DEVBOX_WORKDIR : request.cwd;
    const started = await settle(Effect.result(attempt('process', () => native.start(command, { cwd, processId, current }))));

    if (Result.isFailure(started)) {
      if (!current()) return STALE;

      return settle(Effect.fail(started.failure));
    }

    return current() ? { kind: 'started', process: started.success } : STALE;
  }

  private async stop(request: SupervisedStop, owner: SupervisedProcessSpec | undefined, current: () => boolean): Promise<Stopped | typeof STALE> {
    const killed = await settle(Effect.result(attempt('process', () => this.ports.native().kill(request.processId))));

    if (Result.isFailure(killed)) {
      if (request.kind === 'native-stop') return settle(Effect.fail(killed.failure));

      await this.ports.failedStop(request.processId, killed.failure);

      return { kind: 'stopped', stopped: false };
    }

    if (!current()) return STALE;

    if (request.kind === 'stop') {
      const held = await this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${request.processId}`);

      if (!current() || !sameReservation(owner, held)) return STALE;
      await this.ports.storage.delete(`${SUPERVISED_SPEC_PREFIX}${request.processId}`);
    }

    return current() ? { kind: 'stopped', stopped: true } : STALE;
  }
}
