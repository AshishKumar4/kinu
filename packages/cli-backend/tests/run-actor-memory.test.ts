/**
 * A swarm node's turn reads its MEMORY.md as every turn does (core turn-assembly reads it once and hands it to the step's
 * dynamic context), on this machine as in the cloud: the local run actors took the read and dropped it.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { appendMemoryNote, HeadCapture, REAL_CLOCK, type HeadInput } from '@kinu.run/core';
import { scratchDir, scriptedTurnModel, workspaceDatabase, servedStoresOf } from '@kinu.run/test-utils';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { workspaceHome } from '../src/runtime';
import { LocalAgentHost } from '../src/agent-host/host';
import { openWorkspaceCLI } from '../src/open';

const NOTE = 'Staging takes its migration before the deploy.';

test("a local swarm node's turn carries its MEMORY.md into the model's context", async () => {
  const prompts: string[] = [];

  const model = scriptedTurnModel({ doGenerate: (options) => {
    prompts.push(JSON.stringify(options.prompt));

    return {
      content: [{ type: 'text' as const, text: 'done' }], finishReason: { unified: 'stop' as const, raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
  } });

  const space = scratchDir('node-memory-space');
  const folder = scratchDir('node-memory-folder');
  const dbPath = join(space, 'agent.db');
  const seed = workspaceDatabase(dbPath);

  try {
    await createWorkspace(seed, { name: 'root', purpose: 'Keep the api Worker deployed.', home: workspaceHome(seed) });
  } finally {
    seed.close();
  }

  const host = new LocalAgentHost({
    roster: () => [{ name: 'root', cwd: folder, workspaceId: 'node-memory' }],
    dbPath: () => dbPath,
    open: async (_ref, db, path) => {
      const openConfig = { llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'scripted' }, cwd: folder };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);

      rt.actor.config.setLearning(false);

      return { rt, openConfig, staticModel: model };
    },
  });

  try {
    const owner = await host.acquire('root');
    const node = await owner.hostNode({ nodeId: 'memory-node', rootId: 'memory-run', depth: 1 });

    await appendMemoryNote(node.actor.runtime.memory, NOTE);

    const input: HeadInput = { id: 'memory-node', rootId: 'memory-run', parentId: null, depth: 1, task: 'Deploy the fix.', rationale: 'Deploy the fix.',
      mode: 'build', inheritedContext: [], mergeStrategy: 'synthesize', budget: { maxDepth: 0, spawnedAt: Date.now() }, loop: { kind: 'builtin' } };

    const result = await node.infer(input, {
      actor: node.actor, runId: node.runId, stores: servedStoresOf(node.actor.runtime, node.actor.stores.conversationSearch), sources: node.sources, clock: REAL_CLOCK,
      tools: {}, capture: new HeadCapture(), isAborted: () => false,
    });

    expect(result.status).toBe('completed');
    expect(prompts.some((prompt) => prompt.includes(NOTE))).toBe(true);
  } finally {
    await host.close();
  }
});
