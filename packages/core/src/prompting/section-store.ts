/**
 * Evolved prompt sections: propose, trial, promote, as scaffolds are.
 * `buildSystemPromptSync` reads {@link activePromptSectionOverrides} once per
 * activation, so the live prompt moves only on a promotion.
 *
 * `proposePromptSection` gates, in order: rationale minimum; slot-contract
 * identity with the incumbent; misevolution checklist; size rule plus ceiling;
 * one pending per section. Promotion uses the scaffold's `decidePromotion` rule
 * and is not auto-wired; every promotion lands in the Evolution Changelog.
 */

import * as v from 'valibot';
import { renderThrownChain } from '../obs/error';
import { DEFAULT_CONFIG } from '../config';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import type { ScoreInterval } from '../utils/stats';
import { checkMisevolution, recordMisevolutionVeto } from '../scaffold/misevolution';
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
    PRIMARY KEY (actor_id, section_id, version)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_prompt_section_status
           ON prompt_section_versions(actor_id, status, section_id)`);
  execRaw(`CREATE TABLE IF NOT EXISTS prompt_section_evaluations (
    actor_id        TEXT NOT NULL,
    id              TEXT NOT NULL,
    section_id      TEXT NOT NULL,
    pending_version INTEGER NOT NULL,
    instance_id     TEXT NOT NULL,
    current_score   REAL NOT NULL,
    pending_score   REAL NOT NULL,
    winner          TEXT NOT NULL CHECK (winner IN ('current','pending','tie')),
    feedback        TEXT NOT NULL,
    evaluated_at    INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_prompt_section_eval_pending
           ON prompt_section_evaluations(actor_id, section_id, pending_version)`);
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

type PromptSizeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A candidate longer than the incumbent needs a strictly better score: its
 * interval must clear the incumbent's mean. At or below the incumbent's size,
 * GEPA's strictly-better aggregate suffices. Bytes are paid every turn, so the
 * ambiguous case falls closed. Gate 4 only; tested through the gate.
 */
function checkPromptSizeRule(input: PromptSizeRuleInput): PromptSizeVerdict {
  if (input.candidateBytes <= input.incumbentBytes) return { ok: true };

  if (input.candidateScore.lo > input.incumbentScore.mean) return { ok: true };
  const grown = input.candidateBytes - input.incumbentBytes;

  return {
    ok: false,
    reason: `+${String(grown)} bytes (${String(input.incumbentBytes)} → ${String(input.candidateBytes)}) `
      + `for a score of ${input.candidateScore.mean.toFixed(3)} whose interval `
      + `(lo ${input.candidateScore.lo.toFixed(3)}) does not clear the incumbent's `
      + `${input.incumbentScore.mean.toFixed(3)} — a longer section needs a strictly better score`,
  };
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

export type ProposeSectionResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly code: ProposeSectionRefusal; readonly error: string };

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
    return { ok: false, code: 'not_registered', error: `"${section.id}" is not a registered prompt section` };
  }

  if (rationale.length < MIN_RATIONALE_LENGTH) {
    return { ok: false, code: 'rationale_too_short', error: `Rationale must be ≥${String(MIN_RATIONALE_LENGTH)} chars` };
  }

  const incumbent = incumbentSectionSource(sql, actor, section);

  if (source === incumbent) {
    return { ok: false, code: 'unchanged', error: 'candidate is the incumbent, byte for byte' };
  }

  // Gate 2: the slot contract. Also the only place a malformed template is caught before rendering.
  const wanted = templateContract(section.id, incumbent);
  let offered;

  try {
    offered = templateContract(section.id, source);
  } catch (err) {
    return {
      ok: false, code: 'malformed_template',
      error: renderThrownChain({ cause: err }),
    };
  }

  if (wanted.slots.join('|') !== offered.slots.join('|')
    || wanted.flags.join('|') !== offered.flags.join('|')) {
    return {
      ok: false, code: 'slot_contract',
      error: `slot contract changed — the builder supplies {slots: ${wanted.slots.join(', ') || '(none)'}; `
        + `flags: ${wanted.flags.join(', ') || '(none)'}}, the candidate declares `
        + `{slots: ${offered.slots.join(', ') || '(none)'}; flags: ${offered.flags.join(', ') || '(none)'}}`,
    };
  }

  // Gate 3: misevolution.
  const misevolution = checkMisevolution(source);

  if (!misevolution.ok) {
    recordMisevolutionVeto(sql, actor, {
      surface: 'scaffold', violation: misevolution, detail: `prompt section ${section.id}: ${rationale}`,
    });

    return {
      ok: false, code: 'misevolution',
      error: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}`,
    };
  }

  // Gate 4: size.
  const candidateBytes = Buffer.byteLength(source, 'utf8');
  const incumbentBytes = Buffer.byteLength(incumbent, 'utf8');

  if (candidateBytes > PROMPT_SECTION_MAX_BYTES) {
    return {
      ok: false, code: 'byte_ceiling',
      error: `${String(candidateBytes)} bytes exceeds the ${String(PROMPT_SECTION_MAX_BYTES)}-byte section ceiling`,
    };
  }

  const size = checkPromptSizeRule({
    incumbentBytes, candidateBytes,
    incumbentScore: args.incumbentScore, candidateScore: args.candidateScore,
  });

  if (!size.ok) return { ok: false, code: 'size_rule', error: size.reason };

  // Gate 5: one pending per section.
  const pending = sql<{ version: number }>`
    SELECT version FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${section.id} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  if (pending.length > 0) {
    return {
      ok: false, code: 'already_pending',
      error: `a rollout for ${section.id} (v${String(pending[0].version)}) is already pending; resolve it before proposing another`,
    };
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

  return { ok: true, version };
}

export function getPendingPromptSection(
  sql: SqlExecutor,
  actor: ActorHandle,
  sectionId: string,
): PendingPromptSection | null {
  actor.assertCurrent();

  const rows = sql<{ version: number; source: string; rationale: string; written_at: number }>`
    SELECT version, source, rationale, written_at FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  const row = rows[0];

  if (!row) return null;

  const counts = sql<{ winner: string; n: number }>`
    SELECT winner, COUNT(*) AS n FROM prompt_section_evaluations
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId}
      AND pending_version = ${row.version} GROUP BY winner`;

  let trialsSoFar = 0, pendingWins = 0, currentWins = 0, ties = 0;

  for (const count of counts) {
    trialsSoFar += count.n;

    if (count.winner === 'pending') pendingWins = count.n;
    else if (count.winner === 'current') currentWins = count.n;
    else if (count.winner === 'tie') ties = count.n;
  }

  return {
    sectionId, version: row.version, source: row.source, rationale: row.rationale,
    writtenAt: row.written_at, trialsSoFar, pendingWins, currentWins, ties,
  };
}

/** Record one executed comparison. A tie is recorded as a tie: `decidePromotion` counts only decisive trials. */
export function recordPromptSectionTrial(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    sectionId: string;
    pendingVersion: number;
    instanceId: string;
    currentScore: number;
    pendingScore: number;
    winner: 'current' | 'pending' | 'tie';
    feedback: string;
    now?: number;
  },
): void {
  actor.assertCurrent();
  void sql`
    INSERT INTO prompt_section_evaluations
      (actor_id, id, section_id, pending_version, instance_id, current_score, pending_score,
       winner, feedback, evaluated_at)
    VALUES (${actor.actorId}, ${`psec-${nanoid()}`}, ${args.sectionId}, ${args.pendingVersion},
            ${args.instanceId}, ${args.currentScore}, ${args.pendingScore},
            ${v.parse(TrialWinnerSchema, args.winner)}, ${args.feedback}, ${args.now ?? nowMs()})`;
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
    const misevolution = checkMisevolution(pending.source);

    if (!misevolution.ok) {
      recordMisevolutionVeto(sql, actor, {
        surface: 'scaffold', violation: misevolution,
        detail: `promotion of ${pending.sectionId} v${String(pending.version)} vetoed; rolled back instead`,
      });
      const rolled = applyPromptSectionDecision(sql, actor, pending, 'rollback');

      return { ...rolled, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
    }

    void sql`UPDATE prompt_section_versions SET status = 'historical'
      WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId} AND status = 'current'`;
    void sql`UPDATE prompt_section_versions SET status = 'current'
      WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId}
        AND version = ${pending.version}`;

    return { action: 'promote' };
  }

  void sql`UPDATE prompt_section_versions SET status = 'rolled_back'
    WHERE actor_id = ${actor.actorId} AND section_id = ${pending.sectionId}
      AND version = ${pending.version}`;

  return { action: 'rollback' };
}

/** Newest first; what the Evolution Changelog reads. */
export function listPromptSectionVersions(
  sql: SqlExecutor, actor: ActorHandle, limit = 50,
): PromptSectionVersion[] {
  actor.assertCurrent();

  const rows = sql<{
    section_id: string; version: number; source: string; rationale: string;
    status: string; incumbent_bytes: number; written_at: number;
  }>`
    SELECT section_id, version, source, rationale, status, incumbent_bytes, written_at
    FROM prompt_section_versions WHERE actor_id = ${actor.actorId}
    ORDER BY written_at DESC LIMIT ${limit}`;

  return rows.map((row) => ({
    sectionId: row.section_id,
    version: row.version,
    source: row.source,
    rationale: row.rationale,
    status: v.parse(PromptSectionStatusSchema, row.status),
    incumbentBytes: row.incumbent_bytes,
    writtenAt: row.written_at,
  }));
}

/** Keyed `sectionId:version`. */
export function promptSectionTrialRecord(
  sql: SqlExecutor,
  actor: ActorHandle,
): ReadonlyMap<string, { wins: number; losses: number; ties: number }> {
  actor.assertCurrent();

  const rows = sql<{ section_id: string; pending_version: number; winner: string; n: number }>`
    SELECT section_id, pending_version, winner, COUNT(*) AS n
    FROM prompt_section_evaluations WHERE actor_id = ${actor.actorId}
    GROUP BY section_id, pending_version, winner`;

  const record = new Map<string, { wins: number; losses: number; ties: number }>();

  for (const row of rows) {
    const key = `${row.section_id}:${String(row.pending_version)}`;
    const entry = record.get(key) ?? { wins: 0, losses: 0, ties: 0 };

    if (row.winner === 'pending') entry.wins = row.n;
    else if (row.winner === 'current') entry.losses = row.n;
    else entry.ties = row.n;
    record.set(key, entry);
  }

  return record;
}
