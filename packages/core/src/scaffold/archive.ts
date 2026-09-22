/**
 * Scaffold variant archive (DGM, arXiv:2505.22954): a read model over
 * `scaffold_versions` and `scaffold_evaluations` with lineage, shadow scores, and
 * branch-base selection. No second table.
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { parseJsonValue } from '../utils/json';
import type { ScaffoldArchiveEntry, ScaffoldStatus } from './shadow';

export type { ScaffoldArchiveEntry, ScaffoldStatus } from './shadow';

const VetoDataSchema = v.object({
  detail: v.optional(v.string()),
  surface: v.optional(v.string()),
});

/** Every version with lineage and aggregated shadow record, newest first. */
export function listScaffoldArchive(
  sql: SqlExecutor, actor: ActorHandle, limit = 50,
): ScaffoldArchiveEntry[] {
  actor.assertCurrent();

  type Row = {
    version: number; parent_version: number | null; status: ScaffoldStatus;
    rationale: string; pathology: string | null; written_at: number;
    trials: number | null; wins: number | null; losses: number | null; ties: number | null;
  };

  const rows = sql<Row>`
    SELECT v.version, v.parent_version, v.status, v.rationale, v.pathology, v.written_at,
           COUNT(e.id) AS trials,
           SUM(CASE WHEN e.winner = 'pending' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN e.winner = 'current' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN e.winner = 'tie' THEN 1 ELSE 0 END) AS ties
    FROM scaffold_versions v
    LEFT JOIN scaffold_evaluations e
      ON e.actor_id = v.actor_id AND e.pending_version = v.version
    WHERE v.actor_id = ${actor.actorId}
    GROUP BY v.version
    ORDER BY v.version DESC LIMIT ${limit}`;

  return rows.map((r) => {
    const wins = r.wins ?? 0, losses = r.losses ?? 0;
    const decisive = wins + losses;

    return {
      version: r.version,
      parentVersion: r.parent_version,
      status: r.status,
      rationale: r.rationale,
      pathology: r.pathology,
      writtenAt: r.written_at,
      trials: r.trials ?? 0,
      wins, losses,
      ties: r.ties ?? 0,
      winRate: decisive === 0 ? null : wins / decisive,
    };
  });
}

/** Why a proposal never became the live scaffold. */
export type RejectionKind = 'rolled_back' | 'misevolution_veto';

export interface RejectedProposal {
  kind: RejectionKind;
  /** null for a veto: refused before a version existed. */
  version: number | null;
  at: number;
  rationale: string;
  reason: string;
  pathology: string | null;
  /** Zeroes for a veto. */
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  judgeRationales: string[];
}

/**
 * Every refused proposal, newest first, with the reason: rolled-back versions
 * joined to judge reasons, plus misevolution vetoes from `evolution_events`.
 */
export function listRejectedProposals(
  sql: SqlExecutor, actor: ActorHandle, limit = 50,
): RejectedProposal[] {
  actor.assertCurrent();
  const rejected: RejectedProposal[] = [];

  for (const entry of listScaffoldArchive(sql, actor, limit).filter((e) => e.status === 'rolled_back')) {
    const judgeRationales = sql<{ judge_rationale: string | null }>`
      SELECT judge_rationale FROM scaffold_evaluations
      WHERE actor_id = ${actor.actorId} AND pending_version = ${entry.version}
        AND winner = 'current'
      ORDER BY evaluated_at DESC LIMIT 3`
      .flatMap((r) => (r.judge_rationale ? [r.judge_rationale] : []));

    const decisive = entry.wins + entry.losses;
    rejected.push({
      kind: 'rolled_back',
      version: entry.version,
      at: entry.writtenAt,
      rationale: entry.rationale,
      reason: decisive === 0
        ? `discarded before any decisive shadow trial (${entry.trials} trial${entry.trials === 1 ? '' : 's'}, all ties)`
        : `lost ${entry.losses} of ${decisive} decisive shadow trials`,
      pathology: entry.pathology,
      trials: entry.trials, wins: entry.wins, losses: entry.losses, ties: entry.ties,
      judgeRationales,
    });
  }

  const vetoes = sql<{ message: string; data: string | null; created_at: number }>`
    SELECT message, data, created_at FROM evolution_events
    WHERE actor_id = ${actor.actorId} AND type = 'misevolution_veto'
    ORDER BY created_at DESC LIMIT ${limit}`;

  for (const veto of vetoes) {
    // Written by recordMisevolutionVeto here, so an unparseable payload is corruption.
    const parsed = v.parse(VetoDataSchema, parseJsonValue(veto.data ?? '{}'));

    if ((parsed.surface ?? 'scaffold') !== 'scaffold') continue;
    rejected.push({
      kind: 'misevolution_veto',
      version: null,
      at: veto.created_at,
      rationale: parsed.detail ?? '',
      reason: veto.message,
      pathology: null,
      trials: 0, wins: 0, losses: 0, ties: 0,
      judgeRationales: [],
    });
  }

  return rejected.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface EvolutionBaseSelection {
  version: number;
  mode: 'current' | 'explore';
}

/**
 * Clade-metaproductivity (HGM, ICLR 2026): evidence-weighted pooled `winRate`
 * over the subtree including the node, so a lucky 1-trial child cannot outvote a
 * well-tried parent. A leaf scores its own rate; an unscored clade returns null.
 * Unscored versions contribute nothing; status is ignored.
 */
function cladeScores(archive: ReadonlyArray<ScaffoldArchiveEntry>): Map<number, number | null> {
  const children = new Map<number, ScaffoldArchiveEntry[]>();

  for (const e of archive) {
    if (e.parentVersion === null) continue;
    const siblings = children.get(e.parentVersion);

    if (siblings) siblings.push(e);
    else children.set(e.parentVersion, [e]);
  }

  const scores = new Map<number, number | null>();

  for (const root of archive) {
    let pooled = 0;
    let evidence = 0;
    const stack: ScaffoldArchiveEntry[] = [root];
    const seen = new Set<number>();

    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (seen.has(node.version)) continue;
      seen.add(node.version);

      if (node.winRate !== null) {
        // Shadow trials plus real outcomes from blendRealOutcomeRates; ≥ 1 when scored.
        const w = Math.max(1, node.trials);
        pooled += node.winRate * w;
        evidence += w;
      }

      const kids = children.get(node.version);

      if (kids) stack.push(...kids);
    }

    scores.set(root.version, evidence === 0 ? null : pooled / evidence);
  }

  return scores;
}

/**
 * Pathology coverage: 1/(1+n) over versions sharing a failure cell. A version
 * that named no cell scores 0, so a pathology-free archive adds nothing.
 */
function pathologyCoverage(archive: ReadonlyArray<ScaffoldArchiveEntry>): Map<string, number> {
  const counts = new Map<string, number>();

  for (const e of archive) {
    if (e.pathology === null) continue;
    counts.set(e.pathology, (counts.get(e.pathology) ?? 0) + 1);
  }

  return counts;
}

/**
 * Pick the branch base for a new proposal. With probability 1 - exploreShare use
 * the current version; otherwise sample archived variants weighted by clade score,
 * a novelty bonus 1/(1+trials), and pathology coverage (DGM + HGM).
 *
 * Descendants have higher version numbers and the archive is truncated newest-first,
 * so every candidate's clade is complete. Deterministic under an injected RNG;
 * null for an empty archive.
 */
export function selectEvolutionBase(
  archive: ReadonlyArray<ScaffoldArchiveEntry>,
  opts: { exploreShare: number; random?: () => number },
): EvolutionBaseSelection | null {
  const random = opts.random ?? Math.random;
  const current = archive.find((e) => e.status === 'current');
  // Pending versions are mid-trial and never a branch base.
  const explorable = archive.filter((e) => e.status === 'historical' || e.status === 'rolled_back');

  if (!current) {
    if (explorable.length > 0) return { version: explorable[0].version, mode: 'explore' };

    return archive.length > 0 ? { version: archive[0].version, mode: 'current' } : null;
  }

  const exploreShare = Math.min(1, Math.max(0, opts.exploreShare));

  if (explorable.length === 0 || random() >= exploreShare) {
    return { version: current.version, mode: 'current' };
  }

  // Scored over the full archive: the best descendant is usually the current version.
  const clade = cladeScores(archive);
  const coverage = pathologyCoverage(archive);

  const weight = (e: ScaffoldArchiveEntry): number =>
    (clade.get(e.version) ?? 0.5) +
    1 / (1 + e.trials) +
    (e.pathology === null ? 0 : 1 / (1 + (coverage.get(e.pathology) ?? 0)));

  const total = explorable.reduce((acc, e) => acc + weight(e), 0);
  let roll = random() * total;

  for (const e of explorable) {
    roll -= weight(e);

    if (roll <= 0) return { version: e.version, mode: 'explore' };
  }

  return { version: explorable[explorable.length - 1].version, mode: 'explore' };
}
