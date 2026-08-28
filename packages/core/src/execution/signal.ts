/**
 * Cancellation convention for executor tools.
 *
 * The `run` tool (and other in-process callers) pass a trailing `{ signal }`
 * options argument to an executor's `exec` tool; codemode sandbox calls pass
 * nothing. Executors honor the signal at the strongest level their transport
 * supports, and the levels are not interchangeable:
 *
 *   The workspace shell stops between commands.
 *
 *   The SANDBOX kills the container process it started and waits for it to be
 *   gone, so a cancelled exec means cancelled work — see `SandboxHandle.exec`
 *   and `adaptCloudflareSandbox`.
 *
 *   The LAPTOP tunnel kills the command on the user's machine. Each command
 *   runs as its own process group, registered on the device under the request
 *   identity it was issued with, so a cancellation reaches the shell AND
 *   everything it started. It waits for that kill before it rejects, and when
 *   the device refuses one it says so rather than claiming the work ended.
 *
 *   Nimbus exposes no kill for an in-flight exec, so it stops WAITING and
 *   rejects with an AbortError that says the remote command may still finish.
 *   That sentence is the honest report of a transport gap, and it must never be
 *   attached to a transport that could have killed the work.
 */
import * as v from 'valibot';

const ExecContextSchema = v.object({ signal: v.optional(v.instance(AbortSignal)) });

export function readExecSignal(input: { context: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(ExecContextSchema, input.context);
  return parsed.success ? parsed.output.signal : undefined;
}

/**
 * Per-call device ownership, in the same trailing context that carries `signal`.
 *
 * Ownership is per call because a turn can hold several parallel device
 * commands: a turn-wide handover would move requests that never detached. Two
 * fields, one authority - the call announces the durable identity it issued, and
 * `deviceRequestOwner()` answers who owns that scope AT THE MOMENT of the call.
 * Before a detach it is null and the announced identity is what gets
 * transferred; after one it names the job, so a later call is owned where it is
 * inserted and no handover has to race it.
 *
 * The getter is read per call, never cached: the whole point is that the answer
 * changes under a running scope.
 */
const DeviceOwnershipContextSchema = v.object({
  onDeviceRequest: v.optional(v.function()),
  deviceRequestOwner: v.optional(v.function()),
});

/** A job id is only an owner when it names one - an empty string names nothing. */
const OwnerAnswerSchema = v.nullable(v.pipe(v.string(), v.minLength(1)));

export interface DeviceOwnership {
  /** Announce the identity this call issued. Called for EVERY device exec: the
   *  holder decides what a report means, so this file never branches on owner. */
  report?: (requestId: string) => void;
  /** Who owns this scope right now, or null before a detach. */
  owner?: () => string | null;
}

export function readDeviceOwnershipContext(input: { context: unknown }): DeviceOwnership {
  const parsed = v.safeParse(DeviceOwnershipContextSchema, input.context);
  if (!parsed.success) return {};
  const ownership: DeviceOwnership = {};
  const reporter = parsed.output.onDeviceRequest;
  if (reporter !== undefined) ownership.report = (requestId: string) => { reporter(requestId); };
  const owner = parsed.output.deviceRequestOwner;
  if (owner !== undefined) {
    ownership.owner = () => {
      const answer = v.safeParse(OwnerAnswerSchema, owner() ?? null);
      return answer.success ? answer.output : null;
    };
  }
  return ownership;
}
