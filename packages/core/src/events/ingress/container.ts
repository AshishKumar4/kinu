/**
 * Producer for `sandbox_cb` events from inside the agent's container, via an intercepted virtual
 * host. The workspace comes from backend config and trust is captured at runtime handoff, never
 * read off the wire. `process_done` is effectively-once (dedupe on process id); `file_changed` is
 * at-least-once. Recorded order is arrival order at the DO. Publish is synchronous before the
 * response because `waitUntil` is a no-op in a DO (`do.wait_until.no_op`); the retry is recovery.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import { IngressRejectedError, type IngressDescriptor, type TrustLevel } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import { EVENT_BRIEF_MAX_CHARS } from '../hub/visibility';
import type { VFS } from '../../types/primitives';
import type { JsonValue } from '../../utils/json';

const MAX_COMMAND_CHARS = 4_000;

const MAX_PATH_CHARS = 4_000;

/** Carries no workspace, trust, priority or timestamp: untrusted code must not set them. */
const ProcessDoneEnvelope = v.object({
  kind: v.literal('process_done'),
  process_id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  command: v.pipe(v.string(), v.maxLength(MAX_COMMAND_CHARS)),
  exit_code: v.pipe(v.number(), v.integer()),
  stdout: v.optional(v.string(), ''),
  stderr: v.optional(v.string(), ''),
  duration_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 0),
});

const FileChangedEnvelope = v.object({
  kind: v.literal('file_changed'),
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_CHARS)),
  change: v.picklist(['created', 'modified', 'deleted']),
  size: v.optional(v.pipe(v.number(), v.minValue(0))),
});

export const ContainerEventEnvelopeSchema = v.variant('kind', [
  ProcessDoneEnvelope, FileChangedEnvelope,
]);

export type ContainerEventEnvelope = v.InferOutput<typeof ContainerEventEnvelopeSchema>;

export interface ContainerIngressDeps {
  readonly log: EventLog;
  readonly vfs: VFS;
  /** Captured by the backend; never read off the wire. */
  readonly launchingHeadTrust: TrustLevel;
  /** Debounced, so a burst of reports becomes one turn. */
  readonly onAdmitted: () => void;
}

export type ContainerEventResult =
  | { readonly status: 'admitted'; readonly event_id: string; readonly admitted: boolean }
  | { readonly status: 'rejected'; readonly http_status: number; readonly reason: string };

/** The parse boundary for container-written JSON. */
export async function acceptContainerEvent(
  deps: ContainerIngressDeps,
  body: JsonValue,
  now: number,
): Promise<ContainerEventResult> {
  const parsed = v.safeParse(ContainerEventEnvelopeSchema, body);

  if (!parsed.success) {
    return {
      status: 'rejected',
      http_status: 400,
      reason: `malformed container event: ${parsed.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const envelope = parsed.output;

  const descriptor = envelope.kind === 'process_done'
    ? await processDoneDescriptor(deps, envelope)
    : fileChangedDescriptor(deps, envelope);

  // The hub's priority table decides which trust may publish; its rejection becomes a 403.
  try {
    const { id, admitted } = deps.log.publish({ descriptor, now });

    if (admitted) deps.onAdmitted();

    return { status: 'admitted', event_id: id, admitted };
  } catch (err) {
    if (err instanceof IngressRejectedError) {
      return { status: 'rejected', http_status: 403, reason: err.message };
    }

    throw err;
  }
}

async function processDoneDescriptor(
  deps: ContainerIngressDeps,
  envelope: Extract<ContainerEventEnvelope, { kind: 'process_done' }>,
): Promise<IngressDescriptor> {
  const [stdout, stderr] = await Promise.all([
    spillEventContent(deps.vfs, envelope.stdout),
    spillEventContent(deps.vfs, envelope.stderr),
  ]);

  return {
    ingress: 'sandbox_cb',
    variant: 'process_done',
    launching_head_trust: deps.launchingHeadTrust,
    payload: {
      process_id: envelope.process_id,
      command: envelope.command,
      exit_code: envelope.exit_code,
      stdout_excerpt: envelope.stdout.slice(0, EVENT_BRIEF_MAX_CHARS),
      stderr_excerpt: envelope.stderr.slice(0, EVENT_BRIEF_MAX_CHARS),
      duration_ms: envelope.duration_ms,
      full_stdout_handle: stdout?.path,
      full_stderr_handle: stderr?.path,
      stdout_unsaved: stdout?.unsaved,
      stderr_unsaved: stderr?.unsaved,
    },
  };
}

function fileChangedDescriptor(
  deps: ContainerIngressDeps,
  envelope: Extract<ContainerEventEnvelope, { kind: 'file_changed' }>,
): IngressDescriptor {
  return {
    ingress: 'sandbox_cb',
    variant: 'file_changed',
    launching_head_trust: deps.launchingHeadTrust,
    payload: { path: envelope.path, change: envelope.change, size: envelope.size },
  };
}
