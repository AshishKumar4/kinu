import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';

const REPO = join(import.meta.dirname, '../..');

test('a task file that did not load and a suite whose hook threw are named in the run\'s output, with why', () => {
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

  const run = spawnSync('bun', ['--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--root', dir,
    '--config', join(dir, 'vitest.config.mjs'), `--reporter=${join(REPO, 'evals/src/reporter.ts')}`], { cwd: REPO, encoding: 'utf8' });

  const output = `${run.stdout}${run.stderr}`;

  expect(run.status, output).toBe(1);
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

      return { output: { success: false, turns: [{ outcome, checks: [], turnWallMs: 0, verificationWallMs: 0 }] }, events: [{ type: 'message', role: 'user', content: input.prompt }] };
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

/** Run the held trial, send `signal` once it is open to the run's whole process group or to vitest's process alone, and
 *  hand back how the run ended, everything it printed, and the outcome its report recorded for the trial. */
async function cancelHeldTrial(signal: 'SIGTERM' | 'SIGINT', to: 'group' | 'vitest'): Promise<{ code: number; output: string; outcome: unknown }> {
  const dir = scratchDir(`cancelled-${signal}`, join(REPO, 'bench-artifacts'));

  // The eval suite's own plugin, interop and preload: the watch reaches core, which imports its prompts as text, and the
  // preload's scratch release raises the signal again in every worker (`releaseOnSignals`).
  writeFileSync(join(dir, 'vitest.config.ts'), [
    `import { promptText } from '${join(REPO, 'packages/cf-backend/vite-prompt-text')}';`,
    `export default { plugins: [promptText()], test: { include: ['*.eval.ts'], testTimeout: 0, hookTimeout: 0, deps: { interopDefault: false },`,
    `  setupFiles: ['${join(REPO, 'scripts/test-preload-vitest.ts')}'] } };`,
  ].join('\n'));
  writeFileSync(join(dir, 'held.eval.ts'), HELD_TRIAL);

  // Its own process group, as the deploy starts a gate: the group signal reaches vitest and its workers at once.
  const run = Bun.spawn(['bun', '--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--root', dir, '--config', join(dir, 'vitest.config.ts'),
    `--reporter=${join(REPO, 'evals/src/reporter.ts')}`, '--reporter=json', `--outputFile.json=${join(dir, 'results.json')}`],
  { cwd: REPO, detached: true, stdout: 'pipe', stderr: 'pipe' });

  let output = '';
  let sent = false;

  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });

      if (!sent && output.includes('[fixture] the trial waits on its job')) {
        sent = true;
        process.kill(to === 'group' ? -run.pid : run.pid, signal);
      }
    }
  };

  await Promise.all([read(run.stdout), read(run.stderr)]);
  const code = await run.exited;
  const results = v.parse(ResultsSchema, JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));

  return { code, output, outcome: results.testResults[0]?.assertionResults[0]?.meta.harness.run.output.turns[0]?.outcome };
}

describe('a run cancelled mid-trial records what held each open trial, then exits naming them', () => {
  const held = { status: 'cancelled', heldBy: ['running shell job'] };

  // The deploy's watchdog signals the run's process group, and its kill follows 5 s later (scripts/deadline.ts).
  test("SIGTERM to the run's process group, as the deploy sends it", async () => {
    const { code, output, outcome } = await cancelHeldTrial('SIGTERM', 'group');

    expect(code, output).toBe(143);
    expect(outcome).toMatchObject({ ...held, message: expect.stringMatching(/^cancelled by SIGTERM, held by running shell job bgjob-server \(workspace: node server\.js\) for \d+ s$/u) });
    expect(output).toContain('[evals] cancelled by SIGTERM, the trials open and what held each:');
    expect(output).toMatch(/held > muse \| product \| trial 1: cancelled by SIGTERM, held by running shell job bgjob-server \(workspace: node server\.js\) for \d+ s/u);
  });

  // A person who stops vitest's own process: its workers hear the cancel from it.
  test("SIGINT to vitest's process alone, which passes it to its workers", async () => {
    const { code, output, outcome } = await cancelHeldTrial('SIGINT', 'vitest');

    expect(code, output).toBe(130);
    expect(outcome).toMatchObject({ ...held, message: expect.stringMatching(/^cancelled by SIGINT, held by running shell job bgjob-server/u) });
    expect(output).toContain('[evals] cancelled by SIGINT, the trials open and what held each:');
  });
});
