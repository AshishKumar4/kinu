import { markStoreChanged } from '@kinu.run/agent-utils';
/**
 * Evolved prompt sections: propose, trial, promote, as scaffolds are.
 * `buildSystemPromptSync` reads {@link activePromptSectionOverrides} once per
 * activation, so the live prompt moves only on a promotion.
 *
 * `proposePromptSection` gates, in order: rationale minimum; slot-contract
 * identity with the incumbent; misevolution checklist; size rule plus ceiling;
 * one pending per section. Promotion uses the scaffold's `decidePromotion` rule;
 * every promotion lands in the Evolution Changelog.
 */

import { Result } from 'effect';
import * as v from 'valibot';
import { renderThrownChain } from '../obs/error';
import { DEFAULT_CONFIG } from '../config';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { nowMs } from '../utils/date';
import type { ScoreInterval } from '../utils/stats';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { decidePromotion, DEFAULT_SHADOW_CONFIG, type PromotionDecision, type ScaffoldStatus } from '../scaffold/shadow';
import { templateContract, type PromptSection } from './template';
import { PROMPT_SECTIONS, type PromptSectionOverrides } from './section-templates';

/** About twice the largest shipped section, so a runaway is refused before scoring. */
export const PROMPT_SECTION_MAX_BYTES = 4800;

/** Same bar as a scaffold proposal: the operator reads one changelog. */
const MIN_RATIONALE_LENGTH = DEFAULT_CONFIG.scaffold.minRationaleLength;

const PromptSectionStatusSchema = v.picklist(['current', 'pending', 'rolled_back', 'historical']);

const TrialWinnerSchema = v.picklist(['current', 'pending', 'tie']);

export interface PromptSectionVersion {
  readonly sectionId: string;
  readonly version: number;
  readonly source: string;
  readonly rationale: string;
  readonly status: ScaffoldStatus;
  /** The size rule's comparand, kept so the changelog can show the accepted trade. */
  readonly incumbentBytes: number;
  readonly writtenAt: number;
  readonly decidedAt: number | null;
  /** Shadow trials run while this version was the pending candidate, scored against the incumbent. */
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
}

export interface PendingPromptSection {
  readonly sectionId: string;
  readonly version: number;
  readonly source: string;
  readonly rationale: string;
  readonly writtenAt: number;
  readonly trialsSoFar: number;
  readonly pendingWins: number;
  readonly currentWins: number;
  readonly ties: number;
}

export function initPromptSectionTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS prompt_section_versions (
    actor_id        TEXT NOT NULL,
    section_id      TEXT NOT NULL,
    version         INTEGER NOT NULL,
    source          TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('current','pending','rolled_back','historical')),
    incumbent_bytes INTEGER NOT NULL,
    written_at      INTEGER NOT NULL,
    wins            INTEGER NOT NULL DEFAULT 0,
    losses          INTEGER NOT NULL DEFAULT 0,
    ties            INTEGER NOT NULL DEFAULT 0,
    decided_at      INTEGER,
    PRIMARY KEY (actor_id, section_id, version)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_prompt_section_status
           ON prompt_section_versions(actor_id, status, section_id)`);
}

/** The promoted source per section, passed as `sectionOverrides`. Read once per
 * activation: the cacheable prefix may move on a promotion. */
export function activePromptSectionOverrides(
  sql: SqlExecutor, actor: ActorHandle,
): PromptSectionOverrides {
  actor.assertCurrent();

  const rows = sql<{ section_id: string; source: string }>`
    SELECT section_id, source FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND status = 'current'`;

  const overrides: Record<string, string> = {};

  for (const row of rows) overrides[row.section_id] = row.source;

  return overrides;
}

/** The promoted source if any, else the bundled template. */
export function incumbentSectionSource(
  sql: SqlExecutor, actor: ActorHandle, section: PromptSection<string>,
): string {
  actor.assertCurrent();

  const rows = sql<{ source: string }>`
    SELECT source FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${section.id}
      AND status = 'current' LIMIT 1`;

  return rows[0]?.source ?? section.source;
}

/** First section with a candidate under trial; the cadence finishes one before proposing another. */
export function firstPendingPromptSection(sql: SqlExecutor, actor: ActorHandle): string | null {
  actor.assertCurrent();

  const rows = sql<{ section_id: string }>`
    SELECT section_id FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND status = 'pending'
    ORDER BY written_at ASC LIMIT 1`;

  return rows[0]?.section_id ?? null;
}

interface PromptSizeRuleInput {
  readonly incumbentBytes: number;
  readonly candidateBytes: number;
  readonly incumbentScore: ScoreInterval;
  readonly candidateScore: ScoreInterval;
}


/**
 * A candidate longer than the incumbent needs a strictly better score: its
 * interval must clear the incumbent's mean. At or below the incumbent's size,
 * GEPA's strictly-better aggregate suffices. Bytes are paid every turn, so the
 * ambiguous case falls closed. Gate 4 only; tested through the gate.
 */
function checkPromptSizeRule(input: PromptSizeRuleInput): Result.Result<void, string> {
  if (input.candidateBytes <= input.incumbentBytes) return Result.void;

  if (input.candidateScore.lo > input.incumbentScore.mean) return Result.void;
  const grown = input.candidateBytes - input.incumbentBytes;

  return Result.fail(`+${String(grown)} bytes (${String(input.incumbentBytes)} to ${String(input.candidateBytes)}) `
    + `for a score of ${input.candidateScore.mean.toFixed(3)} whose interval `
    + `(lo ${input.candidateScore.lo.toFixed(3)}) does not clear the incumbent's `
    + `${input.incumbentScore.mean.toFixed(3)}: a longer section needs a strictly better score`);
}

/** Named so callers can branch: the GEPA bridge reports a size-rule refusal differently from a veto. */
export type ProposeSectionRefusal =
  | 'not_registered'
  | 'rationale_too_short'
  | 'unchanged'
  | 'malformed_template'
  | 'slot_contract'
  | 'misevolution'
  | 'byte_ceiling'
  | 'size_rule'
  | 'already_pending';

export interface ProposeSectionRefused { readonly code: ProposeSectionRefusal; readonly error: string }

export type ProposeSectionResult = Result.Result<number, ProposeSectionRefused>;

const refused = (code: ProposeSectionRefusal, error: string): ProposeSectionResult => Result.fail({ code, error });

export interface ProposePromptSectionArgs {
  readonly section: PromptSection<string>;
  readonly source: string;
  readonly rationale: string;
  readonly incumbentScore: ScoreInterval;
  readonly candidateScore: ScoreInterval;
}

export function proposePromptSection(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: ProposePromptSectionArgs,
): ProposeSectionResult {
  actor.assertCurrent();
  const { section, source, rationale } = args;

  if (!PROMPT_SECTIONS.some((known) => known.id === section.id)) {
    return refused('not_registered', `"${section.id}" is not a registered prompt section`);
  }

  if (rationale.length < MIN_RATIONALE_LENGTH) {
    return refused('rationale_too_short', `Rationale must be at least ${String(MIN_RATIONALE_LENGTH)} chars`);
  }

  const incumbent = incumbentSectionSource(sql, actor, section);

  if (source === incumbent) {
    return refused('unchanged', 'candidate is the incumbent, byte for byte');
  }

  // Gate 2: the slot contract. Also the only place a malformed template is caught before rendering.
  const wanted = templateContract(section.id, incumbent);
  const contract = Result.try({ try: () => templateContract(section.id, source), catch: (cause) => renderThrownChain({ cause }) });

  if (Result.isFailure(contract)) return refused('malformed_template', contract.failure);
  const offered = contract.success;

  if (wanted.slots.join('|') !== offered.slots.join('|')
    || wanted.flags.join('|') !== offered.flags.join('|')) {
    return refused('slot_contract', `slot contract changed: the builder supplies {slots: ${wanted.slots.join(', ') || '(none)'}; `
      + `flags: ${wanted.flags.join(', ') || '(none)'}}, the candidate declares `
      + `{slots: ${offered.slots.join(', ') || '(none)'}; flags: ${offered.flags.join(', ') || '(none)'}}`);
  }

  // Gate 3: misevolution.
  const misevolution = checkMisevolutionForSurface({ prose: source }, 'scaffold');

  if (Result.isFailure(misevolution)) {
    recordMisevolutionVeto(sql, actor, {
      surface: 'scaffold', violation: misevolution.failure, detail: `prompt section ${section.id}: ${rationale}`,
    });

    return refused('misevolution', `Misevolution veto (${misevolution.failure.criterionId}): ${misevolution.failure.reason}`);
  }

  // Gate 4: size.
  const candidateBytes = Buffer.byteLength(source, 'utf8');
  const incumbentBytes = Buffer.byteLength(incumbent, 'utf8');

  if (candidateBytes > PROMPT_SECTION_MAX_BYTES) {
    return refused('byte_ceiling', `${String(candidateBytes)} bytes exceeds the ${String(PROMPT_SECTION_MAX_BYTES)}-byte section ceiling`);
  }

  const size = checkPromptSizeRule({
    incumbentBytes, candidateBytes,
    incumbentScore: args.incumbentScore, candidateScore: args.candidateScore,
  });

  if (Result.isFailure(size)) return refused('size_rule', size.failure);

  // Gate 5: one pending per section.
  const pending = sql<{ version: number }>`
    SELECT version FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${section.id} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  if (pending.length > 0) {
    return refused('already_pending', `a rollout for ${section.id} (v${String(pending[0].version)}) is already pending; resolve it before proposing another`);
  }

  const maxRows = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) AS v FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${section.id}`;

  const version = (maxRows[0]?.v ?? 0) + 1;
  void sql`
    INSERT INTO prompt_section_versions
      (actor_id, section_id, version, source, rationale, status, incumbent_bytes, written_at)
    VALUES (${actor.actorId}, ${section.id}, ${version}, ${source}, ${rationale}, 'pending',
            ${incumbentBytes}, ${nowMs()})`;
  markStoreChanged(sql);

  return Result.succeed(version);
}

export function getPendingPromptSection(
  sql: SqlExecutor,
  actor: ActorHandle,
  sectionId: string,
): PendingPromptSection | null {
  actor.assertCurrent();

  const rows = sql<{
    version: number; source: string; rationale: string; written_at: number;
    wins: number; losses: number; ties: number;
  }>`
    SELECT version, source, rationale, written_at, wins, losses, ties FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  const row = rows[0];

  if (!row) return null;

  return {
    sectionId, version: row.version, source: row.source, rationale: row.rationale,
    writtenAt: row.written_at, trialsSoFar: row.wins + row.losses + row.ties,
    pendingWins: row.wins, currentWins: row.losses, ties: row.ties,
  };
}

/** Record one executed comparison. A tie is recorded as a tie: `decidePromotion` counts only decisive trials. */
export function recordPromptSectionTrial(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    sectionId: string;
    pendingVersion: number;
    winner: 'current' | 'pending' | 'tie';
  },
): void {
  actor.assertCurrent();
  const winner = v.parse(TrialWinnerSchema, args.winner);
  void sql`
    UPDATE prompt_section_versions SET
      wins = wins + ${winner === 'pending' ? 1 : 0},
      losses = losses + ${winner === 'current' ? 1 : 0},
      ties = ties + ${winner === 'tie' ? 1 : 0}
    WHERE actor_id = ${actor.actorId} AND section_id = ${args.sectionId} AND version = ${args.pendingVersion}`;
  markStoreChanged(sql);
}

/** The scaffold's calibrated rule, unchanged: one policy for one question. */
export function decidePromptSectionPromotion(pending: PendingPromptSection): PromotionDecision {
  return decidePromotion(pending, DEFAULT_SHADOW_CONFIG);
}

/** `action` is the applied action: a promotion whose source went bad comes back as a rollback. */
export interface AppliedSectionDecision {
  readonly action: 'promote' | 'rollback';
  readonly vetoReason?: string;
}

/**
 * Promote flips pending to `current` and retires the old one; rollback marks it
 * `rolled_back`. Re-checks misevolution first: the row is durable state between
 * acceptance and promotion.
 */
export function applyPromptSectionDecision(
  sql: SqlExecutor,
  actor: ActorHandle,
  pending: PendingPromptSection,
  decision: 'promote' | 'rollback',
): AppliedSectionDecision {
  actor.assertCurrent();

  if (decision === 'promote') {
    const misevolution = checkMisevolutionForSurface({ prose: pending.source }, 'scaffold');

    if (Result.isFailure(misevolution)) {
      recordMisevolutionVeto(sql, actor, {
        surface: 'scaffold', violation: misevolution.failure,
        detail: `promotion of ${pending.sectionId} v${String(pending.version)} vetoed; rolled back instead`,
      });
      const rolled = applyPromptSectionDecision(sql, actor, pending, 'rollback');

      return { ...rolled, vetoReason: `Misevolution veto (${misevolution.failure.criterionId}): ${misevolution.failure.reason}` };
    }

    void sql`UPDATE prompt_section_versions SET status = 'historical'
      WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId} AND status = 'current'`;
    markStoreChanged(sql);
    void sql`UPDATE prompt_section_versions SET status = 'current', decided_at = ${nowMs()}
      WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId}
        AND version = ${pending.version}`;

    return { action: 'promote' };
  }

  void sql`UPDATE prompt_section_versions SET status = 'rolled_back', decided_at = ${nowMs()}
    WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId}
      AND version = ${pending.version}`;
  markStoreChanged(sql);

  return { action: 'rollback' };
}

/** Newest first; what the Evolution Changelog reads. */
export function listPromptSectionVersions(
  sql: SqlExecutor, actor: ActorHandle, limit = 50,
): PromptSectionVersion[] {
  actor.assertCurrent();

  const rows = sql<{
    section_id: string; version: number; source: string; rationale: string;
    status: string; incumbent_bytes: number; written_at: number; decided_at: number | null;
    wins: number; losses: number; ties: number;
  }>`
    SELECT section_id, version, source, rationale, status, incumbent_bytes, written_at, decided_at, wins, losses, ties
    FROM prompt_section_versions WHERE actor_id = ${actor.actorId}
    ORDER BY COALESCE(decided_at, written_at) DESC LIMIT ${limit}`;

  return rows.map((row) => ({
    sectionId: row.section_id,
    version: row.version,
    source: row.source,
    rationale: row.rationale,
    status: v.parse(PromptSectionStatusSchema, row.status),
    incumbentBytes: row.incumbent_bytes,
    writtenAt: row.written_at,
    decidedAt: row.decided_at,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
  }));
}
