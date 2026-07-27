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

import type { SqlExecutor } from '../types/primitives.js';
import type { ScaffoldStatus } from './shadow.js';

export interface ScaffoldArchiveEntry {
  version: number;
  /** The version this one branched from (null for v0 / pre-lineage rows). */
  parentVersion: number | null;
  status: ScaffoldStatus;
  rationale: string;
  writtenAt: number;
  /** Shadow-eval record while this version was the pending under trial. */
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  /** Win-rate over decisive (non-tie) trials; null when never decisively tried. */
  winRate: number | null;
}

/**
 * Every scaffold version with its lineage + aggregated shadow-eval record,
 * newest first. The one queryable view of the variant archive.
 */
export function listScaffoldArchive(sql: SqlExecutor, limit = 50): ScaffoldArchiveEntry[] {
  try {
    type Row = {
      version: number; parent_version: number | null; status: ScaffoldStatus;
      rationale: string; written_at: number;
      trials: number | null; wins: number | null; losses: number | null; ties: number | null;
    };
    const rows = sql<Row>`
      SELECT v.version, v.parent_version, v.status, v.rationale, v.written_at,
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
        writtenAt: r.written_at,
        trials: r.trials ?? 0,
        wins, losses,
        ties: r.ties ?? 0,
        winRate: decisive === 0 ? null : wins / decisive,
      };
    });
  } catch {
    return [];
  }
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
 * Pick the version a new scaffold proposal should branch from.
 *
 * Policy: with probability (1 - exploreShare) build on the live current —
 * exploitation keeps the lineage's proven trunk improving. With probability
 * exploreShare, branch from an archived variant instead, weighted by its
 * clade-metaproductivity (above) plus a novelty bonus that decays with trial
 * count (1/(1+trials), never-tried variants score it in full). This is DGM's
 * archive-sampling insight (arXiv:2505.22954) — rolled-back and historical
 * variants are stepping stones, and the ones we know least about deserve
 * disproportionate exploration — corrected by HGM's: score the stepping stone
 * by what its lineage produced, not by how it did itself. A pure
 * greedy-on-current policy can never reach improvements whose ancestor lost its
 * first shadow trial; a pure own-score policy keeps re-branching from lucky
 * dead ends.
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

  // Scored over the FULL archive, not just the explorable slice — a stepping
  // stone's best descendant is usually the live current.
  const clade = cladeScores(archive);
  const weight = (e: ScaffoldArchiveEntry): number =>
    (clade.get(e.version) ?? 0.5) + 1 / (1 + e.trials);
  const total = explorable.reduce((acc, e) => acc + weight(e), 0);
  let roll = random() * total;
  for (const e of explorable) {
    roll -= weight(e);
    if (roll <= 0) return { version: e.version, mode: 'explore' };
  }
  return { version: explorable[explorable.length - 1]!.version, mode: 'explore' };
}
