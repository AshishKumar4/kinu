import { createHash } from 'node:crypto';
import type { JsonValue } from 'vitest-evals';
import type { EvalVerifier } from './verifier';

/** A file the harness writes into the workspace before a prompt: data a person would drop in. */
export type SeedFile = { readonly path: string; readonly content: string };

export type EvalTurn = {
  readonly seed?: readonly SeedFile[];
  readonly prompt: string;
  readonly verify: (verifier: EvalVerifier) => Promise<void>;
  /** End the workspace's activation, then run these checks: what the product promises survives an eviction. */
  readonly verifyAfterEviction?: (verifier: EvalVerifier) => Promise<void>;
};

export type EvalTask = {
  readonly id: string;
  /** The workspace's mission, written to SOUL.md before the first prompt; no genesis turn runs. */
  readonly mission: string;
  readonly turns: readonly [EvalTurn, ...EvalTurn[]];
};

export type EvalCheck = { id: string; pass: boolean; evidence?: JsonValue };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate one task before it can spend inference. */
export function defineEvalTask(task: EvalTask): EvalTask {
  if (!ID.test(task.id)) throw new Error(`Invalid eval task id ${JSON.stringify(task.id)}`);

  if (task.mission.trim() === '') throw new Error(`Eval task ${task.id} has no mission`);

  for (const [index, turn] of task.turns.entries()) {
    if (turn.prompt.trim() === '') throw new Error(`Eval task ${task.id} turn ${String(index + 1)} is empty`);
  }

  return task;
}

/** Hash what the agent is given: the mission, every prompt and every seeded file. */
export function taskVersion(task: EvalTask): string {
  const given = { mission: task.mission, turns: task.turns.map((turn) => ({ seed: turn.seed ?? [], prompt: turn.prompt })) };

  return createHash('sha256').update(JSON.stringify(given)).digest('hex');
}

export type EvalRunInput = { model: string; arm: string; trial: number };

/**
 * How the deployment ended a turn. `completed`: it ran, and its checks grade what the agent built.
 * `error`: the deployment reported the run failed (a provider outage, a crashed run), which says
 * nothing about the agent's work and is counted as infrastructure. `refused`: the deployment
 * answered one of the turn's requests with a failure of its own (a 5xx, a refused RPC), which is
 * the build's result and counts against it like a failed check.
 */
export const TURN_OUTCOMES = ['completed', 'error', 'refused'] as const;

export type EvalTurnOutcome = { status: (typeof TURN_OUTCOMES)[number]; message?: string };

export type EvalTurnResult = {
  outcome: EvalTurnOutcome;
  checks: EvalCheck[];
  turnWallMs: number;
  verificationWallMs: number;
};

/**
 * What a trial cost the agent, off the run ledger. `providerWaits` and `providerWaitMs` are the
 * product waiting out the model provider (429 backoff, a retry-after, a shared cooldown): the eval
 * account's rate limit, not the agent's work, reported as infrastructure.
 */
export type EvalMetrics = { modelTurns: number; toolCalls: number; toolErrors: number; providerWaits: number; providerWaitMs: number };

export type EvalRunOutput = { success: boolean; turns: EvalTurnResult[]; metrics: EvalMetrics };

/**
 * Harness-level failures, by name. None is the agent's result: the comparison counts a trial
 * carrying one as an infrastructure failure and keeps it out of the pass rate it compares.
 */
export const HARNESS_ERRORS = ['InfraError', 'EvalRunError', 'EvalCleanupError', 'EvalBuildChanged'] as const;

export type HarnessError = { name: (typeof HARNESS_ERRORS)[number]; message: string };
