/**
 * The CLI process a terminal-transition test kills: it SIGKILLs itself at a named durable instant
 * (`before-settle`, `inside-claim`, `inside-title`), so no teardown runs.
 * Run as `bun <this file> <dbPath> <mode>`; the stdout marker proves the kill point was reached.
 */
import type { SqlExecutor, SqlValue } from '@kinu.run/core';
import { LocalAgentSession } from '../src/local-session';
import { armShadowTrials, captureTakes, openTerminalWorkspace, scriptedModel } from './terminal-workspace';

const MODES = ['before-settle', 'inside-claim', 'inside-title'] as const;

const [dbPath, rawMode] = process.argv.slice(2);

const mode = MODES.find((candidate) => candidate === rawMode);

if (dbPath === undefined || mode === undefined) {
  throw new Error(`usage: terminal-death-probe.ts <dbPath> <${MODES.join('|')}>`);
}

function die(at: string): never {
  process.stdout.write(`KILLED ${at}\n`);
  // SIGKILL rather than `process.exit`: exit runs teardown and flushes.
  process.kill(process.pid, 'SIGKILL');
  // Unreachable; the signal is delivered synchronously to this process.
  throw new Error('unreachable');
}

const { db, rt } = openTerminalWorkspace(dbPath);

await armShadowTrials(rt);

captureTakes(rt, 'root-child');

if (mode === 'inside-claim') {
  // The roster's first row, inside the commit holding the outer claim; installed before the session is built.
  const real: SqlExecutor = rt.storage.sql;

  const cutting: SqlExecutor = <T = unknown>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): T[] => {
    if (query.join('').includes('INSERT INTO terminal_effects')) die('inside-claim');

    return real<T>(query, ...values);
  };

  const storage: { sql: SqlExecutor } = rt.storage;
  storage.sql = cutting;
}

const modelOptions = mode === 'inside-title'
  ? { onGenerate: () => die('inside-title') }
  : {};

const { model } = scriptedModel('the parser is fixed', modelOptions);

const session = new LocalAgentSession({
  rt,
  db,
  model,
  onEvent: (event) => {
    if (mode === 'before-settle' && event.type === 'run-event' && event.event.type === 'run_end') {
      die('before-settle');
    }
  },
});

await session.send('refactor the parser', { id: crypto.randomUUID() });

// The title lane is detached, so `send` resolves before it runs; this is the join a one-shot process makes.
await session.settleBackgroundWork();

// Reached only if the kill point was missed: a fixture defect, so it fails instead of exiting 0.
process.stdout.write('MISSED\n');

process.exit(2);
