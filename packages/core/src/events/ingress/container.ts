/**
 * Container ingress — a process inside the agent's own container reports that
 * something happened, and it becomes a durable event.
 *
 * Why this exists. The DO can already reach into the container
 * (`containerFetch`, `exec`); the container had no way to reach back, so
 * anything it learned between two polls was invisible until something asked.
 * A build that finished in ninety seconds sat unnoticed until the next poll,
 * and a watcher inside the container had nowhere to send what it saw.
 *
 * What this is NOT. It is not a second event plane. The `sandbox_cb` ingress
 * kind and the `process_done` / `file_changed` variants have been fully
 * modelled in the hub since it was written — trust derivation, priority,
 * dedupe, LLM rendering — with no producer anywhere. This is that producer.
 * Everything downstream (the drain, the debounce that turns a burst into one
 * turn, the journal) is the machinery that was already there.
 *
 * ── Addressing ───────────────────────────────────────────────────
 * The container posts to a virtual hostname that resolves nowhere on the
 * public internet and is intercepted by the egress layer, so the request never
 * leaves the machine. WHICH workspace the report belongs to is NOT in the
 * envelope: the backend derives it from configuration the container cannot
 * influence, because a container that could name its own workspace could post
 * into somebody else's.
 *
 * ── Trust ────────────────────────────────────────────────────────
 * `launching_head_trust` is captured by the backend at the moment the
 * container was handed to a runtime, never read off the wire. The hub meets it
 * with `self`, and its priority table has cells for `process_done` and
 * `file_changed` only at `self` and `owner`. So a container driven by a head
 * that had consumed external input CANNOT publish — and that is a deliberate
 * property of the trust lattice, not an accident. This adapter maps the hub's
 * `IngressRejectedError` to a 403 refusal with a reason, rather than letting
 * it throw out through an HTTP proxy handler.
 *
 * ── Delivery guarantees, stated exactly ──────────────────────────
 *   `process_done`  — effectively once. The hub's dedupe key is
 *                     `process_done:<process_id>` with no time bucket, so a
 *                     container that retries the same process id gets
 *                     `admitted: false` and no second row, forever.
 *   `file_changed`  — AT LEAST once. The hub assigns this variant no dedupe
 *                     key, so a retried delivery does produce a second row.
 *                     Said plainly because the honest guarantee is the one a
 *                     caller can rely on: this transport does not add a
 *                     dedupe key of its own, because two identical writes to
 *                     one path are a real thing that happens twice.
 *
 * ── Ordering ─────────────────────────────────────────────────────
 * Deliveries are independent requests and may arrive in any order. Durable
 * order is the ULID minted at publish, which is monotonic per DO, so the
 * recorded order is arrival order at the DO — not the order events occurred
 * inside the container. A caller that needs causal order must carry it in the
 * payload; the transport does not invent it.
 *
 * ── Eviction mid-flight ──────────────────────────────────────────
 * Nothing here continues after a response. `publish` is a synchronous write
 * inside the invocation that answers the container, and the container is told
 * the outcome. `waitUntil` is a no-op in a Durable Object — `ctx.waitUntil(p)`
 * and a bare floating `p` are the same code path, and both are cancelled with
 * the cancellation swallowed when the object is evicted — so a design that
 * acknowledged first and wrote afterwards would silently lose events. If the
 * DO is evicted while the write is in flight the container's request fails,
 * and the retry is the recovery. There is no background task to lose.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import { IngressRejectedError, type IngressDescriptor, type TrustLevel } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import { EVENT_BRIEF_MAX_CHARS } from '../hub/visibility';
import type { VFS } from '../../types/primitives';
import type { JsonValue } from '../../utils/json';

/** Longest command line a report may carry. Past this it is not a command, it
 *  is a payload wearing one. */
const MAX_COMMAND_CHARS = 4_000;

/** Longest path a file report may carry. */
const MAX_PATH_CHARS = 4_000;

/**
 * The wire envelope, as the container writes it.
 *
 * Deliberately narrow. It carries no workspace, no trust, no priority and no
 * timestamp: every one of those is either derived by the hub or supplied by
 * the backend from configuration, and accepting any of them from inside the
 * container would let untrusted code set it.
 */
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
  /** Where oversize stdout/stderr is spilled so the woken turn can read the
   *  whole thing instead of a truncated fragment. */
  readonly vfs: VFS;
  /** Trust of the head that was driving this container when it was handed a
   *  runtime. Captured by the backend; never read off the wire. */
  readonly launchingHeadTrust: TrustLevel;
  /** Wake the agent. The debounce behind this is what turns a burst of
   *  container reports into ONE turn, so it is called instead of draining. */
  readonly onAdmitted: () => void;
}

export type ContainerEventResult =
  | { readonly status: 'admitted'; readonly event_id: string; readonly admitted: boolean }
  | { readonly status: 'rejected'; readonly http_status: number; readonly reason: string };

/** Gate + publish one container report. Runs inside the agent's storage.
 *
 *  `body` is arbitrary JSON because the container wrote it — this function IS
 *  the parse boundary, and `ContainerEventEnvelopeSchema` is the parser. */
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

  // The hub's priority table is the one authority on which trust publishes
  // which variant: its `IngressRejectedError` becomes the 403 refusal.
  try {
    const { id, admitted } = deps.log.publish({ descriptor, now });
    // Only a newly admitted event wakes anything: a duplicate is already bound
    // or in flight, and waking for it would re-run a turn for work already seen.
    if (admitted) deps.onAdmitted();
    return { status: 'admitted', event_id: id, admitted };
  } catch (err) {
    if (err instanceof IngressRejectedError) {
      return { status: 'rejected', http_status: 403, reason: err.message };
    }
    throw err;
  }
}

/** Oversize output is spilled to the agent's own file plane, and the brief
 *  carries the window plus the path — the reference-plus-digest pair the woken
 *  turn reads back. Without it the agent is woken BY output it can only see a
 *  fragment of. */
async function processDoneDescriptor(
  deps: ContainerIngressDeps,
  envelope: Extract<ContainerEventEnvelope, { kind: 'process_done' }>,
): Promise<IngressDescriptor> {
  const [stdoutHandle, stderrHandle] = await Promise.all([
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
      full_stdout_handle: stdoutHandle || undefined,
      full_stderr_handle: stderrHandle || undefined,
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
