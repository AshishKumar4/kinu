/**
 * Background-tool policy — which tool calls may auto-detach to the background
 * (with the per-call gate: `agents` detaches only its fork action — the
 * converse actions keep their inline semantics), the wrapper that arms it,
 * and the evict/exit resume policy. One implementation for both backends
 * (each previously carried its own copy of the map AND the wrapper AND the
 * resume gate).
 *
 * Two shapes of backgroundable work, one axis:
 *   'result' — the turn is waiting on the call's result and its duration is
 *              unknown (`run`, `execute_tools`), so it races the surface's
 *              detach threshold and only work that proved slow crosses.
 *   'spawn'  — the call launches a process whose completion arrives as a wake
 *              event (`agents` fork). Where a wake can arrive it detaches the
 *              moment the spawn is confirmed started (the threshold wait could
 *              only ever be dead air); where none can, it runs inline to
 *              completion, because a detached result there has no reader.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { combineAbortSignals } from '@proteus/agent-utils';
import { SPAWN_STARTED_OPTION, withBackgroundThreshold, withSpawnDetach } from '../jobs/threshold.js';
import { JobNotResumable } from '../jobs/runner.js';
import type { BackgroundJobRunner } from '../jobs/runner.js';
import type { WorkMode } from '../prompting/surface.js';
import { resumableForkInput } from '../tools/agents-tool.js';
import { nanoid } from '../utils/nanoid.js';
import { decodeJsonValue, type JsonValue } from '../utils/json.js';

/** How a backgroundable tool's work detaches: racing the threshold for a
 *  result the turn waits on, or on spawn-confirm for a launched process. */
export interface BackgroundableTool {
  readonly completion: 'result' | 'spawn';
  /** Per-call gate over the tool input. */
  readonly detachable: (input: JsonValue) => boolean;
}

function isForkInput(input: JsonValue): boolean {
  return resumableForkInput('agents', input) !== null;
}

/** Tools whose work can be long enough to auto-detach to the background. */
export const BACKGROUNDABLE_TOOLS: ReadonlyMap<string, BackgroundableTool> = new Map([
  ['agents', { completion: 'spawn', detachable: isForkInput }],
  ['execute_tools', { completion: 'result', detachable: () => true }],
  ['run', { completion: 'result', detachable: () => true }],
]);

/**
 * Return a SHALLOW CLONE of the raw toolset with the long-running tools'
 * execute wrapped in the surface's background detach (threshold race for
 * result-shaped work, spawn-confirm for spawn-shaped). Never mutates the
 * cached raw toolset — so the raw surface stays unwrapped for the eval
 * side-streams (shadow eval / scaffold / GEPA), where a long tool run must
 * complete inline instead of detaching a job into the user's chat.
 *
 * Each detachable call gets its own AbortController (hard-cancel aborts the
 * underlying work), merged with the turn's signal so a turn abort still
 * propagates. `trackController` (cf) registers the controller for foreground
 * cancellation until the call settles; once detached, BackgroundJobRunner
 * owns it.
 */
export function wrapToolsForBackground(raw: ToolSet, deps: {
  jobRunner: Pick<BackgroundJobRunner, 'thresholdDeps' | 'policy'>;
  /** Captured when the outer tool call begins, before it can detach. */
  mode: () => WorkMode;
  trackController?: (controller: AbortController) => (() => void);
}): ToolSet {
  const wrapped: ToolSet = { ...raw };
  for (const [key, { completion, detachable }] of BACKGROUNDABLE_TOOLS) {
    const orig = wrapped[key];
    const exec = orig?.execute;
    if (!orig || !exec) continue;
    wrapped[key] = {
      ...orig,
      execute: (input, options) => {
        const parsedInput = decodeJsonValue({ value: input });
        if (!detachable(parsedInput)) return exec(input, options);
        const controller = new AbortController();
        const mode = deps.mode();
        const turnSignal = options.abortSignal;
        const abortSignal = turnSignal ? combineAbortSignals([turnSignal, controller.signal]) : controller.signal;
        const untrack = deps.trackController?.(controller);
        // The policy is read per call, exactly like the threshold: on cf one
        // runner serves both surfaces and only the turn in flight knows which
        // it is.
        let run: Promise<unknown>;
        if (completion === 'spawn') {
          if (!deps.jobRunner.policy.wakesAfterTurn) {
            run = Promise.resolve(exec(input, { ...options, abortSignal }));
          } else {
            run = withSpawnDetach(
              key,
              (spawnStarted) => {
                const execOptions: ToolExecutionOptions & { [SPAWN_STARTED_OPTION]: () => void } = {
                  ...options, abortSignal, [SPAWN_STARTED_OPTION]: spawnStarted,
                };
                return exec(input, execOptions);
              },
              deps.jobRunner.thresholdDeps(key, input, mode, controller),
            );
          }
        } else {
          run = withBackgroundThreshold(
            key,
            () => exec(input, { ...options, abortSignal }),
            deps.jobRunner.thresholdDeps(key, input, mode, controller),
          );
        }
        return untrack ? run.finally(untrack) : run;
      },
    };
  }
  return wrapped;
}

/**
 * Re-drive a background job interrupted by a DO eviction / CLI process exit
 * (B6). Only a FORK is resumable: re-running the RAW agents tool (no 30s
 * re-detach) continues an interrupted MCTS from its durable search checkpoint
 * (runMCTS.findResumable matches the unfinished run by task) and re-runs
 * heads. Jobs stored before the agents unification carry kind 'think';
 * resumableForkInput translates them onto the same path. Side-effecting kinds
 * (execute_tools / run) can't be safely re-executed, so they decline.
 *
 * `rawTools` is a thunk: the gate runs first, so a non-resumable kind never
 * pays for (or fails on) tool construction — the CLI resolves its model-bound
 * surface inside it.
 */
export async function resumeForkBackgroundJob(
  rawTools: (mode: WorkMode) => ToolSet,
  kind: string,
  input: JsonValue,
  mode: WorkMode,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const forkInput = resumableForkInput(kind, input);
  if (!forkInput) throw new JobNotResumable(kind);
  const exec = rawTools(mode).agents?.execute;
  if (!exec) throw new JobNotResumable(kind);
  const result = await exec(forkInput, {
    abortSignal: signal, toolCallId: `resume-${nanoid()}`, messages: [],
  });
  return result === undefined ? undefined : decodeJsonValue({ value: result });
}
