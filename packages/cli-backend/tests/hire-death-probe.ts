/**
 * The CLI process a hire-recovery test kills: its root hires a task agent whose turn files its `completed` report, and
 * the process SIGKILLs itself the moment the hire's turn hears the report taken, so no teardown runs.
 * Run as `bun <this file> <stateDir> <projectDir>`; the stdout marker proves the kill point was reached.
 */
import { join } from 'node:path';
import { LocalAgentHost } from '../src/agent-host';
import { openWorkspaceCLI } from '../src/open';
import { HIRE_DEATH_TASK, hireDeathModel, PROBE_LLM } from './hire-death-model';

const [state, project] = process.argv.slice(2);

if (state === undefined || project === undefined) throw new Error('usage: hire-death-probe.ts <stateDir> <projectDir>');

function die(): never {
  process.stdout.write('KILLED after-report\n');
  // SIGKILL rather than `process.exit`: exit runs teardown and flushes.
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

const host = new LocalAgentHost({
  roster: () => [{ name: 'root', cwd: project, workspaceId: 'proj' }],
  dbPath: (name) => join(state, name, 'agent.db'),
  open: async (ref, db, dbPath) => {
    const openConfig = { llm: PROBE_LLM, cwd: ref.cwd };
    const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

    return { rt, openConfig, staticModel: hireDeathModel().model };
  },
});

// The hire's turn ending here means the kill point was missed: a fixture defect, so it fails instead of exiting 0.
const ended = Promise.withResolvers<void>();

host.subscribe((agent, event) => {
  if (agent === 'root') return;

  if (event.type === 'tool-result') die();

  if (event.type === 'turn-end') ended.resolve();
});

const team = await host.team('root');

await team.temporary?.start({ role: 'researcher', roleLabel: 'researcher', task: HIRE_DEATH_TASK, mode: 'build' });

await ended.promise;

process.stdout.write('MISSED\n');

process.exit(2);
