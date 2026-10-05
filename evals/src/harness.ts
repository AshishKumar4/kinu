import { join } from 'node:path';
import * as v from 'valibot';
import { attachHarnessRunToError, createHarness, normalizeHarnessRun } from 'vitest-evals/harness';
import type { TranscriptEvent } from 'vitest-evals';
import { platformFact, type EvalAccount, type RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { DeploymentAnswer, evalNameSlug, INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import { gatherEvidence, writeEvidence, type WorkspaceEvidence } from './evidence';
import { HarnessRunSchema, measurePromptUsage, type ActorLedger } from './results';
import type { KinuPublicSession } from './session';
import { claimTrialAccount, trialTarget } from './slot';
import { ARMS, deployedBuild, openWorkspace, type EvalArm, type EvalTarget } from './target';
import type {
  EvalCheck, EvalRunInput, EvalRunOutput, EvalTask, EvalTurn, EvalTurnOutcome, EvalTurnResult, HarnessError,
} from './task';
import { redact } from './redact';
import { cutButCompleted, measure, toTranscript } from './transcript';
import { TrialTimeline } from './timeline';
import { EvalVerifier } from './verifier';
import { duringTrial, trialCancel } from './cancel';
import { answered, repliesTo, settle, TrialCancelled, TurnWatch, type WatchOptions, WorkspaceHeld } from './workspace-completion';

/** How long a trial whose workspace keeps streaming may go without a line before it says so. */
const STREAMING_LINE_MS = 60_000;

/** Who spoke in a room the session heard outside the trial's own turns (`KinuPublicSession.onHeard`). */
function speakerOf(room: string | null, type: string): string {
  if (type.startsWith('head_')) return 'a head';

  return room === null ? 'a turn the product opened' : `helper ${room}`;
}

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


/** What a trial is: its task's version, the eval commit, and the account each trial acts as (`slot.ts`); without
 *  `slotOf` every trial acts as eval-service. */
export type TrialIdentity = {
  readonly taskVersion: string;
  readonly evalCommit: string;
  readonly slotOf?: (input: EvalRunInput) => EvalAccount;
};

/** How an isolate memory reset reads when it surfaces (platform catalog `do.isolate.oom_reported`). */
const MEMORY_RESETS = platformFact('do.isolate.oom_reported').observable.map((observable) => observable.message);

/** Whether a failure the deployment reported is its workspace's isolate reset for memory. */
function memoryReset(message: string): boolean {
  return MEMORY_RESETS.some((reset) => message.includes(reset));
}

/** A turn whose runs the deployment ended in error measured the deployment, not the agent. */
function outcomeOf(events: readonly RunEvent[], before: ReadonlySet<string>): EvalTurnOutcome {
  const failed = events.find((event) => event.type === 'run_end' && !before.has(event.runId)
    && (event.reason === 'error' || event.reason === 'aborted'));

  if (failed?.type !== 'run_end') return { status: 'completed' };
  const message = failed.error ?? `a run ended ${failed.reason ?? 'without a reason'}`;

  return { status: memoryReset(message) ? 'reset' : 'error', message: redact(message) };
}

/** What a turn tells its trial while it waits: how many steps its runs have recorded (a stream that dropped shows no
 *  more, and the ledger does), and through `watching` the jobs it waits on. */
export type TurnHooks = { readonly stepped: (steps: number) => void; readonly watching: WatchOptions };

/** Where a trial records what stopped it early, and how long the turn it stopped had run. */
type StopRecord = { readonly turns: EvalTurnResult[]; readonly errors: HarnessError[]; readonly turnWallMs: number };

/**
 * What stopped a trial before its turns were done, recorded where it counts: a turn the watch or the run's cancel ended,
 * a turn the build refused or reset, or else a failure of the harness's own, infrastructure when the transport made it.
 */
function recordStop(thrown: { readonly cause: unknown }, { turns, errors, turnWallMs }: StopRecord): void {
  const error = thrown.cause;
  const message = renderThrownChain(thrown);

  if (error instanceof WorkspaceHeld) {
    turns.push({ outcome: { status: error.outcome, message: redact(error.message), heldBy: [...error.heldBy] }, checks: [], turnWallMs: 0, verificationWallMs: 0 });
  } else if (error instanceof DeploymentAnswer) {
    // The build answered one of this turn's requests with a failure of its own, a memory reset among them: the
    // turn failed on the build.
    const status = memoryReset(error.message) ? 'reset' : 'refused';

    turns.push({ outcome: { status, message: redact(message) }, checks: [], turnWallMs, verificationWallMs: 0 });
  } else {
    // infraBoundary marks a failure of the deployment's transport; anything else is the harness's own.
    errors.push({ name: message.includes(INFRA_FAILURE_MARKER) ? 'InfraError' : 'EvalRunError', message });
  }
}

/** One turn: its seeded files, the prompt, the wait until the workspace settles, and the checks. */
export async function runTurn(session: KinuPublicSession, turn: EvalTurn, timeline: TrialTimeline, { stepped, watching }: TurnHooks): Promise<EvalTurnResult> {
  if (turn.fresh) {
    await timeline.span('evict', async () => {
      await session.abortActivation();
      session.disconnect();
      await session.connect();
    });
    await timeline.span('clear', () => session.clearConversation());
  }

  await timeline.span('seed', async () => {
    for (const file of turn.seed ?? []) await session.writeFile(file.path, file.content);
  });

  const before = new Set((await timeline.span('ledger', () => session.runEvents())).map((event) => event.runId));
  const startedAt = Date.now();
  const watch = new TurnWatch(session, watching);
  let lost: Error | undefined;

  try {
    try {
      await timeline.span('prompt', () => answered(watch, session.prompt(turn.prompt)));
    } catch (error) {
      // A socket the deployment drops loses the turn's stream, not the turn: the run goes on up there
      // and the ledger records its end. The history below says whether the prompt ever arrived.
      if (error instanceof WorkspaceHeld || !renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
      lost = error instanceof Error ? error : new Error(renderThrownChain({ cause: error }));
    }

    await timeline.span('settle', () => settle(watch, (busy, events) => {
      timeline.mark('poll', { busy });
      stepped(events.filter((event) => event.type === 'step_finish' && !before.has(event.runId)).length);
    }));
  } catch (error) {
    if (!(error instanceof WorkspaceHeld)) throw error;

    return { outcome: { status: error.outcome, message: redact(error.message), heldBy: [...error.heldBy] }, checks: [], turnWallMs: Date.now() - startedAt, verificationWallMs: 0 };
  }

  const turnWallMs = Date.now() - startedAt;
  const [events, history] = await timeline.span('read', () => Promise.all([session.runEvents(), session.history()]));

  // Whether it ran as its own turn or landed in one already running, a prompt that arrived is in the history.
  if (!history.some((row) => row.role === 'user' && row.text.trim() === turn.prompt.trim())) {
    throw new Error(`${INFRA_FAILURE_MARKER} \u2014 the prompt never reached the workspace: the history has no row for it`, { cause: lost });
  }

  const outcome = outcomeOf(events, before);

  if (outcome.status !== 'completed') return { outcome, checks: [], turnWallMs, verificationWallMs: 0 };

  const replies = repliesTo(history, turn.prompt);
  const firstStart = events.find((event) => event.type === 'run_start' && !before.has(event.runId));

  if (firstStart === undefined) throw new Error('a completed turn has no new public run_start');
  const runStartedAt = Date.parse(firstStart.timestamp);
  const verifiedAt = Date.now();
  const cut = cutButCompleted(events, before);
  const checks: EvalCheck[] = cut.length === 0 ? [] : [{ id: CUT_REPORTED_COMPLETED, pass: false, evidence: { runs: cut } }];
  const verify = turn.verify;

  if (verify !== undefined) checks.push(...await timeline.span('verify', () => new EvalVerifier(session, replies, runStartedAt).collect(verify)));
  const afterEviction = turn.verifyAfterEviction;

  if (afterEviction !== undefined && checks.every((check) => check.pass)) {
    checks.push(...await timeline.span('evict', async () => {
      await session.abortActivation();
      session.disconnect();
      await session.connect();

      return new EvalVerifier(session, replies, runStartedAt).collect(afterEviction);
    }));
  }

  return { outcome, checks, turnWallMs, verificationWallMs: Date.now() - verifiedAt };
}

/**
 * What a trial's workspace holds at its end, then its deletion: the ledger and spend, the evidence, the
 * teardown. A failure of any is recorded in `errors`, or, for the evidence, said in it, and never
 * thrown over the verdict the trial's checks gave. `evidence` is null for a trial the run's cancel
 * ended: nothing grades it, and the deploy's kill follows its cancel within seconds.
 */
async function closeWorkspace(session: KinuPublicSession, evidence: EvalTask['evidence'] | null, errors: HarnessError[], timeline: TrialTimeline): Promise<{
  events: RunEvent[]; ledgers: ActorLedger[]; costUsd: number | undefined; workspace: WorkspaceEvidence;
}> {
  let events: RunEvent[] = [];
  let ledgers: ActorLedger[] = [];
  let costUsd: number | undefined;

  try {
    events = [...await timeline.span('ledger', () => session.runEvents())];
    ledgers = await timeline.span('request usage', () => session.actorLedgers(events));
    costUsd = (await timeline.span('spend', () => session.spend())).total.usd;
  } catch (error) {
    errors.push({ name: 'InfraError', message: `the trial's ledger could not be read: ${renderThrownChain({ cause: error })}` });
  }

  const workspace = evidence === null
    ? { files: new Map(), slates: null, data: [], unread: ['the run was cancelled before the workspace was read'] }
    : await timeline.span('evidence', () => gatherEvidence(session, evidence));

  try {
    await timeline.span('teardown', () => session.teardown());
  } catch (error) {
    const message = renderThrownChain({ cause: error });

    errors.push({ name: message.includes(INFRA_FAILURE_MARKER) ? 'InfraError' : 'EvalCleanupError', message });
  }

  return { events, ledgers, costUsd, workspace };
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
    run: ({ input, signal }) => duringTrial(async () => {
      const startedAt = Date.now();
      const timeline = new TrialTimeline();
      const stop = trialCancel(signal);

      // A line per step, straight to stdout: a run's reader sees every trial move, and the longest silence is a step, or a
      // minute of one that streams longer. The deploy ends a run that writes nothing for 480 s, and a step streaming for
      // minutes is the workspace working.
      let saidAt = Date.now();

      const say = (line: string): void => {
        saidAt = Date.now();
        process.stdout.write(`[evals] ${task.id} | ${input.model} | ${input.arm} | trial ${String(input.trial)}: ${line}\n`);
      };

      const streaming = (who: string): void => {
        if (Date.now() - saidAt >= STREAMING_LINE_MS) say(`${who} still streaming`);
      };

      let turnNumber = 0;
      let steps = 0;
      const turns: EvalTurnResult[] = [];
      const errors: HarnessError[] = [];
      let session: KinuPublicSession | undefined;
      let productSha = 'unknown';
      let account = 'eval-service';
      let attempted: string | undefined;
      let turnStartedAt = Date.now();

      try {
        if (stop.aborted) throw new TrialCancelled(`cancelled by ${String(stop.reason)} before its workspace opened`, []);
        await timeline.span('admit', admit);

        const opened = await (async () => {
          try {
            const { slotOf } = identity;

            const trial = slotOf === undefined ? { target, account }
              : await timeline.span('account', () => trialTarget(target, slotOf(input), Date.now()));

            account = trial.account;
            productSha = (await timeline.span('build', () => deployedBuild(trial.target))).sha;

            const created = await timeline.span('open', () => openWorkspace(trial.target, {
              subject: `${task.id}-${String(input.trial)}`, mission: task.mission, model: input.model,
            }));

            session = created;
            say(`workspace ${created.workspace} open on ${account}`);

            if (trial.target !== target) await timeline.span('claim', () => claimTrialAccount(trial.target, created.workspace, Date.now()));
            created.onChunk = (type) => {
              timeline.chunk(type);

              if (type === 'finish-step') say(`turn ${String(turnNumber)}, step ${String(steps += 1)}`);
              else if (type.startsWith('closed')) say(`the workspace socket ${type}`);
              else streaming(`turn ${String(turnNumber)}`);
            };

            created.onHeard = (room, type) => {
              const who = speakerOf(room, type);

              if (type === 'finish-step' || type === 'head_activity') say(`${who}, step done`);
              else streaming(who);
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
          if (stop.aborted) throw new TrialCancelled(`cancelled by ${String(stop.reason)} before turn ${String(index + 1)} was sent`, []);
          attempted = turn.prompt;
          turnStartedAt = Date.now();
          turnNumber = index + 1;
          steps = 0;
          timeline.mark('turn', { index });
          say(`turn ${String(turnNumber)} of ${String(task.turns.length)} sent`);

          const result = await runTurn(opened, turn, timeline, {
            stepped: (recorded) => {
              if (recorded > steps) say(`turn ${String(turnNumber)}, step ${String(steps = recorded)}, off the ledger`);
            },
            watching: { waiting: say, cancelled: stop },
          });

          say(`turn ${String(turnNumber)} ${result.outcome.status} in ${String(Math.round(result.turnWallMs / 1000))}s, `
            + `${String(result.checks.filter((check) => check.pass).length)} of ${String(result.checks.length)} checks passed`
            + `${result.outcome.message === undefined ? '' : `: ${result.outcome.message}`}`);
          turns.push(result);

          if (result.outcome.status !== 'completed' || result.checks.some((check) => !check.pass)) break;
        }
      } catch (error) {
        recordStop({ cause: error }, { turns, errors, turnWallMs: Date.now() - turnStartedAt });
      }

      timeline.mark('close');

      const { events, ledgers, costUsd, workspace } = session === undefined
        ? { events: [], ledgers: [], costUsd: undefined, workspace: { files: new Map(), slates: null, data: [], unread: ['no workspace was opened'] } }
        : await closeWorkspace(session, stop.aborted ? null : task.evidence, errors, timeline);

      try {
        const after = (await timeline.span('build', () => deployedBuild(target))).sha;

        if (after !== productSha) {
          errors.push({ name: 'EvalBuildChanged', message: `the deployment served ${productSha.slice(0, 12)} then ${after.slice(0, 12)} during the trial` });
        }
      } catch (error) {
        errors.push({ name: 'InfraError', message: renderThrownChain({ cause: error }) });
      }

      const metrics = measure(events);
      const promptUsage = measurePromptUsage(ledgers);
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
          inputTokens: promptUsage.inputTokens, outputTokens: promptUsage.outputTokens,
          metadata: usageMetadata,
        },
        errors: scrubbed,
        metadata: {
          taskId: task.id, taskVersion: identity.taskVersion, evalCommit: identity.evalCommit, productSha,
          arm: input.arm, trial: input.trial, origin: target.origin, account, workspace: session?.workspace ?? null,
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
    }),
  });
}
