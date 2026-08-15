/**
 * Cancellation convention for executor tools.
 *
 * The `run` tool (and other in-process callers) pass a trailing `{ signal }`
 * options argument to an executor's `exec` tool; codemode sandbox calls pass
 * nothing. Executors honor the signal at the strongest level their transport
 * supports — the workspace shell stops between commands, remote executors
 * (sandbox / nimbus / laptop) stop WAITING and reject with an AbortError that
 * states the remote command may still finish, because their protocols expose
 * no kill for an in-flight exec.
 */
import * as v from 'valibot';

const ExecContextSchema = v.object({ signal: v.optional(v.instance(AbortSignal)) });

export function readExecSignal(input: { context: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(ExecContextSchema, input.context);
  return parsed.success ? parsed.output.signal : undefined;
}
