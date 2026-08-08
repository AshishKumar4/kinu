/**
 * `proteus label` end to end, against a local workspace whose true outcomes
 * are known by construction.
 *
 * The real binary is spawned for every step, so this covers what the owner
 * will actually type: draw a file, fill it in, hand it back, read the numbers.
 * No model is involved — the ledger is written the way the classifier would
 * have written it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { initTurnOutcomeTables, recordTurnOutcome, seededRandom } from '@proteus/core';
import { makeSql } from '@proteus/cli-backend';

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(home: string, args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROTEUS_HOME: home, NO_COLOR: '1' },
  });
  return {
    stdout: `${result.stdout.toString()}${result.stderr.toString()}`.replace(/\x1b\[[0-9;]*m/g, ''),
    exitCode: result.exitCode,
  };
}

interface World {
  home: string;
  /** outcome-row id → what the turn REALLY was. */
  truth: Map<string, 'accepted' | 'corrected'>;
}

/** A workspace whose classifier catches only 65% of real corrections and
 *  falsely flags 4% of the good turns — a bias no telemetry can see. */
function seedWorkspace(name: string, size = 600): World {
  const home = mkdtempSync(join(tmpdir(), 'proteus-label-'));
  tempDirs.push(home);
  mkdirSync(join(home, name), { recursive: true });
  const db = new Database(join(home, name, 'agent.db'));
  const sql = makeSql(db);
  initTurnOutcomeTables((ddl: string) => { db.exec(ddl); }, sql);

  const random = seededRandom(4242);
  const truthByTurn = new Map<string, 'accepted' | 'corrected'>();
  for (let i = 0; i < size; i++) {
    const reallyNegative = random() < 0.22;
    const flagged = reallyNegative ? random() < 0.65 : random() >= 0.96;
    truthByTurn.set(`turn-${i}`, reallyNegative ? 'corrected' : 'accepted');
    recordTurnOutcome(sql, {
      turnId: `turn-${i}`,
      outcome: flagged ? (random() < 0.25 ? 'frustrated' : 'corrected') : 'accepted',
      confidence: 0.8,
      source: 'classifier',
      userMessage: `refactor the token store (#${i})`,
      assistantResponse: `Here is what I changed for #${i}.`,
      followup: reallyNegative ? 'no, that is not what I asked for' : 'great, ship it',
      scaffoldVersion: i < size / 2 ? 1 : 2,
      now: 1_750_000_000_000 + i * 3_600_000,
    });
  }

  const truth = new Map<string, 'accepted' | 'corrected'>();
  for (const row of sql<{ id: string; turn_id: string }>`SELECT id, turn_id FROM turn_outcomes`) {
    truth.set(row.id, truthByTurn.get(row.turn_id) ?? 'accepted');
  }
  db.close();
  return { home, truth };
}

/** Stand in for the owner: answer each blind item from the ground truth. */
function fillFile(path: string, truth: World['truth'], answer = (t: string): string => (t === 'corrected' ? 'c' : 'a')): void {
  let current = '';
  const filled = readFileSync(path, 'utf8').split('\n').map((line) => {
    const header = /^###\s+\d+\/\d+\s+(\S+)$/.exec(line);
    if (header) {
      current = header[1];
      return line;
    }
    if (line !== 'verdict:') return line;
    return `verdict: ${answer(truth.get(current) ?? 'accepted')}`;
  });
  writeFileSync(path, filled.join('\n'));
}

describe('proteus label', () => {
  test('export → fill → ingest → report, and the corrected rate finds the truth the raw one missed', () => {
    const { home, truth } = seedWorkspace('demo');
    const file = join(home, 'calib.txt');

    const exported = runCli(home, ['label', 'export', 'demo', '--out', file]);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain('drew 100 turns');
    expect(exported.stdout).toContain('minutes)');

    // The file must not tell the labeler what the classifier already thinks.
    const drawn = readFileSync(file, 'utf8');
    const body = drawn.slice(drawn.indexOf('### 1/100'));
    for (const verdict of ['accepted', 'corrected', 'frustrated']) expect(body).not.toContain(verdict);

    fillFile(file, truth);
    const ingested = runCli(home, ['label', 'ingest', 'demo', file, '--labeler', 'owner']);
    expect(ingested.exitCode).toBe(0);
    expect(ingested.stdout).toContain('stored 100 verdicts as owner');
    expect(ingested.stdout).toMatch(/You disagreed with the classifier on \d+ of 100\./);

    const report = runCli(home, ['label', 'report', 'demo', '--json']);
    const { calibration: parsed, ensemble } = JSON.parse(report.stdout) as {
      calibration: {
        universe: number; labeled: number; gap: unknown;
        accuracy: { sensitivity: { mean: number }; specificity: { mean: number } };
        overall: { raw: number; corrected: { mean: number; lo: number; hi: number } };
        segments: Array<{ scaffoldVersion: number; rate: { corrected: { mean: number } } }>;
      };
      ensemble: { gap: { kind: string } | null; standIn: unknown };
    };
    // The panel has not been run, and the report says so rather than implying
    // the classifier has been checked by anything but the owner.
    expect(ensemble.gap?.kind).toBe('not_run');
    expect(ensemble.standIn).toBeNull();

    const trueRate = [...truth.values()].filter((t) => t === 'corrected').length / truth.size;
    expect(parsed.universe).toBe(600);
    expect(parsed.labeled).toBe(100);
    expect(parsed.gap).toBeNull();
    // The classifier's own rate is well below the truth, and the correction
    // brings the estimate back to it.
    expect(parsed.overall.raw).toBeLessThan(trueRate - 0.02);
    expect(parsed.overall.corrected.lo).toBeLessThan(trueRate);
    expect(parsed.overall.corrected.hi).toBeGreaterThan(trueRate);
    expect(parsed.accuracy.sensitivity.mean).toBeLessThan(0.95);
    expect(parsed.accuracy.specificity.mean).toBeGreaterThan(0.9);
    expect(parsed.segments).toHaveLength(2);
  });

  test('alignment prints the corrected block beside the raw rate', () => {
    const { home, truth } = seedWorkspace('demo');
    const file = join(home, 'calib.txt');

    const before = runCli(home, ['alignment', 'demo']);
    expect(before.stdout).toContain('K_align');
    expect(before.stdout).toContain('uncalibrated — no hand-labeled turns yet');
    expect(before.stdout).toContain('600 classifier-graded turns are waiting to be checked');

    runCli(home, ['label', 'export', 'demo', '--out', file]);
    fillFile(file, truth);
    runCli(home, ['label', 'ingest', 'demo', file]);

    const after = runCli(home, ['alignment', 'demo']);
    expect(after.stdout).toContain('K_align');
    expect(after.stdout).toContain('Sensitivity:');
    expect(after.stdout).toContain('Corrected correction rate:');
    expect(after.stdout).not.toContain('uncalibrated');
  });

  test('a second export never re-asks a turn already answered', () => {
    const { home, truth } = seedWorkspace('demo');
    const first = join(home, 'a.txt');
    const second = join(home, 'b.txt');

    runCli(home, ['label', 'export', 'demo', '--out', first, '--size', '30']);
    fillFile(first, truth);
    runCli(home, ['label', 'ingest', 'demo', first]);
    runCli(home, ['label', 'export', 'demo', '--out', second, '--size', '30']);

    const ids = (path: string): string[] =>
      [...readFileSync(path, 'utf8').matchAll(/^###\s+\d+\/\d+\s+(\S+)$/gm)].map((m) => m[1]);
    const answered = new Set(ids(first));
    expect(ids(second)).toHaveLength(30);
    expect(ids(second).some((id) => answered.has(id))).toBe(false);
  });

  test('a file with a problem in it stores nothing', () => {
    const { home } = seedWorkspace('demo');
    const file = join(home, 'broken.txt');
    runCli(home, ['label', 'export', 'demo', '--out', file, '--size', '5']);
    // A typo on a real verdict line. (The instructions at the top of the file
    // mention `verdict:` too; only lines that START with it are verdicts.)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^verdict:$/m, 'verdict: z'));

    const ingested = runCli(home, ['label', 'ingest', 'demo', file]);
    expect(ingested.exitCode).toBe(1);
    expect(ingested.stdout).toContain('nothing was stored');
    expect(ingested.stdout).toContain('is not a verdict');
    expect(runCli(home, ['label', 'report', 'demo']).stdout).toContain('uncalibrated');
  });

  test('an untouched file is not an error, it is just nothing yet', () => {
    const { home } = seedWorkspace('demo');
    const file = join(home, 'blank.txt');
    runCli(home, ['label', 'export', 'demo', '--out', file, '--size', '5']);

    const ingested = runCli(home, ['label', 'ingest', 'demo', file]);
    expect(ingested.exitCode).toBe(0);
    expect(ingested.stdout).toContain('no verdicts');
  });

  test('the panel refuses before there is anything to score it against', () => {
    const { home, truth } = seedWorkspace('demo');
    const file = join(home, 'calib.txt');

    // No hand labels yet: the missing step is named before anything else is
    // checked, because it is the step the whole flow exists for.
    const early = runCli(home, ['label', 'ensemble', 'demo', '--models', 'anthropic/claude-fable-5,codex/gpt-5.6-sol']);
    expect(early.exitCode).toBe(0);
    expect(early.stdout).toContain('did not run');
    expect(early.stdout).toContain('proteus label export');
    expect(early.stdout).toContain('proteus label ingest');

    runCli(home, ['label', 'export', 'demo', '--out', file]);
    fillFile(file, truth);
    runCli(home, ['label', 'ingest', 'demo', file]);

    // Labels exist, but one model is not a panel — and no second model from the
    // same vendor is substituted for the missing one.
    const alone = runCli(home, ['label', 'ensemble', 'demo', '--models', 'anthropic/claude-fable-5']);
    expect(alone.exitCode).toBe(0);
    expect(alone.stdout).toContain('two models from different vendors');
    expect(runCli(home, ['label', 'report', 'demo']).stdout).toContain('Judge panel');
  });

  test('unknown actions and missing arguments say what to type', () => {
    const { home } = seedWorkspace('demo');
    expect(runCli(home, ['label', 'summarise', 'demo']).stdout)
      .toContain('use export, ingest, ensemble, report, mine, or score');
    expect(runCli(home, ['label', 'ingest', 'demo']).stdout).toContain('proteus label ingest <agent> <file>');
  });
});
