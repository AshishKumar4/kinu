/** `shell.run` served over the execution router: the workspace's shell by default, or the sandbox's, or a user's machine. */
import * as v from 'valibot';
import { Effect } from 'effect';
import { clampToolResult, type ClampToolResultOptions } from './clamp';
import { createFileToolSteer } from './shell-file-steer';
import { commandResultAt, CommandResultSchema, type CommandResult } from '../execution/exec-result';
import type { TurnEscalationLedger } from '../execution/escalation';
import type { ExecutionRouter } from '../execution/types';
import type { TurnContextBudget } from '../context-budget';
import type { CallJob, Shell, ShellExecOptions } from '../types/primitives';
import { attempt, KinuError, settle, type Logger } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { shellRun } from '../operations/shell';

/** What the call hands its runtime: absent keys stay absent, so a runtime reads presence. */
function shellCallOptions(
  args: { readonly cwd?: string | undefined; readonly name?: string | undefined },
  signal: AbortSignal | undefined,
  job: CallJob | undefined,
): ShellExecOptions {
  const options: ShellExecOptions = {};

  if (signal) options.signal = signal;

  if (job) {
    options.job = job.id;
    options.detached = job.detached;
    options.output = job.output;
  }

  if (args.cwd !== undefined) options.cwd = args.cwd;

  if (args.name !== undefined) options.name = args.name;

  return options;
}

/** Log event names; constants so emitter and query spell them identically. Only refusals and handled failures. */
const RUN_SHELL_ABSENT = 'shell.shell_absent';

const RUN_ESCALATION_REFUSED = 'shell.escalation_refused';

const RUN_RUNTIME_NO_EXEC = 'shell.runtime_no_exec';

const RUN_ESCALATION_FAILED = 'shell.escalation_failed';

function unprovisionedAdvice(runtimeKey: string): string {
  if (runtimeKey === 'device') {
    return 'A machine runtime requires the Kinu PC daemon. Ask the user to install it from the Executors tab.';
  }

  if (runtimeKey === 'sandbox') {
    return 'The full Cloudflare Sandbox is not active yet. It will be auto-provisioned on first use: retry.';
  }

  return `Runtime "${runtimeKey}" is not registered.`;
}

export interface ShellDeps {
  readonly shell: Shell | undefined;
  readonly router: ExecutionRouter | undefined;
  readonly files: ClampToolResultOptions['files'];
  readonly budget: TurnContextBudget;
  readonly escalations: TurnEscalationLedger;
  readonly logger: Logger;
}

/** No fallback chain: an unready runtime refuses, and never silently routes elsewhere. Approval lives at the execution seam. */
export function serveShell({ shell, router, files, budget, escalations, logger }: ShellDeps): Served {
  const fileToolSteer = createFileToolSteer();

  const runtimes = [...new Set(['workspace', ...(router?.listExecutors().map(({ name }) => name) ?? [])])];

  return serve(shellRun(runtimes), async (args, { signal, job }) => await settle(Effect.gen(function* () {
        // Approval lives at the execution seam (execution/approval.ts), not here.

        // The file steer is composed into the clamped text so one cap covers it (shell-file-steer.ts).
        const steer = fileToolSteer(args.command);
        const clampOpts: ClampToolResultOptions = { files, budget, producer: 'shell' };

        const clamp = (result: CommandResult): Effect.Effect<string, KinuError> => {
          if (!v.is(v.string(), result)) {
            return Effect.flatMap(Effect.promise(() => clampToolResult(result.error, clampOpts)), (failure) => Effect.fail(new KinuError(result.reason, failure, { execution: result.execution })));
          }

          return Effect.promise(() => clampToolResult(steer ? `${steer}\n\n${result}` : result, clampOpts));
        };

        const defaultRuntime = 'workspace';
        const runtimeKey = args.runtime ?? defaultRuntime;

        if (runtimeKey === 'workspace') {
          if (!shell) {
            const refusal = new KinuError(
              'unsupported',
              'no workspace shell available in this runtime',
            );

            logger.failure(RUN_SHELL_ABSENT, refusal, { runtime: runtimeKey });

            return yield* refusal;
          }

          const result = yield* Effect.promise(() => shell.exec(args.command, shellCallOptions(args, signal, job)));

          return yield* clamp(commandResultAt(result));
        }

        // Past here is an escalation; every exit records it, including refusals.
        // Unknown runtime values are device nicknames resolved by the device executor.
        const registered = router?.getProvider(runtimeKey);
        const nickname = registered === undefined && runtimeKey !== 'sandbox' ? runtimeKey : undefined;
        const provider = nickname === undefined ? registered : router?.getProvider('device');

        if (!provider) {
          escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
          // Never fall back to workspace. `unavailable` (retryable), not `unsupported`; the `error`
          // token is matched by the install card (cf-backend WorkspacePage.tsx).
          const refusal = new KinuError('unavailable', 'runtime_not_provisioned');
          logger.failure(RUN_ESCALATION_REFUSED, refusal, { runtime: runtimeKey });

          return yield* new KinuError(refusal.code, refusal.message + ': '
            + unprovisionedAdvice(nickname !== undefined ? 'device' : runtimeKey), { cause: refusal });
        }

        const execTool = provider.tools.exec;

        if (!execTool) {
          escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'refused' });
          // `unsupported`: this environment has no shell; retrying cannot help.
          const refusal = new KinuError('unsupported', 'runtime_does_not_support_exec');
          logger.failure(RUN_RUNTIME_NO_EXEC, refusal, { runtime: runtimeKey });

          return yield* new KinuError(refusal.code, refusal.message + ': Runtime "' + runtimeKey + '" is provisioned but does not expose shell exec.', { cause: refusal });
        }

        const context = { ...shellCallOptions(args, signal, job), device: nickname, reportCwd: true };

        // Classify cancellations and OOM prose here, or the durable row only records `threw`.
        const result: CommandResult = yield* attempt({ doing: `run \`${args.command}\` on ${runtimeKey}`, otherwise: 'io' },
          async () => v.parse(CommandResultSchema, await execTool.execute(args.command, context))).pipe(
          Effect.tapError((failure) => Effect.sync(() => {
            escalations.observe({ runtime: runtimeKey, reason: args.why, outcome: 'failed' });
            logger.failure(RUN_ESCALATION_FAILED, failure, { runtime: runtimeKey });
          })),
        );

        escalations.observe({
          runtime: runtimeKey,
          reason: args.why,
          outcome: v.is(v.string(), result) ? 'ok' : 'failed',
        });

        return yield* clamp(result);
  })));
}
