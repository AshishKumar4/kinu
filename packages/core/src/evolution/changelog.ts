/**
 * Evolution Changelog — the "what I changed about myself" digest.
 *
 * The transparency layer that lets the autonomy defaults ship ON: evolution
 * acts first, this reports honestly, and every line is revertable. It is a
 * READ MODEL over the durable ledgers that already exist (scaffold_versions +
 * shadow record, crafted_tools + craft_scores EMA, agent_facts, gepa_runs,
 * replay_evals, turn_outcomes) — no parallel event system, no new write path.
 * The only state it owns is the `changelog_seen_at` config marker (unseen
 * badge), and reverts dispatch to the REAL existing paths: scaffold rollback,
 * craft retire, fact forget.
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { FactsStore } from '../memory/facts.js';
import { listScaffoldArchive } from '../scaffold/archive.js';
import { getPendingScaffold, applyPromotionDecision } from '../scaffold/shadow.js';
import { rollbackScaffold } from '../scaffold/rollback.js';
import { listGepaRuns } from './gepa/persistence.js';
import { listReplayEvals } from './replay.js';
import { listTurnOutcomes } from './outcomes.js';
import { formatScoreInterval, lossInterval } from '../utils/stats.js';

export type ChangelogEntryKind = 'scaffold' | 'tool' | 'fact' | 'gepa' | 'replay' | 'outcomes';

export type ChangelogRevertAction =
  | { type: 'scaffold_rollback'; target: string }
  | { type: 'craft_retire'; target: string }
  | { type: 'fact_forget'; target: string }
  | { type: 'fact_forget_many'; targets: string[] };

export type ChangelogRevertType = ChangelogRevertAction['type'];

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
  try {
    const rows = sql<{ type: string; payload: string; ts: string }>`
      SELECT type, payload, ts FROM run_events
      WHERE type IN ('scaffold_promotion', 'scaffold_rollback')`;
    for (const r of rows) {
      const at = Date.parse(r.ts);
      if (!Number.isFinite(at)) continue;
      try {
        const p = JSON.parse(r.payload) as { fromVersion?: number; toVersion?: number };
        const version = r.type === 'scaffold_promotion' ? p.toVersion : p.fromVersion;
        if (typeof version === 'number' && at > (byVersion.get(version) ?? 0)) {
          byVersion.set(version, at);
        }
      } catch { /* malformed payload — written_at stands */ }
    }
  } catch { /* no run_events table — written_at stands */ }
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
    const revertable = e.status === 'current' || e.status === 'pending';
    const summary =
      e.status === 'current'
        ? `I improved how I work${e.trials > 0 ? ` (won ${e.wins} of ${e.trials} trial runs)` : ''}`
        : e.status === 'pending'
          ? 'I am testing an improvement to how I work'
          : e.status === 'rolled_back'
            ? 'I reverted a change to how I work'
            : 'I replaced an earlier way of working';
    return {
      id: `scaffold:v${e.version}:${e.status}`,
      kind: 'scaffold' as const,
      at: Math.max(e.writtenAt, changedAt.get(e.version) ?? 0),
      summary,
      evidence: `${verb} v${e.version}${trial} — ${e.rationale} · ${record}`,
      ...(revertable ? { revert: { type: 'scaffold_rollback' as const, target: String(e.version) } } : {}),
      scaffoldVersion: e.version,
    };
  });
}

function craftScoreMap(sql: SqlExecutor): Map<string, { score: number; uses: number }> {
  // craft_scores is created lazily by the EMA path — its absence must not
  // hide crafted tools from the digest, only their scores.
  try {
    const rows = sql<{ tool_name: string; score: number; uses: number }>`
      SELECT tool_name, score, uses FROM craft_scores`;
    return new Map(rows.map((r) => [r.tool_name, { score: r.score, uses: r.uses }]));
  } catch {
    return new Map();
  }
}

function toolEntries(sql: SqlExecutor, limit: number): ChangelogEntry[] {
  try {
    const rows = sql<{ name: string; description: string; created_at: number; updated_at: number }>`
      SELECT name, description, created_at, updated_at
      FROM crafted_tools ORDER BY updated_at DESC LIMIT ${limit}`;
    const scores = craftScoreMap(sql);
    return rows.map((r) => {
      const at = Math.max(r.updated_at, r.created_at);
      const verb = r.updated_at > r.created_at ? 'Updated crafted tool' : 'Crafted tool';
      const s = scores.get(r.name);
      const readableName = r.name.replace(/[._-]+/g, ' ');
      const score = s ? `EMA ${s.score.toFixed(2)} over ${s.uses} uses` : 'unscored (new)';
      return {
        id: `tool:${r.name}:${at}`,
        kind: 'tool' as const,
        at,
        summary: `${verb === 'Crafted tool' ? 'Created' : 'Updated'} a tool: ${readableName}`,
        evidence: `${verb} ${r.name}${r.description ? ` — ${r.description}` : ''} · ${score}`,
        revert: { type: 'craft_retire' as const, target: r.name },
      };
    });
  } catch {
    return [];
  }
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
  try {
    const rows = sql<{
      key: string; value_json: string; confidence: number;
      source: string | null; last_observed_at: number;
    }>`
      SELECT key, value_json, confidence, source, last_observed_at
      FROM agent_facts ORDER BY last_observed_at DESC LIMIT ${limit}`;
    return rows.map((r) => {
      let value = r.value_json;
      try {
        const parsed = JSON.parse(r.value_json) as unknown;
        value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      } catch { /* stored as raw text */ }
      return {
        id: `fact:${r.key}`,
        kind: 'fact' as const,
        at: r.last_observed_at,
        summary: humanizeFact(r.key, value),
        evidence: `${r.key} = ${value} · confidence ${pct(r.confidence)}${r.source ? ` · via ${r.source}` : ''}`,
        revert: { type: 'fact_forget' as const, target: r.key },
      };
    });
  } catch {
    return [];
  }
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
  try {
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
  } catch {
    return [];
  }
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

function outcomeEntry(sql: SqlExecutor, since: number | undefined): ChangelogEntry | null {
  const rows = listTurnOutcomes(sql, { limit: 200 })
    .filter((r) => since === undefined || r.createdAt > since);
  if (rows.length === 0) return null;
  const count = (k: string) => rows.filter((r) => r.outcome === k).length;
  const newest = rows.reduce((acc, r) => Math.max(acc, r.createdAt), 0);
  const parts = (['accepted', 'corrected', 'frustrated', 'abandoned'] as const)
    .map((k) => [k, count(k)] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return {
    id: `outcomes:${newest}:${rows.length}`,
    kind: 'outcomes',
    at: newest,
    summary: `Graded ${rows.length} turn${rows.length === 1 ? '' : 's'} from real user follow-ups`,
    evidence: parts.join(' · '),
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
    ...gepaEntries(sql, limit),
    ...replayEntries(sql, limit),
  ].filter((e) => opts.since === undefined || e.at > opts.since);
  const facts = factAggregate(sql, limit, opts.since);
  if (facts) entries.push(facts);
  const outcomes = outcomeEntry(sql, opts.since);
  if (outcomes) entries.push(outcomes);
  entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return entries.slice(0, limit);
}

/** Entries newer than the seen marker — the badge count. */
export function countUnseenChangelog(sql: SqlExecutor, seenAt: number): number {
  return buildChangelog(sql, { since: seenAt, limit: 99 }).length;
}

// ── The one text renderer (TUI overlay + classic print + tests) ──

const KIND_GLYPH: Record<ChangelogEntryKind, string> = {
  scaffold: '⟳', tool: '⚒', fact: '✦', gepa: '◬', replay: '⏱', outcomes: '☑',
};

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
    lines.push(`${String(i + 1).padStart(3)}. ${KIND_GLYPH[e.kind]} ${e.summary}`);
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

  // Revert a promoted (live) version: restore the predecessor's code via the
  // existing rollback API, then record the status flip in the archive.
  const prev = sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE version < ${version}
    ORDER BY version DESC LIMIT 1`[0];
  if (!prev) return { ok: false, error: `scaffold v${version} has no earlier version to roll back to` };
  const restored = await rollbackScaffold(rt, prev.version);
  if (!restored.ok) return { ok: false, error: restored.error };
  sql`UPDATE scaffold_versions SET status = 'rolled_back' WHERE version = ${version}`;
  sql`UPDATE scaffold_versions SET status = 'current' WHERE version = ${prev.version}`;
  return { ok: true, detail: `rolled back to v${prev.version}` };
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
    case 'craft_retire': {
      if (!ctx.rt.craftStore.get(action.target)) {
        return { ok: false, error: `crafted tool ${action.target} is already retired` };
      }
      ctx.rt.craftStore.delete(action.target);
      try {
        ctx.rt.storage.sql`DELETE FROM craft_scores WHERE tool_name = ${action.target}`;
      } catch { /* no scores table — the tool itself is gone, which is the revert */ }
      return { ok: true, detail: `retired crafted tool ${action.target}` };
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
          failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
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
