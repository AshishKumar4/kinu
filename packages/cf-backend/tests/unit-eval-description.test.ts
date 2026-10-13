/**
 * Eval's description lists each namespace with what it is for and its members' call forms, and a program reads a full
 * declaration on demand with `describe`, as Codex code mode leaves declarations out of its description: they were half
 * the text of every request (4.0K of eval's tokens).
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { chatSessionTurns, orchestratorHarness } from './helpers/actor-harness';

async function evalTool() {
  const { agent } = orchestratorHarness();
  await agent.activateActor();
  await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'keep a counter' }] });

  return present(agent.harnessPreparedTools().eval, 'eval');
}

test("eval lists a namespace's members as call forms, and a program reads one's declaration with describe", async () => {
  const program = await evalTool();
  const run = toolExecute<{ code: string }, { result: JsonValue }>(program);
  const { result } = await run({ code: "// read state's declarations\nreturn [describe('state.get'), describe('state')]" });
  const [member, namespace] = v.parse(v.tuple([v.string(), v.string()]), result);

  expect(member).toContain('get');
  expect(namespace).toContain('state');
});

test('describe names the namespaces it has when asked for one it does not', async () => {
  const run = toolExecute<{ code: string }, JsonValue>(await evalTool());

  await expect(run({ code: "return describe('stat')" })).rejects.toThrow('"stat"');
});
