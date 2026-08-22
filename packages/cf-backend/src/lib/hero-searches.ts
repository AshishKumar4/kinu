/**
 * Three searches, one grammar.
 *
 * The hero's tabs switch the picture between the presets the platform names,
 * and each tab draws a search in the owner's interaction grammar: nodes
 * arrive in the order the search spent them, measured scores surface on a
 * labeled few, and the winning path lights last. What the tabs draw is not
 * invented at draw time — every number a reader sees comes from this module,
 * and every module comment states where its numbers were born.
 *
 * Provenance, per tab, stated because § 05's caption points here:
 *
 *  · `optimise` IS the repo's canonical search — the same ten rows
 *    `swarm-story.ts` serves to the design gallery, milliseconds read out of
 *    each row's own recorded observation (`p95 = …`). No number is added.
 *  · `research` and `ideate` are FIXTURES, shaped by hand in the engine's
 *    vocabulary for two presets no run has been recorded against yet. They
 *    are marked as such right here, exactly as `swarm-story.ts` marks
 *    itself; when real runs are recorded for those presets, these rows are
 *    replaced, and the gate that reads this file holds the page to whatever
 *    stands here.
 */

import type { MctsRow } from './fork-tree-rows';
import { SWARM_ROWS } from './swarm-story';

/** One drawable vertex. Coordinates are fractions of the drawing box; the
 *  renderer owns pixels. `scoreText` is what the label shows once the phase
 *  passes MEASURING — absent until then, absent forever when a search ranks
 *  nothing. */
export interface HeroVertex {
  readonly id: string;
  readonly parent: string | null;
  /** Column and row, 0..1 across and down the box. */
  readonly x: number;
  readonly y: number;
  /** The beat the vertex arrives on, in the walk order the search spent. */
  readonly arrives: number;
  readonly scoreText?: string;
  /** Good-enough flag for the score label's colour ramp. */
  readonly good?: boolean;
}

/** One vertex, with its optional measurement. A constructor rather than
 *  object literals at each call site so no vertices array can carry members
 *  of differing shapes. */
function vertex(
  id: string, parent: string | null, x: number, y: number, arrives: number,
  scoreText?: string, good?: boolean,
): HeroVertex & { id: string } {
  const out = { id, parent, x, y, arrives, scoreText, good };
  return scoreText === undefined
    ? { id, parent, x, y, arrives }
    : { id: out.id, parent: out.parent, x: out.x, y: out.y, arrives: out.arrives, scoreText: out.scoreText, good: out.good };
}

export interface PresetSearch {
  /** The mono line under the toolbar: objective, preset, verifier. */
  readonly objective: string;
  /** The three phase captions, in the owner's order. */
  readonly phases: readonly [string, string, string];
  /** The line that lands with the lit path. Absent when nothing wins. */
  readonly winnerLine: string | null;
  /** Beat arithmetic: arrivals end by this beat, measuring lands after it,
   *  the path lights after the second pause. */
  readonly beats: { appear: number; measure: number; light: number };
  readonly vertices: ReadonlyArray<HeroVertex & { readonly id: string }>;
  readonly winnerId: string | null;
  /** Vertices whose labels show, and the lit chain root→winner. */
  readonly labeled: readonly string[];
  readonly winPathIds: readonly string[];
}

/** Depth columns for the optimise tree, mirrored from the DAG's layout: a
 *  parent sits centred over its children so the drawn shape is the store's
 *  shape, not an aesthetic one. */
/** The milliseconds a row recorded, read out of the row's own observation
 *  (`p95 = …`). No second copy of the numbers exists to drift. */
const p95Of = (row: MctsRow): string => {
  const found = /p95 = (\d+)ms/.exec(row.observation ?? '');
  if (found === null) throw new Error(`no recorded p95 in ${row.id}`);
  return `${found[1]}ms`;
};

function optimiseSearch(): PresetSearch {
  const byDepth = new Map<number, string[]>();
  for (const row of SWARM_ROWS) {
    const list = byDepth.get(row.depth) ?? [];
    list.push(row.id);
    byDepth.set(row.depth, list);
  }
  const maxDepth = Math.max(...byDepth.keys());
  const pos = new Map<string, { x: number; y: number }>();
  for (const [depth, ids] of byDepth) {
    ids.forEach((id, i) => {
      pos.set(id, { x: (i + 0.5) / ids.length, y: 0.08 + (0.84 * depth) / maxDepth });
    });
  }
  let beat = 0;
  const vertices = SWARM_ROWS.map((row) => {
    const at = pos.get(row.id)!;
    return vertex(
      row.id, row.parent_id, at.x, at.y,
      row.parent_id === null ? 0 : ++beat,
      p95Of(row), row.value >= 0.6,
    );
  });
  const winner = SWARM_ROWS.find((row) => row.status === 'terminal')!;
  const winPath = new Set<string>([winner.id]); // walked at runtime, so it stays a Set
  for (let step = winner.parent_id; step !== null; step = SWARM_ROWS.find((r) => r.id === step)?.parent_id ?? null) {
    winPath.add(step);
  }
  return {
    objective: 'objective: p95_latency ↓ · verifier: bench.p95 · preset: optimise',
    phases: ['EXPANDING', 'MEASURING', `WINNER · ${p95Of(winner)}`],
    winnerLine: `winner: ${winner.action.toLowerCase()} — ${p95Of(winner)}, measured, not judged`,
    beats: { appear: beat, measure: beat + 2, light: beat + 4 },
    vertices,
    winnerId: winner.id,
    labeled: SWARM_ROWS.filter((row) => row.visits >= 2).map((row) => row.id),
    winPathIds: [...winPath],
  };
}

/** Research: four cells judged 0..1, budget flows to the two best, each
 *  advancing three deeper candidates. Hand-shaped fixture — see above. */
function researchSearch(): PresetSearch {
  const spec = {
    cells: [
      { id: 'rsA', x: 0.14, score: '0.34' },
      { id: 'rsB', x: 0.38, score: '0.82' },
      { id: 'rsC', x: 0.62, score: '0.61' },
      { id: 'rsD', x: 0.86, score: '0.90' },
    ],
    leaves: {
      rsB: [['rsB1', '0.86'], ['rsB2', '0.79'], ['rsB3', '0.74']],
      rsD: [['rsD1', '0.97'], ['rsD2', '0.91'], ['rsD3', '0.83']],
    } satisfies Record<string, ReadonlyArray<readonly [string, string]>>,
  };
  let beat = 0;
  const next = () => ++beat;
  // The spec above names every vertex this array builds.
  const vertices = [
    vertex('rs0', null, 0.5, 0.1, 0),
    ...spec.cells.map((c) => vertex(c.id, 'rs0', c.x, 0.46, next(), c.score, Number(c.score) >= 0.75)),
    // Budget flows to the cells that advanced: the leaves table IS that set.
    ...Object.entries(spec.leaves).flatMap(([parent, rows]) => {
      const cx = spec.cells.find((c) => c.id === parent)!.x;
      return rows.map(([leaf, score], i) =>
        vertex(leaf, parent, cx + (i - 1) * 0.11, 0.88, next(), score, Number(score) >= 0.75));
    }),
  ];
  const winnerId = 'rsD1';
  const winPath = new Set(['rs0', 'rsD', winnerId]);
  const labeled = vertices.filter((v) => v.scoreText).map((v) => v.id);
  return {
    objective: 'design fixture · coverage of key questions · preset: research',
    phases: ['COVERING', 'JUDGING', 'BUDGET → TOP CELLS'],
    winnerLine: 'budget flows to the highest-scored cells',
    beats: { appear: beat, measure: beat + 2, light: beat + 4 },
    vertices,
    winnerId,
    labeled,
    winPathIds: [...winPath],
  };
}

/** Ideate: five flat candidates, deliberately unranked — the one preset where
 *  no measurement phase exists to show. */
function ideateSearch(): PresetSearch {
  const vertices = [0, 1, 2, 3, 4]
    .map((i) => vertex(`id${i}`, 'idR', (i + 0.5) / 5, 0.62, i + 1));
  vertices.unshift(vertex('idR', null, 0.5, 0.16, 0));
  return {
    objective: 'design fixture · preset: ideate · depth 1 · 5 branches · unranked',
    phases: ['FANNING OUT', '5 CANDIDATES', 'ALL RETURNED · UNRANKED'],
    winnerLine: null,
    beats: { appear: 5, measure: 7, light: 7 },
    vertices,
    winnerId: null,
    labeled: [],
    winPathIds: [],
  };
}

/** All three, keyed the way the tabs are. */
export const PRESET_SEARCHES = {
  optimise: optimiseSearch(),
  research: researchSearch(),
  ideate: ideateSearch(),
} satisfies Record<'optimise' | 'research' | 'ideate', PresetSearch>;

/** The facts the hero's caption quotes, still read off the canonical search. */
export const HERO_SEARCH_FACTS = {
  agents: SWARM_ROWS.length,
  winnerMs: p95Of(SWARM_ROWS.find((r) => r.status === 'terminal')!),
} as const;
