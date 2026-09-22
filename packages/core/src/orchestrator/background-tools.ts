/**
 * The actor's background-detach and evict/exit resume policy, shared by both backends.
 * The wrapper lives in `jobs/background-wrap.ts`; importing the delegation tool here keeps that leaf acyclic.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import * as v from 'valibot';
import { CONFINED_BACKGROUNDABLE_TOOLS, type BackgroundableTool } from '../jobs/background-wrap';
import { RESUME_REDRIVE_OPTION } from '../jobs/threshold';
import { JobNotResumable } from '../jobs/runner';
import type { WorkMode } from '../types/turn';
import { resumableAgentsInput } from '../delegation/agents-tool';
import { harvestSwarm } from '../strategy/swarm-resume';
import type { MctsSearchStore } from '../mcts/search-store';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { nanoid } from '../utils/nanoid';
import { decodeJsonValue, type JsonValue } from '../utils/json';

/** The durable rows a swarm harvest reads. */
export interface SwarmHarvestDeps {
  readonly sql: SqlExecutor;
  /** Tree and node records are actor-private; raw reads carry the ledger's owner. */
  readonly actor: ActorHandle;
  readonly ledger: MctsSearchStore;
}

/** Detach and resume share one predicate: a call that cannot be re-driven must never detach. */
function isResumableSpawn(input: JsonValue): boolean {
  return resumableAgentsInput('agents', input) !== null;
}

/** `agents` is spawn-shaped: completion arrives as a wake, so it detaches once the spawn starts. */
export const BACKGROUNDABLE_TOOLS = {
  ...CONFINED_BACKGROUNDABLE_TOOLS,
  agents: { completion: 'spawn', detachable: isResumableSpawn },
} as const satisfies Readonly<Record<string, BackgroundableTool>>;

/** One re-drive of an interrupted background job. */
export interface BackgroundResumeRequest {
  /** Thunk, so a non-resumable kind never pays for tool construction. */
  readonly rawTools: (mode: WorkMode) => ToolSet;
  /** Durable row's tool kind, whatever build wrote it. */
  readonly kind: string;
  /** Replayed verbatim. */
  readonly input: JsonValue;
  readonly mode: WorkMode;
  readonly signal: AbortSignal;
}

/**
 * Re-drive an evicted/exited background job (B6). Only a search resumes; the raw agents tool re-enters its
 * durable rows. Only this path sets {@link RESUME_REDRIVE_OPTION}: a fresh call must get its own tree.
 */
export async function resumeBackgroundJob(drive: BackgroundResumeRequest): Promise<JsonValue | undefined> {
  const { rawTools, kind, input, mode, signal } = drive;
  const resumed = resumableAgentsInput(kind, input);

  if (!resumed) throw new JobNotResumable(kind);
  const exec = rawTools(mode).agents?.execute;

  if (!exec) throw new JobNotResumable(kind);

  // Typed as a variable: the SDK options type is closed, so an extra key in a literal fails overload resolution.
  const execOptions: ToolExecutionOptions & { [RESUME_REDRIVE_OPTION]: true } = {
    abortSignal: signal, toolCallId: `resume-${nanoid()}`, messages: [],
    [RESUME_REDRIVE_OPTION]: true,
  };

  const result = await exec(resumed, execOptions);

  return result === undefined ? undefined : decodeJsonValue({ value: result });
}

/**
 * What an unfinished `agents` job already has, for paths that will not drive it again.
 * Same gate as detach/resume; side-effecting kinds return null.
 */
export function harvestBackgroundJob(
  deps: SwarmHarvestDeps,
  kind: string,
  input: JsonValue,
): JsonValue | null {
  const resumed = resumableAgentsInput(kind, input);

  if (!resumed) return null;
  // Parsed, not duck-typed: `resumed` is a durable row this build did not write.
  const task = v.safeParse(v.pipe(v.string(), v.minLength(1)), resumed.task);

  if (!task.success) return null;
  const harvest = harvestSwarm(deps, task.output);

  if (!harvest) return null;

  return decodeJsonValue({ value: harvest });
}
