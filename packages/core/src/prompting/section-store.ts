/**
 * Evolved prompt sections: propose, trial, promote — the `scaffold/modify.ts` +
 * `scaffold/shadow.ts` discipline, applied to the eleven addressable sections.
 * Nothing here renders anything. `buildSystemPromptSync` reads
 * {@link activePromptSectionOverrides} once per activation, exactly as it reads
 * the soul, and a section with no promoted row renders its built-in template.
 * So the live prompt moves on ONE event — a promotion — and never on a proposal.
 *
 * The gates, in the order `proposePromptSection` applies them:
 *
 *   1. Rationale ≥ the same minimum a scaffold proposal owes, because the
 *      operator reading the changelog is owed the same sentence either way.
 *   2. SLOT CONTRACT IDENTITY. A candidate must declare exactly the incumbent's
 *      text slots and boolean flags. This is the gate with no scaffold analog
 *      and the one that matters most: the builder computes slot values from
 *      typed TypeScript, so a candidate that drops `{{workspaceRoot}}` renders
 *      a prompt missing a fact the model needs, and one that invents a slot
 *      throws on the next turn, mid-prompt, for every turn after.
 *   3. Misevolution, the full checklist (`scaffold/misevolution.ts`, which
 *      carries the grounding). A section is prose the model reads every turn,
 *      which is the prompt pathway that gate exists for, and the
 *      Execution-environments section carries the approvals doctrine — so
 *      `consent-weakening` is not hypothetical here.
 *   4. THE SIZE RULE (see {@link checkPromptSizeRule}) plus an absolute ceiling.
 *   5. One pending per section, for the same reason the scaffold allows one:
 *      trials are evidence about ONE candidate.
 *
 * Promotion needs trials. `recordPromptSectionTrial` writes one row per
 * executed comparison and `decidePromotion` — the SAME Monte-Carlo-calibrated
 * rule the scaffold rollout uses, not a second one invented here — reads the
 * record. Auto-promotion is not wired: `applyPromptSectionDecision` is called
 * by whoever drains the trials, and every promotion lands in the Evolution
 * Changelog where the operator can revert it.
 */

import * as v from 'valibot';
import { renderThrownChain } from '../obs/error';
import { DEFAULT_CONFIG } from '../config';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import type { ScoreInterval } from '../utils/stats';
import { checkMisevolution, recordMisevolutionVeto } from '../scaffold/misevolution';
import { decidePromotion, DEFAULT_SHADOW_CONFIG, type PromotionDecision, type ScaffoldStatus } from '../scaffold/shadow';
import { templateContract, type PromptSection } from './template';
import { PROMPT_SECTIONS, type PromptSectionOverrides } from './section-templates';

/**
 * The most bytes an evolved section may occupy.
 *
 * About twice the largest section Kinu ships (`executors/section`, 2,341
 * bytes, measured 2026-09-05), so a rewrite has room to restructure a section
 * rather than only edit it, and a runaway is refused before anything pays to
 * score it. The eleven together are 8,505 bytes on the same date; eleven at
 * this ceiling would be 52,800, which is the number that makes the ceiling a
 * real bound rather than a formality.
 */
export const PROMPT_SECTION_MAX_BYTES = 4800;

/** Same bar as a scaffold proposal: the operator reads one changelog. */
const MIN_RATIONALE_LENGTH = DEFAULT_CONFIG.scaffold.minRationaleLength;

const PromptSectionStatusSchema = v.picklist(['current', 'pending', 'rolled_back', 'historical']);
const TrialWinnerSchema = v.picklist(['current', 'pending', 'tie']);

/** One proposed or promoted replacement for a built-in section. */
export interface PromptSectionVersion {
  readonly sectionId: string;
  readonly version: number;
  readonly source: string;
  readonly rationale: string;
  readonly status: ScaffoldStatus;
  /** What the incumbent measured when this was proposed — the size rule's
   *  comparand, kept so the changelog can show the trade that was accepted. */
  readonly incumbentBytes: number;
  readonly writtenAt: number;
}

/** A section's pending candidate and the trial record it has accumulated. The
 *  shape `decidePromotion` reads. */
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
    section_id      TEXT NOT NULL,
    version         INTEGER NOT NULL,
    source          TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('current','pending','rolled_back','historical')),
    incumbent_bytes INTEGER NOT NULL,
    written_at      INTEGER NOT NULL,
    PRIMARY KEY (section_id, version)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_prompt_section_status
           ON prompt_section_versions(status, section_id)`);
  execRaw(`CREATE TABLE IF NOT EXISTS prompt_section_evaluations (
    id              TEXT PRIMARY KEY,
    section_id      TEXT NOT NULL,
    pending_version INTEGER NOT NULL,
    instance_id     TEXT NOT NULL,
    current_score   REAL NOT NULL,
    pending_score   REAL NOT NULL,
    winner          TEXT NOT NULL CHECK (winner IN ('current','pending','tie')),
    feedback        TEXT NOT NULL,
    evaluated_at    INTEGER NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_prompt_section_eval_pending
           ON prompt_section_evaluations(section_id, pending_version)`);
}

/**
 * The promoted source for every section that has one.
 *
 * What the backend hands `buildSystemPromptSync` as `sectionOverrides`. Read
 * once per activation, not per turn: a promotion is an agent event, and the
 * cacheable prefix is allowed to move on one.
 */
export function activePromptSectionOverrides(sql: SqlExecutor): PromptSectionOverrides {
  const rows = sql<{ section_id: string; source: string }>`
    SELECT section_id, source FROM prompt_section_versions WHERE status = 'current'`;
  const overrides: Record<string, string> = {};
  for (const row of rows) overrides[row.section_id] = row.source;
  return overrides;
}

/** What a candidate is measured against: the promoted source if the section has
 *  one, else the template compiled into the bundle. */
export function incumbentSectionSource(sql: SqlExecutor, section: PromptSection<string>): string {
  const rows = sql<{ source: string }>`
    SELECT source FROM prompt_section_versions
    WHERE section_id = ${section.id} AND status = 'current' LIMIT 1`;
  return rows[0]?.source ?? section.source;
}

/** The first section with a candidate under trial, or null. The cadence asks
 *  this before starting a new pass: a proposal nobody trials never lands, so
 *  finishing one is always worth more than proposing another. */
export function firstPendingPromptSection(sql: SqlExecutor): string | null {
  const rows = sql<{ section_id: string }>`
    SELECT section_id FROM prompt_section_versions WHERE status = 'pending'
    ORDER BY written_at ASC LIMIT 1`;
  return rows[0]?.section_id ?? null;
}

interface PromptSizeRuleInput {
  readonly incumbentBytes: number;
  readonly candidateBytes: number;
  /** The incumbent's held-out score with its interval. */
  readonly incumbentScore: ScoreInterval;
  /** The candidate's held-out score with its interval. */
  readonly candidateScore: ScoreInterval;
}

type PromptSizeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A candidate longer than the incumbent needs a strictly better score.
 *
 * Every byte of a prompt section is paid on every turn, forever, by every
 * caller. So the two directions are not symmetric and the rule says so:
 *
 *   - At or below the incumbent's size, GEPA's own strictly-better aggregate is
 *     enough. Same behaviour for fewer bytes is a win with nothing to trade.
 *   - ABOVE it, "better" has to mean better than noise: the candidate's score
 *     interval must clear the incumbent's MEAN entirely. A mean that merely
 *     edges ahead inside two overlapping intervals is not a measurement, and
 *     `scaffold-bridge.ts` already says so about scaffolds ("a winner inside
 *     the seed's interval is not evidence of anything"). The difference here is
 *     that a prompt section pays for the ambiguity in tokens rather than in one
 *     revertible file, so the ambiguous case must fall closed.
 *
 * The practical effect is deliberate: on a small eval set the interval is wide,
 * so a longer candidate cannot land at all. Growing the live prompt should need
 * evidence proportional to what it costs, and a handful of judged turns is not
 * that evidence.
 *
 * Not exported: it is gate 4 of `proposePromptSection` and nothing else, and a
 * rule callers could consult without going through the gate is a rule callers
 * could decline to consult. Its cases are tested through the gate, which is
 * where a caller meets it.
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

/**
 * Why a proposal was refused, named rather than numbered.
 *
 * `modifyScaffold` reports a gate NUMBER, which its callers can only forward.
 * A section proposal has callers that must branch — the GEPA bridge reports a
 * size-rule refusal differently from a veto, because one is the anti-bloat rule
 * working as designed and the other is a safety event.
 */
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
  args: ProposePromptSectionArgs,
): ProposeSectionResult {
  const { section, source, rationale } = args;
  if (!PROMPT_SECTIONS.some((known) => known.id === section.id)) {
    return { ok: false, code: 'not_registered', error: `"${section.id}" is not a registered prompt section` };
  }
  if (rationale.length < MIN_RATIONALE_LENGTH) {
    return { ok: false, code: 'rationale_too_short', error: `Rationale must be ≥${String(MIN_RATIONALE_LENGTH)} chars` };
  }

  const incumbent = incumbentSectionSource(sql, section);
  if (source === incumbent) {
    return { ok: false, code: 'unchanged', error: 'candidate is the incumbent, byte for byte' };
  }

  // Gate 2: the slot contract. Parsing the candidate here is also the only
  // place a malformed template is caught before a turn renders it.
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

  // Gate 3: misevolution, the full checklist.
  const misevolution = checkMisevolution(source);
  if (!misevolution.ok) {
    recordMisevolutionVeto(sql, {
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
    WHERE section_id = ${section.id} AND status = 'pending' ORDER BY version DESC LIMIT 1`;
  if (pending.length > 0) {
    return {
      ok: false, code: 'already_pending',
      error: `a rollout for ${section.id} (v${String(pending[0].version)}) is already pending; resolve it before proposing another`,
    };
  }

  const maxRows = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) AS v FROM prompt_section_versions WHERE section_id = ${section.id}`;
  const version = (maxRows[0]?.v ?? 0) + 1;
  void sql`
    INSERT INTO prompt_section_versions
      (section_id, version, source, rationale, status, incumbent_bytes, written_at)
    VALUES (${section.id}, ${version}, ${source}, ${rationale}, 'pending', ${incumbentBytes}, ${nowMs()})`;
  return { ok: true, version };
}

/** The section's pending candidate with its trial record, or null. */
export function getPendingPromptSection(
  sql: SqlExecutor,
  sectionId: string,
): PendingPromptSection | null {
  const rows = sql<{ version: number; source: string; rationale: string; written_at: number }>`
    SELECT version, source, rationale, written_at FROM prompt_section_versions
    WHERE section_id = ${sectionId} AND status = 'pending' ORDER BY version DESC LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const counts = sql<{ winner: string; n: number }>`
    SELECT winner, COUNT(*) AS n FROM prompt_section_evaluations
    WHERE section_id = ${sectionId} AND pending_version = ${row.version} GROUP BY winner`;
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

/**
 * Record one executed comparison of the pending section against the incumbent.
 *
 * Scores come from the caller's metric — the same outcome-aware judge GEPA
 * scored the candidate with, run on an instance the candidate was not selected
 * against. A tie is a real verdict and is recorded as one: `decidePromotion`
 * counts only decisive trials, so silently rounding a tie to a win would walk
 * the calibrated ladder on evidence nobody has.
 */
export function recordPromptSectionTrial(
  sql: SqlExecutor,
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
  void sql`
    INSERT INTO prompt_section_evaluations
      (id, section_id, pending_version, instance_id, current_score, pending_score, winner, feedback, evaluated_at)
    VALUES (${`psec-${nanoid()}`}, ${args.sectionId}, ${args.pendingVersion}, ${args.instanceId},
            ${args.currentScore}, ${args.pendingScore},
            ${v.parse(TrialWinnerSchema, args.winner)}, ${args.feedback}, ${args.now ?? nowMs()})`;
}

/** What the accumulated trials say. The scaffold's rule, unchanged: the
 *  thresholds were calibrated by 200k-sim Monte Carlo against this exact
 *  decision shape, and a second set of numbers invented for prompts would be
 *  two policies for one question. */
export function decidePromptSectionPromotion(pending: PendingPromptSection): PromotionDecision {
  return decidePromotion(pending, DEFAULT_SHADOW_CONFIG);
}

/** What a decision actually did. `action` is the APPLIED action, never the
 *  requested one: a promotion whose source went bad between acceptance and this
 *  moment comes back as a rollback with the reason attached. */
export interface AppliedSectionDecision {
  readonly action: 'promote' | 'rollback';
  readonly vetoReason?: string;
}

/**
 * Apply a decision. Promote flips the pending to `current` and retires whatever
 * was current; rollback marks it `rolled_back`. Either way the pending's trials
 * are done, so the rows stay as the evidence the changelog reads.
 *
 * Re-checks misevolution before promoting, for the same reason
 * `applyPromotionDecision` does: acceptance and promotion are different moments,
 * and the row between them is durable state.
 */
export function applyPromptSectionDecision(
  sql: SqlExecutor,
  pending: PendingPromptSection,
  decision: 'promote' | 'rollback',
): AppliedSectionDecision {
  if (decision === 'promote') {
    const misevolution = checkMisevolution(pending.source);
    if (!misevolution.ok) {
      recordMisevolutionVeto(sql, {
        surface: 'scaffold', violation: misevolution,
        detail: `promotion of ${pending.sectionId} v${String(pending.version)} vetoed; rolled back instead`,
      });
      const rolled = applyPromptSectionDecision(sql, pending, 'rollback');
      return { ...rolled, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
    }
    void sql`UPDATE prompt_section_versions SET status = 'historical'
      WHERE section_id = ${pending.sectionId} AND status = 'current'`;
    void sql`UPDATE prompt_section_versions SET status = 'current'
      WHERE section_id = ${pending.sectionId} AND version = ${pending.version}`;
    return { action: 'promote' };
  }
  void sql`UPDATE prompt_section_versions SET status = 'rolled_back'
    WHERE section_id = ${pending.sectionId} AND version = ${pending.version}`;
  return { action: 'rollback' };
}

/** The section archive, newest first — what the Evolution Changelog reads. */
export function listPromptSectionVersions(sql: SqlExecutor, limit = 50): PromptSectionVersion[] {
  const rows = sql<{
    section_id: string; version: number; source: string; rationale: string;
    status: string; incumbent_bytes: number; written_at: number;
  }>`
    SELECT section_id, version, source, rationale, status, incumbent_bytes, written_at
    FROM prompt_section_versions ORDER BY written_at DESC LIMIT ${limit}`;
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

/** Decisive win/loss/tie counts per pending version, for the changelog's
 *  evidence line. Keyed `sectionId:version`. */
export function promptSectionTrialRecord(
  sql: SqlExecutor,
): ReadonlyMap<string, { wins: number; losses: number; ties: number }> {
  const rows = sql<{ section_id: string; pending_version: number; winner: string; n: number }>`
    SELECT section_id, pending_version, winner, COUNT(*) AS n
    FROM prompt_section_evaluations GROUP BY section_id, pending_version, winner`;
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
