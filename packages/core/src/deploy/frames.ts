// Wire shapes the DO writes and the page and CLI parse (never cast). Nothing here holds a secret.
import * as v from 'valibot';
import type { DeployStepRow } from './runner';

/** `cloudflare` false: no OAuth client registered; `reason` replaces the sign-in button. */
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

/** `expired`: the vault timed out; the ledger stays readable, the tokens are gone. */
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

/** A full snapshot, not a delta stream, so a reconnecting page replays nothing. */
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

export const DeployFrameSchema = v.variant('type', [
  v.object({ type: v.literal('deploy.snapshot'), snapshot: DeploySnapshotSchema }),
  v.object({ type: v.literal('deploy.progress'), progress: DeployProgressSchema }),
]);

export type DeployFrame = v.InferOutput<typeof DeployFrameSchema>;

export const DeployTicketSchema = v.object({
  runId: v.string(),
  runKey: v.string(),
});
