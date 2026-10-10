import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { HeadCapture, REAL_CLOCK, type HeadInput, type HostedActor } from '@kinu.run/core';
import { scratchDir, scriptedTurnModel, workspaceDatabase } from '@kinu.run/test-utils';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { workspaceHome } from '../src/runtime';
import { LocalAgentHost, type LocalAgentHostOptions } from '../src/agent-host/host';
import { openWorkspaceCLI } from '../src/open';

const model = scriptedTurnModel({ doGenerate: () => ({
  content: [{ type: 'text', text: 'retained answer' }], finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
}) });

async function reopenableWorkspace(label: string) {
  const space = scratchDir(`${label}-space`);
  const folder = scratchDir(`${label}-folder`);
  const dbPath = join(space, 'agent.db');
  const seed = workspaceDatabase(dbPath);
  const llm = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'retained' };

  try {
    await createWorkspace(seed, { name: 'root', purpose: 'Recover retained work.', llm, home: workspaceHome(seed) });
  } finally {
    seed.close();
  }

  const options: LocalAgentHostOptions = {
    roster: () => [{ name: 'root', cwd: folder, workspaceId: 'recovery' }],
    dbPath: () => dbPath,
    open: async (_ref, db, path) => {
      const openConfig = { llm, cwd: folder };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);

      rt.actor.config.setLearning(false);

      return { rt, openConfig, staticModel: model };
    },
  };

  return { options, folder };
}

function head(id: string): HeadInput {
  return { id, rootId: 'retained-work', parentId: null, depth: 1,
    task: 'Continue retained work.', rationale: 'Continue retained work.', mode: 'build', inheritedContext: [],
    mergeStrategy: 'synthesize', budget: { maxDepth: 0, spawnedAt: Date.now() }, loop: { kind: 'builtin' } };
}

async function interrupted(actor: HostedActor): Promise<void> {
  const context = actor.stores.history.context.selected() ?? actor.stores.history.context.initialize();

  await actor.stores.claims.admit({ runId: 'retained-run', turnId: 'retained-turn', workMode: 'build', context,
    program: { kind: 'builtin', version: 0, digest: null, build: null } });
}

test('startup claim recovery leaves a restarted node available to re-drive on the workspace runtime', async () => {
  const workspace = await reopenableWorkspace('node-recovery');
  const first = new LocalAgentHost(workspace.options);
  const owner = await first.acquire('root');
  const seat = await owner.hostNode({ nodeId: 'retained-node', rootId: 'retained-work', depth: 1 });
  await interrupted(seat.actor);
  await first.close();

  const cold = new LocalAgentHost(workspace.options);

  try {
    const resumed = await cold.acquire('root');
    await resumed.recoverBackgroundJobs();

    const node = await resumed.hostNode({ nodeId: 'retained-node', rootId: 'retained-work', depth: 1 });
    const shell = node.actor.runtime.shell;

    if (shell === undefined) throw new Error('the re-driven node must have the workspace shell');

    const home = await shell.exec('printf "%s" "$HOME"');

    expect(home).toMatchObject({ exitCode: 0, stdout: process.env.HOME ?? '' });

    const result = await node.infer(head('retained-node'), {
      actor: node.actor, runId: node.runId, sources: node.sources, clock: REAL_CLOCK,
      tools: {}, capture: new HeadCapture(), isAborted: () => false,
    });

    expect(result.status).toBe('completed');
  } finally {
    await cold.close();
  }
});

test('startup claim recovery leaves a restarted head available to re-drive with its changed-file capture', async () => {
  const workspace = await reopenableWorkspace('head-recovery');
  const first = new LocalAgentHost(workspace.options);
  const owner = await first.acquire('root');
  const seat = await owner.hostHead(head('retained-head'), new HeadCapture().files);
  await interrupted(seat.actor);
  await first.close();

  const cold = new LocalAgentHost(workspace.options);

  try {
    const resumed = await cold.acquire('root');
    await resumed.recoverBackgroundJobs();

    const capture = new HeadCapture();
    const branch = await resumed.hostHead(head('retained-head'), capture.files);
    await writeText(branch.actor.runtime.storage.vfs, join(workspace.folder, 'retained.txt'), 'retained change\n');

    const result = await branch.infer(head('retained-head'), {
      actor: branch.actor, runId: branch.runId, sources: branch.sources, clock: REAL_CLOCK,
      tools: {}, capture, isAborted: () => false,
    });

    expect(result.status).toBe('completed');
    expect(result.fileChanges).toEqual([{ path: join(workspace.folder, 'retained.txt'), status: 'added', added: 1, removed: 0 }]);
    await branch.release();
  } finally {
    await cold.close();
  }
});

test('in-flight and live acquisition cannot replace a head kind or drop its write observer', async () => {
  const workspace = await reopenableWorkspace('seat-admission');
  const host = new LocalAgentHost(workspace.options);

  try {
    const owner = await host.acquire('root');
    const capture = new HeadCapture();
    const acquiring = owner.hostHead(head('same-actor'), capture.files);
    const pending = await Promise.allSettled([owner.hostNode({ nodeId: 'same-actor', rootId: 'retained-work', depth: 1 })]);

    expect(pending).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'denied' }) }]);

    const branch = await acquiring;

    const replacing = await Promise.allSettled([
      owner.hostNode({ nodeId: 'same-actor', rootId: 'retained-work', depth: 1 }),
      owner.hostHead(head('same-actor'), new HeadCapture().files),
    ]);

    expect(replacing).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'denied' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'denied' }) },
    ]);
    await writeText(branch.actor.runtime.storage.vfs, join(workspace.folder, 'kept.txt'), 'kept\n');
    expect(capture.files.snapshot()).toEqual([{ path: join(workspace.folder, 'kept.txt'), status: 'added', added: 1, removed: 0 }]);
    await branch.release();
  } finally {
    await host.close();
  }
});
