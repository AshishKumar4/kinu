/**
 * Where a suite's agent runs: local `cli-backend` or a deployed Worker workspace, as configuration rather
 * than a second harness. `@cloudflare/think` caps cloud turns at ten model steps and core `runChat` does not,
 * so a suite names its target. Depends only on `@kinu.run/core` (core devDepends on this package); the
 * target implementations live in `tests/evals/`. No `sql` member: a Durable Object's SQLite is reachable only
 * as read models over RPC.
 */
import { classifyToolFailure, listRuns, RunEventRecorder } from '@kinu.run/core';
import type {
  LLMProviderConfig, RunEvent, SeekCursor, VFS, WorkspaceSpend,
} from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { recordWorkspaceSpend } from './live-model';

/** `local`: in-process `cli-backend` (core `chat.ts` loop). `cloud`: a deployed Worker workspace, the only way to reach `@cloudflare/think`. */
export type EvalBackend = 'local' | 'cloud';

/** Read once and reported; never inferred from credentials. */
export const EVAL_BACKEND_ENV = 'KINU_EVAL_BACKEND';

/** The target for this process; defaults to `local`, and an unrecognised value throws rather than falling back. */
export type EvalBackendResolution =
  | { readonly kind: 'ready'; readonly backend: EvalBackend }
  | { readonly kind: 'refused'; readonly reason: string };

export function resolveEvalBackend(
  env: Record<string, string | undefined> = { [EVAL_BACKEND_ENV]: process.env.KINU_EVAL_BACKEND },
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

/** Whether the verifier instrument can actually run here (a present shell is not enough). */
export type VerifierProbe =
  /** `evidence` shows which shell answered. */
  | { readonly kind: 'runs'; readonly evidence: string }
  /** `reason` is the executor's own words; a skipping eval must print it. */
  | { readonly kind: 'unavailable'; readonly reason: string };

/** One execution plane from `listExecutors()`; `kind`, not the name, says which machine runs commands. */
export interface EvalExecutor {
  readonly name: string;
  readonly kind: string;
}

/** What this target can actually do, established before anything is spent. */
export interface EvalTargetProbe {
  readonly executors: readonly EvalExecutor[];
  readonly verifier: VerifierProbe;
}

/** Workspace filesystem; `exec` runs on the same plane `files` writes to. */
export interface EvalTargetWorkspace {
  readonly vfs: VFS;
  exec(command: string): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

/** Smallest `exec-ratio` instance: write a `.mjs`, run `node`, expect the RESULT line; fails where the Nimbus `node` shim does. */
const PROBE_MODULE = '_verifier_probe.mjs';

const PROBE_MARKER = 'KINU_VERIFIER_PROBE_OK';

/** Run that probe on `workspace`; one shared instrument for both targets. Callers check their own preconditions first. */
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
      // Cleanup failure is recorded, never rethrown: it must not mask the probe verdict.
      diagnostics.failure('eval.probe_cleanup_failed', toKinuError({
        doing: 'removing the verifier probe module',
        cause: error,
        otherwise: 'io',
      }));
    }
  }
}

/** Rows proving a search really spawned nodes, readable on both targets. */
export interface EvalSearchLedger {
  readonly searchRuns: number;
  readonly forkRuns: number;
  readonly canvasNodes: number;
  readonly recordObjectives: number;
  readonly backgroundJobs: number;
}

/** The seam. Factories in `tests/evals/target-*.ts` return a provisioned target or throw; `teardown` pairs with construction. */
export interface AgentEvalTarget {
  readonly backend: EvalBackend;
  /** Banner line naming backend, workspace and origin. */
  readonly describe: string;
  /** Cloud targets carry the `eval-` prefix so leftovers are attributable. */
  readonly workspace: string;
  /** Read off the target so a record cannot name a model the run did not use. */
  readonly llm: LLMProviderConfig;

  /** Submit one user turn and wait until it settles, including detached background work. */
  sendTurn(text: string): Promise<void>;

  /** The whole run-event log, oldest first; never windowed. */
  runEvents(): Promise<readonly RunEvent[]>;

  /** Workspace spend over the whole log; publish via `recordWorkspaceSpend`. */
  spend(): Promise<WorkspaceSpend>;

  probe(): Promise<EvalTargetProbe>;
  workspaceFiles(): EvalTargetWorkspace;
  searchLedger(): Promise<EvalSearchLedger>;

  roster(): Promise<readonly string[]>;

  /** Release provisioning; on cloud this deletes the workspace, so call it in `finally`. */
  teardown(): Promise<void>;
}

/** What the ledger says one episode did; local harness delegates to {@link ledgerTotalsFromEvents}. */
export interface LedgerTotals {
  turns: number;
  toolCalls: number;
  toolNames: string[];
  tokensIn: number;
  tokensOut: number;
  reasoningOut: number;
  /** Model steps the episode closed, counted from `step_finish`. */
  steps: number;
  /** Why a turn produced nothing; "0 tool calls" alone cannot tell a declining model from a failing provider. */
  failures: string[];
}

/** Prefix marking a turn's own provider error in {@link LedgerTotals.failures}; `environmentFailure` matches on it. */
export const RUN_END_FAILURE_PREFIX = 'run_end: ';

/** Episode totals reduced from `RunEvent[]`, so both targets share one reduction. */
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
      const failure = classifyToolFailure(event);

      if (failure) failures.push(`${event.name}: ${event.error ?? failure.reason}`);
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

/** Time order over a ledger: timestamp, run, then the recorder's index within the run. */
export function compareRunEventOrder(a: RunEvent, b: RunEvent): number {
  return a.timestamp.localeCompare(b.timestamp)
    || a.runId.localeCompare(b.runId)
    || a.eventIndex - b.eventIndex;
}


/**
 * The run a mid-turn landing is answered by: the run open at `landedAt` (ISO, same clock as `timestamp`).
 * A mid-turn prompt opens no run of its own. Without `landedAt`, the live run or the most recently closed one.
 */
export function absorbingRunId(
  events: readonly RunEvent[], landedAt?: string,
): string | null {
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();

  for (const event of events) {
    if (event.type === 'run_start') starts.set(event.runId, event.timestamp);

    if (event.type === 'run_end') ends.set(event.runId, event.timestamp);
  }

  if (starts.size === 0) return null;

  if (landedAt !== undefined) {
    // Open at the landing: started no later, and no `run_end` before it.
    const open = [...starts.entries()].filter(([runId, started]) => {
      const ended = ends.get(runId);

      return started <= landedAt && (ended === undefined || ended > landedAt);
    });

    if (open.length > 0) {
      open.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

      return open[open.length - 1][0];
    }

    // The run closed between write and read: the latest run ending at or after the landing.
    const closed = [...ends.entries()].filter(([, ended]) => ended >= landedAt)
      .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]));

    if (closed.length > 0) return closed[0][0];

    // No run admits the landing; the send said mid-turn, so the latest run answered.
    return [...starts.entries()].sort((a, b) =>
      a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))[starts.size - 1][0];
  }

  const live = [...starts].filter(([runId]) => !ends.has(runId))
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

  if (live.length > 0) return live[live.length - 1][0];

  const closed = [...ends.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]));

  return closed[0]?.[0] ?? null;
}

/**
 * Stop-condition evidence. `stepCountIs(n)` stops a step already filled with tool calls, so a capped turn
 * ends with last reason `tool-calls` beside `run_end: completed`; a finished turn ends with `stop`.
 */
export interface StepBoundEvidence {
  /** `step_finish` rows the episode closed. */
  readonly steps: number;
  /** The last step's finish reason, or null when the episode closed no step. */
  readonly lastStepReason: string | null;
  /** Every `run_end` reason, in order. */
  readonly runEndReasons: readonly string[];
  /** The loop stopped while the model was still calling tools; pair with the `run_end` reason (an interrupt looks the same). */
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

/** Every run event in a workspace store, walked to `status: 'end'`; `listRuns` pages 50 runs and the recorder 200 events. */
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

/** Publish one episode's spend on `target` through `recordWorkspaceSpend`, the one accumulator. */
export async function recordTargetEpisodeSpend(target: AgentEvalTarget): Promise<WorkspaceSpend> {
  const spend = await target.spend();
  recordWorkspaceSpend(spend);

  return spend;
}
