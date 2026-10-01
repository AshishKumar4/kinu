import { join } from 'node:path';
import * as v from 'valibot';
import { attachHarnessRunToError, createHarness, normalizeHarnessRun } from 'vitest-evals/harness';
import type { TranscriptEvent } from 'vitest-evals';
import { platformFact, type RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { DeploymentAnswer, evalNameSlug, INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import { gatherEvidence, writeEvidence, type WorkspaceEvidence } from './evidence';
import { HarnessRunSchema, type StepUsage, type UsageMetadata } from './results';
import type { KinuPublicSession, PublicMessage } from './session';
import { ARMS, deployedBuild, openWorkspace, type EvalArm, type EvalTarget } from './target';
import type {
  EvalCheck, EvalRunInput, EvalRunOutput, EvalTask, EvalTurn, EvalTurnOutcome, EvalTurnResult, HarnessError,
} from './task';
import { redact } from './redact';
import { cutButCompleted, measure, toTranscript } from './transcript';
import { TrialTimeline } from './timeline';
import { EvalVerifier } from './verifier';

/** How often an unsettled workspace is looked at. A poll, not a deadline: nothing here ends a turn. A poll reads only
 *  what the ledger added since the last one, so a short interval costs the deployment little. */
const IDLE_POLL_MS = 1_000;

/** Polls in a row the deployment's transport may fail before the trial fails as infrastructure. */
const DROPPED_POLLS = 3;

/**
 * Trials of one process opening their workspaces at once, at most. Opening is where a trial makes its new connections
 * (the build read, the workspace create, the socket, the model pin), and this workstation's limit on new connections
 * at once is the bound: it sends everything through Cloudflare WARP, which answers a burst of new connections with
 * ICMP host-unreachable, and Bun 1.4's fetch fails such a connect outright where Node's tries the host's next address.
 * Measured 2026-10-01 from twelve processes, as two legs of six task files make: 15 opening per process (180 in all)
 * failed 0 of 540 connects, 20 (240) failed 238 of 720 (kinu-logs/evals-fast/proofs/connect-cause). Once open, a
 * trial runs unbounded.
 */
const MAX_OPENING = 15;

let openingNow = 0;

const waitingToOpen: (() => void)[] = [];

/** Take an opening slot, waiting for one while MAX_OPENING trials of this process are opening. */
function admit(): Promise<void> {
  if (openingNow < MAX_OPENING) {
    openingNow += 1;

    return Promise.resolve();
  }

  return new Promise<void>((resolve) => { waitingToOpen.push(resolve); });
}

/** Hand the slot to the next trial waiting for one, or give it back. */
function release(): void {
  const next = waitingToOpen.shift();

  if (next === undefined) openingNow -= 1;
  else next();
}

/** The check a turn fails when the deployment cut a run mid-work and reported it completed. */
const CUT_REPORTED_COMPLETED = 'deployment.cut-reported-completed';


export type TrialIdentity = { readonly taskVersion: string; readonly evalCommit: string };

/** How an isolate memory reset reads when it surfaces (platform catalog `do.isolate.oom_reported`). */
const MEMORY_RESETS = platformFact('do.isolate.oom_reported').observable.map((observable) => observable.message);

/** Whether a failure the deployment reported is its workspace's isolate reset for memory. */
function memoryReset(message: string): boolean {
  return MEMORY_RESETS.some((reset) => message.includes(reset));
}

/** Prompt usage from the public ledger, complete totals only: a partial denominator would overstate cache hits. */
export function measurePromptUsage(events: readonly RunEvent[]) {
  const steps: StepUsage[] = [];

  for (const event of events) {
    if (event.type !== 'step_finish') continue;
    steps.push({
      runId: event.runId, stepIndex: event.stepIndex,
      inputTokens: event.usage?.input ?? null,
      cacheReadTokens: event.usage?.cacheRead ?? null,
      cacheWriteTokens: event.usage?.cacheWrite ?? null,
    });
  }

  const total = (field: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number | undefined => {
    if (steps.length === 0) return undefined;

    let tokens = 0;

    for (const step of steps) {
      const count = step[field];

      if (count === null) return undefined;
      tokens += count;
    }

    return tokens;
  };

  const metadata: UsageMetadata = { steps };

  for (const field of ['cacheReadTokens', 'cacheWriteTokens'] as const) {
    const tokens = total(field);

    if (tokens !== undefined) metadata[field] = tokens;
  }

  return { inputTokens: total('inputTokens'), metadata };
}

function openRuns(events: readonly RunEvent[]): string[] {
  const ended = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

  return events.filter((event) => event.type === 'run_start' && !ended.has(event.runId)).map((event) => event.runId);
}

/** What one poll of {@link settle} saw: whether the workspace was busy, and the ledger it read. */
export type SettlePoll = (busy: boolean, events: readonly RunEvent[]) => void;

/**
 * Wait until the workspace has nothing left to do for this turn: no run open, no background job
 * running, no helper working, seen on two polls in a row. A background job's completion wakes the
 * agent in a run of its own, and that run answers the prompt too.
 */
export async function settle(session: KinuPublicSession, polled?: SettlePoll): Promise<void> {
  let quiet = 0;
  let dropped = 0;

  for (;;) {
    let busy = true;

    try {
      const [events, jobs, helpers] = await Promise.all([session.runEvents(), session.backgroundJobs(), session.subordinates()]);

      busy = openRuns(events).length > 0 || jobs.some((job) => job.status === 'running')
        || helpers.some((helper) => helper.status === 'working');

      dropped = 0;
      polled?.(busy, events);
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
  const message = failed.error ?? `a run ended ${failed.reason ?? 'without a reason'}`;

  return { status: memoryReset(message) ? 'reset' : 'error', message: redact(message) };
}

/**
 * One turn: its seeded files, the prompt, the wait until the workspace settles, and the checks. `stepped` hears how
 * many steps the turn's runs have recorded while it settles: a stream that dropped shows no more, and the ledger does.
 */
async function runTurn(session: KinuPublicSession, turn: EvalTurn, timeline: TrialTimeline, stepped: (steps: number) => void): Promise<EvalTurnResult> {
  await timeline.span('seed', async () => {
    for (const file of turn.seed ?? []) await session.writeFile(file.path, file.content);
  });

  const before = new Set((await timeline.span('ledger', () => session.runEvents())).map((event) => event.runId));
  const startedAt = Date.now();
  let lost: Error | undefined;

  try {
    await timeline.span('prompt', () => session.prompt(turn.prompt));
  } catch (error) {
    // A socket the deployment drops loses the turn's stream, not the turn: the run goes on up there
    // and the ledger records its end. The history below says whether the prompt ever arrived.
    if (!renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
    lost = error instanceof Error ? error : new Error(renderThrownChain({ cause: error }));
  }

  await timeline.span('settle', () => settle(session, (busy, events) => {
    timeline.mark('poll', { busy });
    stepped(events.filter((event) => event.type === 'step_finish' && !before.has(event.runId)).length);
  }));
  const turnWallMs = Date.now() - startedAt;
  const [events, history] = await timeline.span('read', () => Promise.all([session.runEvents(), session.history()]));

  // Whether it ran as its own turn or landed in one already running, a prompt that arrived is in the history.
  if (!history.some((row) => row.role === 'user' && row.text.trim() === turn.prompt.trim())) {
    throw new Error(`${INFRA_FAILURE_MARKER} \u2014 the prompt never reached the workspace: the history has no row for it`, { cause: lost });
  }

  const outcome = outcomeOf(events, before);

  if (outcome.status !== 'completed') return { outcome, checks: [], turnWallMs, verificationWallMs: 0 };

  const replies = repliesTo(history, turn.prompt);
  const verifiedAt = Date.now();
  const cut = cutButCompleted(events, before);
  const checks: EvalCheck[] = cut.length === 0 ? [] : [{ id: CUT_REPORTED_COMPLETED, pass: false, evidence: { runs: cut } }];
  checks.push(...await timeline.span('verify', () => new EvalVerifier(session, replies).collect(turn.verify)));
  const afterEviction = turn.verifyAfterEviction;

  if (afterEviction !== undefined && checks.every((check) => check.pass)) {
    checks.push(...await timeline.span('evict', async () => {
      await session.abortActivation();
      session.disconnect();
      await session.connect();

      return new EvalVerifier(session, replies).collect(afterEviction);
    }));
  }

  return { outcome, checks, turnWallMs, verificationWallMs: Date.now() - verifiedAt };
}

/**
 * What a trial's workspace holds at its end, then its deletion: the ledger and spend, the evidence, the
 * teardown. A failure of any is recorded in `errors`, or, for the evidence, said in it, and never
 * thrown over the verdict the trial's checks gave.
 */
async function closeWorkspace(session: KinuPublicSession, task: EvalTask, errors: HarnessError[], timeline: TrialTimeline): Promise<{
  events: RunEvent[]; costUsd: number | undefined; workspace: WorkspaceEvidence;
}> {
  let events: RunEvent[] = [];
  let costUsd: number | undefined;

  try {
    events = [...await timeline.span('ledger', () => session.runEvents())];
    costUsd = (await timeline.span('spend', () => session.spend())).total.usd;
  } catch (error) {
    errors.push({ name: 'InfraError', message: `the trial's ledger could not be read: ${renderThrownChain({ cause: error })}` });
  }

  const workspace = await timeline.span('evidence', () => gatherEvidence(session, task.evidence));

  try {
    await timeline.span('teardown', () => session.teardown());
  } catch (error) {
    const message = renderThrownChain({ cause: error });

    errors.push({ name: message.includes(INFRA_FAILURE_MARKER) ? 'InfraError' : 'EvalCleanupError', message });
  }

  return { events, costUsd, workspace };
}

/**
 * One trial of one task on the deployment: a fresh workspace, then per turn the seeded files, the
 * prompt, the wait until the workspace settles, and the checks. It stops at the first turn that
 * fails, because every later turn builds on it, keeps the trial's evidence under `evidenceRoot`, and
 * deletes the workspace whatever happened.
 */
export function createKinuHarness(task: EvalTask, target: EvalTarget, identity: TrialIdentity, evidenceRoot: string) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: 'kinu-agent',
    run: async ({ input, signal }) => {
      const startedAt = Date.now();
      const timeline = new TrialTimeline();

      // A line per step, straight to stdout: a run's reader sees every trial move, and the longest silence is a step.
      const say = (line: string): void => {
        process.stdout.write(`[evals] ${task.id} | ${input.model} | ${input.arm} | trial ${String(input.trial)}: ${line}\n`);
      };

      let turnNumber = 0;
      let steps = 0;
      const turns: EvalTurnResult[] = [];
      const errors: HarnessError[] = [];
      let session: KinuPublicSession | undefined;
      let productSha = 'unknown';
      let attempted: string | undefined;
      let turnStartedAt = Date.now();

      try {
        await timeline.span('admit', admit);

        const opened = await (async () => {
          try {
            productSha = (await timeline.span('build', () => deployedBuild(target))).sha;

            const created = await timeline.span('open', () => openWorkspace(target, {
              subject: `${task.id}-${String(input.trial)}`, mission: task.mission, model: input.model,
            }));

            session = created;
            say(`workspace ${created.workspace} open`);
            created.onChunk = (type) => {
              timeline.chunk(type);

              if (type === 'finish-step') say(`turn ${String(turnNumber)}, step ${String(steps += 1)}`);
              else if (type.startsWith('closed')) say(`the workspace socket ${type}`);
            };

            const arm: EvalArm | undefined = ARMS.find((declared) => declared.id === input.arm);

            if (arm === undefined) throw new Error(`no arm is declared as ${input.arm}`);
            await timeline.span('arm', () => arm.apply(created));

            return created;
          } finally {
            release();
          }
        })();

        for (const [index, turn] of task.turns.entries()) {
          if (signal?.aborted === true) throw new Error('the eval run was cancelled', { cause: signal.reason });
          attempted = turn.prompt;
          turnStartedAt = Date.now();
          turnNumber = index + 1;
          steps = 0;
          timeline.mark('turn', { index });
          say(`turn ${String(turnNumber)} of ${String(task.turns.length)} sent`);

          const result = await runTurn(opened, turn, timeline, (recorded) => {
            if (recorded > steps) say(`turn ${String(turnNumber)}, step ${String(steps = recorded)}, off the ledger`);
          });

          say(`turn ${String(turnNumber)} ${result.outcome.status} in ${String(Math.round(result.turnWallMs / 1000))}s, `
            + `${String(result.checks.filter((check) => check.pass).length)} of ${String(result.checks.length)} checks passed`);
          turns.push(result);

          if (result.outcome.status !== 'completed' || result.checks.some((check) => !check.pass)) break;
        }
      } catch (error) {
        const message = renderThrownChain({ cause: error });

        if (error instanceof DeploymentAnswer) {
          // The build answered one of this turn's requests with a failure of its own, a memory reset among them: the
          // turn failed on the build.
          const status = memoryReset(error.message) ? 'reset' : 'refused';

          turns.push({ outcome: { status, message: redact(message) }, checks: [], turnWallMs: Date.now() - turnStartedAt, verificationWallMs: 0 });
        } else {
          // infraBoundary marks a failure of the deployment's transport; anything else is the harness's own.
          errors.push({ name: message.includes(INFRA_FAILURE_MARKER) ? 'InfraError' : 'EvalRunError', message });
        }
      }

      timeline.mark('close');

      const { events, costUsd, workspace } = session === undefined
        ? { events: [], costUsd: undefined, workspace: { files: new Map(), slates: null, data: [], unread: ['no workspace was opened'] } }
        : await closeWorkspace(session, task, errors, timeline);

      try {
        const after = (await timeline.span('build', () => deployedBuild(target))).sha;

        if (after !== productSha) {
          errors.push({ name: 'EvalBuildChanged', message: `the deployment served ${productSha.slice(0, 12)} then ${after.slice(0, 12)} during the trial` });
        }
      } catch (error) {
        errors.push({ name: 'InfraError', message: renderThrownChain({ cause: error }) });
      }

      const metrics = measure(events);
      const promptUsage = measurePromptUsage(events);
      const usageMetadata = promptUsage.metadata;

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
          inputTokens: promptUsage.inputTokens, outputTokens: metrics.outputTokens,
          metadata: usageMetadata,
        },
        errors: scrubbed,
        metadata: {
          taskId: task.id, taskVersion: identity.taskVersion, evalCommit: identity.evalCommit, productSha,
          arm: input.arm, trial: input.trial, origin: target.origin, workspace: session?.workspace ?? null,
          evidence: join(evidenceRoot, evalNameSlug(input.model), input.arm, `${task.id}-trial-${String(input.trial)}`),
        },
      };

      say(`${success ? 'passed' : 'failed'} in ${String(Math.round((Date.now() - startedAt) / 1000))}s; evidence ${result.metadata.evidence}`);
      writeEvidence(result.metadata.evidence, {
        run: v.parse(HarnessRunSchema, normalizeHarnessRun(input, result)),
        verdict: { status: success ? 'passed' : 'failed', durationMs: Date.now() - startedAt },
        events, workspace, timeline: timeline.entries,
      });

      if (scrubbed.length > 0) {
        const failure = new Error(scrubbed.map((error) => `${error.name}: ${error.message}`).join('\n'));
        throw attachHarnessRunToError(failure, normalizeHarnessRun(input, result));
      }

      return result;
    },
  });
}
