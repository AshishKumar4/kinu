import { attachHarnessRunToError, createHarness, normalizeHarnessRun, type TranscriptEvent } from 'vitest-evals';
import type { RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import type { KinuPublicSession, PublicMessage } from '../../tests/evals/public-session';
import { ARMS, deployedBuild, openWorkspace, type EvalArm, type EvalTarget } from './target';
import type {
  EvalCheck, EvalRunInput, EvalRunOutput, EvalTask, EvalTurn, EvalTurnOutcome, EvalTurnResult, HarnessError,
} from './task';
import { redact } from './redact';
import { measure, toTranscript } from './transcript';
import { EvalVerifier } from './verifier';

/** How often an unsettled workspace is looked at. A poll, not a deadline: nothing here ends a turn. */
const IDLE_POLL_MS = 3_000;

/** Polls in a row the deployment's transport may fail before the trial fails as infrastructure. */
const DROPPED_POLLS = 3;


export type TrialIdentity = { readonly taskVersion: string; readonly evalCommit: string };

function openRuns(events: readonly RunEvent[]): string[] {
  const ended = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

  return events.filter((event) => event.type === 'run_start' && !ended.has(event.runId)).map((event) => event.runId);
}

/**
 * Wait until the workspace has nothing left to do for this turn: no run open, no background job
 * running, no helper working, seen on two polls in a row. A background job's completion wakes the
 * agent in a run of its own, and that run answers the prompt too.
 */
export async function settle(session: KinuPublicSession): Promise<void> {
  let quiet = 0;
  let dropped = 0;

  for (;;) {
    let busy = true;

    try {
      const [events, jobs, helpers] = await Promise.all([session.runEvents(), session.backgroundJobs(), session.subordinates()]);

      busy = openRuns(events).length > 0 || jobs.some((job) => job.status === 'running')
        || helpers.some((helper) => helper.status === 'working');

      dropped = 0;
    } catch (error) {
      // An eviction closes the socket under the polls in flight, and the next poll redials. Three
      // failed polls in a row is a deployment that is not answering, and fails the trial as that.
      dropped += 1;

      if (!renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER) || dropped >= DROPPED_POLLS) throw error;
    }

    quiet = busy ? 0 : quiet + 1;

    if (quiet >= 2) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, IDLE_POLL_MS); });
  }
}

/** What the agent said after `prompt`, oldest first; wake rows between are the agent's own work. */
export function repliesTo(history: readonly PublicMessage[], prompt: string): string[] {
  const asked = history.map((row) => row.role === 'user' && row.text.trim() === prompt.trim()).lastIndexOf(true);

  if (asked === -1) return [];

  return history.slice(asked + 1).filter((row) => row.role === 'assistant' && row.text.trim() !== '').map((row) => row.text);
}

/** A turn whose runs the deployment ended in error measured the deployment, not the agent. */
function outcomeOf(events: readonly RunEvent[], before: ReadonlySet<string>): EvalTurnOutcome {
  const failed = events.find((event) => event.type === 'run_end' && !before.has(event.runId)
    && (event.reason === 'error' || event.reason === 'aborted'));

  if (failed?.type !== 'run_end') return { status: 'completed' };

  return { status: 'error', message: failed.error ?? `a run ended ${failed.reason ?? 'without a reason'}` };
}

async function runTurn(session: KinuPublicSession, turn: EvalTurn): Promise<EvalTurnResult> {
  for (const file of turn.seed ?? []) await session.writeFile(file.path, file.content);

  const before = new Set((await session.runEvents()).map((event) => event.runId));
  const startedAt = Date.now();

  await session.prompt(turn.prompt);
  await settle(session);
  const turnWallMs = Date.now() - startedAt;
  const [events, history] = await Promise.all([session.runEvents(), session.history()]);

  // Whether it ran as its own turn or landed in one already running, a prompt that arrived is in the history.
  if (!history.some((row) => row.role === 'user' && row.text.trim() === turn.prompt.trim())) {
    throw new Error(`${INFRA_FAILURE_MARKER} \u2014 the prompt never reached the workspace: the history has no row for it`);
  }

  const outcome = outcomeOf(events, before);

  if (outcome.status !== 'completed') return { outcome, checks: [], turnWallMs, verificationWallMs: 0 };

  const replies = repliesTo(history, turn.prompt);
  const verifiedAt = Date.now();
  const checks: EvalCheck[] = await new EvalVerifier(session, replies).collect(turn.verify);

  if (turn.verifyAfterEviction !== undefined && checks.every((check) => check.pass)) {
    await session.abortActivation();
    session.disconnect();
    await session.connect();
    checks.push(...await new EvalVerifier(session, replies).collect(turn.verifyAfterEviction));
  }

  return { outcome, checks, turnWallMs, verificationWallMs: Date.now() - verifiedAt };
}

/**
 * One trial of one task on the deployment: a fresh workspace, then per turn the seeded files, the
 * prompt, the wait until the workspace settles, and the checks. It stops at the first turn that
 * fails, because every later turn builds on it, and deletes the workspace whatever happened.
 */
export function createKinuHarness(task: EvalTask, target: EvalTarget, identity: TrialIdentity) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: 'kinu-agent',
    run: async ({ input, signal }) => {
      const turns: EvalTurnResult[] = [];
      const errors: HarnessError[] = [];
      let session: KinuPublicSession | undefined;
      let events: RunEvent[] = [];
      let costUsd: number | undefined;
      let productSha = 'unknown';
      let attempted: string | undefined;

      try {
        productSha = await deployedBuild(target);
        session = await openWorkspace(target, { subject: `${task.id}-${String(input.trial)}`, mission: task.mission, model: input.model });
        const arm: EvalArm | undefined = ARMS.find((declared) => declared.id === input.arm);

        if (arm === undefined) throw new Error(`no arm is declared as ${input.arm}`);
        await arm.apply(session);

        for (const turn of task.turns) {
          if (signal?.aborted === true) throw new Error('the eval run was cancelled', { cause: signal.reason });
          attempted = turn.prompt;
          const result = await runTurn(session, turn);
          turns.push(result);

          if (result.outcome.status !== 'completed' || result.checks.some((check) => !check.pass)) break;
        }
      } catch (error) {
        // infraBoundary marks a failure of the deployment's transport; anything else is the harness's own.
        const message = renderThrownChain({ cause: error });
        errors.push({ name: message.includes(INFRA_FAILURE_MARKER) ? 'InfraError' : 'EvalRunError', message });
      }

      if (session !== undefined) {
        try {
          events = [...await session.runEvents()];
          costUsd = (await session.spend()).total.usd;
        } catch (error) {
          errors.push({ name: 'InfraError', message: `the trial's ledger could not be read: ${renderThrownChain({ cause: error })}` });
        }

        try {
          await session.teardown();
        } catch (error) {
          errors.push({ name: 'EvalCleanupError', message: renderThrownChain({ cause: error }) });
        }
      }

      try {
        const after = await deployedBuild(target);

        if (after !== productSha) {
          errors.push({ name: 'EvalBuildChanged', message: `the deployment served ${productSha.slice(0, 12)} then ${after.slice(0, 12)} during the trial` });
        }
      } catch (error) {
        errors.push({ name: 'InfraError', message: renderThrownChain({ cause: error }) });
      }

      const metrics = measure(events);
      const usageMetadata: Record<string, number> = {};

      if (costUsd !== undefined) usageMetadata.costUsd = costUsd;
      const checks = turns.flatMap((turn) => turn.checks);

      const success = errors.length === 0 && turns.length === task.turns.length
        && turns.every((turn) => turn.outcome.status === 'completed') && checks.length > 0 && checks.every((check) => check.pass);

      const transcript: TranscriptEvent[] = toTranscript(events);

      if (attempted !== undefined && !events.some((event) => event.type === 'run_start' && event.userMessage === attempted)) {
        transcript.push({ type: 'message', role: 'user', content: attempted, metadata: { attempted: true } });
      }

      // A trial that failed before its first prompt still reports what it was about to ask.
      if (transcript.length === 0) {
        transcript.push({ type: 'message', role: 'user', content: task.turns[0].prompt, metadata: { attempted: false } });
      }

      // Error text can quote a URL or a header; it is scrubbed like the transcript before it is stored.
      const scrubbed = errors.map((error) => ({ name: error.name, message: redact(error.message) }));

      const result = {
        output: {
          success, turns,
          metrics: {
            modelTurns: metrics.modelTurns, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors,
            providerWaits: metrics.providerWaits, providerWaitMs: metrics.providerWaitMs,
          },
        },
        events: transcript,
        usage: {
          provider: input.model.split('/')[0] ?? 'unknown', model: input.model, toolCalls: metrics.toolCalls,
          inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens,
          metadata: usageMetadata,
        },
        errors: scrubbed,
        metadata: {
          taskId: task.id, taskVersion: identity.taskVersion, evalCommit: identity.evalCommit, productSha,
          arm: input.arm, trial: input.trial, origin: target.origin, workspace: session?.workspace ?? null,
        },
      };

      if (scrubbed.length > 0) {
        const failure = new Error(scrubbed.map((error) => `${error.name}: ${error.message}`).join('\n'));
        throw attachHarnessRunToError(failure, normalizeHarnessRun(input, result));
      }

      return result;
    },
  });
}
