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
import { sqlCheckList } from '../identity/schema';
import type { ActorTurnProgram } from './actor-program';
import type { SessionHistory } from '../session/history';
import type { ContextSelection } from '../session/context';
import type { PromptCacheRoute } from '../prompting/cache-breakpoints';

export const CLAIM_OUTCOMES = [...RUN_END_REASONS, 'indeterminate'] as const;

const CLAIM_STATUSES = ['admitted', 'settled'] as const;

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
  readonly workMode: WorkMode; readonly program: ActorProgramIdentity;
  readonly status: (typeof CLAIM_STATUSES)[number]; readonly outcome: ClaimOutcome | null; readonly claimedAt: number;
}

export interface ContextRevision {
  readonly requestId: string; readonly revision: number; readonly epoch: number;
  readonly workingRevision: number; readonly workingContextId: string; readonly stepIndex: number | null;
  readonly messages: readonly ModelMessage[];
}

export interface ConsumedContext { readonly requestId: string; readonly revision: number }

export function initActorClaimTables(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS actor_turn_claims (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), turn_id TEXT NOT NULL, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    work_mode TEXT NOT NULL CHECK(work_mode IN ('plan','build')),
    program_kind TEXT NOT NULL CHECK(program_kind IN (${sqlCheckList(PROGRAM_KINDS)})),
    program_version INTEGER NOT NULL, program_digest TEXT, program_build TEXT,
    outcome TEXT CHECK(outcome IS NULL OR outcome IN (${sqlCheckList(CLAIM_OUTCOMES)})),
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,turn_id))`);
  exec(`CREATE INDEX IF NOT EXISTS idx_actor_claims_outcome ON actor_turn_claims(actor_id,outcome,claimed_at DESC)`);
  initSessionContextTables(exec);
  initSessionTranscriptTables(exec);
}

export function programIdentityOf(program: ActorTurnProgram, installedBuild: string | null): ActorProgramIdentity {
  return Object.freeze(program.kind === 'scaffold'
    ? { kind: 'scaffold' as const, version: program.version, digest: program.digest, build: null }
    : { kind: 'builtin' as const, version: 0, digest: null, build: installedBuild });
}

interface ClaimRow { turn_id: string; run_id: string; epoch: number; work_mode: WorkMode; program_kind: ActorProgramIdentity['kind']; program_version: number; program_digest: string | null; program_build: string | null; outcome: ClaimOutcome | null; claimed_at: number }

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

  async admit(input: { readonly runId: string; readonly turnId: string; readonly workMode: WorkMode; readonly program: ActorProgramIdentity; readonly context: ContextSelection; readonly installedBuild?: string | null }): Promise<ActorTurnClaim> {
    this.actor.assertCurrent();
    const previous = this.read(input.turnId);
    const epoch = (previous?.epoch ?? 0) + 1;

    const admission = await this.history.requests.prepare({
      id: `${input.turnId}:${epoch}:admission`, turnId: input.turnId, runId: input.runId, epoch, revision: 0, step: null,
      source: input.context,
      metadata: { program: { ...input.program }, workMode: input.workMode, ...(input.installedBuild !== undefined && { installedBuild: input.installedBuild }) },
    });

    const claim = this.transactionSync(() => {
      this.actor.assertCurrent();
      const now = this.read(input.turnId);

      if ((now?.epoch ?? 0) !== (previous?.epoch ?? 0)) throw new KinuError('denied', 'claim changed during admission preparation');
      const selected = this.history.context.selected();

      if (selected?.contextId !== input.context.contextId || selected.revision !== input.context.revision) throw new KinuError('denied', 'working selection changed during admission preparation');

      const admitted: ActorTurnClaim = Object.freeze({ actorId: this.actorId, runId: input.runId, turnId: input.turnId, epoch,
        workMode: input.workMode, program: Object.freeze({ ...input.program }), workingRevision: input.context.revision, workingContextId: input.context.contextId });

      void this.sql`INSERT INTO actor_turn_claims(actor_id,turn_id,run_id,epoch,work_mode,program_kind,program_version,program_digest,program_build,outcome,claimed_at)
        VALUES(${this.actorId},${input.turnId},${input.runId},${epoch},${input.workMode},${input.program.kind},${input.program.version},${input.program.digest},${input.program.build},NULL,${nowMs()})
        ON CONFLICT(actor_id,turn_id) DO UPDATE SET run_id=excluded.run_id,epoch=excluded.epoch,work_mode=excluded.work_mode,program_kind=excluded.program_kind,
          program_version=excluded.program_version,program_digest=excluded.program_digest,program_build=excluded.program_build,outcome=NULL,claimed_at=excluded.claimed_at`;
      this.history.requests.record(admission);

      return admitted;
    });

    // Seal messages left open under a superseded epoch only after this admission holds the turn.
    await this.history.sealAbandoned();
    this.changed();

    return claim;
  }

  async consume(claim: ActorTurnClaim, input: { readonly index: number; readonly messages: readonly ModelMessage[]; readonly cache?: PromptCacheRoute | undefined }): Promise<ConsumedContext> {
    const source = this.history.context.selected();

    if (source === null || source.contextId !== claim.workingContextId) throw new KinuError('denied', 'claimed working context is not selected');
    const latest = this.sql<{ revision: number | null }>`SELECT MAX(revision) AS revision FROM actor_requests WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`[0]?.revision ?? 0;

    const prepared = await this.history.requests.prepareRendered({ id: crypto.randomUUID(), turnId: claim.turnId, runId: claim.runId,
      epoch: claim.epoch, revision: latest + 1, step: input.index, source, messages: input.messages,
      metadata: { program: { ...claim.program }, workMode: claim.workMode, ...(input.cache !== undefined && { cache: { ...input.cache } }) } });

    const consumed = this.transactionSync(() => {
      this.assertLive(claim);
      const currentRevision = this.sql<{ revision: number | null }>`SELECT MAX(revision) AS revision FROM actor_requests WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`[0]?.revision ?? 0;

      if (currentRevision !== latest) throw new KinuError('denied', 'another request consumed this claim during preparation');
      const selected = this.history.context.selected();

      if (selected?.contextId !== source.contextId || selected.revision !== source.revision) throw new KinuError('denied', 'working selection changed during request preparation');
      this.history.requests.recordPrepared(prepared);

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

  settle(claim: ActorTurnClaim, outcome: ClaimOutcome): void {
    this.transactionSync(() => { this.assertLive(claim); void this.sql`UPDATE actor_turn_claims SET outcome=${outcome} WHERE actor_id=${this.actorId} AND turn_id=${claim.turnId} AND epoch=${claim.epoch}`; });
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
    const row = this.sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,program_kind,program_version,program_digest,program_build,outcome,claimed_at FROM actor_turn_claims WHERE actor_id=${this.actorId} AND turn_id=${turnId}`[0];

    return row === undefined ? null : this.claimOf(row);
  }

  turns(limit = 100): readonly StoredActorClaim[] {
    this.actor.assertCurrent();

    return this.sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,program_kind,program_version,program_digest,program_build,outcome,claimed_at FROM actor_turn_claims WHERE actor_id=${this.actorId} ORDER BY claimed_at DESC LIMIT ${limit}`.map(row => this.claimOf(row));
  }
  latestTurn(): StoredActorClaim | null { return this.turns(1)[0] ?? null; }
  unsettled(limit?: number): readonly StoredActorClaim[] {
    this.actor.assertCurrent();

    return this.sql<ClaimRow>`SELECT turn_id,run_id,epoch,work_mode,program_kind,program_version,program_digest,program_build,outcome,claimed_at FROM actor_turn_claims WHERE actor_id=${this.actorId} AND outcome IS NULL ORDER BY claimed_at DESC LIMIT ${limit ?? -1}`.map(row => this.claimOf(row));
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
    return Object.freeze({ actorId: this.actorId, turnId: row.turn_id, runId: row.run_id, epoch: row.epoch, workMode: row.work_mode,
      program: Object.freeze({ kind: row.program_kind, version: row.program_version, digest: row.program_digest, build: row.program_build }),
      status: row.outcome === null ? 'admitted' : 'settled', outcome: row.outcome, claimedAt: row.claimed_at });
  }
  private assertLive(claim: ActorTurnClaim): void {
    const current = this.read(claim.turnId);

    if (current === null || current.epoch !== claim.epoch) throw new KinuError('denied', 'actor turn is owned by another execution epoch');

    if (current.status !== 'admitted') throw new KinuError('denied', 'actor turn is settled and takes no further work');
  }
}

export type ClaimRecovery =
  | { readonly kind: 'verified' | 'build_unknown'; readonly claim: StoredActorClaim }
  | { readonly kind: 'source_changed'; readonly claim: StoredActorClaim; readonly found: string | null };

export async function verifyClaimedProgram(claim: StoredActorClaim, readVersionedSource: (version: number) => Promise<string | null>, digestOf: (source: string) => string,
  context: ContextRevision | null): Promise<ClaimRecovery> {
  if (context === null) throw new KinuError('missing', 'claimed request evidence is missing');

  if (claim.program.kind === 'builtin') return { kind: claim.program.build === null ? 'build_unknown' : 'verified', claim };
  const source = await readVersionedSource(claim.program.version);
  const found = source === null ? null : digestOf(source);

  return found === null || found !== claim.program.digest ? { kind: 'source_changed', claim, found } : { kind: 'verified', claim };
}
