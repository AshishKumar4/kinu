import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { CHAT_SESSION_ID, HeadCapture, localActorDirectory, REAL_CLOCK, sha256Hex, type HeadInput, type HostedActor } from '@kinu.run/core';
import { scratchDir, scriptedTurnModel, workspaceDatabase, admitTestClaim, servedStoresOf } from '@kinu.run/test-utils';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { workspaceHome, type CLIRuntime } from '../src/runtime';
import { LocalAgentHost, type LocalAgentHostOptions } from '../src/agent-host/host';
import { openWorkspaceCLI } from '../src/open';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';

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
  const runtimes = new Map<string, CLIRuntime>();

  try {
    await createWorkspace(seed, { name: 'root', purpose: 'Recover retained work.', home: workspaceHome(seed) });
  } finally {
    seed.close();
  }

  const options: LocalAgentHostOptions = {
    roster: () => [{ name: 'root', cwd: folder, workspaceId: 'recovery' }],
    dbPath: () => dbPath,
    open: async (ref, db, path) => {
      const openConfig = { llm, cwd: folder };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);

      rt.actor.config.setLearning(false);
      runtimes.set(ref.name, rt);

      return { rt, openConfig, staticModel: model };
    },
  };

  return { options, folder, runtimes };
}

function head(id: string): HeadInput {
  return { id, rootId: 'retained-work', parentId: null, depth: 1,
    task: 'Continue retained work.', rationale: 'Continue retained work.', mode: 'build', inheritedContext: [],
    mergeStrategy: 'synthesize', budget: { maxDepth: 0, spawnedAt: Date.now() }, loop: { kind: 'builtin' } };
}

async function interrupted(actor: HostedActor): Promise<void> {
  const context = actor.stores.history.context.current();
  const version = await actor.runtime.identity.scaffold.version();
  const source = await actor.runtime.identity.scaffold.read();

  await admitTestClaim(actor.stores.claims, { runId: 'retained-run', turnId: 'retained-turn', workMode: 'build', context,
    program: { kind: version === 0 ? 'builtin' : 'scaffold', version, digest: version === 0 ? null : sha256Hex(source), build: null } });
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
    expect(node.actor.stores.claims.read('retained-turn')).toMatchObject({ status: 'admitted', outcome: null });
    const shell = node.actor.runtime.shell;

    if (shell === undefined) throw new Error('the re-driven node must have the workspace shell');

    const home = await shell.exec('printf "%s" "$HOME"');

    expect(home).toMatchObject({ exitCode: 0, stdout: process.env.HOME ?? '' });

    const result = await node.infer(head('retained-node'), {
      actor: node.actor, runId: node.runId, stores: servedStoresOf(node.actor.runtime, node.actor.stores.conversationSearch), sources: node.sources, clock: REAL_CLOCK,
      tools: {}, capture: new HeadCapture(), isAborted: () => false,
    });

    expect(result.status).toBe('completed');
  } finally {
    await cold.close();
  }
});

// The cloud drives a head's or a node's run as a delivered run, which keeps its brief and its answer in its own chat; the
// CLI ran the same inference with no chat at all, so a run actor's transcript was empty.
test('a run actor\'s chat holds what it was asked and its answer, as the cloud\'s does', async () => {
  const workspace = await reopenableWorkspace('run-transcript');
  const host = new LocalAgentHost(workspace.options);

  try {
    const owner = await host.acquire('root');
    const node = await owner.hostNode({ nodeId: 'transcribed-node', rootId: 'transcript-work', depth: 1 });

    const result = await node.infer(head('transcribed-node'), {
      actor: node.actor, runId: node.runId, stores: servedStoresOf(node.actor.runtime, node.actor.stores.conversationSearch), sources: node.sources, clock: REAL_CLOCK,
      tools: {}, capture: new HeadCapture(), isAborted: () => false,
    });

    expect(result.status).toBe('completed');

    const chat = node.actor.stores.history.transcript(CHAT_SESSION_ID);
    const said = await Promise.all(chat.entries().map(async (entry) => [entry.role, (await chat.narration(entry.parts)).join('')]));

    expect(said).toEqual([['user', 'Continue retained work.'], ['assistant', 'retained answer']]);
  } finally {
    await host.close();
  }
});

// The cloud retires a run actor once its row is settled, at its next start; the CLI seated its nodes and never retired one.
test('a node whose row has settled is retired at the next start, as the cloud retires it; one still running is kept', async () => {
  const workspace = await reopenableWorkspace('node-reclaim');
  const first = new LocalAgentHost(workspace.options);
  const owner = await first.acquire('root');
  const settled = await owner.hostNode({ nodeId: 'settled-node', rootId: 'reclaim-work', depth: 1 });
  const working = await owner.hostNode({ nodeId: 'working-node', rootId: 'reclaim-work', depth: 1 });
  const root = workspace.runtimes.get('root');

  if (root === undefined) throw new Error('the owner runtime must be open');

  const row = (id: string, status: string) => root.storage.sql`INSERT INTO head_journal
    (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES (${root.actor.actorId}, ${id}, 'reclaim-work', 'reclaim-work', 1, 'Try one way', 'r', ${status}, 1, 'synthesize')`;

  void row('settled-node', 'completed');
  void row('working-node', 'running');

  await interrupted(working.actor);
  await first.close();

  const cold = new LocalAgentHost(workspace.options);

  try {
    await cold.acquire('root');
    const reopened = workspace.runtimes.get('root');

    if (reopened === undefined) throw new Error('the reopened owner runtime must be open');
    const { directory } = localActorDirectory(reopened.actor);

    expect(directory.retained(settled.actor.reference.actorId)?.deletedAt).not.toBeNull();
    expect(directory.retained(working.actor.reference.actorId)?.deletedAt).toBeNull();
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
    expect(branch.actor.stores.claims.read('retained-turn')).toMatchObject({ status: 'admitted', outcome: null });
    await writeText(branch.actor.runtime.storage.vfs, join(workspace.folder, 'retained.txt'), 'retained change\n');

    const result = await branch.infer(head('retained-head'), {
      actor: branch.actor, runId: branch.runId, stores: servedStoresOf(branch.actor.runtime, branch.actor.stores.conversationSearch), sources: branch.sources, clock: REAL_CLOCK,
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

test('a child keeps the inherited loop but edits only its own scaffold, never its parent program', async () => {
  const workspace = await reopenableWorkspace('scaffold-ownership');
  const host = new LocalAgentHost(workspace.options);

  try {
    const owner = await host.acquire('root');
    const parent = workspace.runtimes.get('root');

    if (parent === undefined) throw new Error('the owner runtime must be open');
    const inherited = 'export default async function main() { return "inherited parent loop"; }';

    await writeText(parent.agentStateVfs, `${parent.identity.scaffold.path}.v0`, inherited);
    const node = await owner.hostNode({ nodeId: 'program-node', rootId: 'program-work', depth: 1 });

    expect(await node.actor.runtime.identity.scaffold.read()).toBe(inherited);
    const nodeEdit = 'export default async function main() { return "node edit"; }';
    const nodeVersion = await node.actor.runtime.identity.scaffold.version();

    await writeText(node.actor.runtime.agentStateVfs, `${node.actor.runtime.identity.scaffold.path}.v${nodeVersion}`, nodeEdit);
    expect(await node.actor.runtime.identity.scaffold.read()).toBe(nodeEdit);
    expect(await parent.identity.scaffold.read()).toBe(inherited);
    const branchInput = { ...head('program-head'), loop: { kind: 'inherit' } } satisfies HeadInput;
    const branch = await owner.hostHead(branchInput, new HeadCapture().files);

    expect(await branch.actor.runtime.identity.scaffold.read()).toBe(inherited);
    const headEdit = 'export default async function main() { return "head edit"; }';
    const headVersion = await branch.actor.runtime.identity.scaffold.version();

    await writeText(branch.actor.runtime.agentStateVfs, `${branch.actor.runtime.identity.scaffold.path}.v${headVersion}`, headEdit);
    expect(await branch.actor.runtime.identity.scaffold.read()).toBe(headEdit);
    expect(await parent.identity.scaffold.read()).toBe(inherited);
    await branch.release();
  } finally {
    await host.close();
  }
});

test('a retained child without its owned program bytes names the required local reset and leaves the parent files', async () => {
  const workspace = await reopenableWorkspace('scaffold-reset');
  const first = new LocalAgentHost(workspace.options);
  const owner = await first.acquire('root');
  const node = await owner.hostNode({ nodeId: 'old-program', rootId: 'old-layout', depth: 1 });
  // Its turn outlives the process, so the start's reclaim of settled run actors keeps it.
  await interrupted(node.actor);
  const program = node.actor.runtime.identity.scaffold;
  const version = await program.version();
  const files = node.actor.runtime.agentStateVfs;
  const parent = workspace.runtimes.get('root');

  if (parent === undefined) throw new Error('the owner runtime must be open');
  const before = await parent.identity.scaffold.read();

  await files.unlink(`${program.path}.v${version}`);
  await first.close();
  const cold = new LocalAgentHost(workspace.options);

  try {
    const reopened = await cold.acquire('root');
    const result = await Promise.allSettled([reopened.hostNode({ nodeId: 'old-program', rootId: 'old-layout', depth: 1 })]);

    expect(result).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'unsupported', message: expect.stringContaining('reset') }) }]);
    expect(await workspace.runtimes.get('root')?.identity.scaffold.read()).toBe(before);
  } finally {
    await cold.close();
  }
});

test('refusing a head layout happens before it can leave an observer on the parent workspace', async () => {
  const workspace = await reopenableWorkspace('head-observer-refusal');
  const first = new LocalAgentHost(workspace.options);
  const owner = await first.acquire('root');
  const branch = await owner.hostHead(head('invalid-head-layout'), new HeadCapture().files);
  // Its turn outlives the process, so the start's reclaim of settled run actors keeps it.
  await interrupted(branch.actor);
  const actorId = branch.actor.reference.actorId;
  const program = branch.actor.runtime.identity.scaffold;
  const version = await program.version();
  const state = branch.actor.runtime.agentStateVfs;

  await state.unlink(`${program.path}.v${version}`);
  await first.close();
  const cold = new LocalAgentHost(workspace.options);

  try {
    const reopened = await cold.acquire('root');
    const leaked = new HeadCapture();
    const admission = await Promise.allSettled([reopened.hostHead(head('invalid-head-layout'), leaked.files)]);

    expect(admission).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'unsupported' }) }]);
    const parent = workspace.runtimes.get('root');

    if (parent === undefined) throw new Error('the owner runtime must be open');

    await writeText(parent.plane.composite.as(CRED_SESSION_USER, actorId), join(workspace.folder, 'after-refusal.txt'), 'parent work\n');
    expect(leaked.files.snapshot()).toEqual([]);
  } finally {
    await cold.close();
  }
});
