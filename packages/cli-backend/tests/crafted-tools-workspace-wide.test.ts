// Crafted tools are workspace-wide (`crafted_tools` has no actor): a node's `eval` reads main's rows and scores, as on
// cf (workerd/agent-facet.test.ts). The node is seated, and its `eval` built, the way the session's swarm does.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initWorkspaceSchema, toolsInWorkMode, type JsonValue, type LLMProviderConfig } from '@kinu.run/core';
import { scratchDir, scratchPath, toolExecute } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { hostedCodemodeTool } from '../src/head-runtime';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

describe('a crafted tool belongs to the workspace', () => {
  test("a tool main crafted is callable from a swarm node's eval, and main's score retires it there too", async () => {
    const db = new Database(scratchPath('crafted-workspace-wide', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { llm: DUMMY_LLM });

    const session = new LocalAgentSession({
      rt, db, model: new TestLanguageModelV2(), noAutoEvolve: true, cwd: scratchDir('crafted-workspace-wide'), onEvent: () => {},
    });

    try {
      rt.craftStore.create({ name: 'double', description: 'doubles a number', code: 'async (n) => n * 2' });
      const seat = await session.hostNode({ nodeId: 'crafted-node', rootId: 'crafted-swarm', depth: 1 });
      const nodeEval = toolsInWorkMode('build', { eval: hostedCodemodeTool(seat.actor, [])({}) }).eval;

      if (nodeEval === undefined) throw new Error('the node has no eval');
      const call = () => toolExecute<{ code: string }, { result: JsonValue }>(nodeEval)({ code: 'return await tools.double(21);' });

      expect(await call()).toMatchObject({ result: 42 });
      db.run("UPDATE crafted_tools SET score = 0.01, uses = 9, last_used_at = ? WHERE name = 'double'", [Date.now()]);
      await expect(call()).rejects.toThrow('tools.double is not a function');
    } finally {
      await session.end();
      db.close();
    }
  });
});
