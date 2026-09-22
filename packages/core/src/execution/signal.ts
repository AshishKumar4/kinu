/**
 * Cancellation convention: callers pass a trailing `{ signal }` to an executor's `exec`.
 * Sandbox and laptop kill the work before rejecting; Nimbus has no kill, so it stops
 * waiting and rejects saying the remote command may still finish. Never attach that
 * message to a transport that could have killed the work.
 */
import * as v from 'valibot';

const ExecContextSchema = v.object({ signal: v.optional(v.instance(AbortSignal)) });

export function readExecSignal(input: { context: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(ExecContextSchema, input.context);

  return parsed.success ? parsed.output.signal : undefined;
}

/**
 * Per-call device ownership (a turn can hold parallel device commands). `owner()`
 * is read per call, never cached: the answer changes under a running scope.
 */
const DeviceOwnershipContextSchema = v.object({
  onDeviceRequest: v.optional(v.function()),
  deviceRequestOwner: v.optional(v.function()),
});

/** An empty string names no owner. */
const OwnerAnswerSchema = v.nullable(v.pipe(v.string(), v.minLength(1)));

export interface DeviceOwnership {
  /** Called for every device exec; the holder decides what a report means. */
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
