import { processScope, supervisedScope, type ResourceLane, type ResourceScope } from './operation-lanes';
import type { SupervisedProcessSpec } from './lifecycle';
import { isProcessLive, type ProcessRecord, type Processes } from './processes';
import { DEVBOX_WORKDIR } from './storage';
import { jobSessionId } from './sessions';
import { Effect, Result } from 'effect';
import { attempt, settle, type DevboxError } from './errors';

const SUPERVISED_SPEC_PREFIX = 'devbox:proc:';

export type SupervisedStart =
  | { readonly kind: 'start'; readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly reveal: boolean; readonly job?: string }
  | { readonly kind: 'restore'; readonly spec: SupervisedProcessSpec }
  | { readonly kind: 'native-start'; readonly processId: string; readonly command: string; readonly cwd: string };

export type SupervisedStop =
  | { readonly kind: 'stop'; readonly processId: string }
  | { readonly kind: 'native-stop'; readonly processId: string };

/** A job's process looked at under its reservation: its end told and its spec gone if it has ended. */
export type SupervisedReap = { readonly kind: 'reap'; readonly spec: SupervisedProcessSpec };

type Request = SupervisedStart | SupervisedStop | SupervisedReap;

/** `job`: the job the process runs as, which may be an earlier start's: a live run keeps the job it was started as. */
type Started = { readonly kind: 'started'; readonly process: ProcessRecord; readonly job?: string };

type Stopped = { readonly kind: 'stopped'; readonly stopped: boolean };

/** What ended a job's process, where not itself, and the look it was told under. */
export interface EndTold {
  readonly why?: string;
  readonly current?: () => boolean;
}

type Reaped = { readonly kind: 'reaped'; readonly ended: boolean };

const STALE = { kind: 'stale' } as const;

const REBIND = { kind: 'rebind' } as const;

type Outcome = Started | Stopped | Reaped | typeof STALE;

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
  /** The values a job its owner started may read, asked at each of its launches and handed over in memory only. */
  readonly revealed: () => Promise<Readonly<Record<string, string>>>;
  /**
   * A process that runs as a job has ended, or is about to be forgotten: its end is told to the workspace while its spec
   * still names the job. `process` is its record, null where there is none; `why` says what ended it, where not itself.
   * Told only while `current` holds after what it wrote is read: a stale look tells nothing, and leaves the spec to
   * whatever holds the box now.
   */
  readonly ended: (spec: SupervisedProcessSpec & { readonly job: string }, process: ProcessRecord | null, as?: EndTold) => Promise<void>;
}

/** A run's answer, with the job its reservation names, if it runs as one. */
function startedAs(process: ProcessRecord, owner: SupervisedProcessSpec | undefined): Started {
  return owner?.job === undefined ? { kind: 'started', process } : { kind: 'started', process, job: owner.job };
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

  /**
   * A stopped computer's job, ended without starting it: its spec goes, so no restore runs it again. One that runs as a
   * background job has its end told first, while its spec still names the job.
   */
  async forget(processId: string, why: string): Promise<void> {
    const spec = await this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`);

    if (spec?.job !== undefined) await this.ports.ended({ ...spec, job: spec.job }, null, { why });
    await this.ports.storage.delete(`${SUPERVISED_SPEC_PREFIX}${processId}`);
  }

  run(request: SupervisedStart, context?: ReservationContext): Promise<Started | typeof STALE>;
  run(request: SupervisedStop, context?: ReservationContext): Promise<Stopped | typeof STALE>;
  run(request: SupervisedReap, context?: ReservationContext): Promise<Reaped | typeof STALE>;
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

        if (request.kind === 'restore' || request.kind === 'reap') seen = request.spec;
        else if (request.kind !== 'start') seen = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${request.processId}`));

        if (!current()) return STALE;

        let scopes: readonly ResourceScope[];

        if (request.kind === 'start') scopes = supervisedScope(request.command, request.cwd, kernel);
        else {
          const processId = request.kind === 'restore' || request.kind === 'reap' ? request.spec.processId : request.processId;

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

        if (owner === undefined) known = false;
        const ownerJob = owner?.job;

        // A run that is a job's keeps it: a live one is that job's still, and answers it, with nothing rewritten; an
        // ended one has its end told before a new start takes its id.
        if (owner !== undefined && ownerJob !== undefined) {
          const was = owner;
          const run = yield* attempt('process', () => native.get(was.processId));

          if (!current()) return STALE;

          if (run !== null && isProcessLive(run.status)) return { kind: 'started', process: run, job: ownerJob };
          yield* attempt('io', () => this.ports.ended({ ...was, job: ownerJob }, run, { current }));

          // Telling it reads what it wrote: a teardown or a replaced container may have come meanwhile.
          if (!current()) return STALE;
        }

        // A re-issue keeps its id and takes the variables and the starter it was asked with, for this start and every
        // restart after.
        const reserved: SupervisedProcessSpec = {
          processId: crypto.randomUUID(), createdAt: Date.now(), ...owner, command: request.command, cwd: request.cwd, env: request.env, reveal: request.reveal,
          ...(request.job === undefined ? { job: undefined } : { job: request.job }),
        };

        owner = reserved;

        yield* attempt('io', () => this.ports.storage.put(`${SUPERVISED_SPEC_PREFIX}${reserved.processId}`, reserved));
      } else {
        const processId = request.kind === 'restore' || request.kind === 'reap' ? request.spec.processId : request.processId;

        owner = yield* attempt('io', () => this.ports.storage.get<SupervisedProcessSpec>(`${SUPERVISED_SPEC_PREFIX}${processId}`));

        if (!current()) return STALE;

        if (!sameReservation(seen, owner)) return request.kind === 'restore' || request.kind === 'reap' ? STALE : REBIND;
      }

      if (!current()) return STALE;

      if (request.kind === 'reap') return yield* this.reap(request, owner, current, native);

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

      if (existing !== null && isProcessLive(existing.status)) return startedAs(existing, owner);
      const command = request.kind === 'restore' ? request.spec.command : request.command;
      const cwd = request.kind === 'restore' ? request.spec.cwd ?? DEVBOX_WORKDIR : request.cwd;
      const env = request.kind === 'native-start' ? undefined : owner?.env;

      // Asked again at every launch, so a restart holds the values as the owner left them, and no launch keeps them.
      // An account that does not answer fails this launch with its reason: the job never runs short of a value it was
      // allowed, and a retry or the next restore asks again.
      const revealed = request.kind !== 'native-start' && owner?.reveal === true
        ? yield* attempt('io', () => this.ports.revealed(), "the account did not answer with the values this job's agents may read")
        : undefined;

      // An agent's job runs in a terminal session of its own, where a person can watch and answer it (D95).
      const session = request.kind === 'native-start' ? undefined : jobSessionId(processId);
      const started = yield* Effect.result(attempt('process', () => native.start(command, { cwd, processId, current, session, env, revealed })));

      if (Result.isFailure(started)) {
        if (!current()) return STALE;

        return yield* Effect.fail(started.failure);
      }

      return current() ? startedAs(started.success, owner) : STALE;
    });
  }

  /**
   * A job's process, read under its reservation, which a start or stop of it holds too: one that has ended has its end
   * told and its spec removed; a live one is left. A spec a later start rewrote is not this reap's (D105).
   */
  private reap(request: SupervisedReap, owner: SupervisedProcessSpec | undefined, current: () => boolean, native: Processes): Effect.Effect<Reaped | typeof STALE, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const job = owner?.job;

      if (owner === undefined || job === undefined || job !== request.spec.job) return STALE;
      const run = yield* attempt('process', () => native.get(owner.processId));

      if (!current()) return STALE;

      if (run !== null && isProcessLive(run.status)) return { kind: 'reaped', ended: false };
      yield* attempt('io', () => this.ports.ended({ ...owner, job }, run, { current }));

      if (!current()) return STALE;
      yield* attempt('io', () => this.ports.storage.delete(`${SUPERVISED_SPEC_PREFIX}${owner.processId}`));

      return { kind: 'reaped', ended: true };
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
        const job = held?.job;

        // Told while the spec still names its job: once it is gone, nothing could say whose end this was.
        if (held !== undefined && job !== undefined) {
          const run = yield* attempt('process', () => native.get(request.processId));

          if (!current()) return STALE;
          yield* attempt('io', () => this.ports.ended({ ...held, job }, run, { why: 'it was stopped', current }));

          if (!current()) return STALE;
        }

        yield* attempt('io', () => this.ports.storage.delete(`${SUPERVISED_SPEC_PREFIX}${request.processId}`));
      }

      return current() ? { kind: 'stopped', stopped: true } : STALE;
    });
  }
}
