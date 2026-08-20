/**
 * The auto-detach WRAPPER, and the entries of the detach policy whose gate needs
 * nothing.
 *
 * Two shapes of backgroundable work, one axis:
 *   'result' — the turn is waiting on the call's result and its duration is
 *              unknown (`run`, `execute_tools`), so it races the surface's
 *              detach threshold and only work that proved slow crosses.
 *   'spawn'  — the call launches a process whose completion arrives as a wake
 *              event (`agents` swarm). Where a wake can arrive it detaches the
 *              moment the spawn is confirmed started (the threshold wait could
 *              only ever be dead air); where none can, it runs inline to
 *              completion, because a detached result there has no reader.
 *
 * WHY THE WRAPPER LIVES HERE AND THE FULL POLICY DOES NOT. The `agents` entry's
 * gate is a translator of the delegation tool's own input, so the module holding
 * the full policy (orchestrator/background-tools.ts) must import that tool — and
 * that tool's implementation IS the search engine, which builds a swarm node,
 * which needs this wrapper. Importing the full policy from a node would close
 * exactly the runtime import ring whose module-scope reader put six tests in a
 * TDZ. So the mechanism is a leaf, the policy is passed in, and the SET is named
 * at the call site — the same arrangement `keepBuiltins(builtin, NAMED_SET)`
 * already uses to make a confined tool surface structural rather than incidental.
 *
 * A confined surface (a head, a swarm node) has no `agents` tool at all, so the
 * two entries below are the whole of the policy that can apply to one, and they
 * are declared ONCE — the actor's map is built from them plus its own third
 * entry, so the two cannot drift.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { combineAbortSignals } from '@kinu/agent-utils';
import { SPAWN_STARTED_OPTION, withBackgroundThreshold, withSpawnDetach } from './threshold';
import type { BackgroundJobRunner } from './runner';
import type { WorkMode } from '../prompting/surface';
import { decodeJsonValue, type JsonValue } from '../utils/json';

/** How a backgroundable tool's work detaches: racing the threshold for a
 *  result the turn waits on, or on spawn-confirm for a launched process. */
export interface BackgroundableTool {
  readonly completion: 'result' | 'spawn';
  /** Per-call gate over the tool input. */
  readonly detachable: (input: JsonValue) => boolean;
}

/**
 * The two entries every surface can hold — a shell command and a code run, both
 * result-shaped and both ungated, because neither has an input shape that could
 * make one call detachable and another not.
 */
export const CONFINED_BACKGROUNDABLE_TOOLS = {
  execute_tools: { completion: 'result', detachable: () => true },
  run: { completion: 'result', detachable: () => true },
} as const satisfies Readonly<Record<string, BackgroundableTool>>;

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
  /** Which tools may detach, and on what gate. Named by the caller so a
   *  confined surface's set is visible where the surface is built. */
  backgroundable: Readonly<Record<string, BackgroundableTool>>;
  /** Captured when the outer tool call begins, before it can detach. */
  mode: () => WorkMode;
  trackController?: (controller: AbortController) => (() => void);
}): ToolSet {
  const wrapped: ToolSet = { ...raw };
  for (const [key, { completion, detachable }] of Object.entries(deps.backgroundable)) {
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
