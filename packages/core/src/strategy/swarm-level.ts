/**
 * THE LEVEL a swarm iteration runs: who assigned it, which slots it fills, and what
 * each slot is asked.
 *
 * Specified by docs/EXPLORATION.md — "Arbitration", "Budget conservation" and
 * "Inherited context".
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────────
 *
 * There are now THREE things that can decide what a level's children are asked, and
 * the run loop had all three inline as `??` chains reaching into a grant, a pending
 * row and the resolved call at once:
 *
 *   - A NODE proposed the level (`propose_branch` → `BranchGrant`), so each child has
 *     its own sub-question and its own brief.
 *   - THE CALLER assigned the first level (`SwarmInput.nodes`), which is the same
 *     thing one level up: the root is the workspace as found, no model wrote it, so it
 *     proposes nothing and the caller writes its proposal instead.
 *   - NOBODY assigned it, and the engine varies the angle itself.
 *
 * …and a RE-ENTRY crosses all three, because it re-runs nodes an earlier attempt
 * created and must ask them what they were originally asked. Composed in the loop,
 * that was four sources read through three fallback chains per child, in the middle of
 * the busiest function in the engine. {@link planLevel} is the one place that decides
 * it, and the loop's job shrinks to expanding what it returns.
 */

import type { BranchContext, ResolvedSwarm } from './swarm';
import type { BranchGrant, SwarmBudget } from './swarm-budget';
import type { PendingSwarmNode, SwarmReentry } from './swarm-resume';
import { nanoid } from '../utils/nanoid';

/**
 * WHAT THIS NODE WAS ASKED TO DO, in the words of whoever asked it — and what its
 * siblings were asked, so it knows what to differ from.
 *
 * PRESENT EXACTLY WHERE SOMEBODY WROTE A BRIEF: the caller's own per-node `prompt`
 * under an explicit `nodes` assignment, or the parent's per-branch `rationale` under a
 * granted proposal. Absent for a count-based wave, where nobody wrote one and the
 * engine's own diversity angle is the honest answer.
 *
 * WHY IT HAD TO REACH THE PROMPT AT ALL. `propose_branch` has always asked the model
 * for a `rationale` per branch, and the child never saw it: the string went to
 * `head_journal.rationale` and stopped there, because a swarm node's prompt is
 * `nodeSystemPrompt` plus `branchPrompt` and neither read it. So a parent that wrote
 * "check the cache path specifically" got a child asked the parent's task under a
 * canned angle. It occupies the ANGLE's slot rather than sitting beside it, because two
 * angles is two instructions: a node told both what it was asked and, separately, to
 * take an unrelated canned approach has been given a contradiction to resolve alone.
 */
export interface BranchAssignment {
  readonly brief: string;
  /** The briefs this node's siblings were given, in level order minus its own. */
  readonly siblings: readonly string[];
}

/**
 * One parent's unfinished level, as a re-entry owes it.
 *
 * `siblings` is the width the level was ORIGINALLY told about, which is not the number
 * of members re-run here: scoring is sequential after the expansion barrier, so three
 * of five may already be recorded, and re-asking the other two as "1 of 2" would hand
 * them the first two's angles.
 */
export interface ResumedWave {
  readonly parentId: string;
  readonly siblings: number;
  readonly members: readonly PendingSwarmNode[];
}

/**
 * THE WORK A RE-ENTRY OWES, one wave per parent, in the order the dead attempt spawned
 * them.
 *
 * A node that was spawned and never recorded a tree row is an expansion this search
 * ALREADY PAID FOR and holds no answer for. It is re-run under its OWN id: not
 * retired, and not replaced by a fresh sibling. That is the whole of the defect that
 * made a five-node search report five failures and five new nodes on every eviction.
 *
 * GROUPED BY PARENT because a wave is what the expansion barrier is: the members of
 * one parent's level were asked as a set and told each other's angles. A `Map` for its
 * insertion order, which IS level order here because the rows arrive in it.
 */
export function resumedWaves(reentry: SwarmReentry | null): ResumedWave[] {
  const byParent = new Map<string, { parentId: string; siblings: number; members: PendingSwarmNode[] }>();
  for (const node of reentry?.pending ?? []) {
    const wave = byParent.get(node.parentId);
    if (wave) wave.members.push(node);
    else byParent.set(node.parentId, {
      parentId: node.parentId, siblings: node.siblings, members: [node],
    });
  }
  return [...byParent.values()];
}

/**
 * THE CALLER'S OWN FIRST LEVEL, as the grant the expansion path already expands from
 * — or null where the caller assigned nothing and the engine varies the angle itself.
 *
 * NOT A SECOND EXPANSION PATH, and that is the whole design. The run loop has always
 * expanded a granted level by reading `task`, `rationale` and `context` per branch off
 * `BranchGrant.proposal.branches[i]`; the only reason the first level never had one is
 * that its parent is the ROOT, which no model wrote and which therefore proposes
 * nothing. So the caller's assignments become the root's proposal and nothing
 * downstream changes: the same slots, the same ids, the same two journal columns, the
 * same re-entry.
 *
 * DEBITED THROUGH THE BUDGET, exactly as an arbitrated grant is. A grant is expanded
 * without charge because arbitration already charged it, so a grant manufactured here
 * without `take` would hand the run a free level and leave the whole budget for a
 * second one — one node per assignment, and then `branches` more.
 *
 * ONLY ON A FIRST ATTEMPT. A re-entry's first level already EXISTS: each of its nodes
 * is either recorded in the tree or pending, both of which the resume accounting owns,
 * and re-granting it here would create that level a second time under fresh ids — the
 * defect this engine just closed, re-opened from another direction.
 */
export function assignedRootGrant(input: {
  readonly resolved: ResolvedSwarm;
  readonly reentry: SwarmReentry | null;
  readonly budget: SwarmBudget;
}): BranchGrant | null {
  const assignments = input.resolved.nodes;
  if (!assignments || input.reentry) return null;
  const width = input.budget.take(assignments.length);
  if (width === 0) return null;
  return {
    kind: 'granted',
    width,
    nodeIds: Array.from({ length: width }, () => nanoid()),
    proposal: {
      // The run's own name for what it is doing. The per-node briefs are on the
      // branches; this is the level's, and it is what the journal's run header already
      // carries.
      rationale: input.resolved.name ?? input.resolved.label ?? input.resolved.preset,
      branches: assignments.slice(0, width).map((node) => ({
        task: node.task,
        // `prompt` IS the brief. It travels in the field the expansion path already
        // reads and the journal already stores, so there is no new column, no new
        // `HeadInput` field and no snapshot state anywhere in its path.
        rationale: node.prompt,
        // RUN-LEVEL, never per node: `context` is what makes siblings comparable, so a
        // caller assigning tasks does not get to vary it per node.
        context: input.resolved.config.context,
      })),
    },
  };
}

/** One child this iteration expands, fully decided: nothing below this is a fallback
 *  the run loop has to remember. */
export interface LevelSlot {
  /** Its slot in the level — what its diversity angle and sibling disclosure are
   *  derived from. */
  readonly index: number;
  readonly id: string;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  readonly assignment: BranchAssignment | null;
}

/**
 * WHAT THIS ITERATION EXPANDS, one entry per child, every field decided.
 *
 * THE SLOT SET IS NOT THE WIDTH, and only a resumed wave makes them differ: a fresh
 * level fills every slot it is wide, and a resumed one fills the slots whose nodes
 * never recorded an answer while telling each of them the width it was originally
 * asked at. Collapsing the two would re-ask a cut sibling under another sibling's
 * angle.
 *
 * THE ID IS THE LOGICAL NODE. A grant already reserved one per child and a resumed
 * member already has one; anything else mints a fresh id. Minting instead of reusing
 * is how thirty journal rows came to describe five nodes.
 *
 * THE BRIEFS have two sources and one order. A granted level's are its proposal's
 * per-branch rationales, which covers both a node's own `propose_branch` and the
 * caller's explicit `nodes` — those ARE the root's grant. A RESUMED first level has no
 * grant in memory, so its briefs come back off the replayed tool input: the same
 * bytes, at the same slots, because the slot is durable. A resumed level BELOW the
 * first recovers its task from its journal row and not its brief — the proposal that
 * wrote it existed only inside the tool call that made it, which `swarm-resume.ts`
 * names among what a re-entry cannot recover.
 */
export function planLevel(input: {
  readonly resolved: ResolvedSwarm;
  readonly resumed: ResumedWave | null;
  readonly grant: BranchGrant | null;
  /** The level's width — what every member is told about its siblings. */
  readonly width: number;
  readonly parentDepth: number;
}): readonly LevelSlot[] {
  const { resolved, resumed, grant, width } = input;
  const briefs: readonly string[] | null = grant
    ? grant.proposal.branches.map((branch) => branch.rationale)
    : resumed && resolved.nodes && input.parentDepth === 0
      ? resolved.nodes.map((node) => node.prompt)
      : null;
  /** The slots this call fills, and the pending row behind each where there is one.
   *  Annotated so both arms are checked against one shape rather than widened by a
   *  cast at the point where they meet. */
  const filled: readonly { readonly index: number; readonly pending: PendingSwarmNode | null }[] =
    resumed
      ? resumed.members.map((node) => ({ index: node.index, pending: node }))
      : Array.from({ length: width }, (_unused, index) => ({ index, pending: null }));
  return filled.map(({ index, pending }): LevelSlot => {
    const branch = grant?.proposal.branches[index];
    const brief = briefs?.[index];
    return {
      index,
      id: pending?.id ?? grant?.nodeIds[index] ?? nanoid(),
      // What this node was ASKED, and a resumed one is asked again in the same words:
      // its row recorded them, so the re-run is the same assignment rather than a new
      // one that happens to share an id.
      task: pending?.task ?? branch?.task ?? resolved.task,
      rationale: pending?.rationale
        || (branch?.rationale ?? `expansion ${String(index + 1)} of ${String(width)}`),
      context: branch?.context ?? resolved.config.context,
      assignment: briefs && brief !== undefined
        ? { brief, siblings: briefs.filter((_unused, slot) => slot !== index) }
        : null,
    };
  });
}
