/**
 * The CLI process a report-recovery test kills: its root hires a task agent that answers in words alone, so what its
 * turn's end owes the hirer is reported after the answer commits, and the process SIGKILLs itself the moment the
 * hire's turn ends, so no teardown runs and nothing it still owed runs here. The stdout marker says whether the hirer
 * had heard the report by then.
 * Run as `bun <this file> <stateDir> <projectDir>`.
 */
import { join } from 'node:path';
import { LocalAgentHost } from '../src/agent-host';
import { openWorkspaceCLI } from '../src/open';
import { ANSWERING_HIRE_TASK, answeringHireModel, PROBE_LLM } from './hire-death-model';

const [state, project] = process.argv.slice(2);

if (state === undefined || project === undefined) throw new Error('usage: hire-end-death-probe.ts <stateDir> <projectDir>');

const host = new LocalAgentHost({
  roster: () => [{ name: 'root', cwd: project, workspaceId: 'proj' }],
  dbPath: (name) => join(state, name, 'agent.db'),
  open: async (ref, db, dbPath) => {
    const openConfig = { llm: PROBE_LLM, cwd: ref.cwd };
    const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

    return { rt, openConfig, staticModel: answeringHireModel().model };
  },
});

let heard = false;

// The hirer's turn the report opens ending here means the kill point was missed: a fixture defect, so it fails instead of
// exiting 0.
const missed = Promise.withResolvers<void>();

host.subscribe((agent, event) => {
  if (agent === 'root') {
    // The report opens the hirer's next turn.
    if (event.type === 'turn-start') heard = true;

    if (event.type === 'turn-end' && heard) missed.resolve();

    return;
  }

  if (event.type !== 'turn-end') return;
  process.stdout.write(`KILLED after-commit ${heard ? 'heard' : 'unheard'}\n`);
  // SIGKILL rather than `process.exit`: exit runs teardown and flushes.
  process.kill(process.pid, 'SIGKILL');
});

const team = await host.team('root');

await team.temporary?.start({ role: 'researcher', roleLabel: 'researcher', task: ANSWERING_HIRE_TASK, mode: 'build' });

await missed.promise;

process.stdout.write('MISSED\n');

process.exit(2);
