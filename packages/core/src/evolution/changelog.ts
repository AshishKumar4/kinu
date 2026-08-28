/**
 * Evolution Changelog — the "what I changed about myself" digest.
 *
 * The transparency layer that lets the autonomy defaults ship ON: evolution
 * acts first, this reports honestly, and every line is revertable. It is a
 * READ MODEL over the durable ledgers that already exist (scaffold_versions +
 * shadow record, crafted_tools + its EMA columns, agent_facts, gepa_runs,
 * replay_evals, turn_outcomes) — no parallel event system, no new write path.
 * The only state it owns is the `changelog_seen_at` config marker (unseen
 * badge), and reverts dispatch to the REAL existing paths: scaffold rollback,
 * craft retire, fact forget.
 */

import * as v from 'valibot';
import { CHANGE_KIND_GLYPH } from '../tui-presentation';
import type { SqlExecutor } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import type { FactsStore } from '../memory/facts';
import { listScaffoldArchive } from '../scaffold/archive';
import { getPendingScaffold, applyPromotionDecision } from '../scaffold/shadow';
import { rollbackScaffold } from '../scaffold/rollback';
import { revertView } from '../views/store';
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
import { formatScoreInterval, lossInterval } from '../utils/stats';
import { parseJsonValue } from '../utils/json';
import { renderThrownChain, tolerate } from '../obs/index';

const ScaffoldRunEventSchema = v.object({
  fromVersion: v.optional(v.number()),
  toVersion: v.optional(v.number()),
});

export type ChangelogEntryKind =
  'scaffold' | 'tool' | 'view' | 'fact' | 'gepa' | 'replay' | 'outcomes' | 'prompt_section'
  | 'refinement';

export type ChangelogRevertAction =
  | { type: 'scaffold_rollback'; target: string }
  | { type: 'craft_retire'; target: string }
  | { type: 'view_revert'; target: string }
  | { type: 'fact_forget'; target: string }
  | { type: 'fact_forget_many'; targets: string[] }
  /** `<sectionId>:<version>` — a section's versions are numbered per section,
   *  so neither half identifies a row on its own. */
  | { type: 'prompt_section_rollback'; target: string };


export interface ChangelogEntry {
  /** Stable id derived from the source ledger row — safe for revert-by-id. */
  id: string;
  kind: ChangelogEntryKind;
  /** Epoch ms of the change (drives ordering + the unseen count). */
  at: number;
  /** One-line human summary of what changed. */
  summary: string;
  /** The evidence numbers behind it: shadow win-rate, EMA score, counts. */
  evidence: string;
  /** Present only when a real revert path exists and the change is still in
   *  effect. Absent = informational (measurement, already-reverted, …). */
  revert?: ChangelogRevertAction;
  /** Scaffold entries: the version, so UIs can fetch its diff. */
  scaffoldVersion?: number;
  /**
   * Present only on a refinement route the OWNER still has to decide.
   *
   * A first-class field rather than something a surface infers from the prose,
   * so a decided row cannot keep offering the action: this is absent the moment
   * the disposition moves off `pending_owner_approval`. The surface fetches the
   * bytes with `showRefinement(requestId, routeIndex)` and passes back the
   * digest that call printed.
   */
  decision?: { requestId: string; routeIndex: number };
  /** Aggregate cards reuse the same entry model for expandable child rows. */
  items?: ChangelogEntry[];
}

export interface BuildChangelogOptions {
  /** Only entries strictly newer than this (epoch ms). */
  since?: number;
  /** Cap on returned entries (default 50). */
  limit?: number;
  now?: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function scaffoldStatusChangeAt(sql: SqlExecutor): Map<number, number> {
  // Promotions/rollbacks flip a status flag on an existing row, so written_at
  // alone would hide them from the unseen window. The durable run_events log
  // records both decisions with a timestamp — fold it in where present.
  const byVersion = new Map<number, number>();
  const rows = sql<{ type: string; payload: string; ts: string }>`
    SELECT type, payload, ts FROM run_events
    WHERE type IN ('scaffold_promotion', 'scaffold_rollback')`;
  for (const r of rows) {
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at)) continue;
    // A payload written by an older shape is skipped and written_at stands;
    // that is the only failure here that is a value rather than a fault.
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

function scaffoldEntries(sql: SqlExecutor): ChangelogEntry[] {
  const archive = listScaffoldArchive(sql, 100).filter((e) => e.version > 0);
  const changedAt = scaffoldStatusChangeAt(sql);
  return archive.map((e) => {
    const verb =
      e.status === 'current' ? 'Promoted scaffold'
      : e.status === 'pending' ? 'Proposed scaffold'
      : e.status === 'rolled_back' ? 'Rolled back scaffold'
      : 'Superseded scaffold';
    const record = e.trials > 0
      ? `shadow ${e.wins}W-${e.losses}L-${e.ties}T${e.winRate != null ? ` · win-rate ${pct(e.winRate)}` : ''}`
      : 'shadow untried';
    const trial = e.status === 'pending' ? ' (shadow trial in progress)' : '';
    // What problem the version was FOR — the line the operator audits a
    // self-change by. Re-derived from the stamped cell id, no label store.
    const targeting = e.pathology !== null
      ? ` · targets ${describePathology(e.pathology)}`
      : '';
    const revertable = e.status === 'current' || e.status === 'pending';
    const summary =
      e.status === 'current'
        ? `I improved how I work${e.trials > 0 ? ` (won ${e.wins} of ${e.trials} trial runs)` : ''}`
        : e.status === 'pending'
          ? 'I am testing an improvement to how I work'
          : e.status === 'rolled_back'
            ? 'I reverted a change to how I work'
            : 'I replaced an earlier way of working';
    const entry: ChangelogEntry = {
      id: `scaffold:v${e.version}:${e.status}`,
      kind: 'scaffold',
      at: Math.max(e.writtenAt, changedAt.get(e.version) ?? 0),
      summary,
      evidence: `${verb} v${e.version}${trial} — ${e.rationale} · ${record}${targeting}`,
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
    // Every tool is born scored at the neutral prior, so the EMA line is
    // always real — there is no unscored case to label.
    const score = `EMA ${r.score.toFixed(2)} over ${r.uses} uses`;
    return {
      id: `tool:${r.name}:${at}`,
      kind: 'tool' as const,
      at,
      summary: `${verb === 'Crafted tool' ? 'Created' : 'Updated'} a tool: ${readableName}`,
      evidence: `${verb} ${r.name}${r.description ? ` — ${r.description}` : ''} · ${score}`,
      revert: { type: 'craft_retire' as const, target: r.name },
    };
  });
}

/** Views the agent published. The revert restores the previous version, or
 *  removes the tab when there was no previous version — the owner-facing undo
 *  for a dashboard, kept in host chrome rather than inside the view itself. */
function viewEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  const rows = sql<{ slug: string; title: string; version: number; written_at: number; status: string }>`
    SELECT slug, title, version, written_at, status
    FROM agent_views ORDER BY written_at DESC LIMIT ${limit}`;
  return rows.map((r) => {
    const entry: ChangelogEntry = {
      id: `view:${r.slug}:v${r.version}`,
      kind: 'view',
      at: r.written_at,
      summary: r.version === 1
        ? `Added a view to the workspace UI: ${r.title}`
        : `Updated the ${r.title} view (v${r.version})`,
      evidence: r.status === 'deleted'
        ? `views/${r.slug}.json v${r.version} — removed`
        : `views/${r.slug}.json v${r.version} — ${r.status}`,
      // Only the live version is revertible: an older row is already reverted,
      // and a deleted one has no tab to take back.
    };
    if (r.status === 'current') entry.revert = { type: 'view_revert', target: r.slug };
    return entry;
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

function factEntries(sql: SqlExecutor, limit: number): FactChangelogEntry[] {
  const rows = sql<{
    key: string; value_json: string; confidence: number;
    source: string | null; last_observed_at: number;
  }>`
    SELECT key, value_json, confidence, source, last_observed_at
    FROM agent_facts ORDER BY last_observed_at DESC LIMIT ${limit}`;
  return rows.map((r) => {
    // Facts written before the value was JSON-encoded are stored as raw text —
    // the one parse failure this read treats as a value.
    const decoded = tolerate(() => parseJsonValue(r.value_json), 'malformed-input');
    const text = v.safeParse(v.string(), decoded);
    const value = text.success
      ? text.output
      : decoded === undefined ? r.value_json : JSON.stringify(decoded);
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
  limit: number,
  since: number | undefined,
): ChangelogEntry | null {
  const items = factEntries(sql, limit)
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

function gepaEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  return listGepaRuns(sql, limit)
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

/** Evolved prompt sections. The one self-change that moves what the model reads
 *  on every turn, so the evidence line leads with the byte trade — the operator
 *  auditing prompt growth should not have to open a diff to see it. */
function promptSectionEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  const trials = promptSectionTrialRecord(sql);
  return listPromptSectionVersions(sql, limit).map((row) => {
    const bytes = Buffer.byteLength(row.source, 'utf8');
    const delta = bytes - row.incumbentBytes;
    const size = `${delta >= 0 ? '+' : ''}${String(delta)} bytes (${String(row.incumbentBytes)} → ${String(bytes)})`;
    const record = trials.get(`${row.sectionId}:${String(row.version)}`);
    const trial = record && record.wins + record.losses + record.ties > 0
      ? `shadow ${String(record.wins)}W-${String(record.losses)}L-${String(record.ties)}T`
      : 'shadow untried';
    const verb =
      row.status === 'current' ? 'Promoted'
      : row.status === 'pending' ? 'Proposed'
      : row.status === 'rolled_back' ? 'Rolled back'
      : 'Superseded';
    const summary =
      row.status === 'current' ? `I reworded my own ${row.sectionId} guidance`
      : row.status === 'pending' ? `I am testing new wording for my ${row.sectionId} guidance`
      : row.status === 'rolled_back' ? `I reverted new wording for my ${row.sectionId} guidance`
      : `I replaced earlier wording for my ${row.sectionId} guidance`;
    const entry: ChangelogEntry = {
      id: `prompt_section:${row.sectionId}:v${String(row.version)}:${row.status}`,
      kind: 'prompt_section',
      at: row.writtenAt,
      summary,
      evidence: `${verb} ${row.sectionId} v${String(row.version)} — ${row.rationale} · ${size} · ${trial}`,
    };
    // Informational once it is already off: a rolled_back or historical row is
    // not in the prompt, so there is nothing to take back.
    if (row.status === 'current' || row.status === 'pending') {
      entry.revert = { type: 'prompt_section_rollback', target: `${row.sectionId}:${String(row.version)}` };
    }
    return entry;
  });
}

/** How much of a proposal's bytes a card carries. Enough to read the change and
 *  decide on it; the whole file is on the request, one fetch away. */
const SOURCE_PREVIEW_CHARS = 1_200;

/** How a refinement stage reads to the owner. Each is what the request IS, not
 *  what it hopes: `evaluating` promises no promotion, `gated` claims no trial. */
const REFINEMENT_STAGE_PROSE = {
  requested: 'I have a review of my own recent failures queued',
  planning: 'I am reviewing my own recent failures',
  gated: 'I recorded what you told me from my own recent failures',
  evaluating: 'I am testing a change I proposed to myself',
  applied: 'I changed how I work, and the trials backed it',
  rolled_back: 'I proposed a change to how I work and the trials refused it',
  refused: 'I reviewed my own recent failures and changed nothing',
} satisfies Record<RefinementStage, string>;

/** How a route's disposition reads. The three non-refusals are three different
 *  kinds of "not live yet", and the operator has to be able to tell them apart. */
const REFINEMENT_DISPOSITION_PROSE = {
  applied: 'in effect now',
  pending_trials: 'pending held-out trials',
  pending_owner_approval: 'staged, waiting for your approval',
  refused: 'refused by a gate',
  rejected: 'rejected by you',
} satisfies Record<RefinementDisposition, string>;

/**
 * Continual refinements — a review of the agent's own failures, and where each
 * typed edit it proposed actually went.
 *
 * An aggregate card whose CHILDREN carry the reverts, because the artifacts are
 * not this row's: a fact reverts through `fact_forget` and a section through
 * `prompt_section_rollback`, exactly as they do when nothing proposed them.
 * A refinement-shaped revert would be a fourth way to undo three things.
 *
 * The parent is informational for the same reason. Taking back "I reviewed my
 * failures" is not an action; taking back what the review changed is, and that
 * is one child per change.
 */
function refinementEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  return createRefinementStore(sql).list(limit).map((request) => {
    const trigger = request.trigger === 'explicit'
      ? 'you asked for it'
      : 'unresolved corrections accumulated';
    const turns = `${String(request.turnIds.length)} graded turn${request.turnIds.length === 1 ? '' : 's'}`;
    const items: ChangelogEntry[] = request.routes.map((route, index) => {
      // An EXCERPT of the bytes, read straight off the stored proposal. Enough
      // to recognise the change while scanning; the whole file is behind
      // `showRefinement`, which is the one endpoint that hands one out and the
      // one an owner decides from.
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
      // Offered only while the decision is still owed. A decided row that kept
      // advertising the action would invite a click the backend refuses.
      if (route.disposition === 'pending_owner_approval' && route.kind === 'skill') {
        item.decision = { requestId: request.id, routeIndex: index };
      }
      // The owner's own revert, reached by the identity the route recorded.
      if (route.disposition === 'applied' && route.kind === 'fact') {
        item.revert = { type: 'fact_forget', target: route.target };
      }
      if (route.disposition === 'pending_trials' && route.kind === 'prompt_section') {
        item.revert = { type: 'prompt_section_rollback', target: route.target };
      }
      return item;
    });
    return {
      id: `refinement:${request.id}:${request.stage}`,
      kind: 'refinement' as const,
      at: request.updatedAt,
      summary: REFINEMENT_STAGE_PROSE[request.stage],
      evidence: `${request.stage} · ${request.scope} scope · ${trigger} · reviewed ${turns}`
        + (request.detail === '' ? '' : ` — ${request.detail}`),
      items,
    };
  });
}

function replayEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  const rows = listReplayEvals(sql, limit + 1);
  return rows.slice(0, limit).map((r, index) => {
    const previous = rows[index + 1];
    // A move is only called improved/declined when the two intervals don't
    // overlap. Two noisy means crossing is not a direction.
    const direction = previous
      ? r.interval.lo > previous.interval.hi ? 'improved'
        : r.interval.hi < previous.interval.lo ? 'declined'
          : 'held'
      : 'reached';
    const scoreSummary = direction === 'reached'
      ? `Self-test score reached ${formatScoreInterval(r.interval)}`
      : direction === 'held'
        ? `Self-test score held within noise at ${formatScoreInterval(r.interval)}`
        : `Self-test score ${direction} to ${formatScoreInterval(r.interval)}`;
    return {
      id: `replay:${r.id}`,
      kind: 'replay' as const,
      at: r.ranAt,
      summary: scoreSummary,
      evidence: `Replay eval — score ${formatScoreInterval(r.interval)} · ` +
        `loss ${formatScoreInterval(lossInterval(r.interval))}` +
        (r.scaffoldVersion != null ? ` on scaffold v${r.scaffoldVersion}` : '') +
        ` · ${r.sampleSize} labeled turns · ${r.acceptedCount} accepted / ${r.negativeCount} corrected`,
    };
  });
}

/** How a batch of verdicts was reached, honestly per source. A digest that reads
 *  "from real user follow-ups" over `execution` rows reports a person where the
 *  only witness was the runtime, and over `session_end` rows reports a reply
 *  that is precisely what never came. */
const OUTCOME_BATCH_PHRASE = {
  explicit: "from the user's thumbs",
  classifier: 'from how the user replied',
  session_end: 'from sessions ending unanswered',
  take_pick: "from the user's picks between takes",
  execution: 'by whether their tool calls ran',
} satisfies Record<TurnOutcomeSource, string>;

/** What ONE verdict rests on — the expandable answer to "why did it say that?".
 *  `row.evidence` is the classifier's own reason or the execution observation;
 *  a thumb and a session that ended are their own evidence, and rows written
 *  before the column carry none, so those phrase from the source instead. */
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
  sql: SqlExecutor, since: number | undefined, limit: number,
): ChangelogEntry | null {
  const rows = listTurnOutcomes(sql, { limit: 200 })
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
    // Bounded by the digest's own limit, like every other aggregate: the batch
    // reads 200 rows to count them honestly, which is not a list anyone reads.
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

/**
 * Assemble the digest from the durable ledgers, newest first. Pure read —
 * call it at session end, on demand (RPC / slash command), whenever.
 */
export function buildChangelog(sql: SqlExecutor, opts: BuildChangelogOptions = {}): ChangelogEntry[] {
  const limit = opts.limit ?? 50;
  const entries = [
    ...scaffoldEntries(sql),
    ...toolEntries(sql, limit),
    ...viewEntries(sql, limit),
    ...gepaEntries(sql, limit),
    ...replayEntries(sql, limit),
    ...promptSectionEntries(sql, limit),
    ...refinementEntries(sql, limit),
  ].filter((e) => opts.since === undefined || e.at > opts.since);
  const facts = factAggregate(sql, limit, opts.since);
  if (facts) entries.push(facts);
  const outcomes = outcomeEntry(sql, opts.since, limit);
  if (outcomes) entries.push(outcomes);
  entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return entries.slice(0, limit);
}

/** How deep the unseen window is read. Past this the badge stops counting, so
 *  it is generous: a workspace left alone for a week is not "99 unseen". */
const UNSEEN_WINDOW_LIMIT = 99;

/**
 * Entries newer than the seen marker, newest first.
 *
 * The badge counts these; the needs-you queue also reads WHICH of them carry a
 * `revert`, because the digest holds measurements (a graded turn, a replay
 * eval, a GEPA pass) as well as changes, and only the changes can be kept or
 * reverted.
 */
export function listUnseenChangelog(sql: SqlExecutor, seenAt: number): ChangelogEntry[] {
  return buildChangelog(sql, { since: seenAt, limit: UNSEEN_WINDOW_LIMIT });
}

/** Entries newer than the seen marker — the badge count. */
export function countUnseenChangelog(sql: SqlExecutor, seenAt: number): number {
  return listUnseenChangelog(sql, seenAt).length;
}

// ── The one text renderer (TUI overlay + classic print + tests) ──
// The marks come from the one canonical map in tui-presentation.ts — this
// renderer carried its own drifted copy ('⚒'/'⏱'/'☑') for months. The import
// is safe against the reverse edge: tui-presentation's import of
// ChangelogEntryKind is type-only and erased at runtime.

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
  entries.forEach((e, i) => {
    const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${String(i + 1).padStart(3)}. ${CHANGE_KIND_GLYPH[e.kind]} ${e.summary}`);
    lines.push(`      ${when}${e.evidence ? ` · ${e.evidence}` : ''}${e.revert ? ' · revertable' : ''}`);
    for (const item of e.items ?? []) {
      lines.push(`      - ${item.summary}`);
      lines.push(`        ${item.evidence}`);
    }
  });
  return lines.join('\n');
}

// ── Revert dispatch — real paths only ────────────────────────────

export interface ChangelogRevertContext {
  rt: AgentRuntime;
  facts: FactsStore;
}

export interface ChangelogRevertResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

async function revertScaffoldVersion(rt: AgentRuntime, version: number): Promise<ChangelogRevertResult> {
  const sql = rt.storage.sql;
  const row = sql<{ status: string }>`
    SELECT status FROM scaffold_versions WHERE version = ${version} LIMIT 1`[0];
  if (!row) return { ok: false, error: `scaffold v${version} not found` };

  if (row.status === 'pending') {
    // Discard the in-trial pending through the existing decision machinery
    // (restores the live file from the current version, flips the status).
    const pending = getPendingScaffold(sql);
    if (!pending || pending.version !== version) {
      return { ok: false, error: `scaffold v${version} is no longer the pending under trial` };
    }
    const result = await applyPromotionDecision(rt, pending, 'rollback');
    return { ok: true, detail: `discarded pending v${version}; current stays v${result.newCurrentVersion}` };
  }

  if (row.status !== 'current') {
    return { ok: false, error: `scaffold v${version} is already ${row.status} — nothing to revert` };
  }

  // Revert a promoted (live) version through the pointer-first rollback API:
  // one atomic statement retires this version and promotes its predecessor,
  // then the live view is refreshed from the predecessor's canonical source.
  const prev = sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE version < ${version}
    ORDER BY version DESC LIMIT 1`[0];
  if (!prev) return { ok: false, error: `scaffold v${version} has no earlier version to roll back to` };
  const restored = await rollbackScaffold(rt, prev.version);
  if (!restored.ok) return { ok: false, error: restored.error };
  return { ok: true, detail: `rolled back to v${prev.version}` };
}

/**
 * Take back an evolved prompt section.
 *
 * A pending one is discarded through the same decision machinery that would
 * have promoted it. A promoted one falls back to the version it superseded, or
 * — when it superseded nothing — to the template compiled into the bundle,
 * which is what `incumbentSectionSource` returns once no row is current. There
 * is no file to restore either way: the source IS the row.
 */
function revertPromptSection(
  sql: SqlExecutor,
  sectionId: string,
  version: number,
): ChangelogRevertResult {
  const row = sql<{ status: string }>`
    SELECT status FROM prompt_section_versions
    WHERE section_id = ${sectionId} AND version = ${version} LIMIT 1`[0];
  if (!row) return { ok: false, error: `prompt section ${sectionId} v${String(version)} not found` };

  if (row.status === 'pending') {
    const pending = getPendingPromptSection(sql, sectionId);
    if (!pending || pending.version !== version) {
      return { ok: false, error: `${sectionId} v${String(version)} is no longer the pending under trial` };
    }
    applyPromptSectionDecision(sql, pending, 'rollback');
    return { ok: true, detail: `discarded pending ${sectionId} v${String(version)}` };
  }
  if (row.status !== 'current') {
    return { ok: false, error: `${sectionId} v${String(version)} is already ${row.status} — nothing to revert` };
  }

  const prev = sql<{ version: number }>`
    SELECT version FROM prompt_section_versions
    WHERE section_id = ${sectionId} AND version < ${version} AND status = 'historical'
    ORDER BY version DESC LIMIT 1`[0];
  void sql`UPDATE prompt_section_versions SET status = 'rolled_back'
    WHERE section_id = ${sectionId} AND version = ${version}`;
  if (!prev) return { ok: true, detail: `${sectionId} is back on its built-in wording` };
  void sql`UPDATE prompt_section_versions SET status = 'current'
    WHERE section_id = ${sectionId} AND version = ${prev.version}`;
  return { ok: true, detail: `rolled ${sectionId} back to v${String(prev.version)}` };
}

/** Execute one entry's revert action against the real machinery. */
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
      return revertScaffoldVersion(ctx.rt, version);
    }
    case 'prompt_section_rollback': {
      const [sectionId, raw] = action.target.split(':');
      const version = Number(raw);
      if (!sectionId || !Number.isInteger(version) || version <= 0) {
        return { ok: false, error: `invalid prompt-section target: ${action.target}` };
      }
      return revertPromptSection(ctx.rt.storage.sql, sectionId, version);
    }
    case 'craft_retire': {
      if (!ctx.rt.craftStore.get(action.target)) {
        return { ok: false, error: `crafted tool ${action.target} is already retired` };
      }
      ctx.rt.craftStore.delete(action.target);
      // One DELETE removes the tool AND its quality — they are the same row.
      return { ok: true, detail: `retired crafted tool ${action.target}` };
    }
    case 'view_revert': {
      const result = await revertView(
        { vfs: ctx.rt.storage.vfs, sql: ctx.rt.storage.sql },
        action.target,
      );
      if (!result.ok) return { ok: false, error: result.error ?? `could not revert view ${action.target}` };
      return {
        ok: true,
        detail: result.revertedTo === undefined
          ? `removed the ${action.target} view`
          : `restored the ${action.target} view to v${result.revertedTo}`,
      };
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

/** Resolve an entry by id against a freshly-built digest and revert it. The
 *  shared backend entry point (cf RPC + local session) — id-addressed so a
 *  digest that shifted between list and revert can never hit the wrong row. */
export async function revertChangelogEntryById(
  ctx: ChangelogRevertContext,
  id: string,
): Promise<ChangelogRevertResult> {
  const entries = buildChangelog(ctx.rt.storage.sql, { limit: 200 });
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
  return executeChangelogRevert(ctx, entry.revert);
}
