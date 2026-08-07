/**
 * Background-tool policy — which tool calls may auto-detach past the 30s
 * threshold (with the per-call gate: `agents` detaches only its fork action —
 * the converse actions keep their inline semantics), the wrapper that arms
 * it, and the evict/exit resume policy. One implementation for both backends
 * (each previously carried its own copy of the map AND the wrapper AND the
 * resume gate).
 */

import type { ToolSet } from 'ai';
import { combineAbortSignals } from '@proteus/agent-utils';
import { withBackgroundThreshold } from '../jobs/threshold.js';
import { JobNotResumable } from '../jobs/runner.js';
import type { BackgroundJobRunner } from '../jobs/runner.js';
import { resumableForkInput } from '../tools/agents-tool.js';
import { nanoid } from '../utils/nanoid.js';

/** Tools whose work can be long enough to auto-detach to the background,
 *  keyed to a per-call gate over the tool input. */
export const BACKGROUNDABLE_TOOLS: ReadonlyMap<string, (input: unknown) => boolean> = new Map([
  ['agents', (input: unknown) => (input as { action?: unknown } | null)?.action === 'fork'],
  ['execute_tools', () => true],
  ['run', () => true],
]);

/**
 * Return a SHALLOW CLONE of the raw toolset with the long-running tools'
 * execute wrapped in the 30s background threshold. Never mutates the cached
 * raw toolset — so the raw surface stays unwrapped for the eval side-streams
 * (shadow eval / scaffold / GEPA), where a >30s tool run must complete inline
 * instead of detaching a job into the user's chat.
 *
 * Each detachable call gets its own AbortController (hard-cancel aborts the
 * underlying work), merged with the turn's signal so a turn abort still
 * propagates. `trackController` (cf) registers the controller for foreground
 * cancellation until the call settles; once detached, BackgroundJobRunner
 * owns it.
 */
export function wrapToolsForBackground(raw: ToolSet, deps: {
  jobRunner: Pick<BackgroundJobRunner, 'thresholdDeps'>;
  trackController?: (controller: AbortController) => (() => void);
}): ToolSet {
  const wrapped: ToolSet = { ...raw };
  for (const [key, detachable] of BACKGROUNDABLE_TOOLS) {
    const orig = wrapped[key];
    const exec = orig?.execute;
    if (!orig || typeof exec !== 'function') continue;
    wrapped[key] = {
      ...orig,
      execute: (input, options) => {
        if (!detachable(input)) return exec(input, options);
        const controller = new AbortController();
        const turnSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const abortSignal = turnSignal ? combineAbortSignals([turnSignal, controller.signal]) : controller.signal;
        const thresholdDeps = deps.jobRunner.thresholdDeps(key, input, controller);
        const untrack = deps.trackController?.(controller);
        const run = withBackgroundThreshold(key, () => exec(input, { ...options, abortSignal }), thresholdDeps);
        return untrack ? run.finally(untrack) : run;
      },
    } as ToolSet[string];
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
  rawTools: () => ToolSet,
  kind: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const forkInput = resumableForkInput(kind, input);
  if (!forkInput) throw new JobNotResumable(kind);
  const exec = rawTools().agents?.execute;
  if (typeof exec !== 'function') throw new JobNotResumable(kind);
  return (exec as (i: unknown, o: unknown) => unknown)(forkInput, {
    abortSignal: signal, toolCallId: `resume-${nanoid()}`, messages: [],
  });
}
