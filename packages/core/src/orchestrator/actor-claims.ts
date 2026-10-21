import type { ModelMessage } from 'ai';
import type { WorkMode } from '../types/turn';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { KinuError } from '../obs/error';
import { diagnostics, toKinuError } from '../obs/index';
import { nowMs } from '../utils/date';
import { RUN_END_REASONS } from './turn-lifecycle';
import { initSessionContextTables } from '../session/schema';
import { initSessionTranscriptTables } from '../session/transcript-schema';
import { initTurnFactsTables } from './turn-facts';
import { AgentSequence, initAgentSequenceTable } from '../subagents/report-sequence';
import { sqlCheckList } from '../utils/sql';
import type { ActorTurnProgram } from './actor-program';
import type { SessionHistory } from '../session/history';
import { admissionRequestId, type ClaimFences } from '../session/messages';
import type { ContextSelection } from '../session/context';
import type { PromptCacheRoute } from '../prompting/cache-breakpoints';

export const CLAIM_OUTCOMES = [...RUN_END_REASONS, 'indeterminate'] as const;

/** `preparing`: claimed as the execution opens, its epoch minted, before its program, context or profile are bound;
 *  `admitted`: bound, it may consume its context; `settled`: ended, under the outcome it settled with. */
const CLAIM_STATUSES = ['preparing', 'admitted', 'settled'] as const;

const PROGRAM_KINDS = ['builtin', 'scaffold'] as const;

export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

export interface ActorProgramIdentity { readonly kind: (typeof PROGRAM_KINDS)[number]; readonly version: number; readonly digest: string | null; readonly build: string | null }

export interface ActorTurnClaim {
  readonly actorId: string; readonly runId: string; readonly turnId: string; readonly epoch: number;
  readonly workMode: WorkMode; readonly program: ActorProgramIdentity;
  readonly workingRevision: number; readonly workingContextId: string;
}

export interface StoredActorClaim {
  readonly actorId: string; readonly runId: string; readonly turnId: string; readonly epoch: number;
  /** Null for a claim settled or still `preparing` before its program was bound. */
  readonly workMode: WorkMode; readonly program: ActorProgramIdentity | null;
  readonly status: (typeof CLAIM_STATUSES)[number]; readonly outcome: ClaimOutcome | null; readonly claimedAt: number;
  /** The epoch through which the turn's executions were withdrawn by a Retry of its answer (`withdraw`); 0 for none. */
  readonly withdrawnThrough: number;
  /** An execution of its run recorded the step that ended the turn, in that step's own commit (`answered`), and every
   *  later execution of the run keeps it: what is left of the run is its close, never another ask of the model. */
  readonly answered: boolean;
}

export interface ContextRevision {
  readonly requestId: string; readonly revision: number; readonly epoch: number;
  readonly workingRevision: number; readonly workingContextId: string; readonly stepIndex: number | null;
  readonly messages: readonly ModelMessage[];
}

export interface ConsumedContext { readonly requestId: string; readonly revision: number }

export function initActorClaimTables(exec: RawSqlExec): void {
  // One row a turn: its newest execution's claim. The epoch is the agent's, one sequence over all its turns, so it is the
  // execution's capability too; the program columns are null while the claim is `preparing`. What its run was offered as
  // it was prepared and the authority it bound (`TurnFactsStore`) are kept with it, its run's recovery's too.
  initAgentSequenceTable(exec);
  exec(`CREATE TABLE IF NOT EXISTS actor_turn_claims (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), turn_id TEXT NOT NULL, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    work_mode TEXT NOT NULL CHECK(work_mode IN ('plan','build')),
    phase TEXT NOT NULL CHECK(phase IN ('preparing','admitted')),
    program_kind TEXT CHECK(program_kind IS NULL OR program_kind IN (${sqlCheckList(PROGRAM_KINDS)})),
    program_version INTEGER, program_digest TEXT, program_build TEXT,
    outcome TEXT CHECK(outcome IS NULL OR outcome IN (${sqlCheckList(CLAIM_OUTCOMES)})),
    claimed_at INTEGER NOT NULL, withdrawn_through INTEGER NOT NULL DEFAULT 0,
    facts_json TEXT, profile_json TEXT, inputs_key TEXT,
    answered INTEGER NOT NULL DEFAULT 0 CHECK(answered IN (0,1)),
    PRIMARY KEY(actor_id,turn_id))`);
  exec(`CREATE INDEX IF NOT EXISTS idx_actor_claims_outcome ON actor_turn_claims(actor_id,outcome,claimed_at DESC)`);
  // Where each execution of a turn stands, so the next knows where a dead one was cut ({@link TurnCut}).
  // `oom`: the platform reported this execution's isolate out of memory; `oom_cuts`, the executions before it that were.
  exec(`CREATE TABLE IF NOT EXISTS actor_turn_cuts (
    actor_id TEXT NOT NULL, turn_id TEXT NOT NULL, epoch INTEGER NOT NULL, build TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('provider','work')), phase_at INTEGER NOT NULL,
    work_cuts INTEGER NOT NULL, provider_cuts INTEGER NOT NULL,
    oom INTEGER NOT NULL DEFAULT 0 CHECK(oom IN (0,1)), oom_cuts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(actor_id,turn_id))`);
  initTurnFactsTables(exec);
  initSessionContextTables(exec);
  initSessionTranscriptTables(exec);
}

export function programIdentityOf(program: ActorTurnProgram, installedBuild: string | null): ActorProgramIdentity {
  return Object.freeze(program.kind === 'scaffold'
    ? { kind: 'scaffold' as const, version: program.version, digest: program.digest, build: null }
    : { kind: 'builtin' as const, version: 0, digest: null, build: installedBuild });
}

/**
 * Where an execution of a turn stood when it was last seen: waiting on the provider's answer to a step (`provider`), or
 * doing the step's own work, a tool or the processing around a call (`work`). The counts are of the executions before
 * this one, on this build since the turn last finished a step, that ended in each: an outside reset (a deploy, a storage
 * reset, an eviction) can land anywhere, and only a cut in the step's own work can be the step's fault. Apart from
 * where it was, an execution may be known to have died of memory: the platform said its isolate ran out
 * ({@link ActorClaimStore.outOfMemory}).
 */
export interface TurnCut {
  readonly epoch: number;
  readonly build: string | null;
  readonly phase: 'provider' | 'work';
  readonly phaseAt: number;
  readonly workCuts: number;
  readonly providerCuts: number;
  readonly outOfMemory: boolean;
  readonly outOfMemoryCuts: number;
}

/** A cut's counts with the execution it describes counted too: what the next execution inherits. */
export function cutsThrough(cut: TurnCut) {
  return {
    work: cut.workCuts + (cut.phase === 'work' ? 1 : 0),
    provider: cut.providerCuts + (cut.phase === 'provider' ? 1 : 0),
    outOfMemory: cut.outOfMemoryCuts + (cut.outOfMemory ? 1 : 0),
  };
}

/** A claim row as one reads it: its program only once bound. */
export interface ClaimRow { turn_id: string; run_id: string; epoch: number; work_mode: WorkMode; phase: 'preparing' | 'admitted'; program_kind: ActorProgramIdentity['kind'] | null; program_version: number | null; program_digest: string | null; program_build: string | null; outcome: ClaimOutcome | null; claimed_at: number; withdrawn_through: number; answered: number }

/** A claim minted as its execution opens: its epoch, which is its capability, and the execution it supersedes. */
export interface PreparingClaim {
  readonly turnId: string;
  readonly runId: string;
  readonly epoch: number;
  /** The turn's claim before this one: a dead execution's, which recovery already decided on. */
  readonly previous: StoredActorClaim | null;
}

export interface RecoveredClaim {
  readonly turnId: string;
  readonly epoch: number;
  readonly outcome: ClaimOutcome;
}

/** Execution fencing and immutable prepared-request references. It never owns message bodies. */
export class ActorClaimStore {
  readonly actorId: string;
  private readonly listeners = new Set<() => void>();
  private readonly recoveredListeners = new Set<(claim: RecoveredClaim) => void>();
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle,
    private readonly transactionSync: <T>(write: () => T) => T, readonly history: SessionHistory) { this.actorId = actor.actorId; }

  observe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => { this.listeners.delete(listener); };
  }

  observeRecovered(listener: (claim: RecoveredClaim) => void): () => void {
    this.recoveredListeners.add(listener);

    return () => { this.recoveredListeners.delete(listener); };
  }

  /**
   * Claims the execution as it opens, before anything is prepared: its epoch is minted here, one past every epoch of the
   * agent's, and is the execution's capability. The cuts of the execution it supersedes carry into it.
   */
  reserve(input: { readonly runId: string; readonly turnId: string; readonly workMode: WorkMode; readonly installedBuild?: string | null }): PreparingClaim {
    return this.transactionSync(() => {
      this.actor.assertCurrent();
      const previous = this.read(input.turnId);

      // The agent's one sequence, which numbers its reports too: read and advanced in one statement, whatever its history.
      const epoch = new AgentSequence(this.sql, this.actorId).next();

      this.carryCuts(input.turnId, epoch, previous?.epoch ?? 0, input.installedBuild ?? null);
      void this.sql`INSERT INTO actor_turn_claims(actor_id,turn_id,run_id,epoch,work_mode,phase,outcome,claimed_at)
        VALUES(${this.actorId},${input.turnId},${input.runId},${epoch},${input.workMode},'preparing',NULL,${nowMs()})
        ON CONFLICT(actor_id,turn_id) DO UPDATE SET run_id=excluded.run_id,epoch=excluded.epoch,work_mode=excluded.work_mode,phase='preparing',
          program_kind=NULL,program_version=NULL,program_digest=NULL,program_build=NULL,outcome=NULL,claimed_at=excluded.claimed_at,
          answered=CASE WHEN run_id=excluded.run_id THEN answered ELSE 0 END,
          facts_json=CASE WHEN run_id=excluded.run_id THEN facts_json END,
          profile_json=CASE WHEN run_id=excluded.run_id THEN profile_json END,
          inputs_key=CASE WHEN run_id=excluded.run_id THEN inputs_key END`;
      this.changed();

      return { turnId: input.turnId, runId: input.runId, epoch, previous };
    });
  }

  /** Binds the `preparing` claim `epoch` to its program and context: from here it may consume its context. */
  async admit(input: { readonly runId: string; readonly turnId: string; readonly epoch: number; readonly workMode: WorkMode; readonly program: ActorProgramIdentity; readonly context: ContextSelection; readonly installedBuild?: string | null }): Promise<ActorTurnClaim> {
    this.actor.assertCurrent();
    const { epoch } = input;

    const admission = await this.history.requests.prepare({
      id: admissionRequestId(input.turnId, epoch), turnId: input.turnId, runId: input.runId, epoch, revision: 0, step: null,
      source: input.context,
      metadata: { program: { ...input.program }, workMode: input.workMode, ...(input.installedBuild !== undefined && { installedBuild: input.installedBuild }) },
    });

    const claim = this.transactionSync(() => {
      const now = this.guard(input.turnId, epoch);

      if (now.epoch !== epoch || !now.open || now.phase !== 'preparing') throw new KinuError('denied', 'claim changed during admission preparation');

      if (now.selected?.contextId !== input.context.contextId || now.selected.revision !== input.context.revision) {
        throw new KinuError('denied', 'working selection changed during admission preparation');
      }

      const admitted: ActorTurnClaim = Object.freeze({ actorId: this.actorId, runId: input.runId, turnId: input.turnId, epoch,
        workMode: input.workMode, program: Object.freeze({ ...input.program }), workingRevision: input.context.revision, workingContextId: input.context.contextId });

      void this.sql`UPDATE actor_turn_claims SET phase='admitted',work_mode=${input.workMode},program_kind=${input.program.kind},
        program_version=${input.program.version},program_digest=${input.program.digest},program_build=${input.program.build}
        WHERE actor_id=${this.actorId} AND turn_id=${input.turnId} AND epoch=${epoch}`;
      this.history.requests.record(admission);

      return admitted;
    });

    // Seal messages left open under a superseded epoch only after this admission holds the turn.
    await this.history.sealAbandoned();
    this.changed();

    return claim;
  }

  async consume(claim: ActorTurnClaim, input: { readonly index: number; readonly messages: readonly ModelMessage[]; readonly cache?: PromptCacheRoute | undefined }): Promise<ConsumedContext> {
    const { selected: source, revision: latest } = this.guard(claim.turnId, claim.epoch);

    if (source === null || source.contextId !== claim.workingContextId) throw new KinuError('denied', 'claimed working context is not selected');

    const prepared = await this.history.requests.prepareRendered({ id: crypto.randomUUID(), turnId: claim.turnId, runId: claim.runId,
      epoch: claim.epoch, revision: latest + 1, step: input.index, source, messages: input.messages,
      metadata: { program: { ...claim.program }, workMode: claim.workMode, ...(input.cache !== undefined && { cache: { ...input.cache } }) } });

    const consumed = this.transactionSync(() => {
      const now = this.guard(claim.turnId, claim.epoch);

      assertLiveIn(now, claim);

      if (now.revision !== latest) throw new KinuError('denied', 'another request consumed this claim during preparation');

      if (now.selected?.contextId !== source.contextId || now.selected.revision !== source.revision) {
        throw new KinuError('denied', 'working selection changed during request preparation');
      }

      this.history.requests.recordPrepared(prepared);
      this.markCut(claim, 'provider');

      return { requestId: prepared.request.id, revision: prepared.request.revision };
    });

    this.history.requests.remember(prepared);

    return consumed;
  }

  async consumedContext(turnId: string, stepIndex?: number): Promise<ContextRevision | null> {
    const claim = this.read(turnId);

    if (claim === null) return null;
    const requests = this.history.requests.forTurn(turnId).filter(item => item.epoch === claim.epoch);
    const request = stepIndex === undefined ? requests.at(-1) : requests.find(item => item.step === stepIndex);

    return request === undefined ? null : this.materialize(request.id);
  }

  async admittedContext(turnId: string): Promise<ContextRevision | null> {
    const claim = this.read(turnId);

    if (claim === null) return null;
    const request = this.history.requests.forTurn(turnId).find(item => item.epoch === claim.epoch && item.step === null);

    return request === undefined ? null : this.materialize(request.id);
  }

  /** The step's own work began: its answer is in and a tool runs. */
  working(claim: ActorTurnClaim): void {
    this.markCut(claim, 'work');
  }

  /** Its execution recorded the step that ended the turn, in that step's commit: a later execution of the same run only
   *  closes it ({@link StoredActorClaim.answered}). */
  answered(claim: Pick<ActorTurnClaim, 'turnId' | 'epoch'>): void {
    void this.sql`UPDATE actor_turn_claims SET answered=1 WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`;
  }

  /** A step finished: the turn moved, so no cut before it says anything about the next. */
  progressed(claim: ActorTurnClaim): void {
    void this.sql`UPDATE actor_turn_cuts SET phase='work',phase_at=${nowMs()},work_cuts=0,provider_cuts=0,oom=0,oom_cuts=0
      WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`;
  }

  /**
   * The platform reported the agent's isolate out of memory at `diedAt`: the execution it killed was the agent's newest,
   * if that one was open and admitted by then. One opened since is not the one that died, and a report about an earlier
   * one, late, names nothing: an undercount, never a death charged twice. Each death of one execution marks it once.
   */
  outOfMemory(diedAt: number): void {
    void this.sql`UPDATE actor_turn_cuts SET oom=1 WHERE actor_id=${this.actorId} AND (turn_id,epoch) IN (
      SELECT turn_id,epoch FROM (SELECT turn_id,epoch,outcome,claimed_at FROM actor_turn_claims WHERE actor_id=${this.actorId} ORDER BY epoch DESC LIMIT 1)
      WHERE outcome IS NULL AND claimed_at <= ${diedAt})`;
  }

  cutOf(turnId: string): TurnCut | null {
    const row = this.sql<{ epoch: number; build: string | null; phase: 'provider' | 'work'; phase_at: number; work_cuts: number; provider_cuts: number; oom: number; oom_cuts: number }>`
      SELECT epoch,build,phase,phase_at,work_cuts,provider_cuts,oom,oom_cuts FROM actor_turn_cuts WHERE actor_id=${this.actorId} AND turn_id=${turnId}`[0];

    return row === undefined ? null : {
      epoch: row.epoch, build: row.build, phase: row.phase, phaseAt: row.phase_at, workCuts: row.work_cuts, providerCuts: row.provider_cuts,
      outOfMemory: row.oom === 1, outOfMemoryCuts: row.oom_cuts,
    };
  }

  /** Inside the admission: the cuts of the execution `admitted` follows, as {@link TurnCut} charges them; a new build
   *  may have fixed what cut them, so they start over. */
  private carryCuts(turnId: string, epoch: number, previousEpoch: number, build: string | null): void {
    const cut = this.cutOf(turnId);
    const carried = cut === null || cut.epoch !== previousEpoch || cut.build !== build ? { work: 0, provider: 0, outOfMemory: 0 } : cutsThrough(cut);

    void this.sql`INSERT INTO actor_turn_cuts(actor_id,turn_id,epoch,build,phase,phase_at,work_cuts,provider_cuts,oom,oom_cuts)
      VALUES(${this.actorId},${turnId},${epoch},${build},'work',${nowMs()},${carried.work},${carried.provider},0,${carried.outOfMemory})
      ON CONFLICT(actor_id,turn_id) DO UPDATE SET epoch=excluded.epoch,build=excluded.build,phase=excluded.phase,
        phase_at=excluded.phase_at,work_cuts=excluded.work_cuts,provider_cuts=excluded.provider_cuts,oom=0,oom_cuts=excluded.oom_cuts`;
  }

  private markCut(claim: ActorTurnClaim, phase: TurnCut['phase']): void {
    void this.sql`UPDATE actor_turn_cuts SET phase=${phase},phase_at=${nowMs()}
      WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`;
  }

  settle(claim: Pick<ActorTurnClaim, 'turnId' | 'epoch'>, outcome: ClaimOutcome): void {
    this.settleIn(claim, outcome)();
  }

  /** The claim's verdict, written in the caller's commit; the returned call tells its observers, once that commit holds. */
  settleIn(claim: Pick<ActorTurnClaim, 'turnId' | 'epoch'>, outcome: ClaimOutcome): () => void {
    this.transactionSync(() => {
      this.actor.assertCurrent();

      // The live claim is the update's own condition; a refused one is read only to say why.
      const settled = this.sql<{ epoch: number }>`UPDATE actor_turn_claims SET outcome=${outcome}
        WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch} AND outcome IS NULL RETURNING epoch`;

      if (settled.length === 0) assertLiveIn(this.guard(claim.turnId, claim.epoch), claim);
    });

    return () => { this.changed(); };
  }

  /** Every claim of the run still open settles `outcome`, in the caller's commit: the rounds an execution that died opened,
   *  closed as the run ends. The returned call tells its observers, once that commit holds. */
  settleRunIn(runId: string, outcome: ClaimOutcome): () => void {
    this.actor.assertCurrent();
    void this.sql`UPDATE actor_turn_claims SET outcome=${outcome} WHERE actor_id=${this.actorId} AND run_id=${runId} AND outcome IS NULL`;

    return () => { this.changed(); };
  }

  /** A Retry of the turn's answer: what its executions through its answered one produced is no longer its output. */
  withdraw(turnId: string): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE actor_turn_claims SET withdrawn_through=epoch WHERE actor_id=${this.actorId} AND turn_id=${turnId} AND outcome='completed'`;
    this.changed();
  }

  settleRecovered(turnId: string, epoch: number, outcome: ClaimOutcome): void {
    this.actor.assertCurrent();
    const open = this.read(turnId);
    void this.sql`UPDATE actor_turn_claims SET outcome=${outcome} WHERE actor_id=${this.actorId} AND turn_id=${turnId} AND epoch=${epoch} AND outcome IS NULL`;
    this.changed();

    if (open?.epoch !== epoch || open.status !== 'admitted') return;

    this.notify(this.recoveredListeners, { turnId, epoch, outcome });
  }

  read(turnId: string): StoredActorClaim | null {
    this.actor.assertCurrent();
    const row = this.sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,phase,program_kind,program_version,program_digest,program_build,outcome,claimed_at,withdrawn_through,answered FROM actor_turn_claims WHERE actor_id=${this.actorId} AND turn_id=${turnId}`[0];

    return row === undefined ? null : this.claimOf(row);
  }

  turns(limit = 100): readonly StoredActorClaim[] {
    this.actor.assertCurrent();

    return this.sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,phase,program_kind,program_version,program_digest,program_build,outcome,claimed_at,withdrawn_through,answered FROM actor_turn_claims WHERE actor_id=${this.actorId} ORDER BY claimed_at DESC LIMIT ${limit}`.map(row => this.claimOf(row));
  }
  latestTurn(): StoredActorClaim | null { return this.turns(1)[0] ?? null; }
  unsettled(limit?: number): readonly StoredActorClaim[] {
    this.actor.assertCurrent();

    return unsettledClaimsOf(this.sql, this.actorId, limit ?? -1);
  }
  private async materialize(id: string): Promise<ContextRevision> {
    const { request, messages } = await this.history.requests.materialize(id);

    return { requestId: id, revision: request.revision, epoch: request.epoch, workingRevision: request.source.revision, workingContextId: request.source.contextId, stepIndex: request.step, messages };
  }
  private changed(): void {
    this.notify(this.listeners, undefined);
  }
  private notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); } catch (cause) {
        diagnostics.failure('actor.claim_listener_failed',
          toKinuError({ doing: 'notify a turn-claim listener', cause, otherwise: 'io' }), { actorId: this.actorId });
      }
    }
  }
  private claimOf(row: ClaimRow): StoredActorClaim {
    return claimOfRow(this.actorId, row);
  }
  /**
   * What a write's guard compares with what it prepared, in one statement: the turn's claim, its epoch's newest request
   * revision, and the selected working context as {@link SessionContext.selected} reads it.
   */
  private guard(turnId: string, epoch: number): ClaimGuard {
    this.actor.assertCurrent();

    const row = this.sql<{ epoch: number | null; open: number | null; phase: 'preparing' | 'admitted' | null; revision: number | null; context_id: string | null; selected: number | null }>`
      SELECT c.epoch, c.outcome IS NULL AS open, c.phase,
        (SELECT MAX(revision) FROM actor_requests WHERE actor_id=${this.actorId} AND turn_id=${turnId} AND epoch=${epoch}) AS revision,
        s.context_id, (SELECT MAX(r.revision) FROM context_revisions r WHERE r.actor_id=s.actor_id AND r.context_id=s.context_id) AS selected
      FROM (SELECT 1)
        LEFT JOIN actor_turn_claims c ON c.actor_id=${this.actorId} AND c.turn_id=${turnId}
        LEFT JOIN actor_context_selection s ON s.actor_id=${this.actorId}`[0];

    return {
      epoch: row?.epoch ?? null,
      open: row?.open === 1,
      phase: row?.phase ?? null,
      revision: row?.revision ?? 0,
      selected: row?.context_id === null || row?.context_id === undefined || row.selected === null ? null : { contextId: row.context_id, revision: row.selected },
    };
  }
}

interface ClaimGuard {
  /** Null when the turn holds no claim. */
  readonly epoch: number | null;
  readonly open: boolean;
  readonly phase: 'preparing' | 'admitted' | null;
  readonly revision: number;
  readonly selected: ContextSelection | null;
}

/** The actor's claims still open, newest first; read without a handle too, as a cold root reads them before it hosts
 *  anybody. */
export function unsettledClaimsOf(sql: SqlExecutor, actorId: string, limit: number): readonly StoredActorClaim[] {
  return sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,phase,program_kind,program_version,program_digest,program_build,outcome,claimed_at,withdrawn_through,answered
    FROM actor_turn_claims WHERE actor_id=${actorId} AND outcome IS NULL ORDER BY claimed_at DESC LIMIT ${limit}`.map((row) => claimOfRow(actorId, row));
}

/** Which try of its turn the claim's execution is: one past the executions cut before it since the turn last finished a
 *  step ({@link TurnCut}). Its epoch is the agent's sequence, which numbers every opening and report, so it says nothing
 *  of the turn's own tries. */
export function turnAttemptOf(sql: SqlExecutor, claim: Pick<StoredActorClaim, 'actorId' | 'turnId' | 'epoch'>): number {
  const cut = sql<{ cuts: number }>`SELECT work_cuts + provider_cuts AS cuts FROM actor_turn_cuts
    WHERE actor_id=${claim.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`[0];

  return 1 + (cut?.cuts ?? 0);
}

function claimOfRow(actorId: string, row: ClaimRow): StoredActorClaim {
  const program = row.program_kind === null || row.program_version === null ? null
    : Object.freeze({ kind: row.program_kind, version: row.program_version, digest: row.program_digest, build: row.program_build });

  let status: StoredActorClaim['status'] = 'settled';

  if (row.outcome === null) status = row.phase;

  return Object.freeze({ actorId, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, workMode: row.work_mode, program, status, outcome: row.outcome, claimedAt: row.claimed_at, withdrawnThrough: row.withdrawn_through, answered: row.answered === 1 });
}

/** The session's one fence on a turn's claim ({@link ClaimFences}), read here, where the claim table is declared. */
export function claimFences(sql: SqlExecutor, actor: ActorHandle): ClaimFences {
  const claimOf = (turnId: string) => {
    actor.assertCurrent();

    return sql<{ epoch: number; open: number; run_id: string }>`SELECT epoch, outcome IS NULL AS open, run_id FROM actor_turn_claims
      WHERE actor_id=${actor.actorId} AND turn_id=${turnId}`[0];
  };

  return {
    live: (turnId, epoch) => {
      const claim = claimOf(turnId);

      return claim?.epoch === epoch && claim.open === 1;
    },
    assertLive: (turnId, epoch) => {
      const claim = claimOf(turnId);

      assertLiveIn({ epoch: claim?.epoch ?? null, open: claim?.open === 1 }, { epoch });
    },
    // Settled or not: only the epoch is asked.
    assertOwned: (turnId, epoch) => {
      assertLiveIn({ epoch: claimOf(turnId)?.epoch ?? null, open: true }, { epoch });
    },
    openClaims: () => {
      actor.assertCurrent();

      return new Map(sql<{ turn_id: string; epoch: number }>`SELECT turn_id, epoch FROM actor_turn_claims
        WHERE actor_id=${actor.actorId} AND outcome IS NULL`.map((claim) => [claim.turn_id, claim.epoch]));
    },
    openRun: (turnId) => {
      const claim = claimOf(turnId);

      return claim?.open === 1 ? claim.run_id : null;
    },
  };
}

function assertLiveIn(guard: Pick<ClaimGuard, 'epoch' | 'open'>, claim: Pick<ActorTurnClaim, 'epoch'>): void {
  if (guard.epoch !== claim.epoch) throw new KinuError('denied', 'actor turn is owned by another execution epoch');

  if (!guard.open) throw new KinuError('denied', 'actor turn is settled and takes no further work');
}

export type ClaimRecovery =
  | { readonly kind: 'verified' | 'build_unknown'; readonly claim: StoredActorClaim }
  | { readonly kind: 'source_changed'; readonly claim: StoredActorClaim; readonly found: string | null };

export async function verifyClaimedProgram(claim: StoredActorClaim, readVersionedSource: (version: number) => Promise<string | null>, digestOf: (source: string) => string,
  context: ContextRevision | null): Promise<ClaimRecovery> {
  const { program } = claim;

  // A claim never bound to its program (still `preparing`) admitted no request either.
  if (context === null || program === null) throw new KinuError('missing', 'claimed request evidence is missing');

  if (program.kind === 'builtin') return { kind: program.build === null ? 'build_unknown' : 'verified', claim };
  const source = await readVersionedSource(program.version);
  const found = source === null ? null : digestOf(source);

  return found === null || found !== program.digest ? { kind: 'source_changed', claim, found } : { kind: 'verified', claim };
}
