/**
 * The CLI process a terminal-transition test kills: it SIGKILLs itself at a named durable instant
 * (`before-settle`, `inside-claim`, `inside-title`, `after-record`, `inside-close`, `mid-cancel`, `mid-program`), so no
 * teardown runs.
 * Run as `bun <this file> <dbPath> <mode>`; the stdout marker proves the kill point was reached.
 */
import type { SqlExecutor, SqlValue, TerminalEffectFault } from '@kinu.run/core';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { LocalAgentSession } from '../src/local-session';
import { DELEGATING_PROGRAM, installProgram, openTerminalWorkspace, scriptedModel } from './terminal-workspace';

const MODES = ['before-settle', 'inside-claim', 'inside-title', 'after-record', 'inside-close', 'mid-cancel', 'mid-program'] as const;

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

if (mode === 'inside-close') {
  // Inside the close, once every effect has run: the outer claim's disposition is written, its rows not yet pruned.
  setDiagnosticsSink({
    event: (name) => { if (name === 'turn.terminal_effects_settled') die('inside-close'); },
    failure: () => undefined,
  });
}

/** The turn's model call has begun and will never answer: the instant a stop lands mid-turn. */
const streaming = Promise.withResolvers<void>();

// The turn runs a promoted program, version 1, and dies inside its model call.
if (mode === 'mid-program') await installProgram(rt, 1, DELEGATING_PROGRAM);

/** Where each mode's model call cuts the process, if it does. */
const MODEL_CUTS: Partial<Record<typeof mode, Parameters<typeof scriptedModel>[1]>> = {
  'inside-title': { onGenerate: () => die('inside-title') },
  'mid-cancel': { onStream: async () => { streaming.resolve(); await Promise.withResolvers<never>().promise; } },
  'mid-program': { onStream: () => die('mid-program') },
};

const modelOptions = MODEL_CUTS[mode] ?? {};

const { model } = scriptedModel('the parser is fixed', modelOptions);

class KillSession extends LocalAgentSession {
  protected override terminalEffectFault: TerminalEffectFault = (phase, name) => {
    if (mode === 'after-record' && phase === 'after' && name === 'turn_record') die('after-record');
  };
}

const session = new KillSession({
  rt,
  db,
  model,
  onEvent: (event) => {
    if (mode === 'before-settle' && event.type === 'run-event' && event.event.type === 'run_end') {
      die('before-settle');
    }
  },
});

if (mode === 'mid-cancel') {
  // Never settles: the process dies first.
  const sent = session.send('refactor the parser', { id: crypto.randomUUID() });
  await Promise.race([sent, streaming.promise]);
  // The owner's stop is acknowledged once this returns; the death comes before the turn has settled anything.
  session.interrupt();
  die('mid-cancel');
}

await session.send('refactor the parser', { id: crypto.randomUUID() });

// The title lane is detached, so `send` resolves before it runs; this is the join a one-shot process makes.
await session.settleBackgroundWork();

// Reached only if the kill point was missed: a fixture defect, so it fails instead of exiting 0.
process.stdout.write('MISSED\n');

process.exit(2);
