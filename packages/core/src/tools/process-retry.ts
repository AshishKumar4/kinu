/**
 * A process job's retry (`retryBackgroundJob`): its command started again as the process of the retry's own job, and
 * answered when that process ends. No model is given it: a retry adds it under the job kind `startProcess`.
 */
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { Effect } from 'effect';
import { detach, KinuError, settle } from '../obs/index';
import { startJobProcess, type NimbusSandboxHandle } from '../execution/nimbus';
import { parseInput } from '../utils/json';
import { readCallJob } from './call-job';

/** As `startProcess` stored it: its command and where it started. */
const RetriedProcessSchema = v.object({ command: v.string(), cwd: v.optional(v.string()) });

export function processRetryTool(box: NimbusSandboxHandle): ToolSet[string] {
  return tool({
    description: "Start a process job's command again as the process of the retry's job.",
    inputSchema: jsonSchema({ type: 'object' }),
    execute: (input, options) => settle(Effect.gen(function* () {
      const job = readCallJob(options);
      const retried = parseInput(RetriedProcessSchema, { value: input });

      if (job === undefined || retried === undefined) return yield* new KinuError('bad_input', 'a process is started again only as a retried job');
      const { command, cwd } = retried;
      const started = yield* Effect.promise(() => startJobProcess(box, { command, ...(cwd !== undefined && { cwd }), jobId: job.id }));

      if ('success' in started) return yield* new KinuError(started.reason, started.error);
      // Its job's cancel ends it.
      options.abortSignal?.addEventListener('abort', () => { detach(started.stopping); }, { once: true });

      return yield* Effect.promise(() => started.ended);
    })),
  });
}
