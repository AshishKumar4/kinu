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

import type { ToolSet } from 'ai';
import { CONFINED_BACKGROUNDABLE_TOOLS, type BackgroundableTool } from '../jobs/background-wrap';
import { JobNotResumable } from '../jobs/runner';
import type { WorkMode } from '../prompting/surface';
import { resumableAgentsInput } from '../tools/agents-tool';
import { nanoid } from '../utils/nanoid';
import { decodeJsonValue, type JsonValue } from '../utils/json';

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
 * (B6). Only a SEARCH is resumable: re-running the RAW agents tool (no 30s
 * re-detach) continues an interrupted search from its durable checkpoint.
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
  const result = await exec(resumed, {
    abortSignal: signal, toolCallId: `resume-${nanoid()}`, messages: [],
  });
  return result === undefined ? undefined : decodeJsonValue({ value: result });
}
