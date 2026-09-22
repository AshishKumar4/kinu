/**
 * Auto-detach wrapper plus the two ungated detach-policy entries. 'result' races the detach threshold;
 * 'spawn' detaches on spawn-confirm when a wake can arrive, else runs inline.
 * The full policy (orchestrator/background-tools.ts) is passed in: importing it here closes a runtime import ring.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { combineAbortSignals } from '@kinu.run/agent-utils';
import { DEVICE_REQUEST_OPTION, SPAWN_STARTED_OPTION, withBackgroundThreshold, withSpawnDetach } from './threshold';
import { DeviceRequestOwnership } from './device-ownership';
import type { BackgroundJobRunner } from './runner';
import type { WorkMode } from '../types/turn';
import { decodeJsonValue, type JsonValue } from '../utils/json';

export interface BackgroundableTool {
  readonly completion: 'result' | 'spawn';
  readonly detachable: (input: JsonValue) => boolean;
}

export const CONFINED_BACKGROUNDABLE_TOOLS = {
  eval: { completion: 'result', detachable: () => true },
  shell: { completion: 'result', detachable: () => true },
} as const satisfies Readonly<Record<string, BackgroundableTool>>;

/**
 * Returns a shallow clone; never mutates the cached raw toolset, which eval side-streams (shadow eval,
 * scaffold, GEPA) use unwrapped. Once a job retains a call, BackgroundJobRunner owns its controller.
 */
export function wrapToolsForBackground(raw: ToolSet, deps: {
  jobRunner: Pick<BackgroundJobRunner, 'thresholdDeps' | 'policy'>;
  /** Named by the caller so a confined surface's set is visible where it is built. */
  backgroundable: Readonly<Record<string, BackgroundableTool>>;
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
        const ownership = new DeviceRequestOwnership();
        const mode = deps.mode();
        const turnSignal = options.abortSignal;
        const abortSignal = turnSignal ? combineAbortSignals([turnSignal, controller.signal]) : controller.signal;
        const untrack = deps.trackController?.(controller);
        // Policy is read per call: on cf one runner serves both surfaces.
        let run: Promise<unknown>;

        if (completion === 'spawn') {
          if (!deps.jobRunner.policy.wakesAfterTurn) {
            run = Promise.resolve(exec(input, { ...options, abortSignal }));
          } else {
            run = withSpawnDetach(
              key,
              (spawnStarted) => {
                const execOptions: ToolExecutionOptions & {
                  [SPAWN_STARTED_OPTION]: () => void;
                  [DEVICE_REQUEST_OPTION]: DeviceRequestOwnership;
                } = {
                  ...options, abortSignal,
                  [SPAWN_STARTED_OPTION]: spawnStarted,
                  [DEVICE_REQUEST_OPTION]: ownership,
                };

                return exec(input, execOptions);
              },
              deps.jobRunner.thresholdDeps(input, mode, controller, ownership),
            );
          }
        } else {
          const execOptions: ToolExecutionOptions & {
            [DEVICE_REQUEST_OPTION]: DeviceRequestOwnership;
          } = {
            ...options, abortSignal, [DEVICE_REQUEST_OPTION]: ownership,
          };

          run = withBackgroundThreshold(
            key,
            () => exec(input, execOptions),
            deps.jobRunner.thresholdDeps(input, mode, controller, ownership),
          );
        }

        return untrack ? run.finally(untrack) : run;
      },
    };
  }

  return wrapped;
}
