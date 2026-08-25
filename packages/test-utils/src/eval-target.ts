/**
 * WHERE a suite's agent runs — the one seam, and the facts a suite may read
 * through it.
 *
 * Tests and evals are ONE suite. Whether the agent under test is the local
 * `cli-backend` runtime or a workspace on a deployed Worker is CONFIGURATION,
 * not a second harness. This module is that configuration's type.
 *
 * WHY IT EXISTS, measured rather than argued. `agent://SwarmNoopRootCause`
 * established that production turns are capped at ten model steps by
 * `@cloudflare/think` (`stepCountIs(finalMaxSteps)` OR-ed ahead of the caller's
 * condition), that four of four capped runs across two workspaces reported
 * `run_end: 'completed'` with the model still emitting tool calls, and that
 * NOTHING in the tree could see it. The live swarm eval could not: it opens the
 * workspace with `openWorkspaceCLI`, whose turn driver is core `runChat` — the
 * genuinely unbounded loop — so the cap is structurally unreachable from the one
 * suite whose header claims to prove the search works. Two named holes, both of
 * them the same hole:
 *
 *   WRONG LOOP.     `@cloudflare/think` carries the cap. `runChat` does not.
 *                   An eval on the CLI loop cannot speak for the cloud loop.
 *   WRONG EXECUTOR. `ctx.exec` resolves to the CLI's local shell with a real
 *                   `node`. The Nimbus workspace's `node` shim rejects
 *                   esbuild-wasm's `wasmModule` option, so `exec-ratio` — the
 *                   ONLY registered verifier kind — returns `unavailable` in
 *                   the cloud and cannot there. The eval asserted that a
 *                   verifier shell EXISTS, which is a different fact.
 *
 * A suite cannot close a divergence it cannot address. So the target is named,
 * both targets answer the same questions, and a suite states which it ran on.
 *
 * WHAT THIS MODULE MAY DEPEND ON, and why the implementations are not here.
 * `packages/test-utils` imports `@kinu.run/core` and nothing else — deliberately,
 * because `@kinu.run/core` itself devDepends on this package, so a dependency on
 * `@kinu.run/cli` or `@kinu.run/cli-backend` would close a workspace cycle
 * through the very package every other suite's fixtures come from. The seam and
 * every target-agnostic reader therefore live here; the two implementations live
 * beside the suites in `tests/evals/`, which is the layer that already reaches
 * both backends by relative import (`tests/evals/harness.ts` has done so since
 * it was written). The interface is the shared thing; the wiring is not.
 *
 * `probeVerifier` is here for the same reason and it is not an exception to it:
 * it depends on `EvalTargetWorkspace` and core's diagnostics and on nothing
 * either backend owns, and it is the one INSTRUMENT both arms must run
 * identically — so it is shared code rather than a comment in each target
 * claiming the other uses the same module and marker.
 *
 * WHAT A SUITE MAY ASK, and nothing wider. Every member below is here because a
 * shipped assertion reads it. The shape was taken FROM the suites rather than
 * designed for them:
 *
 *   `runEvents`  — `readLedgerTotals`, `scoreTrajectory` and
 *                  `collectRunEventProvenance` all walk the run-event log. It is
 *                  the ledger, so it is the seam's primary read.
 *   `spend`      — `recordLiveModelEpisode` publishes what an episode cost. ONE
 *                  definition (`workspaceSpend`), reported through ONE meter.
 *   `probe`      — `requireSandboxedExecutors` / `requireVerifierShell`, with the
 *                  correction the root cause forces: the verifier probe RUNS the
 *                  instrument instead of asserting a shell exists.
 *   `files`      — `seedHardTask` writes the task tree, `verifyHardTask` reads it
 *                  back and runs the oracle.
 *   `search`     — the swarm arm's proof that a tree was really built.
 *   `roster`     — which agents the workspace holds after a delegating turn.
 *
 * There is no `sql`. A deployed workspace's SQLite lives inside its Durable
 * Object and is reachable only as read models over RPC, and a seam with a
 * member one target cannot honour is a seam that teaches a suite to branch on
 * its target. Every reader a suite needs is expressed over `RunEvent[]` or over
 * a core read-model type, both of which cross the wire intact.
 */
import { listRuns, RunEventRecorder } from '@kinu.run/core';
import type {
  LLMProviderConfig, RunEvent, SeekCursor, VFS, WorkspaceSpend,
} from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { recordWorkspaceSpend } from './live-model';

/**
 * The two places an agent under test can run.
 *
 * `local` is the in-process `cli-backend` runtime — free, offline-capable, and
 * the loop `packages/core/src/chat.ts` owns. `cloud` is a workspace on a
 * deployed Worker, driven over the product's own client, which is the ONLY way
 * to reach `@cloudflare/think`.
 */
export type EvalBackend = 'local' | 'cloud';

/** The ONE knob. A suite reads it once and reports which target it ran on; it
 *  never branches on a credential to decide where it is. */
export const EVAL_BACKEND_ENV = 'KINU_EVAL_BACKEND';

/**
 * Which target this process is for.
 *
 * `local` is the default and always will be: the cloud arm spends money against
 * a shared deployment, so it is reached by naming it. An unrecognised value is a
 * refusal rather than a silent fallback — a typo that quietly ran the free arm
 * would report a local measurement under a cloud arm's banner, which is the
 * class of error this whole module exists to remove.
 */
export type EvalBackendResolution =
  | { readonly kind: 'ready'; readonly backend: EvalBackend }
  | { readonly kind: 'refused'; readonly reason: string };

export function resolveEvalBackend(
  env: Record<string, string | undefined> = process.env,
): EvalBackendResolution {
  const raw = env[EVAL_BACKEND_ENV]?.trim();
  if (raw === undefined || raw === '') return { kind: 'ready', backend: 'local' };
  if (raw === 'local' || raw === 'cloud') return { kind: 'ready', backend: raw };
  return {
    kind: 'refused',
    reason: `${EVAL_BACKEND_ENV}=${raw} names no target. It is \`local\` (the in-process `
      + 'cli-backend runtime) or `cloud` (a workspace on the staging deployment). Unset it '
      + 'for local.',
  };
}

/**
 * Whether the instrument a measured task depends on CAN RUN here.
 *
 * The distinction is the root cause's, not a refinement of it. `exec-ratio` is
 * the only registered verifier kind; the live eval asserted that `rt.shell`
 * exists and the deployed workspace's shell exists and cannot run it. So a
 * probe that answers "a shell is present" answers the question that passed
 * while production failed. This one answers by running the thing.
 */
export type VerifierProbe =
  /** The measurement harness executed and returned what it was asked for.
   *  `evidence` is what it said, so a reader can see WHICH shell answered. */
  | { readonly kind: 'runs'; readonly evidence: string }
  /** It did not. `reason` is the executor's own words: an eval that skips here
   *  must print why, and "the verifier is unavailable" is not a remedy. */
  | { readonly kind: 'unavailable'; readonly reason: string };

/** One execution plane the agent can reach, as `listExecutors()` reports it.
 *  `kind` is the load-bearing half — a name is a namespace, not a claim about
 *  which machine runs the command. */
export interface EvalExecutor {
  readonly name: string;
  readonly kind: string;
}

/** What this target can actually do, established before anything is spent. */
export interface EvalTargetProbe {
  readonly executors: readonly EvalExecutor[];
  readonly verifier: VerifierProbe;
}

/** The workspace filesystem, for seeding a task and reading the outcome back.
 *  `exec` is the oracle's own channel — `verifyHardTask` runs commands through
 *  it — and it is the SAME plane `files` writes to on both targets. */
export interface EvalTargetWorkspace {
  readonly vfs: VFS;
  exec(command: string): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

/**
 * The command a verifier probe runs, and why it is this one.
 *
 * `exec-ratio` — the only registered verifier kind — writes a `.mjs` measurement
 * harness into the workspace and runs `node <file>`, expecting a RESULT line on
 * stdout. So the probe is the smallest possible instance of that: write a module,
 * run it with `node`, require the line back. It fails wherever `exec-ratio`
 * fails, including the deployed Nimbus shell whose `node` shim cannot transform
 * `.mjs` (esbuild-wasm rejects its `wasmModule` option outside a browser), and it
 * costs one command rather than a whole baseline measurement.
 */
const PROBE_MODULE = '_verifier_probe.mjs';
const PROBE_MARKER = 'KINU_VERIFIER_PROBE_OK';

/**
 * Run that probe on `workspace`.
 *
 * ONE INSTRUMENT, not two that agree by assertion. Both targets spelled this
 * sequence out — write, run, check the marker, clean up — differing only in
 * whether the cleanup said `vfs.unlink` or `exec('rm -f')`, which on the cloud
 * plane IS `rm -f`. A comment claiming the two arms use the same module and
 * marker is a claim; a shared function is a guarantee, and the instrument the two
 * arms must share is precisely the thing that must not be written twice.
 *
 * It takes an {@link EvalTargetWorkspace} and nothing else, so a caller's own
 * preconditions stay the caller's: the cloud target checks that its workspace
 * executor exists BEFORE calling this, because which planes a deployment offered
 * is the useful half of that answer and this function cannot know it.
 */
export async function probeVerifier(workspace: EvalTargetWorkspace): Promise<VerifierProbe> {
  try {
    await workspace.vfs.writeFile(PROBE_MODULE, `console.log('${PROBE_MARKER}');\n`);
    const run = await workspace.exec(`node ${PROBE_MODULE}`);
    if (run.stdout.includes(PROBE_MARKER)) {
      return { kind: 'runs', evidence: run.stdout.trim() };
    }
    return {
      kind: 'unavailable',
      reason: `\`node ${PROBE_MODULE}\` exited ${String(run.exitCode)} without the probe's own `
        + 'marker, so this target cannot run an exec-ratio measurement harness and every '
        + `score:'verify' search here is dead on arrival. It said: `
        + `${run.stdout.trim() || '(nothing)'}`,
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `the workspace shell refused the probe outright: ${renderThrownChain({ cause: error })}`,
    };
  } finally {
    try {
      await workspace.vfs.unlink(PROBE_MODULE);
    } catch (error) {
      // A probe artifact that outlives the probe is untidy, never wrong: the
      // workspace is a scratch store the target deletes in teardown. Recorded
      // rather than swallowed, and never rethrown — a cleanup failure must not
      // mask the probe's own verdict, which is the answer the caller asked for.
      diagnostics.failure('eval.probe_cleanup_failed', toKinuError({
        doing: 'removing the verifier probe module',
        cause: error,
        otherwise: 'io',
      }));
    }
  }
}

/**
 * Rows that prove a search really happened, rather than that a tool returned.
 *
 * These are the six reads `agent://SwarmNoopRootCause` used to rule out
 * "the swarm started and died silently": every one was empty, which is how it
 * established that no node ever spawned. A suite asserting a tree was built
 * asserts over these, so the same reads answer on both targets.
 */
export interface EvalSearchLedger {
  readonly searchRuns: number;
  readonly forkRuns: number;
  readonly canvasNodes: number;
  readonly recordObjectives: number;
  readonly backgroundJobs: number;
}

/**
 * The seam. One interface, two implementations, and a suite that names neither.
 *
 * PROVISIONING IS THE CONSTRUCTOR'S JOB, not a member: a target that can be
 * observed before it exists is a target a suite can read a zero from. The
 * factories in `tests/evals/target-*.ts` return an already-provisioned target or
 * throw, and `teardown` is what pairs with construction.
 */
export interface AgentEvalTarget {
  readonly backend: EvalBackend;
  /** One line naming the target for a banner: which backend, which workspace,
   *  which origin. Printed before anything is spent. */
  readonly describe: string;
  /** The workspace's own name. Cloud targets carry the `eval-` prefix so a row
   *  left behind on the account is attributable. */
  readonly workspace: string;
  /** The model config in force. Read off the target rather than re-derived, so
   *  a record cannot name a model the run did not use. */
  readonly llm: LLMProviderConfig;

  /** Submit one user turn and wait for it to SETTLE, including the background
   *  work it detached. Every row a suite reads is written when a turn closes, so
   *  a read before settle reports a zero denominator from a turn that was merely
   *  still running. */
  sendTurn(text: string): Promise<void>;

  /** The whole run-event log, oldest first. A WALK, not a window: this is one
   *  episode's entire ledger and a truncated read understates the episode's own
   *  totals. */
  runEvents(): Promise<readonly RunEvent[]>;

  /** What this workspace spent, in the core read model's own shape — the whole
   *  log on both targets, so there is no window to disclose and no floor to
   *  refuse. Publish it through `recordWorkspaceSpend`, which is the one
   *  accumulator. */
  spend(): Promise<WorkspaceSpend>;

  probe(): Promise<EvalTargetProbe>;
  workspaceFiles(): EvalTargetWorkspace;
  searchLedger(): Promise<EvalSearchLedger>;

  /** Additional agents the workspace holds, by name. Empty on a workspace whose
   *  turn delegated to nobody. */
  roster(): Promise<readonly string[]>;

  /** Release everything provisioning took. On cloud that DELETES the workspace,
   *  which is why the callers put it in a `finally`: a run that throws must not
   *  leave a row on the account. */
  teardown(): Promise<void>;
}

/** What the ledger says one episode did. ONE shape and ONE reduction: the local
 *  harness delegates to {@link ledgerTotalsFromEvents} rather than keeping a
 *  second walk in step with the recorder. */
export interface LedgerTotals {
  turns: number;
  toolCalls: number;
  toolNames: string[];
  tokensIn: number;
  tokensOut: number;
  reasoningOut: number;
  /** Model steps the episode closed, counted from `step_finish`. */
  steps: number;
  /** Why a turn produced nothing. A degenerate run that cannot say why is a
   *  dead end for whoever reads the record: "0 tool calls" is equally
   *  consistent with a model that declined to act and a provider that rejected
   *  every request. */
  failures: string[];
}

/**
 * How a TURN's own provider error is marked in {@link LedgerTotals.failures}, so
 * a reader can tell it from a tool's.
 *
 * Load-bearing rather than cosmetic: `environmentFailure` in the eval harness
 * classifies only the turn's error, because a tool that failed mid-episode is
 * part of the agent's episode and an outage is not. The producer below and that
 * consumer must spell the prefix the same way, so they share this constant
 * instead of two string literals that agree today.
 */
export const RUN_END_FAILURE_PREFIX = 'run_end: ';

/**
 * The episode's totals, over events rather than over a store.
 *
 * TARGET-AGNOSTIC BY CONSTRUCTION. The local reader walked a `bun:sqlite`
 * Database through `RunEventRecorder`; a deployed workspace has no such handle.
 * Both, however, produce the same `RunEvent[]` — the canonical union, validated
 * by the recorder on the way out on either side — so the REDUCTION is the only
 * part that was ever backend-specific, and it was not. One function, two
 * targets, no second denominator.
 */
export function ledgerTotalsFromEvents(events: readonly RunEvent[]): LedgerTotals {
  let turns = 0, toolCalls = 0, tokensIn = 0, tokensOut = 0, reasoningOut = 0, steps = 0;
  const toolNames: string[] = [];
  const failures: string[] = [];
  for (const event of events) {
    if (event.type === 'turn_end') {
      turns += 1;
      tokensIn += event.usage?.input ?? 0;
      tokensOut += event.usage?.output ?? 0;
      reasoningOut += event.usage?.reasoning ?? 0;
    } else if (event.type === 'tool_call_end') {
      toolCalls += 1;
      toolNames.push(event.name);
      if (event.error != null && event.error !== '') failures.push(`${event.name}: ${event.error}`);
    } else if (event.type === 'step_finish') {
      steps += 1;
    } else if (event.type === 'error') {
      failures.push(event.message);
    } else if (event.type === 'run_end' && event.error != null && event.error !== '') {
      failures.push(`${RUN_END_FAILURE_PREFIX}${event.error}`);
    }
  }
  return { turns, toolCalls, toolNames, tokensIn, tokensOut, reasoningOut, steps, failures };
}

/**
 * Evidence about the STOP CONDITION, which is the fact the two loops disagree
 * about.
 *
 * This is the probe the whole ticket turns on, so it is stated as data rather
 * than as an assertion: a suite reads it on both targets and compares.
 *
 * WHAT IT CATCHES. `stepCountIs(n)` fires when `steps.length === n`, and the
 * step it stops is one the model had already filled with tool calls — so a
 * capped turn has a LAST `step_finish` whose reason is `tool-calls` and a
 * `run_end` that says `completed`. That pair is the signature: a turn that
 * genuinely finished has a last reason of `stop`. Measured on production at
 * `17abc2980`: four runs at exactly ten steps, every last reason `tool-calls`,
 * every `run_end` `completed`; the one naturally-finished run had `stop` at
 * five. Nothing in the ledger distinguished them, which is why it shipped.
 */
export interface StepBoundEvidence {
  /** `step_finish` rows the episode closed. */
  readonly steps: number;
  /** The last step's finish reason, or null when the episode closed no step. */
  readonly lastStepReason: string | null;
  /** Every `run_end` reason, in order. */
  readonly runEndReasons: readonly string[];
  /**
   * The loop stopped while the model was still calling tools.
   *
   * TRUE is not by itself a defect — an operator interrupt looks the same from
   * here — so a suite pairs it with the `run_end` reason: `truncated` beside
   * `completed` is the invisible cut, and that pair is what no ledger row
   * distinguished before.
   */
  readonly truncated: boolean;
}

export function stepBoundEvidence(events: readonly RunEvent[]): StepBoundEvidence {
  let steps = 0;
  let lastStepReason: string | null = null;
  const runEndReasons: string[] = [];
  for (const event of events) {
    if (event.type === 'step_finish') {
      steps += 1;
      lastStepReason = event.reason ?? null;
    } else if (event.type === 'run_end') {
      runEndReasons.push(event.reason ?? 'unstated');
    }
  }
  return { steps, lastStepReason, runEndReasons, truncated: lastStepReason === 'tool-calls' };
}

/**
 * Every run event in a workspace store, oldest run first.
 *
 * A WALK, NOT A WINDOW, and the distinction has already cost this tier a
 * corpus: `listRuns`' default page is 50 runs and the recorder's is 200 events,
 * so a windowed read truncates a multi-turn episode into a smaller denominator
 * — which reads as an agent that acted less rather than a reader that stopped
 * looking. It walks to `status: 'end'` instead of guessing a limit high enough,
 * because a guess that it will never be reached is exactly the assumption the
 * page contract exists to remove.
 *
 * Lives here rather than in the harness because BOTH targets need it and the
 * local harness already held two copies of it (`readLedgerTotals` and
 * `collectRunEventProvenance`). A third copy beside a cloud target would be a
 * third thing to keep in step with the recorder.
 */
export function walkRunEvents(recorder: RunEventRecorder): RunEvent[] {
  const events: RunEvent[] = [];
  let cursor: SeekCursor | null = null;
  for (;;) {
    const page = listRuns(recorder, cursor);
    for (const run of page.items) events.push(...recorder.read(run.runId, { limit: 100_000 }));
    if (page.status === 'end') break;
    cursor = page.next;
  }
  return events;
}

/**
 * Publish what one episode on `target` cost, through the ONE meter.
 *
 * A wrapper rather than a call site convention, because the two targets read the
 * total from different places — the local one from the store it owns, the cloud
 * one from `getActivitySnapshot().spend` over RPC — and both must land in the
 * same accumulator. `recordWorkspaceSpend` is that accumulator, and it is the
 * only place calls, usage and unmeasured episodes are counted.
 *
 * It used to choose a truncation remedy per backend, because the deployed read
 * model was windowed and a bounded total had to be refused rather than published
 * as a floor. `workspaceSpend` now aggregates over the whole log, so there is no
 * window on either target and no remedy to name.
 */
export async function recordTargetEpisodeSpend(target: AgentEvalTarget): Promise<WorkspaceSpend> {
  const spend = await target.spend();
  recordWorkspaceSpend(spend);
  return spend;
}
