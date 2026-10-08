/**
 * Auto-detach wrapper plus the two ungated detach-policy entries. 'result' races the detach threshold;
 * 'spawn' detaches on spawn-confirm when a wake can arrive, else runs inline.
 * The full policy (orchestrator/background-tools.ts) is passed in: importing it here closes a runtime import ring.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { DEVICE_REQUEST_OPTION, SPAWN_STARTED_OPTION, withBackgroundThreshold, withSpawnDetach } from './threshold';
import { DeviceRequestOwnership } from './device-ownership';
import { CALL_JOB_OPTION } from '../tools/call-job';
import type { CallJob } from '../types/primitives';
import { newJobId, type BackgroundJobRunner } from './runner';
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

export interface ActorJobs {
  readonly jobRunner: Pick<BackgroundJobRunner, 'thresholdDeps' | 'policy' | 'output' | 'foreground'>;
  readonly backgroundable: Readonly<Record<string, BackgroundableTool>>;
  readonly mode: () => WorkMode;
}

/** A shallow clone, so the raw surface stays inline; once a job retains a call, its runner owns the controller. */
export function wrapToolsForBackground(raw: ToolSet, deps: ActorJobs): ToolSet {
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
        const ownership = new DeviceRequestOwnership(newJobId());
        const output = deps.jobRunner.output.open(ownership.jobId);
        const job: CallJob = { id: ownership.jobId, detached: ownership.detached, output };
        const ending = <T>(call: T | PromiseLike<T>): Promise<T> => Promise.resolve(call).finally(() => { output.end(); });

        ownership.detached.addEventListener('abort', () => { output.live(); }, { once: true });
        const mode = deps.mode();
        const turnSignal = options.abortSignal;
        const abortSignal = turnSignal ? AbortSignal.any([turnSignal, controller.signal]) : controller.signal;
        deps.jobRunner.foreground.add(controller);
        // Policy is read per call: on cf one runner serves both surfaces.
        let run: Promise<unknown>;

        if (completion === 'spawn') {
          if (!deps.jobRunner.policy.wakesAfterTurn) {
            run = ending(exec(input, { ...options, abortSignal }));
          } else {
            run = withSpawnDetach(
              key,
              (spawnStarted) => {
                const execOptions: ToolExecutionOptions<unknown> & {
                  [SPAWN_STARTED_OPTION]: () => void;
                  [DEVICE_REQUEST_OPTION]: DeviceRequestOwnership;
                  [CALL_JOB_OPTION]: CallJob;
                } = {
                  ...options, abortSignal,
                  [SPAWN_STARTED_OPTION]: spawnStarted,
                  [DEVICE_REQUEST_OPTION]: ownership,
                  [CALL_JOB_OPTION]: job,
                };

                return ending(exec(input, execOptions));
              },
              deps.jobRunner.thresholdDeps(input, mode, controller, ownership),
            );
          }
        } else {
          const execOptions: ToolExecutionOptions<unknown> & {
            [DEVICE_REQUEST_OPTION]: DeviceRequestOwnership;
            [CALL_JOB_OPTION]: CallJob;
          } = {
            ...options, abortSignal, [DEVICE_REQUEST_OPTION]: ownership, [CALL_JOB_OPTION]: job,
          };

          run = withBackgroundThreshold(
            key,
            () => ending(exec(input, execOptions)),
            deps.jobRunner.thresholdDeps(input, mode, controller, ownership),
          );
        }

        return run.finally(() => { deps.jobRunner.foreground.delete(controller); });
      },
    };
  }

  return wrapped;
}
