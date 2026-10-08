import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runToExit, scratchDir, spawnTest } from '@kinu.run/test-utils';
import * as v from 'valibot';

const REPO = join(import.meta.dirname, '../..');

test('a task file that did not load and a suite whose hook threw are named in the run\'s output, with why', async () => {
  // On 2026-10-01 the staging pass printed "10 failed" with 24 trials "skipped" and no reason: vitest-evals' reporter
  // drops vitest's "Failed Suites" summary for a run of eval files alone. These two task files fail the same two ways:
  // one does not load (chess.js was missing), one's hook throws before its trial (a sweep was refused). They are
  // written for the run, inside the repository so vitest resolves, and outside evals/tasks so no eval run takes them.
  const dir = scratchDir('silent-suites', join(REPO, 'bench-artifacts'));

  writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['*.eval.ts'], globals: true } };\n");
  writeFileSync(join(dir, 'import-throws.eval.ts'), "throw new Error(\"the task file did not load: Cannot find package 'chess.js'\");\n");

  writeFileSync(join(dir, 'hook-throws.eval.ts'), [
    "describe('hook-throws', () => {",
    "  beforeAll(() => { throw new Error('the suite hook failed: no such table: workspace_identity'); });",
    "  test('trial 1', () => undefined);",
    '});',
  ].join('\n'));

  // Awaited, never `spawnSync`: the runner spun in it, state R, until the row's silence bound killed it (2026-10-08, on
  // 78c0615783, f735c55efa and 3b005c2e2; oven-sh/bun#34069), as session.test.ts's did.
  const run = await runToExit(['bun', '--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--root', dir,
    '--config', join(dir, 'vitest.config.mjs'), `--reporter=${join(REPO, 'evals/src/reporter.ts')}`], { env: process.env, cwd: REPO });

  const output = `${run.stdout}${run.stderr}`;

  expect(run.exitCode, output).toBe(1);
  expect(output).toContain('Failed suites 2: their trials did not run');
  expect(output).toContain("import-throws.eval.ts: the task file did not load: Cannot find package 'chess.js'");
  expect(output).toContain('hook-throws.eval.ts > hook-throws: the suite hook failed: no such table: workspace_identity');
});

/**
 * A trial held by a job that never ends, as the harness runs one: the lead's run has ended, the agent's own server runs
 * as a job, and the watch waits on it with the run's cancel. Written for the run like the files above.
 */
const HELD_TRIAL = `import { createHarness, describeEval } from 'vitest-evals';
import { duringTrial, runCancelled } from '${join(REPO, 'evals/src/cancel')}';
import { settle, TurnWatch, WorkspaceHeld } from '${join(REPO, 'evals/src/workspace-completion')}';

const at = new Date().toISOString();
const server = { id: 'bgjob-server', kind: 'shell', status: 'running', label: 'workspace: node server.js', createdAt: Date.parse(at) - 60_000 };

const workspace = {
  runEvents: async () => [
    { type: 'run_start', runId: 'run-1', eventIndex: 0, timestamp: at, agentId: 'lead', caused_by: 'chat' },
    { type: 'run_end', runId: 'run-1', eventIndex: 1, timestamp: at, reason: 'completed' },
  ],
  backgroundJobs: async (of) => (of === undefined ? [server] : []),
  subordinates: async () => [],
  agents: async () => [],
  toolCallsInFlight: () => [],
  heard: () => 0,
  listen: () => undefined,
  readsMoved: () => 0,
  readsMoving: new AbortController().signal,
};

const harness = createHarness({
  name: 'held',
  run: ({ input }) => duringTrial(async () => {
    process.stdout.write('[fixture] the trial waits on its job\\n');

    try {
      await settle(new TurnWatch(workspace, { cancelled: runCancelled() }));
    } catch (error) {
      if (!(error instanceof WorkspaceHeld)) throw error;
      const outcome = { status: error.outcome, message: error.message, heldBy: [...error.heldBy] };

      return { output: { success: false, turns: [{ part: 'build', turn: 1, outcome, checks: [], turnWallMs: 0, verificationWallMs: 0 }] }, events: [{ type: 'message', role: 'user', content: input.prompt }] };
    }

    throw new Error('the job ended');
  }),
});

describeEval('held', { harness }, (it) => {
  it.concurrent('muse | product | trial 1', async ({ run }) => { await run({ prompt: 'Serve the site.' }); });
});
`;

const ResultsSchema = v.object({
  testResults: v.array(v.looseObject({
    assertionResults: v.array(v.looseObject({
      meta: v.looseObject({ harness: v.looseObject({ run: v.looseObject({ output: v.looseObject({ turns: v.array(v.looseObject({ outcome: v.unknown() })) }) }) }) }),
    })),
  })),
});

/**
 * Run the held trial and send `signal` once it is open: to the run's whole process group, to vitest's process alone, or
 * to the deploy row's runner, the way a terminal's Ctrl-C reaches it (scripts/deadline.ts, a session of its own for the
 * run). Hand back how the run, or its runner, ended, everything it printed, and the outcome its report recorded.
 */
async function cancelHeldTrial(signal: 'SIGTERM' | 'SIGINT', to: 'group' | 'vitest' | 'deploy row'): Promise<{ code: number; output: string; outcome: unknown }> {
  const dir = scratchDir(`cancelled-${signal}`, join(REPO, 'bench-artifacts'));

  // The eval suite's own plugin, interop and preload: the watch reaches core, which imports its prompts as text, and the
  // preload's scratch release raises the signal again in every worker (`releaseOnSignals`).
  writeFileSync(join(dir, 'vitest.config.ts'), [
    `import { promptText } from '${join(REPO, 'packages/cf-backend/vite-prompt-text')}';`,
    `export default { plugins: [promptText()], test: { include: ['*.eval.ts'], testTimeout: 0, hookTimeout: 0, deps: { interopDefault: false },`,
    `  setupFiles: ['${join(REPO, 'scripts/test-preload-vitest.ts')}'] } };`,
  ].join('\n'));
  writeFileSync(join(dir, 'held.eval.ts'), HELD_TRIAL);

  const vitest = ['bun', '--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--root', dir, '--config', join(dir, 'vitest.config.ts'),
    `--reporter=${join(REPO, 'evals/src/reporter.ts')}`, '--reporter=json', `--outputFile.json=${join(dir, 'results.json')}`];

  // A deploy phase's lone row, its output passed on as it comes.
  const row = `import { runUnderDeadline } from ${JSON.stringify(join(REPO, 'scripts/deadline.ts'))};\n`
    + `await runUnderDeadline({ argv: ${JSON.stringify(vitest)}, cwd: ${JSON.stringify(REPO)}, seconds: 480, label: 'Eval pass', stdio: 'tee' });\n`;

  // Its own process group, as the deploy starts a gate and a terminal its foreground job.
  const run = spawnTest(to === 'deploy row' ? [process.execPath, '-e', row] : vitest, { cwd: REPO, detached: true, stdout: 'pipe', stderr: 'pipe' });

  let output = '';
  let sent = false;

  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });

      if (!sent && output.includes('[fixture] the trial waits on its job')) {
        sent = true;
        process.kill(to === 'vitest' ? run.pid : -run.pid, signal);
      }
    }
  };

  await Promise.all([read(run.stdout), read(run.stderr)]);
  const code = await run.exited;
  const results = v.parse(ResultsSchema, JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));

  return { code, output, outcome: results.testResults[0]?.assertionResults[0]?.meta.harness.run.output.turns[0]?.outcome };
}

/** How a held trial's run is cancelled, and what its record and its runner's exit say then. */
const CANCELS = [
  // The deploy's watchdog signals the run's process group, and its kill follows 5 s later (scripts/deadline.ts).
  { title: "SIGTERM to the run's process group, as the deploy sends it", signal: 'SIGTERM', to: 'group', code: 143, by: 'SIGTERM' },
  // A person who stops vitest's own process: its workers hear the cancel from it.
  { title: "SIGINT to vitest's process alone, which passes it to its workers", signal: 'SIGINT', to: 'vitest', code: 130, by: 'SIGINT' },
  // A person's Ctrl-C on the deploy reaches the row's runner, never the run, which leads a session of its own: the runner
  // passes it on as SIGTERM and waits for the run to end. Until 2026-10-01 it SIGKILLed the run at once, unrecorded.
  { title: "a person's Ctrl-C on the deploy row running the eval pass records its cancelled trials", signal: 'SIGINT', to: 'deploy row', code: 130, by: 'SIGTERM' },
] as const;

describe('a run cancelled mid-trial records what held each open trial, then exits naming them', () => {
  for (const { title, signal, to, code, by } of CANCELS) {
    test(title, async () => {
      const run = await cancelHeldTrial(signal, to);
      const held = `cancelled by ${by}, held by running shell job bgjob-server (workspace: node server.js) for `;

      expect(run.code, run.output).toBe(code);
      expect(run.outcome).toMatchObject({ status: 'cancelled', heldBy: ['running shell job'], message: expect.stringMatching(new RegExp(`^${RegExp.escape(held)}\\d+ s$`, 'u')) });
      expect(run.output).toContain(`[evals] cancelled by ${by}, the trials open and what held each:`);
      expect(run.output).toContain(`held > muse | product | trial 1: ${held}`);
    });
  }
});
