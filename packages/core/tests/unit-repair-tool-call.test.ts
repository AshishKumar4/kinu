import { describe, expect, test } from 'bun:test';
import { InvalidToolInputError, NoSuchToolError, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { repairToolCall } from '../src/tools/repair-tool-call';

const tools = {
  read_file: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => 'ok' }),
  Read_File: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => 'ok' }),
  write_file: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => 'ok' }),
};

const messages: ModelMessage[] = [];

const call = (toolName: string, input: string) => ({ type: 'tool-call' as const, toolCallId: 'c1', toolName, input });

const invalid = (toolName: string, input: string) => new InvalidToolInputError({ toolName, toolInput: input, cause: new Error('x') });

const repair = repairToolCall<typeof tools>();

const run = (toolName: string, input: string, error: InvalidToolInputError | NoSuchToolError) =>
  repair({ toolCall: call(toolName, input), tools, error, system: undefined, messages, inputSchema: async () => ({}) });

describe('the deterministic tool-call repair', () => {
  test('a case-only name drift is renamed when exactly one tool matches', async () => {
    await expect(run('WRITE_FILE', '{"path":"a"}', new NoSuchToolError({ toolName: 'WRITE_FILE' })))
      .resolves.toMatchObject({ toolName: 'write_file', input: '{"path":"a"}' });
    // Two tools that differ only by case: choosing is a call the model did not make.
    await expect(run('READ_FILE', '{}', new NoSuchToolError({ toolName: 'READ_FILE' }))).resolves.toBeNull();
    await expect(run('rm', '{}', new NoSuchToolError({ toolName: 'rm' }))).resolves.toBeNull();
  });

  test('fenced, double-encoded and wrapper-keyed arguments settle to the object', async () => {
    const fenced = '```json\n{"path":"a"}\n```';
    await expect(run('write_file', fenced, invalid('write_file', fenced))).resolves.toMatchObject({ input: '{"path":"a"}' });
    const twice = JSON.stringify('{"path":"a"}');
    await expect(run('write_file', twice, invalid('write_file', twice))).resolves.toMatchObject({ input: '{"path":"a"}' });
    await expect(run('write_file', '{"input":{"path":"a"}}', invalid('write_file', ''))).resolves.toMatchObject({ input: '{"path":"a"}' });
  });

  test('an input no rewrite settles, or already well-formed, is left to the model', async () => {
    await expect(run('write_file', '{"path": 1', invalid('write_file', ''))).resolves.toBeNull();
    await expect(run('write_file', '[1,2]', invalid('write_file', ''))).resolves.toBeNull();
    // Well-formed JSON that fails the schema: rewriting it would change the model's claim.
    await expect(run('write_file', '{"path":1}', invalid('write_file', ''))).resolves.toBeNull();
  });
});
