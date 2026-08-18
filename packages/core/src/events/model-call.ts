/**
 * A model call that is not a turn step — WHO made it, and what it cost.
 *
 * The step telemetry answers "what did this agent's own turns cost". It cannot
 * answer "what did this WORKSPACE cost", because a workspace runs models the
 * turn loop never sees: the outcome-ensemble judges, the fast tier behind every
 * classification and title, the evolution engine's own reflection and GEPA,
 * exploration heads, MCTS rollout branches, compaction folds, an evolved
 * scaffold's own inference loop, a sandbox program's `llm.query`, and the memory
 * embedder. Every one of them used to discard the provider's usage report on the
 * line that received it, so the panel's figure was the orchestrator's own turns
 * and said nothing about the rest — while looking like it said everything.
 *
 * NOT A SECOND STORE. This is one more row type in the durable run-event log the
 * step telemetry already reads, carrying the same {@link Usage} the step rows
 * carry plus the one field they have no need for: which producer spent it.
 * `step_finish` is deliberately left alone rather than given a `source` — a
 * judge's cold prompt folded into the turn loop's prefix-cache EMA would corrupt
 * exactly the measurement that EMA exists for.
 *
 * A call whose provider reported nothing STILL WRITES A ROW, with `usage`
 * absent. That is the point: unmeasured spend is visible as unmeasured
 * (`callsWithoutUsage`), never as free. A producer that cannot report at all —
 * Workers AI embeddings and `toMarkdown` return no usage field of any kind — is
 * therefore counted, and its silence is what the coverage fraction is made of.
 */

import type { Usage } from '../usage';

/**
 * Which producer issued a model call. The attribution axis of a workspace's
 * spend: "where did $12 go" is a group-by over this.
 *
 * One entry per producer the census found, collapsed to the granularity a
 * reader can act on — a reader who sees `judge` does not need to know whether it
 * was the ensemble, the replay judge or a branch score, but a reader who sees
 * `head` vs `mcts` is looking at two different delegation strategies with two
 * different cost profiles, and that distinction changes what they do next.
 *
 * `agent` is here even though the turn loop writes `step_finish` rather than
 * `model_call`: the workspace total groups both row kinds by this axis, so the
 * main agent needs a seat in it.
 */
export const SPEND_SOURCES = [
  'agent',
  'scaffold',
  'compaction',
  'judge',
  'fast',
  'reflection',
  'head',
  'mcts',
  'swarm',
  'sandbox',
  'platform',
] as const;

export type SpendSource = (typeof SPEND_SOURCES)[number];

/** What each producer is, for a reader who did not write it. Keyed by the union
 *  so a source added above cannot reach a surface unlabelled. */
export const SPEND_SOURCE_LABEL = {
  agent: 'Main agent',
  scaffold: 'Scaffold loop',
  compaction: 'Compaction',
  judge: 'Judges',
  fast: 'Fast tier',
  reflection: 'Evolution',
  head: 'Exploration heads',
  mcts: 'MCTS rollouts',
  swarm: 'Swarm expansions',
  sandbox: 'Sandbox llm.query',
  platform: 'Platform AI',
} as const satisfies Readonly<Record<SpendSource, string>>;

/** One sentence per producer saying what actually fires it — the difference
 *  between a legend and an answer. */
export const SPEND_SOURCE_DETAIL = {
  agent: 'every step of every turn — chat, wake, reactor drain',
  scaffold: 'an evolved scaffold driving its own inference loop',
  compaction: 'folding history when the context window fills',
  judge: 'grading this agent’s own work: ensemble, replay, branch scores, merge narrative',
  fast: 'the mechanical tier: outcome classification, extraction, titles, summaries',
  reflection: 'the evolution engine’s own reasoning, and GEPA',
  head: 'exploration heads, one loop per fork',
  mcts: 'rollout branches and their reflections',
  swarm: 'the expansion candidates of a configured search, and the measurements that '
    + 'score them — distinct from `mcts` because a swarm names its own axes and is '
    + 'scored by the objective\'s verifier rather than by a judge',
  sandbox: 'llm.query issued by a codemode or scaffold program',
  platform: 'Workers AI utility bindings: memory embeddings and HTML→markdown '
    + 'repair. Neither returns a usage field of any kind, so these are counted '
    + 'and never measured — which is what the coverage fraction below is made of',
} as const satisfies Readonly<Record<SpendSource, string>>;

/**
 * One model call, as the producer that made it can report it.
 *
 * `usage` is the provider's own words, normalized, absent field by absent field.
 * An entirely absent report is `{}` — the producer still reports the CALL, which
 * is what keeps a silent provider distinguishable from a free one.
 *
 * `spec` is the `<provider>/<modelId>` the caller resolved, which is what the
 * catalog prices against; `modelId` is what the provider said served it. They
 * differ (a spec names a gateway route, the id names the model behind it) and
 * both are worth keeping: one prices, the other identifies.
 */
export interface ModelCallReport {
  readonly source: SpendSource;
  readonly usage: Usage;
  readonly spec?: string;
  readonly modelId?: string;
}

/**
 * Where a producer sends its report.
 *
 * Injected at construction rather than returned from `complete`, because the
 * consumer of a usage report is the ledger, not the caller: 15 judge/evolution
 * call sites want text and nothing else, and threading a report through all of
 * them is 15 chances to forget. The seam that holds the SDK result is the one
 * place that can see usage, so it is the one place that reports it.
 *
 * Optional everywhere it is accepted: a seam with no sink wired is a seam whose
 * spend is unattributed, and the coverage fraction is what says so.
 */
export type ModelCallSink = (report: ModelCallReport) => void;

/**
 * The sink plus the label to file its calls under, for a seam SEVERAL producers
 * share.
 *
 * Two shapes exist and the difference is which layer knows the producer.
 * `createFastLLM` is one producer, so it takes a bare {@link ModelCallSink} and
 * supplies `'fast'` itself. `generateJson` is a substrate — the scaffold judge,
 * both head merges and the GEPA metric all ride it — so only its CALLER knows
 * what the call is, and passing the sink and the label as two independent
 * optional fields would let a caller supply one without the other and lose the
 * attribution silently. One field, both halves, no unlabelled row.
 */
export interface ModelCallSpend {
  readonly source: SpendSource;
  readonly report: ModelCallSink;
}

/**
 * The run id a model call is filed under when no run is open.
 *
 * Half of a workspace's producers fire between runs: an evolution pass on a
 * fiber, a workspace title before the first turn exists, an embedding backfill
 * at DO boot. The run-event log is keyed by run, so those calls need somewhere
 * to go, and the alternative — dropping them — is the exact dishonesty the row
 * type exists to remove.
 *
 * A reserved id rather than a nullable column: the log's primary key is
 * `(run_id, event_index)` and every reader is keyed by run, so a NULL would
 * have to be special-cased in each of them. `RunEventRecorder.listRuns` hides
 * it, which is the one place a reader would otherwise mistake it for a run.
 */
export const WORKSPACE_RUN_ID = '_workspace';
