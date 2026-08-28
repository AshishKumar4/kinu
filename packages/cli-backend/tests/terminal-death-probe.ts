/**
 * The CLI process a terminal-transition test kills.
 *
 * The sibling suite restarts by constructing a second session over the SAME live
 * `Database` and `CLIRuntime`, so it cannot observe a death between two
 * synchronous writes, nor state that wrongly survives on the runtime object.
 * This is the real boundary: a child process, over a file-backed workspace, that
 * SIGKILLs ITSELF at a named durable instant. Nothing runs after `SIGKILL` — no
 * `finally`, no flush, no close — which is what an interrupted laptop actually
 * does and what a thrown fault cannot imitate.
 *
 * Three instants, and each is a claim the fix has to answer:
 *
 *   • `before-claim` — the answer and the roster it owes are committed; the
 *     terminal claim is NOT. Killed from the `run_end` run-event, which
 *     `closeTurnRun` emits between the commit and `terminal.settle`. Recovery has
 *     only the intent row to work from, so a workspace that comes back with the
 *     turn recorded proves the intent carried it, and one that comes back empty
 *     is exactly the loss the review named.
 *
 *   • `inside-claim` — INSIDE the commit that claims the transition and writes
 *     the roster, between the outer claim and the first roster row. No event and
 *     no fault hook reaches that instant: it is one synchronous slice, so the
 *     kill hangs off the STATEMENT. A claim that committed without its rows is
 *     read by the next start as a sequence already under way whose roster is
 *     empty — which settles the claim and drops every effect the response owed,
 *     silently, because the resumed branch does not re-declare.
 *
 *   • `inside-title` — INSIDE the `auto_title` body, after the provisional title
 *     is persisted and while the model is being asked to improve on it. The
 *     ledger's fault hook can only cut before or after a whole body; this cuts
 *     through the middle of one, between two of its own durable acts.
 *
 * Run as `bun <this file> <dbPath> <mode>`. The marker line on stdout is what
 * tells the parent the kill point was actually reached rather than the process
 * having died on the way there.
 */
import type { SqlExecutor, SqlValue } from '@kinu.run/core';
import { LocalAgentSession } from '../src/local-session';
import { armShadowTrials, captureTakes, openTerminalWorkspace, scriptedModel } from './terminal-workspace';

const MODES = ['before-claim', 'inside-claim', 'inside-title'] as const;

const [dbPath, rawMode] = process.argv.slice(2);
const mode = MODES.find((candidate) => candidate === rawMode);
if (dbPath === undefined || mode === undefined) {
  throw new Error(`usage: terminal-death-probe.ts <dbPath> <${MODES.join('|')}>`);
}

function die(at: string): never {
  process.stdout.write(`KILLED ${at}\n`);
  // SIGKILL rather than `process.exit`: exit runs teardown and flushes, and the
  // whole subject here is what survives when nothing gets to run.
  process.kill(process.pid, 'SIGKILL');
  // Unreachable; the signal is delivered synchronously to this process.
  throw new Error('unreachable');
}

const { db, rt } = openTerminalWorkspace(dbPath);
await armShadowTrials(rt);
captureTakes(rt, 'root-child', Date.now() + 1_000);

if (mode === 'inside-claim') {
  // The roster's FIRST row, from inside the commit that also holds the outer
  // claim. Installed before the session is built, so every store it opens reads
  // through this executor.
  const real: SqlExecutor = rt.storage.sql;
  const cutting: SqlExecutor = <T = unknown>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): T[] => {
    if (query.join('').includes('INSERT INTO terminal_effects')) die('inside-claim');
    return real<T>(query, ...values);
  };
  // The runtime's storage bag is one plain object with a readonly `sql` seam.
  // Naming the mutable view is the whole of the fixture's reach into it.
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
    // `run_end` is the LAST event `closeTurnRun` emits, and the run seal sits
    // between the durable commit and the terminal claim — so this is the
    // interval the review's first finding is about, observed from production
    // code rather than from a test-only hook.
    if (mode === 'before-claim' && event.type === 'run-event' && event.event.type === 'run_end') {
      die('before-claim');
    }
  },
});

await session.send('refactor the parser');
// The title lane is DETACHED, so `send` resolves before it runs — this is the
// join a real one-shot process makes before it exits, and it is what carries the
// process into the body the `inside-title` cut lands in.
await session.settleBackgroundWork();
// Reached only if the kill point was missed, which is a defect in this fixture
// rather than in the subject — so it says so instead of exiting 0.
process.stdout.write('MISSED\n');
process.exit(2);
