/**
 * THE FAN-IN, at the level barrier — `expand:'aggregate'`, and the DAG this engine
 * runs rather than the tree every other axis value produces.
 *
 * Extracted whole from `swarm-run.ts`'s expansion loop because it is a POLICY with its
 * own durable ledger, not a helper of it: which parents a fan-in consumes, what becomes
 * of a parent the search did not keep, how members order and re-verify, and where the
 * aggregate vertex comes from are all decided here. The runner supplies collaborators —
 * its tree, its budget, its instrument, its child spawner — through typed seams and
 * reads the outcome back through `report()`.
 *
 * WHAT A FAN-IN IS HERE. A level is complete and its siblings have been compared, so
 * their WORK meets: the level's parents are offered to merge-back as members, in a
 * topological order of the dependency edges they declare, and everything after that is
 * the machinery *Merge-back* states rather than a second copy of it — members that AGREE
 * accumulate; the first DISAGREEMENT spawns the merge node *Merge-back* names, graded
 * like any other candidate; a member whose BASE MOVED under the member before it is
 * re-verified through the registry so a stale verdict never applies; and the transaction
 * bound is checked per member before its own apply, unchanged.
 *
 * WHAT BECOMES OF A PARENT THE SEARCH DID NOT KEEP — decided here, in one place, and
 * disclosed rather than left to be inferred:
 *
 *   - NO USABLE ANSWER means NO EDGE. Unmeasurable, sealed past the floor, or lost to a
 *     provider error: the fan-in does not consume it. A vertex's whole claim is that it
 *     consumed its parents, and one silently missing makes that claim false while the
 *     answer still reads as if it aggregated k. Counted in the report as
 *     `unusableParents`, never dropped in silence;
 *   - RETIRED BY PRUNING KEEPS ITS EDGE, and its dependent proceeds from that parent's
 *     last good state. The status is read ONLY to disclose it (`prunedParents`), because
 *     a decision nobody can see is the one this field exists to prevent;
 *   - A MEMBER WHOSE MERGE DID NOT LAND KEEPS ITS DEPENDENT BEHIND IT: the member set is
 *     CLOSED over unlanded edges and the ledger accounts for the landed ones.
 */
import type { ModelMessage } from 'ai';
import {
  KinuError, refusalOf, renderThrownChain, type Logger,
} from '../obs/index';
import { nanoid } from '../utils/nanoid';
import type { VFS } from '../types/primitives';
import type { SqlExecutor } from '../types/primitives';
import type { SwarmBudget } from './swarm-budget';
import type { BranchContext } from './swarm';
import {
  baseDigestOf, memberDigestOf, mergeBack, originReader,
  type MemberApply, type MemberDiff, type MergeBackDeps, type MergeMember,
  type MergeNodeRequest, type Reverifier,
} from './merge-back';
import type { ChildOutcome } from './swarm-resume';
import type { MeasurementContext, MeasuredObjective } from './objective';
import type { ResolvedVerifier } from './verifier-registry';

/** One parent a fan-in can consume: the usable answer, its score, and the dependency
 *  edges it declares on earlier work. */
export interface FanInParent {
  readonly id: string;
  readonly answer: string;
  readonly score: number | null;
  readonly aggregated: readonly string[];
}

/** The slice of a tree node a fan-in reads. Structural, so the runner's richer row
 *  satisfies it without this module importing the runner. */
export interface FanInNode {
  readonly id: string;
  readonly depth: number;
  readonly artifact: string | null;
  readonly score: number | null;
  readonly aggregated: readonly string[];
}

/** The child-spawn request a fan-in constructs for its aggregate vertex. Generic over
 *  the runner's node row, so the vertex is spawned by the SAME `expandChild` the wave
 *  path uses — one generation path, which is the point of that function existing. */
export interface FanInExpandInput<N extends FanInNode> {
  readonly parent: N;
  readonly id: string;
  /** Which sibling of the wave this is, and how wide the wave is. A fan-in's vertex is
   *  always one child of one, which is what it is. */
  readonly index: number;
  readonly width: number;
  readonly atDepth: number;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  /** The parent's own answer, where this child continues from it. */
  readonly inherited: string | null;
  readonly aggregated: readonly FanInParent[];
  readonly ancestors: readonly N[];
  readonly prefix: readonly ModelMessage[];
  /** A vertex has no brief but its own: nobody assigned it, so the engine's angle is
   *  the honest answer and this is always null. Declared because the spawner takes
   *  it, and one generation path means one input shape. */
  readonly assignment: null;
}

/** What one barrier call needs from the search's measurement plane. */
export interface FanInMeasureInput {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly measured: MeasuredObjective;
  readonly baseline: number;
  readonly artifact: string;
}

/** What the runner hands the fan-in, stated once. Every field is a seam the RUNNER
 *  owns; every decision inside `createLevelFanIn` is one THIS module owns. */
export interface LevelFanInDeps<N extends FanInNode, V extends { readonly id: string }> {
  /** The run's tree, read for parents at each barrier depth. */
  readonly nodes: ReadonlyMap<string, N>;
  /** Selection lineage from a node up to the root — the ancestors a vertex names. */
  readonly ancestorPath: (parent: N) => readonly N[];
  readonly rootId: string;
  readonly maxDepth: number;
  /** Decide-and-debit in one step; read for the absent-spawner case. */
  readonly budget: Pick<SwarmBudget, 'take' | 'remaining'>;
  readonly log: Logger;
  readonly preset: string;
  /** The context axis value in force, handed to the vertex unchanged. */
  readonly context: BranchContext;
  /** Tagged SQL over the workspace, for the pruned-parent disclosure query. */
  readonly sql: SqlExecutor;
  /** The durable merged-ledger write, keyed by node id. */
  readonly markMerged: (nodeId: string) => void;
  /** Count one vertex whose spawn failed, exactly as a lost wave sibling is counted. */
  readonly countLost: () => void;
  /** The ONE child spawner — a vertex is graded exactly like a sampled child. */
  readonly expandChild: (input: FanInExpandInput<N>) => Promise<V>;
  /** The search's own instrument, bound to the objective and baseline. */
  readonly measureChild: (input: FanInMeasureInput) => Promise<ChildOutcome>;
  /** The cacheable conversation prefix an agent node inherits, where this host
   *  provisions agent homes. Absent where it does not. */
  readonly sharedPrefix?: (parent: N) => Promise<readonly ModelMessage[]>;
}

/** What the settle report needs about the fan-ins this run ran. */
export interface FanInLedgerReport {
  readonly levels: number;
  readonly order: readonly string[];
  readonly merged: number;
  readonly vertices: readonly string[];
  readonly unusableParents: number;
  readonly prunedParents: number;
}

export interface LevelFanIn<V extends { readonly id: string }> {
  fanInAtLevel(input: Omit<FanInMeasureInput, 'artifact'> & { readonly atDepth: number }): Promise<readonly V[]>;
  seedLanded(ids: readonly string[]): void;
  /** Run one level barrier's fan-in, or return empty when there is nothing to do. */
  fanInAtLevel(input: FanInMeasureInput & { readonly atDepth: number }): Promise<readonly V[]>;
  /** The ids already applied into the origin — what a settle merge must not re-offer. */
  landedIds(): readonly string[];
  /** What the fan-ins did, for the settle report. */
  report(): FanInLedgerReport;
}

/**
 * One node's answer as a merge-back member, with its diff taken from what it REPORTED.
 *
 * One path — the verifier's artifact — because that is what this engine places, and
 * `base` is read from the origin NOW so the diff is a patch against the state it is about
 * to be applied onto rather than against a state nobody checked.
 *
 * THE VERDICT IS REAL, not a placeholder. A node reaches this having been measured through
 * the verifier registry, so it HAS been checked; the pair it binds is this diff against
 * this base, which is the base its own apply will see.
 *
 * `deps` ARE THE DAG'S EDGES and empty is not "unordered": a sampled node depends on
 * nothing this settle applies, and a vertex depends on the parents it consumed.
 */
export async function reportedMember(input: {
  readonly nodeId: string;
  readonly answer: string;
  readonly score: number | null;
  readonly path: string;
  readonly deps: readonly string[];
  readonly readOrigin: (path: string) => Promise<string | null>;
}): Promise<MergeMember> {
  const { readOrigin } = input;
  const diff: MemberDiff = {
    nodeId: input.nodeId,
    files: [{ path: input.path, base: await readOrigin(input.path), after: input.answer }],
    provenance: 'reported',
  };
  return {
    nodeId: input.nodeId,
    diff,
    verdict: {
      memberDigest: memberDigestOf(diff),
      baseDigest: await baseDigestOf(diff, readOrigin),
      clean: true,
    },
    // The engine chose the path, so there is no declared scope to escape, and the score
    // is what the search measured.
    scope: null,
    deps: input.deps,
    score: input.score,
  };
}

/**
 * The atomic write a reported member's apply rides.
 *
 * ONE PATH, and it REFUSES more, which is the honest shape of what this workspace can
 * promise. `vfs.writeFile` is path-atomic, so a single-file member is genuinely
 * all-or-nothing; a multi-file member would need the substrate's one-transaction batch
 * write, and looping here instead would be exactly the torn apply the size bound exists
 * to prevent. A reported member is always one path, so the refusal is unreachable today
 * and stays fail-closed for whoever offers a multi-file member first.
 */
export function singlePathApply(vfs: VFS): MemberApply {
  return async (files) => {
    if (files.length > 1) {
      throw new KinuError('unsupported',
        `this workspace can apply one path atomically and this member has ${
          String(files.length)
        }. A per-file loop would publish a committed prefix if a later file failed, so it is `
        + "refused instead: wire the substrate's one-transaction batch write.");
    }
    for (const file of files) {
      if (file.after === null) await vfs.unlink(file.path);
      else await vfs.writeFile(file.path, file.after);
    }
  };
}

/**
 * Build one run's fan-in. Owns the run's merge ledger across barriers: what has landed,
 * what was consumed, what was unusable or pruned, and the order merges landed in.
 */
export function createLevelFanIn<N extends FanInNode, V extends { readonly id: string }>(
  deps: LevelFanInDeps<N, V>,
): LevelFanIn<V> {
  const { log } = deps;
  /** THE RUN'S MERGE LEDGER: what a fan-in has already landed in the origin.
   *  *Dependency order* asks whether a dependency has SETTLED, and one that settled at
   *  an earlier barrier of this run has — a DAG merged one fan-in at a time is still one
   *  merge order. SEEDED FROM THE DURABLE RECORDS by the caller (`seedLanded`), because
   *  "landed" is a fact about the ORIGIN and the origin outlives the activation. */
  const landed = new Set<string>();
  /** Level members no fan-in could consume, and members a fan-in consumed after the tree
   *  had retired them. Sets, so two fan-ins over one level cannot count a node twice. */
  const unusableParents = new Set<string>();
  const prunedParents = new Set<string>();
  const mergeOrder: string[] = [];
  const aggregateVertices: string[] = [];
  let fanInLevels = 0;
  let fanInMerged = 0;

  const fanInAtLevel = async (
    input: FanInMeasureInput & { readonly atDepth: number },
  ): Promise<readonly V[]> => {
    const { ctx: measureIn, verifier: instrument, atDepth } = input;
    // THE LEVEL, and what of it a fan-in can consume. A node this run already merged has
    // been consumed: offering it again would re-apply bytes the origin holds and could
    // only disagree with a sibling an earlier fan-in already reconciled.
    const parents: FanInParent[] = [];
    for (const node of deps.nodes.values()) {
      if (node.depth !== atDepth || landed.has(node.id)) continue;
      if (node.artifact === null || node.score === null) {
        unusableParents.add(node.id);
        continue;
      }
      parents.push({
        id: node.id, answer: node.artifact, score: node.score, aggregated: node.aggregated,
      });
    }
    if (parents.length < 2 || atDepth + 1 > deps.maxDepth) {
      // NEITHER A REFUSAL NOR SILENCE. A fan-in over one parent is `sample` under another
      // name and the engine will not relabel it; a vertex past the cap is the one thing
      // the depth cap in *Arbitration* forbids. Both say which.
      log.event('swarm.aggregate_skipped', {
        preset: deps.preset, depth: atDepth, parents: parents.length,
        reason: parents.length < 2 ? 'no-level' : 'depth-cap',
      });
      return [];
    }

    // THE MEMBERS: this level's parents, closed over the edges they declare through
    // anything the run has not landed. A vertex's answer was written against its own
    // parents' combined state, so a parent whose work is not in the origin has to land
    // before it — that edge is what `dependencyOrder` orders, and dropping it would apply
    // a diff onto a base its verdict never saw.
    const consumed: FanInParent[] = [];
    const known = new Set<string>();
    const queue = [...parents];
    for (let member = queue.shift(); member !== undefined; member = queue.shift()) {
      if (known.has(member.id)) continue;
      known.add(member.id);
      consumed.push(member);
      for (const dep of member.aggregated) {
        const node = deps.nodes.get(dep);
        if (node === undefined || landed.has(dep) || known.has(dep)) continue;
        // An edge is only ever given to a node that produced a usable answer, so this
        // narrows the row rather than filtering it.
        if (node.artifact === null || node.score === null) continue;
        queue.push({
          id: dep, answer: node.artifact, score: node.score, aggregated: node.aggregated,
        });
      }
    }
    for (const row of deps.sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE root_id = ${deps.rootId} AND status = 'pruned'`) {
      if (known.has(row.id)) prunedParents.add(row.id);
    }

    const readOrigin = originReader(measureIn.vfs);
    const members = await Promise.all(consumed.map((member) => reportedMember({
      nodeId: member.id, answer: member.answer, score: member.score,
      path: instrument.artifact, deps: member.aggregated, readOrigin,
    })));
    const answers = new Map(consumed.map((member) => [member.id, member.answer]));

    /**
     * Re-verification under *A verdict is bound to the exact pair it was issued over*,
     * through the SAME instrument the search scored with.
     *
     * A fan-in applies members onto one another, so every member after the first has a
     * base its verdict never saw — that is the rebase, and the binding rule is what keeps
     * it from being a licence. The check is the measurement itself rather than a cheaper
     * proxy: a re-verified verdict is then the same KIND of fact as the original one.
     *
     * IT PUTS THE WORKSPACE BACK. The instrument measures a candidate in place, so
     * re-measuring moves the very path the merge is about; a member that then REFUSED
     * would have left its bytes behind as an apply nothing gated. The restore is the
     * atomic writer the applies themselves ride, not a second write path.
     */
    const reverify: Reverifier = async ({ member, baseDigest }) => {
      const answer = answers.get(member.nodeId);
      if (answer === undefined) {
        return refusalOf(new KinuError('unavailable',
          `this fan-in holds no answer for node ${member.nodeId}, so nothing here can re-measure it `
          + 'against the base the members before it moved. A verdict that cannot be revalidated '
          + 'never applies.'));
      }
      const before = await readOrigin(instrument.artifact);
      const outcome = await deps.measureChild({
        ctx: measureIn,
        verifier: input.verifier,
        witnessVerifier: input.witnessVerifier,
        measured: input.measured,
        baseline: input.baseline,
        artifact: answer,
      });
      await singlePathApply(measureIn.vfs)([
        { path: instrument.artifact, base: answer, after: before },
      ]);
      if (outcome.kind === 'instrument-faulted') {
        return refusalOf(new KinuError('unavailable',
          `the instrument faulted while re-checking ${member.nodeId} against the base this fan-in `
          + `moved: ${outcome.error}. That is the instrument breaking rather than the member `
          + 'failing, and it refuses the apply instead of guessing.'));
      }
      log.event('swarm.merge_reverified', {
        preset: deps.preset, node: member.nodeId, depth: atDepth, outcome: outcome.kind,
      });
      // CLEAN IS `scored` AND NOTHING ELSE. Rule 4 asks whether the verdict still holds on
      // the base this member would land on: unmeasurable is "not measurable there any
      // more", and sealed is the instrument disagreeing with itself about content it has
      // already scored. Neither is a verdict that lands.
      return {
        memberDigest: memberDigestOf(member.diff),
        baseDigest,
        clean: outcome.kind === 'scored',
      };
    };

    /** The vertex, in an array because it is assigned from inside the spawner and read
     *  after it: one element where a conflict was graded, none where there was none. */
    const vertices: V[] = [];
    const spawnMergeNode = async (request: MergeNodeRequest): Promise<string> => {
      // THE ROW HANGS OFF THE MEMBER ALREADY APPLIED — the state this vertex starts from —
      // and every other parent is a dependency edge, because one measurement must not
      // reach two ancestor means. Looked up BEFORE the budget is charged: a debit taken
      // for a vertex that is then not created is a child the run paid for and never ran.
      const primary = deps.nodes.get(request.parents[0]);
      const paid = primary === undefined ? 0 : deps.budget.take(1);
      if (primary === undefined || paid === 0) {
        // ONE OUTCOME, TWO REASONS, and the reason is a field. Merge-back has already named
        // the conflict; what is missing is the child that would resolve it — either because
        // a child off an empty budget is the overspend conservation refuses, or because the
        // spawner was handed a member this fan-in never offered. An empty id reads exactly
        // as an absent spawner does: named, and nothing there to grade it.
        log.event('swarm.aggregate_skipped', {
          preset: deps.preset, depth: atDepth, parents: parents.length,
          reason: primary === undefined ? 'no-parent' : 'budget',
        });
        return '';
      }
      const id = nanoid();
      try {
        vertices.push(await deps.expandChild({
          parent: primary,
          id,
          // One child of one: the diversity angle and the sibling disclosure are both
          // derived from the pair, and a fan-in has no sibling to be decorrelated from.
          index: 0,
          width: 1,
          atDepth: atDepth + 1,
          task: request.task,
          rationale: `fan-in over ${String(consumed.length)} parents of depth ${String(atDepth)}`,
          assignment: null,
          // What `context` decides for a vertex is only whether it also inherits the
          // applied member's conversation: its parents' ANSWERS reach it either way, as
          // the seed's fan-in block, because they are what it was created to reconcile.
          context: deps.context,
          inherited: primary.artifact,
          aggregated: consumed,
          ancestors: deps.ancestorPath(primary),
          prefix: deps.sharedPrefix ? await deps.sharedPrefix(primary) : [],
        }));
      } catch (error) {
        // Named and counted exactly as a lost wave sibling is, so the report's `stop` can
        // still say the search ran narrower than it was configured to.
        log.event('swarm.branch_failed', {
          preset: deps.preset, depth: atDepth + 1,
          error: renderThrownChain({ cause: error }),
        });
        deps.countLost();
        return '';
      }
      // THE DAG'S EDGES, IN THE RECORD. `search_nodes` holds the selection edge and only
      // that, so this event is where the other k−1 are written down.
      log.event('swarm.aggregate_vertex', {
        preset: deps.preset,
        node: id,
        depth: atDepth + 1,
        selection_parent: primary.id,
        aggregated: consumed.map((member) => member.id).join(','),
        conflict: `${request.parents[0]},${request.parents[1]}`,
        paths: request.paths.length,
      });
      return id;
    };

    // A FAN-IN IS A SEQUENTIAL REBASE BY SHAPE, not by axis, and that is why
    // `mergePolicyOf` is not consulted here. It derives the SETTLE policy from `settle`
    // because there the axes decide how many members are wanted; a fan-in's arity is
    // stated by the DAG's edges, so there is nothing to derive — and a fan-in that applied
    // one member and discarded the rest would not be a fan-in.
    const merging: MergeBackDeps = {
      log,
      preset: deps.preset,
      readOrigin,
      applyMember: singlePathApply(measureIn.vfs),
      reverify,
    };
    const report = await mergeBack(
      { policy: 'sequential-rebase', members, settled: [...landed] },
      // THE SPAWNER IS ABSENT WHERE THE BUDGET CANNOT PAY, and absent is what merge-back
      // reads as "the conflict was named and nothing was there to grade it" — the honest
      // record, where a vertex created off an empty budget would be a child nothing paid
      // for.
      deps.budget.remaining > 0 ? { ...merging, spawnMergeNode } : merging,
    );

    fanInLevels += 1;
    mergeOrder.push(...report.order);
    for (const outcome of report.outcomes) {
      if (outcome.kind !== 'applied') continue;
      landed.add(outcome.nodeId);
      // AND DURABLY, because what this records is a fact about the ORIGIN: the bytes are
      // in the workspace and outlive the activation, so a re-entry that re-offered this
      // member would re-apply them.
      deps.markMerged(outcome.nodeId);
      fanInMerged += 1;
    }
    for (const vertex of vertices) aggregateVertices.push(vertex.id);
    log.event('swarm.aggregate_fan_in', {
      preset: deps.preset,
      depth: atDepth,
      parents: parents.length,
      members: members.length,
      order: report.order.join(','),
      merged: report.outcomes.filter((outcome) => outcome.kind === 'applied').length,
      pruned: [...prunedParents].filter((id) => known.has(id)).length,
      vertex: vertices[0]?.id ?? '',
      stopped_at: report.stoppedAt ?? '',
    });
    return vertices;
  };

  return {
    seedLanded: (ids) => { for (const id of ids) landed.add(id); },
    fanInAtLevel,
    landedIds: () => [...landed],
    report: () => ({
      levels: fanInLevels,
      order: mergeOrder,
      merged: fanInMerged,
      vertices: aggregateVertices,
      unusableParents: unusableParents.size,
      prunedParents: prunedParents.size,
    }),
  };
}
