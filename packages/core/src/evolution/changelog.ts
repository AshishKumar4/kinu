/**
 * Evolution changelog: a read model over the existing evolution ledgers, with
 * no parallel event system. It owns only the `changelog_seen_at` marker;
 * reverts dispatch to the real paths (scaffold rollback, fact forget).
 */

import * as v from 'valibot';
import { CHANGE_KIND_GLYPH } from '../tui-presentation';
import type { SqlExecutor } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ActorHandle } from '../identity/actor-handle';
import type { FactsStore } from '../memory/facts';
import { listScaffoldArchive, type ScaffoldStatus } from '../scaffold/archive';
import { getPendingScaffold, applyPromotionDecision, type ScaffoldDecisionEvents } from '../scaffold/shadow';
import { rollbackScaffold } from '../scaffold/rollback';
import { listGepaRuns } from './gepa/persistence';
import {
  applyPromptSectionDecision, getPendingPromptSection,
  listPromptSectionVersions, promptSectionTrialRecord,
} from '../prompting/section-store';
import { listReplayEvals } from './replay';
import {
  listTurnOutcomes, TURN_OUTCOMES, TURN_OUTCOME_SOURCES,
  type TurnOutcomeSource, type TurnOutcomeRow,
} from './outcomes';
import {
  createRefinementStore,
  type RefinementDisposition, type RefinementStage,
} from './refinement';
import { describePathology } from './pathology';
import { formatScoreInterval, lossInterval, type ScoreInterval } from '../utils/stats';
import { parseJsonValue } from '../utils/json';
import { renderThrownChain, tolerate } from '../obs/index';

const ScaffoldRunEventSchema = v.object({
  fromVersion: v.optional(v.number()),
  toVersion: v.optional(v.number()),
});

export type ChangelogEntryKind =
  'scaffold' | 'tool' | 'fact' | 'gepa' | 'replay' | 'outcomes' | 'prompt_section'
  | 'refinement';

export type ChangelogRevertAction =
  | { type: 'scaffold_rollback'; target: string }
  | { type: 'fact_forget'; target: string }
  | { type: 'fact_forget_many'; targets: string[] }
  /** `<sectionId>:<version>`; versions are numbered per section. */
  | { type: 'prompt_section_rollback'; target: string };

export interface ChangelogEntry {
  /** Derived from the source ledger row; safe for revert-by-id. */
  id: string;
  kind: ChangelogEntryKind;
  /** Epoch ms; drives ordering and the unseen count. */
  at: number;
  summary: string;
  /** Evidence numbers: shadow win-rate, EMA score, counts. */
  evidence: string;
  /** Only when a real revert path exists and the change is still in effect. */
  revert?: ChangelogRevertAction;
  scaffoldVersion?: number;
  /**
   * Only on a skill route still `pending_owner_approval`, so decided rows never
   * offer the action. Surfaces fetch bytes via `showRefinement` and pass back its digest.
   */
  decision?: { requestId: string; routeIndex: number };
  /** A run that moved nothing (a refused refinement); excluded by `changesOnly`. */
  noChange?: boolean;
  /** Child rows of an aggregate card. */
  items?: ChangelogEntry[];
}

export interface BuildChangelogOptions {
  since?: number;
  /** Default 50. */
  limit?: number;
  /** Drop measurements ('outcomes', 'replay') and `noChange` runs before the
   *  limit, so bookkeeping cannot push a real change off the page. */
  changesOnly?: boolean;
  now?: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function scaffoldStatusChangeAt(sql: SqlExecutor, actor: ActorHandle): Map<number, number> {
  // Promotions/rollbacks only flip a status flag, so written_at would hide
  // them; take the decision time from run_events.
  const byVersion = new Map<number, number>();
  actor.assertCurrent();

  const rows = sql<{ type: string; payload: string; ts: string }>`
    SELECT type, payload, ts FROM run_events
    WHERE actor_id = ${actor.actorId}
      AND type IN ('scaffold_promotion', 'scaffold_rollback')`;

  for (const r of rows) {
    const at = Date.parse(r.ts);

    if (!Number.isFinite(at)) continue;
    // An older payload shape is skipped and written_at stands.
    const payload = tolerate(() => parseJsonValue(r.payload), 'malformed-input');
    const parsed = v.safeParse(ScaffoldRunEventSchema, payload);

    if (!parsed.success) continue;

    const version = r.type === 'scaffold_promotion'
      ? parsed.output.toVersion
      : parsed.output.fromVersion;

    if (version !== undefined && at > (byVersion.get(version) ?? 0)) {
      byVersion.set(version, at);
    }
  }

  return byVersion;
}

const SCAFFOLD_VERB: Record<ScaffoldStatus, string> = {
  current: 'Promoted scaffold',
  pending: 'Proposed scaffold',
  rolled_back: 'Rolled back scaffold',
  historical: 'Superseded scaffold',
};

const SCAFFOLD_SUMMARY: Record<ScaffoldStatus, string> = {
  current: 'I improved how I work',
  pending: 'I am testing an improvement to how I work',
  rolled_back: 'I reverted a change to how I work',
  historical: 'I replaced an earlier way of working',
};

function scaffoldEntries(sql: SqlExecutor, actor: ActorHandle): ChangelogEntry[] {
  const archive = listScaffoldArchive(sql, actor, 100).filter((e) => e.version > 0);
  const changedAt = scaffoldStatusChangeAt(sql, actor);

  return archive.map((e) => {
    const record = e.trials > 0
      ? `shadow ${e.wins}W-${e.losses}L-${e.ties}T${e.winRate != null ? ` · win-rate ${pct(e.winRate)}` : ''}`
      : 'shadow untried';

    const trial = e.status === 'pending' ? ' (shadow trial in progress)' : '';

    // Re-derived from the stamped cell id; no label store.
    const targeting = e.pathology !== null
      ? ` · targets ${describePathology(e.pathology)}`
      : '';

    const revertable = e.status === 'current' || e.status === 'pending';

    const won = e.status === 'current' && e.trials > 0 ? ` (won ${e.wins} of ${e.trials} trial runs)` : '';

    const entry: ChangelogEntry = {
      id: `scaffold:v${e.version}:${e.status}`,
      kind: 'scaffold',
      at: Math.max(e.writtenAt, changedAt.get(e.version) ?? 0),
      summary: `${SCAFFOLD_SUMMARY[e.status]}${won}`,
      evidence: `${SCAFFOLD_VERB[e.status]} v${e.version}${trial} — ${e.rationale} · ${record}${targeting}`,
      scaffoldVersion: e.version,
    };

    if (revertable) entry.revert = { type: 'scaffold_rollback', target: String(e.version) };

    return entry;
  });
}

function toolEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  const rows = sql<{ name: string; description: string; created_at: number; updated_at: number; score: number; uses: number }>`
    SELECT name, description, created_at, updated_at, score, uses
    FROM crafted_tools ORDER BY updated_at DESC LIMIT ${limit}`;

  return rows.map((r) => {
    const at = Math.max(r.updated_at, r.created_at);
    const verb = r.updated_at > r.created_at ? 'Updated crafted tool' : 'Crafted tool';
    const readableName = r.name.replace(/[._-]+/g, ' ');
    // Tools start at a neutral EMA prior, so the score is always real.
    const score = `EMA ${r.score.toFixed(2)} over ${r.uses} uses`;

    // No revert: retiring a tool belongs to the Tools surface.
    return {
      id: `tool:${r.name}:${at}`,
      kind: 'tool' as const,
      at,
      summary: `${verb === 'Crafted tool' ? 'Created' : 'Updated'} a tool: ${readableName}`,
      evidence: `${verb} ${r.name}${r.description ? ` — ${r.description}` : ''} · ${score}`,
    };
  });
}

function humanizeFact(key: string, value: string): string {
  const normalizedKey = key.trim().toLowerCase();
  const segments = normalizedKey.split('.').filter(Boolean);
  const leaf = segments.at(-1) ?? normalizedKey;

  if (segments[0] === 'sandbox' && leaf.endsWith('_version')) {
    const software = leaf.slice(0, -'_version'.length).replace(/_/g, ' ');

    const runs = value.toLowerCase().startsWith(software.toLowerCase())
      ? value
      : `${software} ${value}`;

    return `Your sandbox runs ${runs}`;
  }

  const subject = normalizedKey.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();

  return `Your ${subject} is ${value}`;
}

type FactChangelogEntry = ChangelogEntry & {
  kind: 'fact';
  revert: Extract<ChangelogRevertAction, { type: 'fact_forget' }>;
};

/** Facts predating JSON encoding are raw text. */
function factValueText(valueJson: string): string {
  const decoded = tolerate(() => parseJsonValue(valueJson), 'malformed-input');
  const text = v.safeParse(v.string(), decoded);

  if (text.success) return text.output;

  if (decoded === undefined) return valueJson;

  return JSON.stringify(decoded);
}

function factEntries(sql: SqlExecutor, actor: ActorHandle, limit: number): FactChangelogEntry[] {
  actor.assertCurrent();

  const rows = sql<{
    key: string; value_json: string; confidence: number;
    source: string | null; last_observed_at: number;
  }>`
    SELECT key, value_json, confidence, source, last_observed_at
    FROM agent_facts WHERE actor_id = ${actor.actorId}
    ORDER BY last_observed_at DESC LIMIT ${limit}`;

  return rows.map((r) => {
    const value = factValueText(r.value_json);

    return {
      id: `fact:${r.key}`,
      kind: 'fact' as const,
      at: r.last_observed_at,
      summary: humanizeFact(r.key, value),
      evidence: `${r.key} = ${value} · confidence ${pct(r.confidence)}${r.source ? ` · via ${r.source}` : ''}`,
      revert: { type: 'fact_forget' as const, target: r.key },
    };
  });
}

function factAggregate(
  sql: SqlExecutor,
  actor: ActorHandle,
  limit: number,
  since: number | undefined,
): ChangelogEntry | null {
  const items = factEntries(sql, actor, limit)
    .filter((entry) => since === undefined || entry.at > since);

  if (items.length === 0) return null;
  const at = items.reduce((newest, entry) => Math.max(newest, entry.at), 0);
  const ids = items.map((entry) => entry.id).sort();

  return {
    id: `facts:${ids.join('|')}`,
    kind: 'fact',
    at,
    summary: `Learned ${items.length} thing${items.length === 1 ? '' : 's'} about your environment`,
    evidence: '',
    revert: { type: 'fact_forget_many', targets: items.map((entry) => entry.revert.target) },
    items,
  };
}

function gepaEntries(sql: SqlExecutor, actor: ActorHandle, limit: number): ChangelogEntry[] {
  return listGepaRuns(sql, actor, limit)
    .filter((r) => r.status === 'completed')
    .map((r) => ({
      id: `gepa:${r.runId}`,
      kind: 'gepa' as const,
      at: r.endedAt ?? r.startedAt,
      summary: 'Tuned my own instructions',
      evidence: `GEPA self-optimization pass over ${r.target}` +
        (r.winnerId ? ` — found a better candidate (${r.winnerId})` : ' — kept the current') +
        ` · ${r.iterations} iterations · ${r.metricCalls} metric calls` +
        (r.stopReason ? ` · ${r.stopReason}` : ''),
    }));
}

const SECTION_VERB: Record<ScaffoldStatus, string> = {
  current: 'Promoted',
  pending: 'Proposed',
  rolled_back: 'Rolled back',
  historical: 'Superseded',
};

const SECTION_SUMMARY: Record<ScaffoldStatus, string> = {
  current: 'I reworded my own',
  pending: 'I am testing new wording for my',
  rolled_back: 'I reverted new wording for my',
  historical: 'I replaced earlier wording for my',
};

/** Evidence leads with the byte trade, since sections are read every turn. */
function promptSectionEntries(sql: SqlExecutor, actor: ActorHandle, limit: number): ChangelogEntry[] {
  const trials = promptSectionTrialRecord(sql, actor);

  return listPromptSectionVersions(sql, actor, limit).map((row) => {
    const bytes = Buffer.byteLength(row.source, 'utf8');
    const delta = bytes - row.incumbentBytes;
    const size = `${delta >= 0 ? '+' : ''}${String(delta)} bytes (${String(row.incumbentBytes)} → ${String(bytes)})`;
    const record = trials.get(`${row.sectionId}:${String(row.version)}`);

    const trial = record && record.wins + record.losses + record.ties > 0
      ? `shadow ${String(record.wins)}W-${String(record.losses)}L-${String(record.ties)}T`
      : 'shadow untried';

    const entry: ChangelogEntry = {
      id: `prompt_section:${row.sectionId}:v${String(row.version)}:${row.status}`,
      kind: 'prompt_section',
      at: row.writtenAt,
      summary: `${SECTION_SUMMARY[row.status]} ${row.sectionId} guidance`,
      evidence:
        `${SECTION_VERB[row.status]} ${row.sectionId} v${String(row.version)} — ${row.rationale} · ${size} · ${trial}`,
    };

    // Rolled-back and historical rows are not in the prompt; nothing to revert.
    if (row.status === 'current' || row.status === 'pending') {
      entry.revert = { type: 'prompt_section_rollback', target: `${row.sectionId}:${String(row.version)}` };
    }

    return entry;
  });
}

const SOURCE_PREVIEW_CHARS = 1_200;

const REFINEMENT_STAGE_PROSE = {
  requested: 'I have a review of my own recent failures queued',
  planning: 'I am reviewing my own recent failures',
  gated: 'I recorded what you told me from my own recent failures',
  evaluating: 'I am testing a change I proposed to myself',
  applied: 'I changed how I work, and the trials backed it',
  rolled_back: 'I proposed a change to how I work and the trials refused it',
  refused: 'I reviewed my own recent failures and changed nothing',
} satisfies Record<RefinementStage, string>;

/** The three non-refusals are distinct kinds of "not live yet". */
const REFINEMENT_DISPOSITION_PROSE = {
  applied: 'in effect now',
  pending_trials: 'pending held-out trials',
  pending_owner_approval: 'staged, waiting for your approval',
  refused: 'refused by a gate',
  rejected: 'rejected by you',
} satisfies Record<RefinementDisposition, string>;

/**
 * An aggregate card per refinement; children carry the reverts through each
 * artifact's own path (`fact_forget`, `prompt_section_rollback`).
 */
function refinementEntries(sql: SqlExecutor, actor: ActorHandle, limit: number): ChangelogEntry[] {
  return createRefinementStore(sql, actor).list(limit).map((request) => {
    const trigger = request.trigger === 'explicit'
      ? 'you asked for it'
      : 'unresolved corrections accumulated';

    const turns = `${String(request.turnIds.length)} graded turn${request.turnIds.length === 1 ? '' : 's'}`;

    const items: ChangelogEntry[] = request.routes.map((route, index) => {
      // An excerpt; the full file comes only from `showRefinement`.
      const edit = request.proposal?.edits[index];

      const source = edit?.kind === 'prompt_section' || edit?.kind === 'skill'
        ? edit.source
        : undefined;

      const item: ChangelogEntry = {
        id: `refinement:${request.id}:${String(index)}`,
        kind: 'refinement',
        at: request.updatedAt,
        summary: `${route.kind} → ${route.target || '(no target)'} — `
          + REFINEMENT_DISPOSITION_PROSE[route.disposition],
        evidence: `${route.owner === '' ? 'no owning authority' : `owner ${route.owner}`}`
          + (route.reason === undefined ? '' : ` · ${route.reason}`)
          + (source === undefined
            ? ''
            : `\n${source.length > SOURCE_PREVIEW_CHARS
              ? `${source.slice(0, SOURCE_PREVIEW_CHARS)}\n… +${String(source.length - SOURCE_PREVIEW_CHARS)} chars`
              : source}`),
      };

      // Only while the decision is still owed.
      if (route.disposition === 'pending_owner_approval' && route.kind === 'skill') {
        item.decision = { requestId: request.id, routeIndex: index };
      }

      if (route.disposition === 'applied' && route.kind === 'fact') {
        item.revert = { type: 'fact_forget', target: route.target };
      }

      if (route.disposition === 'pending_trials' && route.kind === 'prompt_section') {
        item.revert = { type: 'prompt_section_rollback', target: route.target };
      }

      return item;
    });

    const entry: ChangelogEntry = {
      id: `refinement:${request.id}:${request.stage}`,
      kind: 'refinement' as const,
      at: request.updatedAt,
      summary: REFINEMENT_STAGE_PROSE[request.stage],
      evidence: `${request.stage} · ${request.scope} scope · ${trigger} · reviewed ${turns}`
        + (request.detail === '' ? '' : ` — ${request.detail}`),
      items,
    };

    // `refused` is the only stage that leaves the workspace unchanged.
    if (request.stage === 'refused') entry.noChange = true;

    return entry;
  });
}

type ReplayDirection = 'improved' | 'declined' | 'held' | 'reached';

/** Improved/declined only when the intervals don't overlap. */
function replayDirection(current: ScoreInterval, previous: ScoreInterval | undefined): ReplayDirection {
  if (previous === undefined) return 'reached';

  if (current.lo > previous.hi) return 'improved';

  if (current.hi < previous.lo) return 'declined';

  return 'held';
}

const REPLAY_MOVE: Record<ReplayDirection, string> = {
  improved: 'improved to',
  declined: 'declined to',
  held: 'held within noise at',
  reached: 'reached',
};

function replayEntries(sql: SqlExecutor, actor: ActorHandle, limit: number): ChangelogEntry[] {
  const rows = listReplayEvals(sql, actor, limit + 1);

  return rows.slice(0, limit).map((r, index) => {
    const direction = replayDirection(r.interval, rows.at(index + 1)?.interval);

    return {
      id: `replay:${r.id}`,
      kind: 'replay' as const,
      at: r.ranAt,
      summary: `Self-test score ${REPLAY_MOVE[direction]} ${formatScoreInterval(r.interval)}`,
      evidence: `Replay eval — score ${formatScoreInterval(r.interval)} · ` +
        `loss ${formatScoreInterval(lossInterval(r.interval))}` +
        (r.scaffoldVersion != null ? ` on scaffold v${r.scaffoldVersion}` : '') +
        ` · ${r.sampleSize} labeled turns · ${r.acceptedCount} accepted / ${r.negativeCount} corrected`,
    };
  });
}

/** Per-source phrasing, so `execution` and `session_end` rows never claim a user reply. */
const OUTCOME_BATCH_PHRASE = {
  explicit: "from the user's thumbs",
  classifier: 'from how the user replied',
  session_end: 'from sessions ending unanswered',
  take_pick: "from the user's picks between takes",
  execution: 'by whether their tool calls ran',
} satisfies Record<TurnOutcomeSource, string>;

/** Why one verdict was reached; rows without `evidence` phrase from their source. */
function outcomeItemEvidence(row: TurnOutcomeRow): string {
  switch (row.source) {
    case 'classifier':
      return `the user's reply read as ${row.outcome}`
        + (row.evidence ? ` — ${row.evidence}` : '')
        + ` · confidence ${pct(row.confidence)}`;
    case 'execution':
      return row.evidence
        ?? `the turn's tool calls ${row.outcome === 'accepted' ? 'ran clean' : 'hit an error'}`;
    case 'explicit':
      return row.outcome === 'accepted' ? 'thumbs up from the user' : 'thumbs down from the user';
    case 'take_pick':
      return row.evidence ?? "the user's pick between alternate takes";
    case 'session_end':
      return 'the session ended with no reply to grade';
  }
}

function outcomeEntry(
  sql: SqlExecutor, actor: ActorHandle, since: number | undefined, limit: number,
): ChangelogEntry | null {
  const rows = listTurnOutcomes(sql, actor, { limit: 200 })
    .filter((r) => since === undefined || r.createdAt > since);

  if (rows.length === 0) return null;
  const count = (k: string) => rows.filter((r) => r.outcome === k).length;
  const newest = rows.reduce((acc, r) => Math.max(acc, r.createdAt), 0);

  const parts = TURN_OUTCOMES
    .map((k) => [k, count(k)] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);

  const provenance = TURN_OUTCOME_SOURCES
    .map((s) => [s, rows.filter((r) => r.source === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${OUTCOME_BATCH_PHRASE[s]}`);

  return {
    id: `outcomes:${newest}:${rows.length}`,
    kind: 'outcomes',
    at: newest,
    summary: `Graded ${rows.length} turn${rows.length === 1 ? '' : 's'} · ${provenance.join(' · ')}`,
    evidence: parts.join(' · '),
    // Bounded by the digest limit; the 200-row read is for counting only.
    items: rows.slice(0, limit).map((row) => {
      const request = row.userMessage.trim().replace(/\s+/gu, ' ');

      return {
        id: `outcome:${row.id}`,
        kind: 'outcomes' as const,
        at: row.createdAt,
        summary: `${row.outcome} — "${request.length > 90 ? `${request.slice(0, 90)}…` : request || '(no recorded request)'}"`,
        evidence: outcomeItemEvidence(row),
      };
    }),
  };
}

/** The digest from the durable ledgers, newest first. Pure read. */
export function buildChangelog(
  sql: SqlExecutor, actor: ActorHandle, opts: BuildChangelogOptions = {},
): ChangelogEntry[] {
  const limit = opts.limit ?? 50;

  const entries = [
    ...scaffoldEntries(sql, actor),
    ...toolEntries(sql, limit),
    ...gepaEntries(sql, actor, limit),
    ...replayEntries(sql, actor, limit),
    ...promptSectionEntries(sql, actor, limit),
    ...refinementEntries(sql, actor, limit),
  ].filter((e) => opts.since === undefined || e.at > opts.since);

  const facts = factAggregate(sql, actor, limit, opts.since);

  if (facts) entries.push(facts);
  const outcomes = outcomeEntry(sql, actor, opts.since, limit);

  if (outcomes) entries.push(outcomes);
  entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));

  const kept = opts.changesOnly === true
    ? entries.filter((e) => e.kind !== 'outcomes' && e.kind !== 'replay' && e.noChange !== true)
    : entries;

  return kept.slice(0, limit);
}

/** Unseen badge ceiling. */
const UNSEEN_WINDOW_LIMIT = 99;

/** Entries newer than the seen marker, newest first. */
export function listUnseenChangelog(
  sql: SqlExecutor, actor: ActorHandle, seenAt: number,
): ChangelogEntry[] {
  return buildChangelog(sql, actor, { since: seenAt, limit: UNSEEN_WINDOW_LIMIT });
}

export function countUnseenChangelog(sql: SqlExecutor, actor: ActorHandle, seenAt: number): number {
  return listUnseenChangelog(sql, actor, seenAt).length;
}

// Glyphs come from tui-presentation.ts; its import of ChangelogEntryKind is
// type-only, so there is no runtime cycle.

export function renderChangelogText(
  entries: ReadonlyArray<ChangelogEntry>,
  opts: { unseenCount?: number } = {},
): string {
  if (entries.length === 0) {
    return 'Evolution changelog is empty — no self-changes recorded yet.';
  }

  const header = `Evolution changelog (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
    (opts.unseenCount ? ` · ${opts.unseenCount} unseen` : '') + ')';

  const lines = [header];

  for (const [i, e] of entries.entries()) {
    const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${String(i + 1).padStart(3)}. ${CHANGE_KIND_GLYPH[e.kind]} ${e.summary}`);
    lines.push(`      ${when}${e.evidence ? ` · ${e.evidence}` : ''}${e.revert ? ' · revertable' : ''}`);

    for (const item of e.items ?? []) {
      lines.push(`      - ${item.summary}`);
      lines.push(`        ${item.evidence}`);
    }
  }

  return lines.join('\n');
}

export interface ChangelogRevertContext {
  rt: AgentRuntime;
  facts: FactsStore;
  events: ScaffoldDecisionEvents;
}

export interface ChangelogRevertResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

async function revertScaffoldVersion(rt: AgentRuntime, version: number, events: ScaffoldDecisionEvents): Promise<ChangelogRevertResult> {
  const sql = rt.storage.sql;
  const actor = rt.actor;
  actor.assertCurrent();

  const row = sql<{ status: string }>`
    SELECT status FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND version = ${version} LIMIT 1`[0];

  if (!row) return { ok: false, error: `scaffold v${version} not found` };

  if (row.status === 'pending') {
    // The decision machinery restores the live file from current and flips status.
    const pending = getPendingScaffold(sql, actor);

    if (!pending || pending.version !== version) {
      return { ok: false, error: `scaffold v${version} is no longer the pending under trial` };
    }

    const result = await applyPromotionDecision(rt, pending, 'rollback', events);

    return { ok: true, detail: `discarded pending v${version}; current stays v${result.newCurrentVersion}` };
  }

  if (row.status !== 'current') {
    return { ok: false, error: `scaffold v${version} is already ${row.status} — nothing to revert` };
  }

  // Pointer-first rollback: one statement retires this version and promotes its
  // predecessor, then the live view refreshes from the predecessor's source.
  const prev = sql<{ version: number }>`
    SELECT version FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND version < ${version}
    ORDER BY version DESC LIMIT 1`[0];

  if (!prev) return { ok: false, error: `scaffold v${version} has no earlier version to roll back to` };
  const restored = await rollbackScaffold(rt, prev.version);

  if (!restored.ok) return { ok: false, error: restored.error };

  return { ok: true, detail: `rolled back to v${prev.version}` };
}

/**
 * Pending: discarded via the decision machinery. Promoted: falls back to the
 * superseded version, or to the bundled template when none (the row is the source).
 */
function revertPromptSection(
  sql: SqlExecutor,
  actor: ActorHandle,
  sectionId: string,
  version: number,
): ChangelogRevertResult {
  const row = sql<{ status: string }>`
    SELECT status FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId}
      AND version = ${version} LIMIT 1`[0];

  if (!row) return { ok: false, error: `prompt section ${sectionId} v${String(version)} not found` };

  if (row.status === 'pending') {
    const pending = getPendingPromptSection(sql, actor, sectionId);

    if (!pending || pending.version !== version) {
      return { ok: false, error: `${sectionId} v${String(version)} is no longer the pending under trial` };
    }

    applyPromptSectionDecision(sql, actor, pending, 'rollback');

    return { ok: true, detail: `discarded pending ${sectionId} v${String(version)}` };
  }

  if (row.status !== 'current') {
    return { ok: false, error: `${sectionId} v${String(version)} is already ${row.status} — nothing to revert` };
  }

  const prev = sql<{ version: number }>`
    SELECT version FROM prompt_section_versions
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId}
      AND version < ${version} AND status = 'historical'
    ORDER BY version DESC LIMIT 1`[0];

  void sql`UPDATE prompt_section_versions SET status = 'rolled_back'
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId} AND version = ${version}`;

  if (!prev) return { ok: true, detail: `${sectionId} is back on its built-in wording` };
  void sql`UPDATE prompt_section_versions SET status = 'current'
    WHERE actor_id = ${actor.actorId} AND section_id = ${sectionId} AND version = ${prev.version}`;

  return { ok: true, detail: `rolled ${sectionId} back to v${String(prev.version)}` };
}

export async function executeChangelogRevert(
  ctx: ChangelogRevertContext,
  action: ChangelogRevertAction,
): Promise<ChangelogRevertResult> {
  switch (action.type) {
    case 'scaffold_rollback': {
      const version = Number(action.target);

      if (!Number.isInteger(version) || version <= 0) {
        return { ok: false, error: `invalid scaffold version: ${action.target}` };
      }

      return revertScaffoldVersion(ctx.rt, version, ctx.events);
    }

    case 'prompt_section_rollback': {
      const [sectionId, raw] = action.target.split(':');
      const version = Number(raw);

      if (!sectionId || !Number.isInteger(version) || version <= 0) {
        return { ok: false, error: `invalid prompt-section target: ${action.target}` };
      }

      return revertPromptSection(ctx.rt.storage.sql, ctx.rt.actor, sectionId, version);
    }

    case 'fact_forget': {
      if (!ctx.facts.recall(action.target)) {
        return { ok: false, error: `fact ${action.target} is already forgotten` };
      }

      ctx.facts.forget(action.target);

      return { ok: true, detail: `forgot fact ${action.target}` };
    }

    case 'fact_forget_many': {
      const forgotten: string[] = [];
      const failures: string[] = [];

      for (const target of action.targets) {
        try {
          const result = await executeChangelogRevert(ctx, { type: 'fact_forget', target });

          if (result.ok) forgotten.push(target);
          else failures.push(`${target}: ${result.error ?? 'unknown error'}`);
        } catch (error) {
          failures.push(`${target}: ${renderThrownChain({ cause: error })}`);
        }
      }

      if (failures.length > 0) {
        return {
          ok: false,
          detail: `forgot ${forgotten.length} of ${action.targets.length} facts`,
          error: `failed to forget ${failures.length} fact${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`,
        };
      }

      return { ok: true, detail: `forgot ${forgotten.length} fact${forgotten.length === 1 ? '' : 's'}` };
    }
  }
}

/** Id-addressed so a digest that shifted between list and revert cannot hit
 *  the wrong row. Shared by cf RPC and local sessions. */
export async function revertChangelogEntryById(
  ctx: ChangelogRevertContext,
  id: string,
): Promise<ChangelogRevertResult> {
  const entries = buildChangelog(ctx.rt.storage.sql, ctx.rt.actor, { limit: 200 });

  const findEntry = (candidates: ReadonlyArray<ChangelogEntry>): ChangelogEntry | undefined => {
    for (const candidate of candidates) {
      if (candidate.id === id) return candidate;
      const nested = findEntry(candidate.items ?? []);

      if (nested) return nested;
    }

    return undefined;
  };

  const entry = findEntry(entries);

  if (!entry) return { ok: false, error: `changelog entry ${id} not found` };

  if (!entry.revert) return { ok: false, error: `changelog entry ${id} is informational — nothing to revert` };
  const result = await executeChangelogRevert(ctx, entry.revert);

  // Recorded here, not by callers, so both backends log the reversal on the
  // same audit stream that announced the change.
  if (result.ok) {
    void ctx.rt.storage.sql`INSERT INTO evolution_events (actor_id, type, message, created_at)
      VALUES (${ctx.rt.actor.actorId}, 'reflection',
              ${`Operator reverted changelog entry ${id}: ${result.detail ?? 'done'}`}, ${Date.now()})`;
  }

  return result;
}
