/**
 * The ACTOR's background-detach policy, and the evict/exit resume policy. One
 * implementation for both backends (each previously carried its own copy of the
 * map AND the wrapper AND the resume gate).
 *
 * The WRAPPER is not here: it is `jobs/background-wrap.ts`, a leaf, along with the
 * entries whose gate needs nothing. What is here is the one entry that cannot be
 * — `agents`, whose gate is a translator of the delegation tool's own input — and
 * that import is why the split exists: the delegation tool's implementation IS the
 * search engine, which builds a swarm node, which needs the wrapper. A node
 * reaching this module for it would close that ring.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import * as v from 'valibot';
import { CONFINED_BACKGROUNDABLE_TOOLS, type BackgroundableTool } from '../jobs/background-wrap';
import { RESUME_REDRIVE_OPTION } from '../jobs/threshold';
import { JobNotResumable } from '../jobs/runner';
import type { WorkMode } from '../prompting/surface';
import { resumableAgentsInput } from '../tools/agents-tool';
import { harvestSwarm } from '../strategy/swarm-resume';
import type { MctsSearchStore } from '../mcts/search-store';
import type { SqlExecutor } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { decodeJsonValue, type JsonValue } from '../utils/json';

/** The durable rows a swarm harvest reads. The backend already holds both. */
export interface SwarmHarvestDeps {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
}

/** The detach gate and the resume gate are ONE predicate, deliberately: a call
 *  that could not be re-driven after an eviction must never be detached into a
 *  job in the first place, and two predicates would drift into exactly that. */
function isResumableSpawn(input: JsonValue): boolean {
  return resumableAgentsInput('agents', input) !== null;
}

/**
 * Tools whose work can be long enough to auto-detach on an ACTOR's surface: the
 * two every surface has, plus delegation.
 *
 * `agents` is spawn-shaped because a search's completion arrives as a wake rather
 * than as the call's return value, so it detaches the moment the spawn is
 * confirmed started instead of waiting out a threshold that could only ever be
 * dead air.
 */
export const BACKGROUNDABLE_TOOLS = {
  ...CONFINED_BACKGROUNDABLE_TOOLS,
  agents: { completion: 'spawn', detachable: isResumableSpawn },
} as const satisfies Readonly<Record<string, BackgroundableTool>>;

/**
 * Re-drive a background job interrupted by a DO eviction / CLI process exit
 * (B6). Only a SEARCH is resumable, and re-running the RAW agents tool (no 30s
 * re-detach) CONTINUES the interrupted search rather than starting another: both
 * engines re-enter their own durable rows — `mcts/engine.ts` from its checkpoint,
 * `strategy/swarm-run.ts` from its tree and its per-node records
 * (`strategy/swarm-resume.ts`). That claim used to be true of MCTS only, and the
 * swarm half of it was measured costing a live five-head search its whole tree: the
 * re-drive minted a second root, re-paid for every expansion and abandoned the first.
 *
 * THE CALL IS MARKED AS A RE-DRIVE, and it is the only path that sets that marker.
 * The stored input is replayed verbatim, so nothing in it distinguishes a re-drive
 * from a first call — and only a re-drive may re-enter: a fresh `agents.swarm` whose
 * task matches a search still expanding must get its own tree. See
 * {@link RESUME_REDRIVE_OPTION}.
 *
 * Rows stored before today's surface — the pre-unification `think` kind, and
 * the removed `fork` action — are TRANSLATED onto the same path by
 * `resumableAgentsInput` rather than refused, because a durable row is history
 * and nobody is left to correct its spelling. Side-effecting kinds
 * (execute_tools / run) can't be safely re-executed, so they decline.
 *
 * `rawTools` is a thunk: the gate runs first, so a non-resumable kind never
 * pays for (or fails on) tool construction — the CLI resolves its model-bound
 * surface inside it.
 */
export async function resumeBackgroundJob(
  rawTools: (mode: WorkMode) => ToolSet,
  kind: string,
  input: JsonValue,
  mode: WorkMode,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const resumed = resumableAgentsInput(kind, input);
  if (!resumed) throw new JobNotResumable(kind);
  const exec = rawTools(mode).agents?.execute;
  if (!exec) throw new JobNotResumable(kind);
  // Typed as a variable rather than written inline, for `background-wrap.ts`'s reason:
  // the SDK's own options type is closed, so an extra key in a literal fails overload
  // resolution instead of widening.
  const execOptions: ToolExecutionOptions & { [RESUME_REDRIVE_OPTION]: true } = {
    abortSignal: signal, toolCallId: `resume-${nanoid()}`, messages: [],
    [RESUME_REDRIVE_OPTION]: true,
  };
  const result = await exec(resumed, execOptions);
  return result === undefined ? undefined : decodeJsonValue({ value: result });
}

/**
 * WHAT AN UNFINISHED `agents` JOB ALREADY HAS, for the paths that will not drive it
 * again — a kind with no resume path, and a resumer that declines the checkpoint
 * (`settleBounded` in `jobs/runner.ts`).
 *
 * The gate is the SAME predicate the detach and the resume use, deliberately: a kind
 * that could not be re-driven has no durable state to read either, so a third
 * predicate would drift from the two. `run` and `execute_tools` therefore return null,
 * which is the honest answer — a side-effecting call either happened or did not, and
 * there is no half of it to hand over.
 *
 * A SEARCH IS DIFFERENT and that is the whole point. Its tree, its per-node records
 * and its scores are durable, so a search cut at four of five candidates HAS four
 * candidates. The incident settled a job with an eviction string while its root held
 * two completed candidates with real content, and the owner was handed nothing.
 */
export function harvestBackgroundJob(
  deps: SwarmHarvestDeps,
  kind: string,
  input: JsonValue,
): JsonValue | null {
  const resumed = resumableAgentsInput(kind, input);
  if (!resumed) return null;
  // PARSED, not duck-typed: `resumed` is a durable row this build did not write, and
  // the task string is the key the whole harvest is read by. A row with no readable
  // task has nothing to harvest, which is a refusal rather than a guess.
  const task = v.safeParse(v.pipe(v.string(), v.minLength(1)), resumed.task);
  if (!task.success) return null;
  const harvest = harvestSwarm(deps, task.output);
  if (!harvest) return null;
  return decodeJsonValue({ value: harvest });
}
