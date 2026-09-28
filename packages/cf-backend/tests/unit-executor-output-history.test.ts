/**
 * The terminal's history after a reload is the newest rows `getExecutorOutput` returns per executor; a row past
 * that window is one no reader reaches, so the store keeps no more than the window.
 */
import { expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

test('the terminal history keeps the newest window per executor and drops what no reload can show', async () => {
  const workspace = orchestratorHarness();
  const commands = Array.from({ length: 52 }, (_, i) => `echo line-${String(i)}`);

  for (const command of commands) await workspace.agent.executeInExecutor('workspace', command);

  const shown = await workspace.agent.getExecutorOutput('workspace');

  expect(shown.map((row) => row.command)).toEqual(commands.slice(2).reverse());
  expect(workspace.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executor_output').get()?.n).toBe(shown.length);
});
