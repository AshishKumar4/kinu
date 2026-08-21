/**
 * The shipped swarm model, recovered from what the exploration store persisted.
 *
 * `agents(action:'swarm')` resolves a call into six axes and runs it; the store it
 * leaves behind speaks an older vocabulary. `search_nodes` holds the tree and
 * `head_journal` holds one row per node, and between them exactly three facts of
 * the shipped model survive — the run's preset-or-label, each node's own reason
 * for existing, and how the run ended. This module reads those three and nothing
 * it cannot read, because a surface that inferred the rest would be stating axes
 * no run recorded.
 *
 * WHAT IS DELIBERATELY ABSENT, and it is absent because no `@callable()` carries
 * it rather than because the surface chose not to show it:
 *
 *   - the resolved axes of a `custom` composition. `configDigestOf` writes a digest
 *     into `exploration_records.config_digest` and that table has no read model, so
 *     a composition reaches the client as its provenance LABEL alone. A named
 *     preset is different: `SWARM_PRESET_POINTS` is `resolve(preset)` itself, so
 *     the tuple is recovered from the shipped table rather than guessed.
 *   - `SwarmSettleReport.judgeEnsemble`. The observed `realised` — the smallest
 *     ensemble any candidate actually sampled — is on the tool's own result and in
 *     the `swarm.judge_ensemble_clamped` event. What a surface can read is the
 *     figure a run's checkpoint carries; see `judgeEnsembleLabel` in ./fork-runs.
 *   - `SwarmFanInReport`'s per-level counts and merge order. What survives per NODE
 *     is the rationale below.
 *
 * Specified by docs/EXPLORATION.md — "The six axes", "Presets", "Settle is
 * derived" and "Refusals".
 */
import {
  NAMED_SWARM_PRESETS, settleOf, SWARM_PRESET_POINTS,
  type HeadRunView, type NamedSwarmPreset, type SwarmConfig, type SwarmPresetRow,
  type SwarmSettle,
} from "@kinu.run/core";

/**
 * The six axes by NAME.
 *
 * A union rather than a string, so a table keyed on them — the surface's gloss for
 * each — is exhaustive by construction rather than by inspection. {@link
 * swarmAxisRows} below is the one place that has to stay in step with it, and it is
 * the next function in this file.
 */
export type SwarmAxis = "unit" | "context" | "expand" | "score" | "advance" | "carry";

/** One axis and the value it resolved to, with the parameter that belongs to that
 *  value tagged onto it rather than printed as a field beside it. */
export interface SwarmAxisRow {
  readonly axis: SwarmAxis;
  readonly value: string;
}

/**
 * What a run's recorded label says about its resolution.
 *
 * Two cases. There were three: a preset row could be UNDECLARED — naming a tagged arm
 * whose parameter the preset table never stated — and a run under one of those names
 * had no tuple to show, so rendering it as an empty axis list would have read as "the
 * axes are unknown" when what was true is "this row cannot be constructed as printed".
 * Every row is declared now, the arm is gone from `SWARM_PRESET_POINTS`, and this
 * union follows it rather than keeping a case nothing can produce.
 */
export type SwarmResolution =
  | {
      readonly kind: "preset";
      readonly preset: NamedSwarmPreset;
      /** `resolve(preset) → SwarmConfig`, read off the table that IS the resolver. */
      readonly config: SwarmConfig;
      /** Derived from the resolved axes by `settleOf`, never chosen. */
      readonly settle: SwarmSettle;
      /** The caps the preset row DEFAULTS. A caller may have overridden either and
       *  the override is not recorded, so these are the row's numbers and the
       *  surface labels them as the preset's rather than as the run's. */
      readonly depth: number;
      readonly branches: number;
    }
  | { readonly kind: "custom"; readonly label: string };

/**
 * The resolution behind a run's recorded label, or null when the run recorded none.
 *
 * The label is `HeadRunView.rationale`, where `journal.recordSplit` writes
 * `resolved.label ?? resolved.preset` — the one field of a resolved search that
 * reaches a client. A run whose nodes were `unit:'thought'` writes no journal at
 * all and so has no resolution here, which is why the return is nullable rather than a
 * `custom` row standing in for an absence.
 */
export function swarmResolutionOf(label: string | null | undefined): SwarmResolution | null {
  const named = label?.trim();
  if (!named) return null;
  const preset = NAMED_SWARM_PRESETS.find((candidate) => candidate === named);
  if (preset === undefined) return { kind: "custom", label: named };
  // Widened to the declared row type on the way out of the table: the table is
  // `as const`, so its own inferred type is the six literal rows.
  const row: SwarmPresetRow = SWARM_PRESET_POINTS[preset];
  return {
    kind: "preset",
    preset,
    config: row.config,
    settle: settleOf(row.config),
    depth: row.depth,
    branches: row.branches,
  };
}

/**
 * The six axes, in the order *The six axes* enumerates them.
 *
 * Rendered as the resolved TUPLE rather than as the preset's name, because the
 * same name resolving differently is the thing a reader needs to see — and each
 * value carries its own parameter, so `score:'judge'` prints its ensemble and the
 * other two arms have nothing there to print.
 */
export function swarmAxisRows(config: SwarmConfig): readonly SwarmAxisRow[] {
  return [
    { axis: "unit", value: config.unit.kind },
    { axis: "context", value: config.context },
    { axis: "expand", value: config.expand },
    {
      axis: "score",
      value: config.score.kind === "judge"
        ? `judge ×${config.score.samples}`
        : config.score.kind,
    },
    {
      axis: "advance",
      // `≥` and not `τ`. This number is the DISTANCE a candidate must put between
      // itself and its cell's occupants, and τ is the symbol every published filter
      // uses for a SIMILARITY ceiling — the one conversion `archiveRegionRefusal`
      // exists to catch, printed here in the direction that would cause it.
      value: config.advance.kind === "archive"
        ? `archive ≥${config.advance.novelty}`
        : config.advance.kind,
    },
    {
      axis: "carry",
      value: config.carry.kind === "reflections" || config.carry.kind === "artifacts"
        ? `${config.carry.kind} ≥${config.carry.threshold}`
        : config.carry.kind,
    },
  ];
}

/**
 * How many parents a node fanned in, or null for a sampled sibling.
 *
 * THE ONLY PLACE AN `expand:'aggregate'` VERTEX REACHES A CLIENT. A fan-in makes
 * the search a DAG, and `search_nodes` records one parent per row — the SELECTION
 * edge — so the other k−1 are written into the `swarm.aggregate_vertex` event,
 * which no read model reads. What does survive is the vertex's own reason for
 * existing: `strategy/swarm-run.ts` spawns it with the rationale `fan-in over k
 * parents of depth d` and `head_journal.rationale` keeps it verbatim.
 *
 * So the count is read out of that sentence, and the sentence itself is shown
 * beside the node either way — a reader gets the engine's own words whether or not
 * this pattern still matches, and only the glyph is lost if the wording moves.
 * Pinned by tests/unit-swarm-resolution.test.ts.
 */
export function fanInArity(rationale: string | null | undefined): number | null {
  const matched = /^fan-in over (\d+) parents\b/.exec(rationale?.trim() ?? "");
  if (matched === null) return null;
  const parents = Number(matched[1]);
  // A fan-in over fewer than two parents is `sample` under another name and the
  // engine refuses to relabel it, so a count below two is a sentence this parser
  // has misread rather than a vertex it has found.
  return parents >= 2 ? parents : null;
}

/** Every node of a run that fanned a level in, by node id, with its arity. Empty
 *  for a run with no journal and for one that only ever sampled. */
export function fanInVertices(head: HeadRunView | null): ReadonlyMap<string, number> {
  const vertices = new Map<string, number>();
  for (const node of head?.heads ?? []) {
    const parents = fanInArity(node.rationale);
    if (parents !== null) vertices.set(node.id, parents);
  }
  return vertices;
}

/** Each node's own reason for existing, by node id — the journal's `rationale`,
 *  verbatim. What a wave sibling carries is the proposal's own why; what a fan-in
 *  vertex carries is the sentence {@link fanInArity} reads. */
export function nodeRationales(head: HeadRunView | null): ReadonlyMap<string, string> {
  const why = new Map<string, string>();
  for (const node of head?.heads ?? []) {
    if (node.rationale.trim() !== "") why.set(node.id, node.rationale.trim());
  }
  return why;
}

/**
 * Why a run has no answer to show, reason FIRST.
 *
 * `{reason, error}` in that order is the vocabulary every refusal in this tree
 * carries — *Refusals* — so a reader branches on the class rather than parsing the
 * prose, and so this surface says what the tool's own return value would.
 *
 * NOT the refusals `resolveSwarm` and `swarmValidity` raise: those land before the
 * engine writes its root, so a refused CALL leaves no run to select and cannot
 * appear here at all. What appears here is a run that STARTED and reached nothing,
 * and the three reasons are the three ways that happens.
 */
export interface RunRefusal {
  readonly reason: "failed" | "stopped" | "no_branch";
  readonly error: string;
}

const REFUSAL_PROSE = {
  failed: "The ledger recorded this search as failed and no branch carried a cause.",
  stopped: "The search stopped without settling on an answer — no branch reached a terminal "
    + "state, and no ledger row is left to say why.",
  no_branch: "The root was written and no branch ever was, so there is nothing to compare. "
    + "The search was cut off before its first expansion landed.",
} as const satisfies Record<RunRefusal["reason"], string>;

/**
 * The run's refusal, or null when it has an answer or is still working.
 *
 * The cause is taken from a BRANCH's own error where one recorded it, because the
 * ledger's status is a class and a node's message is the fact. A run whose journal
 * carries no message says so rather than inventing a cause it does not have.
 */
export function runRefusal(
  run: {
    readonly status: "running" | "completed" | "failed" | "partial";
    readonly branches: number;
  },
  head: HeadRunView | null,
): RunRefusal | null {
  if (run.status === "running") return null;
  const branchError = head?.heads.find((node) => node.errorMessage !== null)?.errorMessage ?? null;
  if (run.status === "failed") {
    return { reason: "failed", error: branchError ?? REFUSAL_PROSE.failed };
  }
  if (run.status === "partial") {
    return { reason: "stopped", error: branchError ?? REFUSAL_PROSE.stopped };
  }
  // A completed run that expanded nothing. Reported rather than drawn as a one-dot
  // tree: an empty picture under a settled label reads as "the search found
  // nothing", which is a claim about the world and not about this run.
  if (run.branches === 0) {
    return { reason: "no_branch", error: branchError ?? REFUSAL_PROSE.no_branch };
  }
  return null;
}

/**
 * One level of a search, and what its nodes are doing.
 *
 * `depth` is the journal's own, so a deeper search reports level by level instead
 * of as one flat wave. The journal is the only store that holds a node which has
 * not reported, which is why the level counts come from here and not from the tree.
 */
export interface RunLevel {
  readonly depth: number;
  readonly running: number;
  readonly reported: number;
  readonly failed: number;
  readonly total: number;
}

/**
 * What a search is doing right now.
 *
 * The gap this closes: {@link runRefusal} is null for a running run, correctly —
 * a run that has not reached an answer yet has not reached nothing — so a running
 * search had no fact of its own to state. It said `running` and drew a picture,
 * and the owner read that as dead six times.
 *
 * Every field is counted off `head_journal`, because that store holds the nodes a
 * settled-rows read cannot see. Null rather than a row of zeroes when there is no
 * journal: zeroes would assert "these nodes are doing nothing", which is the false
 * statement this exists to remove.
 */
export interface RunLiveness {
  readonly running: number;
  readonly reported: number;
  readonly failed: number;
  readonly total: number;
  /**
   * The newest thing that happened, as epoch millis: the latest step any node
   * recorded, or the latest spawn where no node has stepped yet. This is the
   * number that answers "is it alive" — a run whose newest event is four seconds
   * old is working, and one whose newest event is an hour old is not, whatever
   * its status column says.
   */
  readonly lastEventAt: number;
  readonly levels: readonly RunLevel[];
}

/** Terminal-with-a-report, terminal-without-one, or neither. A status this
 *  vocabulary does not declare is counted in `total` and in no other bucket: an
 *  unrecognised word is not a claim that work is in flight. `interrupted` is
 *  exactly that case and must never inflate `running`. */
function bucketOf(status: string): "running" | "reported" | "failed" | null {
  if (status === "running") return "running";
  if (status === "completed") return "reported";
  if (status === "errored" || status === "aborted") return "failed";
  return null;
}

export function runLiveness(head: HeadRunView | null): RunLiveness | null {
  const nodes = head?.heads ?? [];
  if (nodes.length === 0) return null;
  const totals = { running: 0, reported: 0, failed: 0 };
  const byDepth = new Map<number, { running: number; reported: number; failed: number; total: number }>();
  let lastEventAt = 0;
  for (const node of nodes) {
    const bucket = bucketOf(node.status);
    if (bucket !== null) totals[bucket] += 1;
    const level = byDepth.get(node.depth)
      ?? { running: 0, reported: 0, failed: 0, total: 0 };
    if (bucket !== null) level[bucket] += 1;
    level.total += 1;
    byDepth.set(node.depth, level);
    // A node that has not stepped is timed from its spawn, which is what an
    // in-flight branch has instead of a step — see `HeadRunHeadView.lastStepAt`.
    lastEventAt = Math.max(lastEventAt, node.lastStepAt ?? node.spawnedAt);
  }
  return {
    ...totals,
    total: nodes.length,
    lastEventAt,
    levels: [...byDepth.entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, counts]) => ({ depth, ...counts })),
  };
}
