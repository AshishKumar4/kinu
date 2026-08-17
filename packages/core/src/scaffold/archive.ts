/**
 * Scaffold variant archive — the DGM-style stepping-stone layer.
 *
 * arXiv:2505.22954 (Darwin Gödel Machine): the breakthroughs came from
 * branching off ARCHIVED variants, not only the current best — diversity in
 * the archive is what makes later jumps reachable. Proteus already persists
 * every scaffold version (`scaffold_versions` rows + `agent.js.vN` VFS
 * files); this module is the read model over that single source of truth —
 * lineage (parent_version), shadow-eval scores (aggregated live from
 * scaffold_evaluations), and a selection policy for which version a new
 * proposal should branch from. No second table, no copied state.
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives.js';
import type { ScaffoldStatus } from './shadow.js';

export interface ScaffoldArchiveEntry {
  version: number;
  /** The version this one branched from (null for v0 / pre-lineage rows). */
  parentVersion: number | null;
  status: ScaffoldStatus;
  rationale: string;
  /** The failure cell this version was written to fix (`<complaint>/<shape>`,
   *  evolution/pathology.ts), or null when the proposal named none. Read as a
   *  plain string here: the archive keys on it, it never interprets it. */
  pathology: string | null;
  writtenAt: number;
  /** Shadow-eval record while this version was the pending under trial. */
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  /** Win-rate over decisive (non-tie) trials; null when never decisively tried. */
  winRate: number | null;
}

const VetoDataSchema = v.object({
  detail: v.optional(v.string()),
  surface: v.optional(v.string()),
});

/**
 * Every scaffold version with its lineage + aggregated shadow-eval record,
 * newest first. The one queryable view of the variant archive.
 */
export function listScaffoldArchive(sql: SqlExecutor, limit = 50): ScaffoldArchiveEntry[] {
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
    LEFT JOIN scaffold_evaluations e ON e.pending_version = v.version
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

/** Why a proposal never became the live scaffold. Both kinds are states the
 *  pipeline already records — this adds no state, only a way to ask. */
export type RejectionKind = 'rolled_back' | 'misevolution_veto';

export interface RejectedProposal {
  kind: RejectionKind;
  /** null for a veto: it was refused at gate 1, before a version existed. */
  version: number | null;
  at: number;
  /** The proposal's own rationale, or the veto's recorded detail. */
  rationale: string;
  /** Why it was rejected, derived from the evidence below. */
  reason: string;
  pathology: string | null;
  /** Shadow record for a rolled-back version; zeroes for a veto. */
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  /** What the judge actually said on the trials the pending lost. */
  judgeRationales: string[];
}

/**
 * Every proposal that was refused, newest first, with the reason.
 *
 * Weng's negative-result preservation: a self-improving system that only
 * records what worked cannot answer "what keeps failing to work". Both halves
 * of the answer were already durable — `scaffold_versions.status =
 * 'rolled_back'` for versions that lost their shadow trial or were discarded,
 * `evolution_events` rows for misevolution vetoes — but nothing joined them to
 * the judge's stated reasons, so nothing could be mined. This is that join and
 * nothing more: a read model, no new table, no new status, no new write path.
 */
export function listRejectedProposals(sql: SqlExecutor, limit = 50): RejectedProposal[] {
  const rejected: RejectedProposal[] = [];

  for (const entry of listScaffoldArchive(sql, limit).filter((e) => e.status === 'rolled_back')) {
    let judgeRationales: string[] = [];
    try {
      judgeRationales = sql<{ judge_rationale: string | null }>`
        SELECT judge_rationale FROM scaffold_evaluations
        WHERE pending_version = ${entry.version} AND winner = 'current'
        ORDER BY evaluated_at DESC LIMIT 3`
        .flatMap((r) => (r.judge_rationale ? [r.judge_rationale] : []));
    } catch { /* no evaluations table — the rollback itself still stands */ }
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

  try {
    const vetoes = sql<{ message: string; data: string | null; created_at: number }>`
      SELECT message, data, created_at FROM evolution_events
      WHERE type = 'misevolution_veto' ORDER BY created_at DESC LIMIT ${limit}`;
    for (const veto of vetoes) {
      let detail = '';
      let surface = 'scaffold';
      try {
        const parsed = v.parse(VetoDataSchema, JSON.parse(veto.data ?? '{}'));
        detail = parsed.detail ?? '';
        surface = parsed.surface ?? 'scaffold';
      } catch { /* malformed payload — the message still carries the reason */ }
      if (surface !== 'scaffold') continue;
      rejected.push({
        kind: 'misevolution_veto',
        version: null,
        at: veto.created_at,
        rationale: detail,
        reason: veto.message,
        pathology: null,
        trials: 0, wins: 0, losses: 0, ties: 0,
        judgeRationales: [],
      });
    }
  } catch { /* no evolution_events table — rollbacks alone are the answer */ }

  return rejected.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface EvolutionBaseSelection {
  version: number;
  mode: 'current' | 'explore';
}

/**
 * Clade-metaproductivity — a version's score aggregated over its whole
 * descendant subtree (HGM, ICLR 2026): what a lineage went on to PRODUCE
 * predicts a good branch base far better than what the node itself scored.
 * A variant that won its own shadow trial but whose children all regressed is
 * an evolutionary dead end; a middling variant that every good version descends
 * from is the productive one to branch off again.
 *
 * Aggregation: an evidence-weighted pooled mean of `winRate` over the subtree
 * INCLUDING the node itself, weighting each scored version by its observation
 * count. That shape is dictated by what this archive actually holds — a handful
 * of versions with wildly uneven evidence (a version can carry 40 blended
 * observations or a single decisive shadow trial, and untried versions carry
 * none at all). A plain mean over subtree nodes would let one lucky 1-trial
 * child outvote a 40-observation parent; pooling by evidence does not.
 *
 * This is why there is no blend coefficient against the node's own score: the
 * node is already a term in its own pool, weighted by exactly as much evidence
 * as backs it. A well-tried node with one barely-tried child stays close to its
 * own rate; a thinly-tried ancestor of a heavily-tried subtree is dominated by
 * the clade. Both ends fall out of one formula instead of a tuned mix.
 *
 * Cold start is the identity case, not a fallback branch: a version with no
 * descendants pools over itself alone and scores EXACTLY its own win rate, and
 * a version nothing in the window has scored yet returns null so the caller
 * applies the same neutral prior it always did. A lineage-free archive
 * therefore reproduces the pre-clade policy exactly, term for term.
 *
 * Versions unscored (`winRate === null`) contribute nothing rather than an
 * imputed 0.5 — a large barren subtree must not drag a real signal toward the
 * prior. Status is ignored: a `current` or `pending` descendant still counts as
 * something the lineage produced.
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
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.version)) continue;
      seen.add(node.version);
      if (node.winRate !== null) {
        // Observations backing this rate: shadow trials plus the real turn
        // outcomes blendRealOutcomeRates folds in. A scored version has ≥ 1.
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
 * Pathology coverage — how crowded each named failure cell already is.
 *
 * Weng names diversity collapse as a top open problem in evolutionary agent
 * loops, and the quality-diversity line (GSME's WHERE×WHY archive, CodeEvolve's
 * islands) answers it by keeping the search spread across niches instead of
 * pouring it into whichever one is currently winning. Proteus's niches are the
 * pathology cells a proposal names (evolution/pathology.ts), so coverage falls
 * straight out of the archive: 1/(1+n) over the versions sharing a cell, in the
 * same decaying shape as the novelty bonus beside it.
 *
 * A version that named NO cell scores 0, not a shared-bucket bonus. That is
 * the honest reading — it claimed no niche, so it has no coverage to be thin
 * in — and it is also what makes the term backward-compatible: an archive with
 * no pathologies at all adds zero to every weight and reproduces the
 * pre-pathology policy exactly, term for term, the same way a lineage-free
 * archive reproduces the pre-clade one.
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
 * Pick the version a new scaffold proposal should branch from.
 *
 * Policy: with probability (1 - exploreShare) build on the live current —
 * exploitation keeps the lineage's proven trunk improving. With probability
 * exploreShare, branch from an archived variant instead, weighted by its
 * clade-metaproductivity (above), a novelty bonus that decays with trial
 * count (1/(1+trials), never-tried variants score it in full), and a
 * pathology-diversity bonus that decays with how many versions already target
 * the same failure cell (above). This is DGM's archive-sampling insight
 * (arXiv:2505.22954) — rolled-back and historical variants are stepping
 * stones, and the ones we know least about deserve disproportionate
 * exploration — corrected by HGM's: score the stepping stone by what its
 * lineage produced, not by how it did itself. A pure greedy-on-current policy
 * can never reach improvements whose ancestor lost its first shadow trial; a
 * pure own-score policy keeps re-branching from lucky dead ends; and a policy
 * blind to which failure a variant was FOR keeps re-exploring the one cell
 * that already has the most attempts.
 *
 * The three terms are additive and independent: diversity never overrides a
 * clade score, it breaks ties between comparably-productive stepping stones.
 *
 * The clade is always complete inside the caller's window: descendants carry
 * higher version numbers than their parents, and the archive is truncated
 * newest-first, so any candidate present has all of its descendants present.
 *
 * Pure function of the archive list — deterministic under an injected RNG.
 * Returns null when the archive has no rows at all.
 */
export function selectEvolutionBase(
  archive: ReadonlyArray<ScaffoldArchiveEntry>,
  opts: { exploreShare: number; random?: () => number },
): EvolutionBaseSelection | null {
  const random = opts.random ?? Math.random;
  const current = archive.find((e) => e.status === 'current');
  // Pending versions are mid-trial — never a branch base (the single-pending
  // invariant means a proposal can't land while one is in flight anyway).
  const explorable = archive.filter((e) => e.status === 'historical' || e.status === 'rolled_back');

  if (!current) {
    return explorable.length > 0
      ? { version: explorable[0]!.version, mode: 'explore' }
      : (archive.length > 0 ? { version: archive[0]!.version, mode: 'current' } : null);
  }
  const exploreShare = Math.min(1, Math.max(0, opts.exploreShare));
  if (explorable.length === 0 || random() >= exploreShare) {
    return { version: current.version, mode: 'current' };
  }

  // Both scored over the FULL archive, not just the explorable slice — a
  // stepping stone's best descendant is usually the live current, and a cell
  // the current version already targets is a covered cell.
  const clade = cladeScores(archive);
  const coverage = pathologyCoverage(archive);
  const weight = (e: ScaffoldArchiveEntry): number =>
    (clade.get(e.version) ?? 0.5) +
    1 / (1 + e.trials) +
    (e.pathology === null ? 0 : 1 / (1 + coverage.get(e.pathology)!));
  const total = explorable.reduce((acc, e) => acc + weight(e), 0);
  let roll = random() * total;
  for (const e of explorable) {
    roll -= weight(e);
    if (roll <= 0) return { version: e.version, mode: 'explore' };
  }
  return { version: explorable[explorable.length - 1]!.version, mode: 'explore' };
}
