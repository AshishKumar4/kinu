// A measured session's turn stays Build but runs behind the inert boundary: its reads run against the folder, and a
// write or a command never runs, kept as what the agent meant to do.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { scratchDir, scratchPath, scriptedTurnModel, workspaceDatabase } from '@kinu.run/test-utils';
import { initWorkspaceSchema, type JsonObject, type LLMProviderConfig, type ToolBoundary } from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/** The turn's tool calls in order, then an answer; every tool result the model was shown, by call. */
function scripted(calls: readonly { readonly name: string; readonly input: JsonObject }[]) {
  const shown: string[] = [];
  let at = 0;

  const model = scriptedTurnModel({ doGenerate: async (options) => {
    const finish = (unified: 'stop' | 'tool-calls') => ({ unified, raw: undefined });

    if ((options.tools ?? []).length === 0) return { content: [{ type: 'text' as const, text: '-' }], finishReason: finish('stop'), usage: USAGE, warnings: [] };
    shown.push(JSON.stringify(options.prompt.at(-1)?.content ?? null));
    const call = calls[at];
    at += 1;

    if (call === undefined) return { content: [{ type: 'text' as const, text: 'done' }], finishReason: finish('stop'), usage: USAGE, warnings: [] };

    return {
      content: [{ type: 'tool-call' as const, toolCallId: `call-${String(at)}`, toolName: call.name, input: JSON.stringify(call.input) }],
      finishReason: finish('tool-calls'), usage: USAGE, warnings: [],
    };
  } });

  return { model, shown };
}

describe('a measured session', () => {
  test('a file read runs; a file write and a shell command are kept from running and recorded', async () => {
    const folder = scratchDir('measured-folder');
    writeFileSync(join(folder, 'README.md'), '# the project\n');
    const db = workspaceDatabase(scratchPath('measured-boundary', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { cwd: folder, llm: DUMMY_LLM });
    rt.actor.config.setLearning(false);
    const intended: Parameters<ToolBoundary['intended']>[0][] = [];

    const { model, shown } = scripted([
      { name: 'file', input: { op: 'read', path: 'README.md' } },
      { name: 'file', input: { op: 'write', path: 'notes.md', content: 'written' } },
      { name: 'shell', input: { command: 'touch made-by-shell' } },
    ]);

    const agent = new LocalAgentSession({ rt, db, model, onEvent: () => {}, boundary: { intended: (call) => { intended.push(call); } } });

    try {
      await agent.send('read the readme, then take notes', { id: crypto.randomUUID() });

      expect(shown[1]).toContain('the project');
      expect(shown.slice(2).every((result) => result.includes('Not run'))).toBe(true);
      expect(existsSync(join(folder, 'notes.md'))).toBe(false);
      expect(existsSync(join(folder, 'made-by-shell'))).toBe(false);
      expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# the project\n');
      expect(intended.map((call) => [call.name, call.input])).toEqual([
        ['file', { op: 'write', path: 'notes.md', content: 'written' }],
        ['shell', { command: 'touch made-by-shell' }],
      ]);
    } finally {
      await agent.end();
      db.close();
    }
  });
});
