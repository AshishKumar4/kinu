/**
 * What the door says over the wire: the door's options, a run's snapshot, and
 * the frames the progress socket carries.
 *
 * ONE SHAPE, THREE READERS. The Durable Object writes these, the `/deploy`
 * page reads them, and `kinu deploy cloudflare` reads the same ones off the
 * same socket. They live in core with a schema each because the two adapters
 * parse rather than cast: a frame whose shape drifted must fail where it
 * arrives, not three fields later where a missing value reads as `undefined`.
 *
 * NOTHING HERE HOLDS A SECRET. A row carries what a step established and, on a
 * refusal, Cloudflare's own sentence. The run key is presented by the caller
 * and never travels back; the tokens live in the run's vault.
 */
import * as v from 'valibot';
import type { DeployStepRow } from './runner';

/** What the door can offer before a run exists. `cloudflare` false means the
 *  owner has registered no OAuth client, and `reason` is the sentence the page
 *  shows instead of a sign-in button. */
export interface DeployOptions {
  readonly cloudflare: boolean;
  /** The public OAuth client id, empty when none is registered. Public by
   *  construction — it travels in every authorize URL — and the CLI door needs
   *  it to build its own authorize leg. */
  readonly clientId: string;
  readonly version: string;
  readonly prompts: readonly string[];
  readonly reason: string;
}

export const DeployOptionsSchema: v.GenericSchema<DeployOptions> = v.object({
  cloudflare: v.boolean(),
  clientId: v.string(),
  version: v.string(),
  prompts: v.array(v.string()),
  reason: v.string(),
});

/** `expired` is the vault's clock running out on a run nobody finished: the
 *  ledger is still readable, and the tokens it was holding are gone. */
export type DeployRunPhase = 'collecting' | 'authorizing' | 'running' | 'failed' | 'done' | 'expired';

export const DeployRunPhaseSchema = v.picklist([
  'collecting', 'authorizing', 'running', 'failed', 'done', 'expired',
]);

const DeployStepStateSchema = v.picklist(['pending', 'running', 'done', 'failed']);

const DeployStepFailureSchema = v.object({
  detail: v.string(),
  code: v.number(),
  status: v.number(),
});

export const DeployStepRowSchema = v.object({
  id: v.string(),
  seq: v.number(),
  title: v.string(),
  state: DeployStepStateSchema,
  attempt: v.number(),
  detail: v.string(),
  notes: v.array(v.string()),
  failure: v.nullable(DeployStepFailureSchema),
  facts: v.record(v.string(), v.string()),
});

/** A run as the page and the CLI see it: the ledger, plus the two facts a
 *  person is waiting for (the address and the version). A snapshot rather than
 *  a delta stream — the row count is a dozen, and a page that reconnects must
 *  not have to replay what it missed. */
export interface DeploySnapshot {
  readonly runId: string;
  readonly state: DeployRunPhase;
  readonly address: string;
  readonly version: string;
  readonly steps: readonly DeployStepRow[];
}

export const DeploySnapshotSchema: v.GenericSchema<DeploySnapshot> = v.object({
  runId: v.string(),
  state: DeployRunPhaseSchema,
  address: v.string(),
  version: v.string(),
  steps: v.array(DeployStepRowSchema),
});

const DeployProgressSchema = v.variant('kind', [
  v.object({ kind: v.literal('step-started'), id: v.string(), attempt: v.number() }),
  v.object({ kind: v.literal('step-note'), id: v.string(), note: v.string() }),
  v.object({ kind: v.literal('step-done'), id: v.string(), detail: v.string() }),
  v.object({ kind: v.literal('step-failed'), id: v.string(), failure: DeployStepFailureSchema }),
  v.object({ kind: v.literal('run-done'), address: v.string() }),
]);

/** Every frame the socket carries. A snapshot on connect and after each change;
 *  a progress event for the line a step is writing right now. */
export const DeployFrameSchema = v.variant('type', [
  v.object({ type: v.literal('deploy.snapshot'), snapshot: DeploySnapshotSchema }),
  v.object({ type: v.literal('deploy.progress'), progress: DeployProgressSchema }),
]);

export type DeployFrame = v.InferOutput<typeof DeployFrameSchema>;

/** The one time a run key exists outside the caller that minted it. */
export const DeployTicketSchema = v.object({
  runId: v.string(),
  runKey: v.string(),
});
