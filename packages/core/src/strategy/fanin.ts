/**
 * The fan-in at the level barrier (`expand:'aggregate'`): the level's parents are
 * offered to merge-back as members in dependency order (*Merge-back*). A parent with
 * no usable answer gets no edge (counted as `unusableParents`); a pruned parent keeps
 * its edge (disclosed as `prunedParents`); an unlanded member keeps its dependent behind it.
 */
import type { ModelMessage } from 'ai';
import {
  KinuError, refusalOf, renderThrownChain, type Logger,
} from '../obs/index';
import { nanoid } from '../utils/nanoid';
import type { VFS } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
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

export interface FanInParent {
  readonly id: string;
  readonly answer: string;
  readonly score: number | null;
  readonly aggregated: readonly string[];
}

/** The slice of a tree node a fan-in reads; structural, so this module does not import the runner. */
export interface FanInNode {
  readonly id: string;
  readonly depth: number;
  readonly artifact: string | null;
  readonly score: number | null;
  readonly aggregated: readonly string[];
}

/** The spawn request for an aggregate vertex, spawned by the same `expandChild` as the wave path. */
export interface FanInExpandInput<N extends FanInNode> {
  readonly parent: N;
  readonly id: string;
  readonly index: number;
  readonly width: number;
  readonly atDepth: number;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  readonly inherited: string | null;
  readonly aggregated: readonly FanInParent[];
  readonly ancestors: readonly N[];
  readonly prefix: readonly ModelMessage[];
  /** Always null: nobody assigns a vertex a brief. */
  readonly assignment: null;
}

export interface FanInMeasureInput {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly measured: MeasuredObjective;
  readonly baseline: number;
  readonly artifact: string;
}

/** Each parent carries its artifact; the fan-in hands it to `measureChild` on revalidation. */
export type FanInAtLevelInput =
  Omit<FanInMeasureInput, 'artifact'> & { readonly atDepth: number };

export interface LevelFanInDeps<N extends FanInNode, V extends { readonly id: string }> {
  readonly nodes: ReadonlyMap<string, N>;
  readonly ancestorPath: (parent: N) => readonly N[];
  readonly rootId: string;
  readonly actor: ActorHandle;
  readonly maxDepth: number;
  readonly budget: Pick<SwarmBudget, 'take' | 'remaining'>;
  readonly log: Logger;
  readonly preset: string;
  readonly context: BranchContext;
  readonly sql: SqlExecutor;
  readonly markMerged: (nodeId: string) => void;
  readonly countLost: () => void;
  /** The one child spawner; a vertex is graded exactly like a sampled child. */
  readonly expandChild: (input: FanInExpandInput<N>) => Promise<V>;
  readonly measureChild: (input: FanInMeasureInput) => Promise<ChildOutcome>;
  /** The cacheable conversation prefix an agent node inherits; absent where the host provisions no agent homes. */
  readonly sharedPrefix?: (parent: N) => Promise<readonly ModelMessage[]>;
}

export interface FanInLedgerReport {
  readonly levels: number;
  readonly order: readonly string[];
  readonly merged: number;
  readonly vertices: readonly string[];
  readonly unusableParents: number;
  readonly prunedParents: number;
}

export interface LevelFanIn<V extends { readonly id: string }> {
  fanInAtLevel(input: FanInAtLevelInput): Promise<readonly V[]>;
  seedLanded(ids: readonly string[]): void;
  /** Ids already applied into the origin; a settle merge must not re-offer them. */
  landedIds(): readonly string[];
  report(): FanInLedgerReport;
}

/**
 * One node's answer as a merge-back member, diffed against the origin as read now,
 * i.e. the base its apply will see. `deps` are the DAG's edges.
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
    scope: null,
    deps: input.deps,
    score: input.score,
  };
}

/**
 * The atomic single-path write a reported member's apply rides. Refuses multi-file
 * members: looping writes would be a torn apply.
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

export function createLevelFanIn<N extends FanInNode, V extends { readonly id: string }>(
  deps: LevelFanInDeps<N, V>,
): LevelFanIn<V> {
  const { log } = deps;
  /** The run's merge ledger: what a fan-in has landed in the origin. Seeded from the
     *  durable records by the caller (`seedLanded`) because the origin outlives the activation. */
  const landed = new Set<string>();
  /** Sets, so two fan-ins over one level cannot count a node twice. */
  const unusableParents = new Set<string>();
  const prunedParents = new Set<string>();
  const mergeOrder: string[] = [];
  const aggregateVertices: string[] = [];
  let fanInLevels = 0;
  let fanInMerged = 0;

  const fanInAtLevel = async (
    input: FanInAtLevelInput,
  ): Promise<readonly V[]> => {
    const { ctx: measureIn, verifier: instrument, atDepth } = input;
    // A node this run already merged has been consumed; re-offering would re-apply its bytes.
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
      // One parent is `sample` by another name; past the cap is forbidden by *Arbitration*.
      log.event('swarm.aggregate_skipped', {
        preset: deps.preset, depth: atDepth, parents: parents.length,
        reason: parents.length < 2 ? 'no-level' : 'depth-cap',
      });

      return [];
    }

    // Members: this level's parents, closed over edges to anything not yet landed, so
        // no diff applies onto a base its verdict never saw.
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

        if (node.artifact === null || node.score === null) continue;
        queue.push({
          id: dep, answer: node.artifact, score: node.score, aggregated: node.aggregated,
        });
      }
    }

    for (const row of deps.sql<{ id: string }>`
      SELECT id FROM search_nodes
      WHERE actor_id = ${deps.actor.actorId} AND root_id = ${deps.rootId} AND status = 'pruned'`) {
      if (known.has(row.id)) prunedParents.add(row.id);
    }

    const readOrigin = originReader(measureIn.vfs);

    const members = await Promise.all(consumed.map((member) => reportedMember({
      nodeId: member.id, answer: member.answer, score: member.score,
      path: instrument.artifact, deps: member.aggregated, readOrigin,
    })));

    const answers = new Map(consumed.map((member) => [member.id, member.answer]));

    /**
         * Re-verify a member whose base moved, through the same instrument the search scored
         * with. Restores the workspace afterwards via the same atomic writer the applies use.
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

      // Only `scored` is clean; unmeasurable or sealed is not a verdict that lands.
      return {
        memberDigest: memberDigestOf(member.diff),
        baseDigest,
        clean: outcome.kind === 'scored',
      };
    };

    const vertices: V[] = [];

    const spawnMergeNode = async (request: MergeNodeRequest): Promise<string> => {
      // The row hangs off the member already applied; other parents are dependency edges.
            // Looked up before the budget is charged so no debit is taken for an uncreated vertex.
      const primary = deps.nodes.get(request.parents[0]);
      const paid = primary === undefined ? 0 : deps.budget.take(1);

      if (primary === undefined || paid === 0) {
        log.event('swarm.aggregate_skipped', {
          preset: deps.preset, depth: atDepth, parents: parents.length,
          reason: primary === undefined ? 'no-parent' : 'budget',
        });

        return '';
      }

      const id = nanoid();
      let expanded = false;

      try {
        vertices.push(await deps.expandChild({
          parent: primary,
          id,
          index: 0,
          width: 1,
          atDepth: atDepth + 1,
          task: request.task,
          rationale: `fan-in over ${String(consumed.length)} parents of depth ${String(atDepth)}`,
          assignment: null,
          // `context` only decides whether the vertex also inherits the applied member's conversation.
          context: deps.context,
          inherited: primary.artifact,
          aggregated: consumed,
          ancestors: deps.ancestorPath(primary),
          prefix: deps.sharedPrefix ? await deps.sharedPrefix(primary) : [],
        }));
        expanded = true;
      } catch (error) {
        log.event('swarm.branch_failed', {
          preset: deps.preset, depth: atDepth + 1,
          error: renderThrownChain({ cause: error }),
        });
        deps.countLost();
      }

      if (!expanded) return '';
      // `search_nodes` holds only the selection edge; this event records the other k−1.
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

    // A fan-in is a sequential rebase by shape, so `mergePolicyOf` is not consulted.
    const merging: MergeBackDeps = {
      log,
      preset: deps.preset,
      readOrigin,
      applyMember: singlePathApply(measureIn.vfs),
      reverify,
    };

    const report = await mergeBack(
      { policy: 'sequential-rebase', members, settled: [...landed] },
      // No spawner when the budget cannot pay; merge-back records the conflict as ungraded.
      deps.budget.remaining > 0 ? { ...merging, spawnMergeNode } : merging,
    );

    fanInLevels += 1;
    mergeOrder.push(...report.order);

    for (const outcome of report.outcomes) {
      if (outcome.kind !== 'applied') continue;
      landed.add(outcome.nodeId);
      // Durable: the bytes outlive the activation, so a re-entry must not re-apply them.
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
