/**
 * An agent's edit to its own working context is recorded in its run's events, as the CLI records it: the audit trail
 * of who changed what the model sees does not depend on where the agent runs.
 */
import { expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import { chatSessionTurns, orchestratorHarness } from './helpers/actor-harness';

test("a turn's edit to its working context is a context_edit event of that turn's run", async () => {
  const { agent } = orchestratorHarness();
  agent.harnessDrivingUserMessage('Tidy your context.', { kinuMode: 'build' });
  const tools = (await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Tidy your context.' }] })).tools;
  const fileTool = tools.file;

  if (fileTool === undefined) throw new Error('Build has no file tool');
  const file = toolExecute<JsonValue, JsonValue>(fileTool);
  const working = '/context/working.jsonl';
  const served = await file({ op: 'read', path: working });

  if (typeof served !== 'string' || !served.includes('Tidy your context.')) throw new Error(`the working context read back as ${JSON.stringify(served)}`);
  await file({ op: 'edit', path: working, edits: [{ old_text: 'Tidy your context.', new_text: 'Tidy your context, briefly.' }] });
  await chatSessionTurns(agent).settle({ messageId: 'tidied', text: 'Tidied.', requestId: 'tidied' });

  const run = (await agent.listRuns()).items[0];

  if (run === undefined) throw new Error('the turn produced no run record');
  // Staged by the file write; the turn ends before a further step would activate it.
  expect((await agent.getRunEvents(run.runId)).filter((event) => event.type === 'context_edit')).toEqual([
    expect.objectContaining({ via: 'file', status: 'staged' }),
  ]);
});
