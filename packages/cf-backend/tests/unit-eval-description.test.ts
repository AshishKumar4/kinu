/**
 * Eval's description lists each namespace with what it is for and its members' call forms, and a program reads a full
 * declaration on demand with `describe`, as Codex code mode leaves declarations out of its description: they were half
 * the text of every request (4.0K of eval's tokens).
 */
import { expect, test } from 'bun:test';
import type { Tool } from 'ai';
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

/** The text the model reads: a description is a string on every tool core builds. */
const described = (tool: Tool): string => (typeof tool.description === 'string' ? tool.description : '');

test("eval lists a namespace's members as call forms, and a program reads one's declaration with describe", async () => {
  const program = await evalTool();
  const run = toolExecute<{ code: string }, { result: JsonValue }>(program);
  const { result } = await run({ code: "// read state's declarations\nreturn [describe('state.get'), describe('state')]" });
  const description = described(program);
  const [member, namespace] = v.parse(v.tuple([v.string(), v.string()]), result);

  expect({
    listed: description.split('\n').includes('- state: Values your programs keep from one run to the next. get(key), set(key, value), delete(key), list({ prefix })'),
    declaredInline: description.includes('declare const'),
    member: member.endsWith('\nget(key: string): Promise<JsonValue | Refusal>;'),
    namespace: [namespace.startsWith('declare const state: {\n'), namespace.includes('  list(options?: { prefix?: string; }): Promise<string[] | Refusal>;\n'), namespace.endsWith('\n};')],
  }).toEqual({ listed: true, declaredInline: false, member: true, namespace: [true, true, true] });
});

test('describe names the namespaces it has when asked for one it does not', async () => {
  const run = toolExecute<{ code: string }, JsonValue>(await evalTool());

  await expect(run({ code: "return describe('stat')" })).rejects.toThrow(/describe: nothing is named "stat"; namespaces: Refusal, state, /u);
});
