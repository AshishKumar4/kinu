/**
 * The one dispatch outside eval: a caller names `ns.op` and its JSON input, and runs the same record a program's call
 * runs. A tool is reached as `tools.<name>` with its own one-object input; a crafted tool runs its body as a program
 * through the actor's `eval`, the one place it is defined.
 */
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { createTestSql } from '@kinu.run/test-utils';
import { createProgramStateStore, initCodemodeStateTable } from '../src/identity/program-state';
import { providersInWorkMode, runWorkModeInvocation } from '../src/execution/work-mode';
import { createStateCodemodeProvider } from '../src/tools/state-operations';
import { callOperation, codemodeNamespace, listOperations } from '../src/tools/operation-surfaces';
import { defineOperation, serve } from '../src/operations/operation';
import { toolsNamespace, withCraftedToolDeclarations } from '../src/tools/sandbox-contract';

function stateProvider() {
  const { sql, execRaw } = createTestSql();

  initCodemodeStateTable(execRaw);

  return createStateCodemodeProvider(createProgramStateStore(sql, 'caller', () => {}));
}

const CALL = { callId: 'outside-eval' };

describe('callOperation', () => {
  test('runs a namespace operation on its JSON input, as a program would', async () => {
    const providers = [stateProvider()];

    await callOperation(providers, 'state.set', { key: 'draft', value: { lines: 3 } }, CALL);

    expect(await callOperation(providers, 'state.get', { key: 'draft' }, CALL)).toEqual({ value: { lines: 3 } });
  });

  test('refuses an id the caller does not reach, and an input its operation does not take', async () => {
    const providers = [stateProvider()];

    await expect(callOperation(providers, 'state.rename', {}, CALL)).rejects.toMatchObject({ code: 'missing' });
    await expect(callOperation(providers, 'state.get', { name: 'draft' }, CALL)).rejects.toMatchObject({ code: 'bad_input' });
  });

  test('Plan refuses an operation it does not permit, and lists only what it does', async () => {
    const note = (name: string, impact: 'observe' | 'mutate') => serve(defineOperation({
      ns: 'notes', name, help: `${name} a note.`, impact, slate: false, input: v.strictObject({}), output: v.string(),
    }), async () => name);

    const providers = providersInWorkMode('plan', [codemodeNamespace('notes', [note('read', 'observe'), note('write', 'mutate')])]);

    await expect(runWorkModeInvocation('plan', () => callOperation(providers, 'notes.write', {}, CALL))).rejects.toMatchObject({ code: 'denied' });
    expect(await runWorkModeInvocation('plan', () => callOperation(providers, 'notes.read', {}, CALL))).toEqual({ value: 'read' });
    expect(runWorkModeInvocation('plan', () => listOperations(providers)).map(({ id }) => id)).toEqual(['notes.read']);
  });

  test('a tool is one record: a program and a caller outside eval run the same execute on the same object', async () => {
    const seen: unknown[] = [];

    const tools: ToolSet = {
      echo: tool({
        description: 'Echo the words back.',
        inputSchema: jsonSchema<{ words: string }>({ type: 'object', properties: { words: { type: 'string' } }, required: ['words'] }),
        execute: async (input) => {
          seen.push(input);

          return { said: input.words };
        },
      }),
    };

    const namespace = toolsNamespace(tools, undefined);

    expect(await callOperation([namespace], 'tools.echo', { words: 'outside' }, CALL)).toEqual({ value: { said: 'outside' } });
    expect(await namespace.tools.echo?.execute({ words: 'inside' })).toEqual({ said: 'inside' });
    expect(seen).toEqual([{ words: 'outside' }, { words: 'inside' }]);
    expect(listOperations([namespace])).toEqual([{
      id: 'tools.echo', help: 'Echo the words back.', impact: 'execute',
      inputSchema: { type: 'object', properties: { words: { type: 'string' } }, required: ['words'] },
    }]);
  });

  test('a crafted tool runs its body as a program through eval, and shadows a native tool of its name', async () => {
    const programs: string[] = [];

    const sandbox = withCraftedToolDeclarations(tool({
      description: 'Run a program.',
      inputSchema: jsonSchema<{ code: string }>({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }),
      execute: async ({ code }) => {
        programs.push(code);

        return { result: 'LOUD', logs: [] };
      },
    }), () => [{ name: 'shout', description: 'Shout the words.' }]);

    const native = tool({ description: 'A native shout.', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'native' });
    const providers = [toolsNamespace({ eval: sandbox, shout: native }, undefined)];

    expect(await callOperation(providers, 'tools.shout', { words: 'hi' }, CALL)).toEqual({ value: 'LOUD' });
    expect(programs).toEqual(['return await tools["shout"]({"words":"hi"});']);
    expect(listOperations(providers).map(({ id, help }) => ({ id, help }))).toEqual([{ id: 'tools.shout', help: 'Shout the words.' }]);
  });
});
