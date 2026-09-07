/**
 * THE TRAJECTORY TIER: multi-turn episodes measured through the PUBLIC API, on
 * the deployed product.
 *
 * WHAT NO OTHER ARM MEASURES. Every scored family in this tier drives ONE turn
 * and grades what it left behind: the behaviour arm hands over a task and reads
 * the ledger, the research arm asks one question, the optimization arm attempts
 * one instrument. A conversation is a different subject. Turn two carries turn
 * one's context, a correction arrives while the model is working, and a failure
 * in turn one is the thing turn two has to recover from — and none of those
 * three is expressible in a single handover. The one suite that took multiple
 * turns (`e2e-lifecycle.test.ts`) asserts message counts over an in-process
 * runtime and reads no ledger at all.
 *
 * AND IT MEASURES THEM WHERE A USER MEETS THEM. The cases run through
 * {@link KinuPublicSession} — REST create, the web client's own chat frames,
 * the public run-event and file routes, `removeWorkspace` in a `finally` — so a
 * green here is a statement about the surface the product ships rather than
 * about a client only this repository has. The operator-plane arm
 * (`swarm.eval.ts`'s cross-target test, through `target-cloud.ts`) is a
 * different claim and neither substitutes for the other: that one proves a
 * credentialed CLI can drive a workspace, this one proves the web app's own
 * surfaces carry a conversation, its artifacts and its evidence.
 *
 * THREE CASES, each a mechanism that only a conversation has:
 *
 *   public-file-artifact     turn one writes a file, turn two reads it back.
 *                            Scores the ARTIFACT off the files route and the
 *                            CONTINUITY off the transcript — a workspace that
 *                            forgot turn one answers turn two with nothing.
 *   public-steer-correction   a correction submitted WHILE the turn is running,
 *                            through the composer's own `steerTurn`. The DO
 *                            answers `mid-turn` or `queued` and both are
 *                            landings; what is scored is whether the correction
 *                            reached the work.
 *   public-failure-recovery   turn one runs a command that FAILS, turn two
 *                            repairs it. The recovery is read off the ledger:
 *                            a failed tool call, then a later call of the same
 *                            tool that did not fail.
 *
 * SCORED BY THE INSTRUMENTS THAT ALREADY EXIST. `scorePublicLedger` puts the
 * events fetched over the public route under the same eight ledger scorers a
 * local episode is scored by, so a trajectory number is comparable with a
 * behaviour number rather than being a fourth statistic. The primary metric is
 * this suite's own: `task_outcome` over subgoals a machine can check — file
 * bytes, transcript rows, ledger rows — never a judge and never prose.
 *
 * FIVE PROPERTIES, held here rather than assumed:
 *
 *   1. THE MEASURED SET EQUALS THE GOVERNED SET. `assessAdmissibility` fails a
 *      run whose executed ids differ from its declared ones, and the
 *      credential-free test below drives both directions.
 *   2. A DEGENERATE TRAJECTORY IS REFUSED, NOT SCORED. A closed turn with zero
 *      tool calls throws {@link DegenerateRunError} before any score is
 *      recorded, so a case that did nothing contributes no number to the pool a
 *      later comparison reads. `disposeFailedCase` then decides whether the
 *      failure was the agent's (`inert`), the harness's (`errored`) or the
 *      environment's (resumable) — one classification, shared with the
 *      behaviour arm.
 *   3. SPEND IS RECORDED BEFORE ANY ASSERTION CAN THROW. A turn that ran and
 *      then failed an assertion still burned what it burned, and this arm's own
 *      spend file is what `eval-spend.ts --expect-live` holds it to.
 *   4. NOTHING IS LEFT ON THE ACCOUNT. `teardown` deletes the workspace from a
 *      `finally`, and the name carries `eval-` so a survivor is attributable.
 *   5. THE EVIDENCE OUTLIVES THE PROCESS. Every case writes the ledger it was
 *      scored on, the durable transcript and its subgoal verdicts under the
 *      directory the record names (`retainEpisodeTranscript`), and its
 *      observation carries the structural provenance the behaviour arm's does.
 *      A record whose `transcripts` held only the record itself — which is
 *      what every public-plane record published before this was — named a
 *      tool-failure count no reader could open.
 *
 * CLOUD ONLY. `resolvePublicSessionPlan` refuses every other backend before it
 * looks at a credential — there is no public REST or WebSocket surface in front
 * of an in-process runtime — and the skip prints the invocation that would run
 * it. The credential-free half of this file runs at every tier and costs
 * nothing.
 */
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import * as v from 'valibot';

import {
  type LLMProviderConfig, type RunEvent,
} from '../../packages/core/src/index';
import {
  EVAL_MODELS, FULL_TOOL_SURFACE, ledgerTotalsFromEvents, outcomeRow, projectRunEventProvenance,
  publishRunRecord, reportLiveModelSpend, retainEpisodeTranscript, withEpisodeEvidence,
  subgoalOutcome, subgoalsOutcome, TASK_OUTCOME,
  compareRunEventOrder, INFRA_FAILURE_MARKER,
  scratchDir,
  assessAdmissibility,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalSubgoal, type EvalTier,
  type LedgerTotals,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { DegenerateRunError, disposeFailedCase } from './episode-failure';
import {
  resolvePublicSessionPlan,
  scorePublicLedger,
  type KinuPublicSession,
  type PublicSessionPlan,
} from './public-session';
import { DEGENERATE_EVENTS, LEDGER_EVENTS } from './fixtures/public-session-frames';

const SUITE = 'Trajectory Evals';
const REPO_ROOT = join(import.meta.dirname, '../..');

/** Which arm this process is — the same split the four sibling arms declare, so
 *  a tier switch reaches this family too. */
const TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

/**
 * WHERE this run's agent lives, resolved once, and the model it PINS.
 *
 * The resolution is the seam's, not this file's: cloud-gated first, then the
 * tier's own `resolveEvalTarget`, then the browser plane's identity. An
 * unavailable environment prints the remedy HERE, at module scope, so the reason
 * is on the line above the skip rather than inside a test nobody ran.
 */
const RESOLUTION = resolvePublicSessionPlan(SUITE, EVAL_MODELS[TIER]);
if (RESOLUTION.kind === 'unavailable') console.warn(`[skip] ${RESOLUTION.remedy}`);
const PLAN: PublicSessionPlan | null = RESOLUTION.kind === 'ready' ? RESOLUTION.plan : null;
if (PLAN !== null) console.warn(`[live] ${SUITE} — ${PLAN.describe}`);
const liveTest = test.skipIf(PLAN === null);

/** The model config in force, read off the plan so the record cannot name a
 *  model the run did not pin. */
const LLM: LLMProviderConfig | null = PLAN?.llm ?? null;

/**
 * The arm, recorded because a measurement whose mechanism was switched off is
 * not a measurement of that mechanism.
 *
 * `evolution: false` is a STATEMENT ABOUT THE RECORD rather than a knob this
 * arm sets: a deployed workspace's evolution is its own durable config, and the
 * create REST offers no way to change it — so this family reports what it
 * cannot control as unset rather than claiming a setting it never applied. The
 * behaviour arm owns the evolution comparison.
 */
const ARM: EvalArmState = {
  evolution: false,
  settle: 'none',
  tools: [...FULL_TOOL_SURFACE],
};

/** Retained beside the record, never under a swept root — the same
 *  `resolveArtifactRoot` rule every other family states. Each case writes its
 *  ledger, its transcript and its verdicts under here BEFORE its subgoals are
 *  asserted (`retainEpisodeTranscript`), so the directory the record names holds
 *  the trajectories its scores were computed from rather than the record alone. */
const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `trajectory-${TIER}-${String(Date.now())}`,
);

const observations: EvalObservation[] = [];

/** What one trajectory case is. The turns are DATA so the credential-free tests
 *  can assert properties of the corpus — every case multi-turn, every case
 *  carrying subgoals — without running one. */
interface TrajectoryCase {
  readonly id: string;
  /** The mission the REST create is given. */
  readonly purpose: string;
  /** Files seeded through the public files route before the first turn. */
  readonly seed: readonly { readonly path: string; readonly content: string }[];
  /** The user turns, in order. At least two: this family measures conversations. */
  readonly turns: readonly string[];
  /** A correction submitted while `turns[0]` is still running, when the case is
   *  about steering. */
  readonly steer?: string;
  /** The machine-checkable subgoals, over the workspace and the ledger the
   *  public surfaces expose. */
  verify(input: {
    readonly session: Pick<KinuPublicSession, 'readFile' | 'execute'>;
    readonly events: readonly RunEvent[];
    readonly history: readonly { readonly role: string; readonly text: string }[];
    readonly steerLanding: 'mid-turn' | 'queued' | null;
  }): Promise<readonly EvalSubgoal[]>;
}

/** The marker a case's artifact must carry verbatim. A fixed string rather than
 *  prose: a subgoal that greps for a paraphrase measures the grep. */
const ARTIFACT_MARKER = 'KINU_PUBLIC_ARTIFACT_OK';
const STEER_MARKER = 'KINU_STEER_LANDED';

/** The seeded bug the recovery case needs. `add` subtracts, and the test expects
 *  a sum — so the first obvious command FAILS, which is the only way execution
 *  recovery can be measured at all. */
const BROKEN_SOURCE = [
  'export function add(a: number, b: number): number {',
  '  return a - b;',
  '}',
  '',
].join('\n');
const BROKEN_TEST = [
  "import { test, expect } from 'bun:test';",
  "import { add } from './broken.ts';",
  '',
  "test('add sums', () => { expect(add(2, 3)).toBe(5); });",
  '',
].join('\n');

const CASES: readonly TrajectoryCase[] = [
  {
    id: 'public-file-artifact',
    purpose: 'A precise assistant that uses its file tool rather than describing what it would do.',
    seed: [],
    turns: [
      `Use your file tool to write the exact text ${ARTIFACT_MARKER} into a file named `
      + 'public-artifact.txt. Then reply with only the word DONE.',
      'Read public-artifact.txt back with your file tool and reply with only its exact contents.',
    ],
    async verify({ session, events, history }) {
      const bytes = await session.readFile('public-artifact.txt', { allowMissing: true });
      const answers = history.filter((row) => row.role === 'assistant');
      const users = history.filter((row) => row.role === 'user');
      const lastAnswer = answers.at(-1)?.text ?? '';
      const calls = promptToolCalls(events, this.turns[1]);
      requireMeasuredToolOutcomes(calls);
      const reads = calls.filter((call) => fileActionOn(call, 'read', 'public-artifact.txt'));
      return [
        {
          what: 'artifact',
          reached: bytes === ARTIFACT_MARKER,
          detail: `public-artifact.txt over the files route: ${JSON.stringify(bytes.slice(0, 120))}`,
        },
        {
          what: 'continuity',
          reached: users.length >= 2 && answers.length >= 2,
          detail: `${String(users.length)} user and ${String(answers.length)} assistant row(s) in `
            + 'the durable transcript',
        },
        {
          what: 'read-back-tool',
          reached: reads.length > 0,
          detail: `${String(reads.length)} file read(s) of public-artifact.txt in the second turn's run`,
        },
        {
          what: 'read-back',
          reached: lastAnswer.trim() === ARTIFACT_MARKER,
          detail: `the second answer: ${JSON.stringify(lastAnswer.slice(0, 160))}`,
        },
      ];
    },
  },
  {
    id: 'public-steer-correction',
    purpose: 'A senior engineer who follows the latest instruction and keeps files where asked.',
    seed: [],
    turns: [
      'Write a four-line summary of what a write-ahead log is into notes/wal.txt using your file '
      + 'tool, then write a one-line version of it into notes/short.txt. Reply with only DONE.',
      'List the files under notes/ with your file tool and reply with only their names.',
    ],
    steer: `Correction before you finish: write the one-line version into notes/steered.txt `
      + `instead of notes/short.txt, and make its first line exactly ${STEER_MARKER}.`,
    async verify({ session, events, steerLanding, history }) {
      const steered = await session.readFile('notes/steered.txt', { allowMissing: true });
      const wal = await session.readFile('notes/wal.txt', { allowMissing: true });
      const totals = ledgerTotalsFromEvents(events);
      const steerText = history.some((row) => row.role === 'user' && row.text.includes(STEER_MARKER));
      const listing = history.filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
      // The second prompt asks for both filenames; accepting either steer
      // landing does not excuse an inaccurate later listing.
      const listed = wal.trimEnd().split('\n').length === 4
        && listing.includes('steered.txt') && listing.includes('wal.txt');
      return [
        {
          what: 'landing',
          reached: steerLanding !== null,
          detail: `the workspace answered steerTurn with ${String(steerLanding)}`,
        },
        {
          what: 'correction-applied',
          reached: steered.split('\n')[0] === STEER_MARKER,
          detail: `notes/steered.txt: ${JSON.stringify(steered.slice(0, 120))}`,
        },
        {
          what: 'steer-is-durable',
          reached: steerText,
          detail: `the steer ${steerText ? 'is' : 'is NOT'} a user row in the transcript, over `
            + `${String(totals.turns)} closed turn(s)`,
        },
        {
          what: 'listing-truthful',
          reached: listed,
          detail: `the listing ${listed ? 'names' : 'does not name'} both notes files: `
            + JSON.stringify(listing.slice(0, 160)),
        },
      ];
    },
  },
  {
    id: 'public-failure-recovery',
    purpose: 'A senior engineer who runs the tests, reads the failure, and fixes the cause.',
    seed: [
      { path: 'broken.ts', content: BROKEN_SOURCE },
      { path: 'broken.test.ts', content: BROKEN_TEST },
    ],
    turns: [
      'Run `bun test broken.test.ts` in this workspace and reply with only PASS or FAIL.',
      'Fix the bug in broken.ts so that test passes, run `bun test broken.test.ts` again, and '
      + 'reply with only PASS or FAIL.',
    ],
    async verify({ session, events, history }) {
      const originalTests = await session.readFile('broken.test.ts', { allowMissing: true });
      const result = await session.execute('workspace', 'bun test broken.test.ts');
      if (result.exitCode === undefined) {
        throw new Error(`${INFRA_FAILURE_MARKER} verification command returned no exit code: ${result.error ?? 'unreported'}`);
      }
      const fixed = originalTests === BROKEN_TEST && result.exitCode === 0;
      const firstCalls = promptToolCalls(events, this.turns[0]).filter((call) => call.name === 'run');
      const reruns = promptToolCalls(events, this.turns[1]).filter((call) => call.name === 'run');
      requireMeasuredToolOutcomes(firstCalls);
      requireMeasuredToolOutcomes(reruns);
      const failed = firstCalls.filter((call) => call.outcome?.success === false);
      const recovered = failed.some((failure) => reruns.some((later) =>
        compareRunEventOrder(failure, later) < 0 && later.outcome?.success === true));
      const answers = history.filter((row) => row.role === 'assistant');
      const first = answers[0]?.text.trim() ?? '';
      const last = answers.at(-1)?.text.trim() ?? '';
      return [
        {
          what: 'failure-observed', reached: failed.length > 0,
          detail: `${String(failed.length)} failed run call(s) in the first prompt's run`,
        },
        {
          what: 'recovery-took', reached: recovered,
          detail: 'a later clean run call must belong to the repair prompt, not an unrelated background run',
        },
        {
          what: 'cause-fixed', reached: fixed,
          detail: `original test unchanged=${String(originalTests === BROKEN_TEST)}, verifier exit=${String(result.exitCode)}; `
            + `${(result.stdout ?? '').slice(0, 300)} ${(result.stderr ?? '').slice(0, 300)}`,
        },
        {
          what: 'reported-truthfully', reached: first === 'FAIL' && last === 'PASS' && fixed,
          detail: `first=${JSON.stringify(first)}, last=${JSON.stringify(last)}, independent verifier passed=${String(fixed)}`,
        },
      ];
    },
  },
];

const DECLARED = CASES.map((entry) => entry.id);

function isToolCallEnd(event: RunEvent): event is Extract<RunEvent, { type: 'tool_call_end' }> {
  return event.type === 'tool_call_end';
}

/** Identify the requested prompt's run, not a later autonomous run or an
 * earlier run that happens to use the same tool. Missing identity earns no credit. */
function promptToolCalls(events: readonly RunEvent[], prompt: string | undefined): Extract<RunEvent, { type: 'tool_call_end' }>[] {
  if (prompt === undefined) return [];
  const runs = new Set(events.filter((event) => event.type === 'run_start' && event.userMessage === prompt).map((event) => event.runId));
  return events.filter(isToolCallEnd).filter((call) => runs.has(call.runId));
}

const FileActionSchema = v.object({ action: v.string(), path: v.string() });

function fileActionOn(
  call: Extract<RunEvent, { type: 'tool_call_end' }>, action: 'read' | 'write' | 'edit', path: string,
): boolean {
  if (call.name !== 'file' || call.outcome?.success !== true) return false;
  const args = v.safeParse(FileActionSchema, call.args);
  if (!args.success || args.output.action !== action) return false;
  const actual = posix.normalize(args.output.path);
  return actual === path || actual === `/${path}`;
}

/** Missing attribution is a harness evidence gap, not an agent failure or
 * a success inferred from harmless-looking output. The attempt/raw ledger remains retained. */
function requireMeasuredToolOutcomes(calls: readonly Extract<RunEvent, { type: 'tool_call_end' }>[]): void {
  const missing = calls.filter((call) => call.outcome === undefined).length;
  if (missing > 0) throw new Error(`producer tool outcomes unmeasured for ${String(missing)}/${String(calls.length)} observed calls`);
}

/**
 * Refuse a trajectory that recorded nothing gradable.
 *
 * The assertion sits UPSTREAM of every write path: it throws before an
 * observation is recorded, so a degenerate case contributes no score to the pool
 * a later comparison reads. A failed case contributing the best number in the
 * pool is inverted contamination, not noise.
 */
export function refuseDegenerateTrajectory(taskId: string, totals: LedgerTotals): void {
  if (totals.turns === 0 || totals.toolCalls === 0) {
    throw new DegenerateRunError(taskId, totals.turns, totals.toolCalls, totals.failures);
  }
}

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);
  publishRunRecord({
    family: 'trajectory', tier: TIER, modelId: LLM?.model ?? EVAL_MODELS[TIER],
    repeats: 1, seed: 1, arm: ARM, declaredTasks: DECLARED, observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
});

describe('Trajectory evals — multi-turn episodes through the public API', () => {
  /**
   * CREDENTIAL-FREE: the corpus can answer the question this family asks.
   *
   * A one-turn case would be the behaviour arm with extra steps, and a case with
   * no subgoals scores nothing — both are corpus defects that must fail before
   * anything is spent rather than produce an empty record afterwards.
   */
  test('every case is multi-turn, uniquely named, and machine-checkable', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(DECLARED).size).toBe(DECLARED.length);
    for (const entry of CASES) {
      expect(entry.turns.length, `${entry.id} is not multi-turn`).toBeGreaterThanOrEqual(2);
      expect(entry.purpose.length).toBeGreaterThan(20);
    }
    // The mechanisms only a conversation has, each covered by exactly one case:
    // a steer that arrives mid-turn, and a failure that turn two repairs.
    expect(CASES.filter((entry) => entry.steer !== undefined)).toHaveLength(1);
    expect(CASES.filter((entry) => entry.seed.length > 0)).toHaveLength(1);
  });

  test('artifact read-back rejects a failed read even when the answer repeats the marker', async () => {
    const entry = CASES.find((candidate) => candidate.id === 'public-file-artifact');
    if (!entry) throw new Error('missing artifact case');
    const events: RunEvent[] = [
      { type: 'run_start', runId: 'read', eventIndex: 0, timestamp: '2026-09-07T00:00:01Z',
        agentId: 'eval-public', caused_by: 'chat', userMessage: entry.turns[1] },
      { type: 'tool_call_end', runId: 'read', eventIndex: 2, timestamp: '2026-09-07T00:00:02Z',
        name: 'file', toolCallId: 'read', args: { action: 'read', path: 'public-artifact.txt' },
        error: 'not found', outcome: { success: false, reason: null } },
      { type: 'run_start', runId: 'background', eventIndex: 0, timestamp: '2026-09-07T00:00:03Z',
        agentId: 'eval-public', userMessage: 'unrelated maintenance' },
      { type: 'tool_call_end', runId: 'background', eventIndex: 2, timestamp: '2026-09-07T00:00:04Z',
        name: 'file', toolCallId: 'background-read', args: { action: 'read', path: 'public-artifact.txt' },
        result: ARTIFACT_MARKER, outcome: { success: true } },
    ];
    const input = {
      session: { readFile: async () => ARTIFACT_MARKER, execute: async () => ({ exitCode: 0 }) },
      events, steerLanding: null, history: [
        { role: 'user', text: entry.turns[0] ?? '' }, { role: 'assistant', text: 'DONE' },
        { role: 'user', text: entry.turns[1] ?? '' }, { role: 'assistant', text: ARTIFACT_MARKER },
      ],
    };
    const failed = await entry.verify(input);
    expect(failed.find((subgoal) => subgoal.what === 'read-back-tool')?.reached).toBe(false);
    const corrected = events.map((event): RunEvent => event.type === 'tool_call_end' && event.runId === 'read'
      ? { ...event, error: undefined, result: ARTIFACT_MARKER, outcome: { success: true } } : event);
    const read = await entry.verify({ ...input, events: corrected });
    expect(read.every((subgoal) => subgoal.reached)).toBe(true);
    const legacy = corrected.map((event): RunEvent => {
      if (event.type !== 'tool_call_end') return event;
      const { outcome: _outcome, ...withoutOutcome } = event;
      return withoutOutcome;
    });
    await expect(entry.verify({ ...input, events: legacy })).rejects.toThrow('unmeasured');
    expect(ledgerTotalsFromEvents(legacy).toolCalls).toBe(2);
  });

  test('a steering answer cannot invent the other file it lists', async () => {
    const entry = CASES.find((candidate) => candidate.id === 'public-steer-correction');
    if (!entry) throw new Error('missing steering case');
    let wal = '';
    const input = {
      session: {
        readFile: async (path: string) => path === 'notes/wal.txt' ? wal : STEER_MARKER,
        execute: async () => ({ exitCode: 0 }),
      },
      events: [], steerLanding: 'queued' as const, history: [
        { role: 'user', text: entry.steer ?? '' }, { role: 'assistant', text: 'wal.txt\nsteered.txt' },
      ],
    };
    const missing = await entry.verify(input);
    expect(missing.find((subgoal) => subgoal.what === 'listing-truthful')?.reached).toBe(false);
    wal = 'Append changes.\nPersist the log.\nApply the changes.\nReplay after a crash.\n';
    const present = await entry.verify(input);
    expect(present.every((subgoal) => subgoal.reached)).toBe(true);
  });

  test('recovery grades executable behavior and orders distinct runs rather than their local indices', async () => {
    const entry = CASES.find((candidate) => candidate.id === 'public-failure-recovery');
    if (!entry) throw new Error('missing recovery case');
    const root = scratchDir('trajectory-oracle');
    const session: Pick<KinuPublicSession, 'readFile' | 'execute'> = {
      readFile: (path) => Bun.file(join(root, path)).text(),
      async execute(_executor, command) {
        const process = Bun.spawn(['bash', '-c', command], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stdout, stderr] = await Promise.all([process.exited,
          new Response(process.stdout).text(), new Response(process.stderr).text()]);
        return { exitCode, stdout, stderr };
      },
    };
    const events: RunEvent[] = [
      { type: 'run_start', runId: 'first', eventIndex: 0, timestamp: '2026-09-07T00:00:01Z',
        agentId: 'eval-public', userMessage: entry.turns[0] },
      { type: 'tool_call_end', runId: 'first', eventIndex: 99, timestamp: '2026-09-07T00:00:02Z',
        name: 'run', toolCallId: 'failed-test', args: { command: 'bun test broken.test.ts' },
        outcome: { success: false, reason: null, execution: { exitCode: 1 } } },
      { type: 'run_start', runId: 'second', eventIndex: 0, timestamp: '2026-09-07T00:00:03Z',
        agentId: 'eval-public', userMessage: entry.turns[1] },
      { type: 'tool_call_end', runId: 'second', eventIndex: 2, timestamp: '2026-09-07T00:00:04Z',
        name: 'run', toolCallId: 'rerun-test', args: { command: 'bun test broken.test.ts' },
        result: '1 pass, 0 fail', outcome: { success: true } },
    ];
    const input = { session, events, steerLanding: null, history: [
      { role: 'assistant', text: 'FAIL' }, { role: 'assistant', text: 'PASS' },
    ] };
    try {
      await Bun.write(join(root, 'broken.test.ts'), BROKEN_TEST);
      await Bun.write(join(root, 'broken.ts'), BROKEN_SOURCE + '// a + b is not the implementation\n');
      const broken = await entry.verify(input);
      expect(broken.find((subgoal) => subgoal.what === 'cause-fixed')?.reached).toBe(false);
      await Bun.write(join(root, 'broken.ts'), 'export const add = (a: number, b: number) => a - -b;\n');
      const fixed = await entry.verify(input);
      expect(fixed.every((subgoal) => subgoal.reached)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * CREDENTIAL-FREE: a degenerate trajectory is refused rather than scored.
   *
   * Both directions, because a refusal that fires on everything is as useless as
   * one that fires on nothing: the degenerate fixture must throw and the real one
   * must not.
   */
  test('a closed turn with no tool call is refused, and a real trajectory is not', () => {
    expect(() => refuseDegenerateTrajectory(
      'probe', ledgerTotalsFromEvents(DEGENERATE_EVENTS),
    )).toThrow(DegenerateRunError);
    refuseDegenerateTrajectory('probe', ledgerTotalsFromEvents(LEDGER_EVENTS));
    // And the refusal classifies as the AGENT producing nothing — `inert`, a
    // terminal verdict — rather than as the harness or the environment failing.
    const disposition = disposeFailedCase(new DegenerateRunError('probe', 1, 0, []));
    expect(disposition).toEqual({ kind: 'settled', outcome: 'inert' });
  });

  /**
   * CREDENTIAL-FREE: the set this run measures must equal the set it declares.
   *
   * Driven over synthetic observations because the property is about the
   * ADMISSIBILITY RULE and this family's score shape, not about a live run: a
   * record carrying two of three declared cases is not evidence about the third,
   * and a record whose scores carry no `task_outcome` measured activity rather
   * than whether anything was solved.
   */
  test('a partial run is inadmissible, and a complete one carries the primary metric', () => {
    const scored = (id: string): EvalObservation => ({
      taskId: id, repetition: 0, outcome: 'scored',
      scores: [outcomeRow(subgoalOutcome(3, 3, 'every subgoal reached'))],
      turns: 2, toolCalls: 4, toolNames: ['file', 'run'], tokensIn: 10, tokensOut: 5, ms: 1_000,
    });

    const partial = assessAdmissibility(DECLARED, [scored(DECLARED[0] ?? '')]);
    expect(partial.admissible).toBe(false);
    expect(partial.failures.join(' ')).toContain('never attempted');

    const complete = assessAdmissibility(DECLARED, DECLARED.map(scored));
    expect(complete.failures).toEqual([]);
    expect(complete.admissible).toBe(true);
    expect(complete.outcomesScored).toBe(DECLARED.length);

    // The same rule, from the other side: an observation whose scores are all
    // covariates measured activity and not outcome, so it is NOT evidence about
    // task performance however many tool calls it made.
    const covariatesOnly: EvalObservation = {
      taskId: 'public-file-artifact', repetition: 0, outcome: 'scored', scores: [],
      turns: 2, toolCalls: 4, toolNames: ['file', 'run'], tokensIn: 10, tokensOut: 5, ms: 1_000,
    };
    const activityOnly = assessAdmissibility(['public-file-artifact'], [covariatesOnly]);
    expect(activityOnly.admissible).toBe(false);
    expect(activityOnly.failures.join(' ')).toContain(TASK_OUTCOME);
  });

  for (const entry of CASES) {
    liveTest(`MEASURED: ${entry.id}`, async () => {
      if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
      const startedAt = Date.now();
      const session = await PLAN.open({ subject: entry.id, purpose: entry.purpose });
      console.warn(`    [trajectory] ${entry.id} on ${session.describe}`);
      try {
        await withEpisodeEvidence(session, { transcripts: TRANSCRIPTS, taskId: entry.id, modelCalls: 'expected' }, async (collect) => {
        // Seeded through the PUBLIC files route — the plane the web file manager
        // writes through and the one the agent's own tools read. Sequential:
        // two writes to one plane are not independent.
        for (const file of entry.seed) await session.writeFile(file.path, file.content);

        let steerLanding: 'mid-turn' | 'queued' | null = null;
        const [first, ...rest] = entry.turns;
        if (first === undefined) throw new Error(`${entry.id} declares no turns`);
        if (entry.steer === undefined) {
          await session.prompt(first);
        } else {
          // The composer's own race, driven deliberately: the turn is submitted
          // and the correction goes in while it is open. `steerTurn` answers
          // `mid-turn` when it was spliced into the running turn and `queued`
          // when that turn had already ended — the DO's own statement, recorded
          // rather than asserted, because both are correct behaviour and which
          // one happens is a property of the model's pace.
          const submission = session.submit(first);
          steerLanding = await session.steer(entry.steer);
          await submission.settled;
        }
        for (const turn of rest) await session.prompt(turn);

        const { events, history } = await collect();
        const totals = ledgerTotalsFromEvents(events);

        // The precondition, upstream of the observation: a trajectory that
        // recorded no closed turn or no tool call is refused rather than scored.
        refuseDegenerateTrajectory(entry.id, totals);

        const subgoals = await entry.verify({ session, events, history, steerLanding });
        // THE EVIDENCE, before any verdict on it. The ledger, the durable
        // transcript and the verdicts land under the directory the record names,
        // so a missed subgoal can be read back from what the trajectory did.
        const retained = retainEpisodeTranscript(TRANSCRIPTS, entry.id, { events, history, subgoals });
        const outcome = subgoalsOutcome(subgoals, { turns: totals.turns, toolCalls: totals.toolCalls });
        const scores: EvalScoreRow[] = [outcomeRow(outcome), ...scorePublicLedger(events)];

        // The observation FIRST, so a missed subgoal still reaches the record
        // with what the trajectory did — a record that only accumulates
        // successes is not evidence.
        observations.push({
          taskId: entry.id, repetition: 0, outcome: 'scored', scores,
          turns: totals.turns, toolCalls: totals.toolCalls, toolNames: totals.toolNames,
          tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, reasoningOut: totals.reasoningOut,
          provenance: projectRunEventProvenance(events),
          ms: Date.now() - startedAt,
        });
        console.warn(`    [trajectory] ${entry.id}: ${String(totals.turns)} turn(s), `
          + `${String(totals.toolCalls)} tool call(s), ${String(totals.steps)} step(s), `
          + `${String(outcome.reached)}/${String(outcome.total)} subgoals — retained at ${retained}`);
        console.warn(`    [trajectory] ${outcome.detail}`);

        // ── Denominators first ─────────────────────────────────────────────
        // The CONVERSATION before the subgoals: a run that closed one turn is
        // not a multi-turn measurement, and holding it to a continuity subgoal
        // would report an agent failure for a transport one.
        expect(totals.turns,
          `${entry.id} closed ${String(totals.turns)} turn(s) over `
          + `${String(entry.turns.length)} prompts — a conversation this family can measure needs `
          + 'at least two closed turns').toBeGreaterThanOrEqual(2);

        // The SUBGOALS, each named in its own failure. Recorded above whatever
        // happens here, so the record carries the partial credit either way.
        for (const subgoal of subgoals) {
          expect(subgoal.reached, `${entry.id}/${subgoal.what}: ${subgoal.detail}`).toBe(true);
        }
        });
      } catch (error) {
        // THREE CAUSES AND ONE VALUE THAT NAMES WHICH — the behaviour arm's own
        // classification, reused rather than re-derived: `inert` is the agent
        // producing nothing, `errored` is this harness failing, and a turn the
        // ENVIRONMENT killed is neither and stays resumable. Filing an outage as
        // the first is how a transient failure becomes a permanent verdict.
        //
        // ONE ROW PER CASE. A case that was already scored carries its verdict
        // above — the throw after it is the subgoal assertion naming the miss,
        // which the outcome row holds as partial credit — so a second row here
        // would count one attempt twice and file the agent's shortcoming as this
        // harness failing. Measured: every first-run record with a missed
        // subgoal carried `scored` AND `errored` for the same pairing key.
        const thrown = error instanceof Error ? error : new Error(String(error));
        if (!observations.some((o) => o.taskId === entry.id)) {
          observations.push({
            taskId: entry.id, repetition: 0,
            outcome: disposeFailedCase(thrown).outcome,
            reason: thrown.message,
          });
        }
        throw error;
      } finally {
        // On the public plane this DELETES the workspace, so it is a `finally`
        // and not a teardown hook: a case that threw must not leave a row on the
        // account.
        await session.teardown();
      }
    });
  }
});
