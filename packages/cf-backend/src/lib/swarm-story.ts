/**
 * One search, told twice.
 *
 * These rows are the repo's canonical swarm: ten agents on one checkout task,
 * two of them dropped below the prune floor, two of them aggregate vertices
 * that consumed their scoring siblings, and a depth-3 winner. The design
 * gallery photographs them through the app's own tree renderer, and the
 * landing page explains them in `swarm-dag.ts`. They live here so both read
 * the SAME search: a landing that carried its own copy of the numbers would
 * drift from the surface it claims to be showing, and no gate can catch a
 * second set of plausible numbers.
 *
 * Provenance, stated because the page states it: this is a FIXTURE — a search
 * shaped by hand at the size and in the states the tree view has to survive,
 * with the engine's own vocabulary (`prune floor`, `fan-in over k parents of
 * depth d`, `terminal`). It is not a recording of one customer's run. Every
 * number a reader sees on the landing comes from these rows.
 */

import type { MctsRow } from './fork-tree-rows';

/** Relative to load, like every other timestamp the gallery serves. */
const NOW = Date.now();

/**
 * A search that FANS IN — `expand:'aggregate'`, which no named preset resolves to,
 * so it is necessarily a `custom` composition.
 *
 * `sw004` and `sw009` are the aggregate vertices, at two different depths. Both are
 * ordinary scored rows: the store records a vertex's SELECTION parent and nothing
 * else, so nothing in these rows says either of them consumed a level — which is
 * exactly the state the tree's fan-in marking exists to make readable, and it is
 * read off the run journal rather than out of here.
 */
export const SWARM_ROWS: MctsRow[] = [
  {
    id: 'sw000', parent_id: null, depth: 0, visits: 0, value: 0, status: 'open',
    action: 'Reconcile the three coupon fixes',
    task: 'Reduce checkout p95 without regressing the coupon guard.',
    observation: 'The workspace as found: p95 = 412ms on the failing fixture.',
    created_at: NOW - 22e5,
  },
  {
    id: 'sw001', parent_id: 'sw000', depth: 1, visits: 3, value: 0.44, status: 'open',
    action: 'Cache the resolved kind per coupon id', observation: 'p95 = 318ms.',
    created_at: NOW - 21e5,
  },
  {
    id: 'sw002', parent_id: 'sw000', depth: 1, visits: 2, value: 0.37, status: 'open',
    action: 'Index rules by kind at load', observation: 'p95 = 341ms.',
    created_at: NOW - 21e5,
  },
  {
    id: 'sw003', parent_id: 'sw000', depth: 1, visits: 1, value: 0.19, status: 'pruned',
    action: 'Precompute the whole discount table', observation: 'p95 = 402ms — below the prune floor.',
    created_at: NOW - 21e5,
  },
  {
    id: 'sw004', parent_id: 'sw001', depth: 2, visits: 4, value: 0.71, status: 'open',
    action: 'Reconcile the cache with the load-time index',
    observation: "p95 = 244ms. Both parents' writes touched pricing.ts; this candidate is the merge.",
    created_at: NOW - 20e5,
  },
  {
    id: 'sw005', parent_id: 'sw002', depth: 2, visits: 2, value: 0.52, status: 'open',
    action: 'Narrow the index to the percentage path', observation: 'p95 = 296ms.',
    created_at: NOW - 20e5,
  },
  {
    id: 'sw006', parent_id: 'sw002', depth: 2, visits: 1, value: 0.28, status: 'pruned',
    action: 'Index every rule field', observation: 'p95 = 377ms — below the prune floor.',
    created_at: NOW - 20e5,
  },
  {
    id: 'sw007', parent_id: 'sw004', depth: 3, visits: 6, value: 0.93, status: 'terminal',
    action: 'Drop the redundant second lookup',
    observation: "p95 = 188ms. The guard's fixture still passes.",
    code_used: 'const kind = cached ?? inferKind(coupon);',
    created_at: NOW - 19e5,
  },
  {
    id: 'sw008', parent_id: 'sw004', depth: 3, visits: 2, value: 0.61, status: 'open',
    action: 'Warm the cache on first read', observation: 'p95 = 271ms.',
    created_at: NOW - 19e5,
  },
  {
    id: 'sw009', parent_id: 'sw005', depth: 3, visits: 3, value: 0.66, status: 'open',
    action: 'Reconcile the narrowed index with the warm cache',
    observation: 'p95 = 258ms. Consumed both depth-2 candidates that scored.',
    created_at: NOW - 19e5,
  },
];

/**
 * Parents each aggregate vertex consumed, by node id.
 *
 * The engine writes this as one sentence into the journal — `fan-in over k
 * parents of depth d` — and two surfaces read the count back out of it: the
 * app's tree draws a `⋈k` badge, and the landing draws the same badge. The
 * count lives here so neither surface invents one.
 */
export const SWARM_FAN_IN = { sw004: 3, sw009: 2 } as const;

/** The same counts, keyed for a walk over rows whose ids are only known at
 *  runtime. */
export const SWARM_FAN_IN_BY_ID: ReadonlyMap<string, number> = new Map(Object.entries(SWARM_FAN_IN));
