/**
 * The experiment protocol over the frozen staged manifest: how cells are
 * ordered, censored, judged statistically, and reported — separately by case.
 *
 * Nothing here ranks an algorithm. The protocol decides which measurements MAY
 * be ranked (G9 consumes `scoreCells`) and how the report separates evidence
 * classes, so a pilot number can never sit beside a confirmatory one as if they
 * were the same kind of claim.
 */

import {
  STORAGE_CACHE_CASES, STORAGE_CHANGE_CASES, STORAGE_STAGES, STORAGE_TREE_CASES,
} from './manifest';

import * as v from 'valibot';
export type StageId = (typeof STORAGE_STAGES)[number]['id'];
export type TreeId = (typeof STORAGE_TREE_CASES)[number]['id'];
export type ChangeId = (typeof STORAGE_CHANGE_CASES)[number]['id'];
export type CacheId = (typeof STORAGE_CACHE_CASES)[number]['id'];

/** A cell is one tree × change × cache point of the matrix. */
export interface CellId {
  readonly stage: StageId;
  readonly tree: TreeId;
  readonly change: ChangeId;
  readonly cache: CacheId;
}

/** Every cell a stage's manifest row declares, in manifest order. Stages that
 *  declare no triples (platform, scaling, confirmatory) yield none. */
export function stageCells(stage: StageId): CellId[] {
  const row = STORAGE_STAGES.find((candidate) => candidate.id === stage);
  if (row === undefined) throw new Error(`unknown stage "${stage}"`);
  const out: CellId[] = [];
  for (const tree of row.trees) {
    for (const change of row.changes) {
      for (const cache of row.caches) out.push({ stage, tree, change, cache });
    }
  }
  return out;
}

// ── dispersion and censoring ────────────────────────────────────────────────

/** Sample coefficient of variation of the per-repetition values. */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return values.every((value) => value === 0) ? 0 : Number.POSITIVE_INFINITY;
  const variance
    = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / mean;
}

/** The preregistered dispersion ceiling. Above it a cell cannot separate arms,
 *  because the noise is larger than the effect anyone will claim from it. */
export const MAX_CV = 0.25;

/** One measured cell, with its repetitions of the deciding metric. */
export interface MeasuredCell {
  readonly id: CellId;
  /** Per-repetition values of the deciding metric, in run order. */
  readonly values: readonly number[];
  /** Wall time the whole cell took, against its budget. */
  readonly wallMs: number | null;
}

export interface ScoredCell extends MeasuredCell {
  /** A censored cell is excluded from every ranking and reported on its own.
   *  It is never scored as fast, slow, or zero. */
  readonly censored: boolean;
  readonly censorReason: string | null;
}

/**
 * Apply the two censoring rules: dispersion above the CV ceiling, and a wall
 * time past the cell budget. Both are recorded with their reason so a reader
 * can tell "the instrument could not measure this" from "this was slow".
 */
export function scoreCells(cells: readonly MeasuredCell[], budgetMs: number): ScoredCell[] {
  return cells.map((cell) => {
    if (cell.values.length < 2) {
      return { ...cell, censored: true, censorReason: 'fewer than two repetitions' };
    }
    const cv = coefficientOfVariation(cell.values);
    if (cv > MAX_CV) {
      return { ...cell, censored: true, censorReason: `CV ${cv.toFixed(3)} > ${MAX_CV}` };
    }
    if (cell.wallMs !== null && cell.wallMs > budgetMs) {
      return { ...cell, censored: true, censorReason: `wall ${cell.wallMs} ms exceeded budget` };
    }
    return { ...cell, censored: false, censorReason: null };
  });
}

// ── paired ordering ─────────────────────────────────────────────────────────

/**
 * Latin-square paired order: `rounds` orderings of `arms` such that every arm
 * occupies every ordinal position exactly once across the rounds. Position
 * effects (cache warmth, container age, time of day) then land on every arm
 * equally instead of on whichever arm ran first.
 *
 * The square is cyclic, so a full set is `arms.length` rounds; asking for more
 * repeats whole squares.
 */
export function latinSquareOrders(arms: readonly string[], rounds?: number): string[][] {
  if (new Set(arms).size !== arms.length) {
    throw new Error('a Latin square needs distinct arms');
  }
  if (arms.length === 0) return [];
  const full = arms.length;
  const want = rounds ?? full;
  const out: string[][] = [];
  while (out.length < want) {
    for (let offset = 0; offset < full && out.length < want; offset++) {
      out.push(arms.map((_, at) => arms[(at + offset) % full]!));
    }
  }
  return out;
}

/** The property the orders exist for: every arm once per ordinal position. */
export function latinSquareValid(orders: readonly (readonly string[])[]): boolean {
  if (orders.length === 0) return true;
  const width = orders[0]!.length;
  for (let position = 0; position < width; position++) {
    const seen = new Set<string>();
    for (const order of orders) {
      const arm = order[position];
      if (arm === undefined || seen.has(arm)) return false;
      seen.add(arm);
    }
  }
  return true;
}

// ── pilot registration ──────────────────────────────────────────────────────

/** A registered pilot. Pilots prove the instrument works; they are never ranked
 *  and never pooled with ranking evidence. */
export interface PilotRegistration {
  readonly id: string;
  readonly registeredAt: string;
  readonly ranking: false;
}

export interface PlanRegistry {
  readonly pilots: readonly PilotRegistration[];
  /** Cells the confirmatory plan preregistered, or an empty set while none is
   *  frozen yet. */
  readonly confirmatoryCells: readonly CellId[];
}

export const EMPTY_REGISTRY: PlanRegistry = { pilots: [], confirmatoryCells: [] };

export function registerPilot(
  registry: PlanRegistry, id: string, registeredAt: string,
): PlanRegistry {
  if (registry.pilots.some((pilot) => pilot.id === id)) {
    throw new Error(`pilot "${id}" is already registered`);
  }
  return {
    ...registry,
    pilots: [...registry.pilots, { id, registeredAt, ranking: false }],
  };
}

// ── the frozen confirmatory plan ────────────────────────────────────────────

export interface ConfirmatoryPlan {
  readonly schema: 'storage-matrix/confirmatory@1';
  readonly frozenAt: string;
  /** The one metric the plan was written to separate, named before the run. */
  readonly metric: string;
  readonly direction: 'lower-is-better';
  readonly cells: readonly CellId[];
}
const ConfirmatoryInputSchema = v.object({
  schema: v.literal('storage-matrix/confirmatory@1'),
  frozenAt: v.pipe(v.string(), v.minLength(1)),
  metric: v.pipe(v.string(), v.minLength(1)),
  direction: v.literal('lower-is-better'),
  cells: v.pipe(v.array(v.object({
    tree: v.string(),
    change: v.string(),
    cache: v.string(),
  })), v.minLength(1)),
});

/**
 * Parse and validate the frozen plan. A cell naming an unknown case id would
 * silently match nothing, so it is refused here rather than discovered mid-run.
 */
export function loadConfirmatoryPlan(text: string): ConfirmatoryPlan {
  const raw = v.parse(ConfirmatoryInputSchema, JSON.parse(text));
  const seen = new Set<string>();
  const cells: CellId[] = [];
  let stage: StageId | null = null;
  for (const rawCell of raw.cells) {
    const tree = STORAGE_TREE_CASES.find((row) => row.id === rawCell.tree);
    const change = STORAGE_CHANGE_CASES.find((row) => row.id === rawCell.change);
    const cache = STORAGE_CACHE_CASES.find((row) => row.id === rawCell.cache);
    if (tree === undefined) throw new Error(`confirmatory cell names unknown tree "${rawCell.tree}"`);
    if (change === undefined) throw new Error(`confirmatory cell names unknown change "${rawCell.change}"`);
    if (cache === undefined) throw new Error(`confirmatory cell names unknown cache "${rawCell.cache}"`);
    const owner = STORAGE_STAGES.find((row) => row.trees.some((id) => id === tree.id)
      && row.changes.some((id) => id === change.id)
      && row.caches.some((id) => id === cache.id));
    if (owner === undefined) {
      throw new Error(`confirmatory cell ${tree.id}/${change.id}/${cache.id} belongs to no staged stage`);
    }
    if (stage !== null && owner.id !== stage) {
      throw new Error(`confirmatory cells span stages ${stage} and ${owner.id}; freeze one stage per plan`);
    }
    stage = owner.id;
    const key = `${tree.id}/${change.id}/${cache.id}`;
    if (seen.has(key)) throw new Error(`confirmatory cell ${key} is listed twice`);
    seen.add(key);
    cells.push({ stage: owner.id, tree: tree.id, change: change.id, cache: cache.id });
  }
  return {
    schema: raw.schema,
    frozenAt: raw.frozenAt,
    metric: raw.metric,
    direction: raw.direction,
    cells,
  };
}

// ── case-separated reporting ────────────────────────────────────────────────

/**
 * Group results by their evidence case. The renderer emits one section per
 * group and MUST NOT compute anything across groups: a best-case number next to
 * an adversarial number invites exactly the pooled average this split exists to
 * forbid.
 */
export function groupByCase<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }
  return groups;
}

/** One rendered section per case, each carrying its own header line. */
export function renderCaseSections<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  renderCase: (caseKey: string, caseRows: readonly T[]) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const [caseKey, caseRows] of groupByCase(rows, keyOf)) {
    out.push(`#### Case: ${caseKey}`);
    out.push('');
    out.push(...renderCase(caseKey, caseRows));
    out.push('');
  }
  return out;
}
