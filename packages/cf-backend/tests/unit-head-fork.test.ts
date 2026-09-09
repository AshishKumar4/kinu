/**
 * Heads are forks of their parent workspace.
 *
 * The production bug this locks down: a head got a freshly-created, empty
 * filesystem on its OWN facet storage, so an agent asked to research a codebase
 * the user had cloned into the workspace spawned heads that could see none of
 * it — and, because the tools were named `sandbox_*`, reported "found nothing"
 * rather than "no access".
 *
 * WHAT THE CUTOVER CHANGED HERE, AND WHAT IT DID NOT. A head is a hosted actor
 * of the workspace it forks: same database, same container, same Nimbus session,
 * same device consent, and the workspace's own file plane keyed by the
 * REGISTERED workspace rather than by the head's own name. So the reads this
 * file exists for are direct now — no `parent` executor, no `workspaceBoxOp`
 * forwarding RPC, no second Durable Object over async RPC.
 *
 * The WRITE half is genuinely different and is asserted as such below rather
 * than preserved: a head is provisioned its own home and its own credential
 * (`hostedHomeKind` answers `'head'`), so it reads the shared tree and writes
 * only its own subtree, exactly as a hired subordinate does. The old
 * expectation — a head writing `/home/user/shared/notes.md` into the canonical
 * tree — describes a facet that shared its parent's uid and no longer holds.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { CRAFT_NEUTRAL_PRIOR, agentHome, agentTmpRoot, headAgentName, parseActorKey } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { installSandboxSdkMock, setSandboxSdk } from './helpers/sandbox-sdk';
import type { CFRuntime } from '../src/runtime';
import * as v from 'valibot';

mockAgentsSdk();

/** The sandbox id the runtime asked for — the observable proof that a head
 *  rides the PARENT workspace's container rather than a fresh one of its own.
 *  Read through an accessor because the reset in the test narrows the binding
 *  itself to `null`, and the assignment that matters happens in the double. */
let requestedSandboxId: string | null = null;
const lastRequestedSandboxId = (): string | null => requestedSandboxId;
/** Restores performed through the handle the runtime built. A head rides a
 *  container it does not own, so this must stay at zero however it is touched. */
let restoresPerformed = 0;
// The suite's double for the container a head rides: the shared stand-in owns
// the module, this file only points it. Reset in `afterAll`, so a later file
// meets the real SDK.
await installSandboxSdkMock();
setSandboxSdk({
  getSandbox: (_ns: NonNullable<Env['Sandbox']>, id: string) => {
    requestedSandboxId = id;
    return {
      ensureReady: async () => {},
      // A command with no caller-set deadline takes the PROCESS lane, so the
      // double has to be able to run one: `exec` here is the SDK's bounded
      // lane and is deliberately not what the handle reaches.
      startProcess: async () => ({
        id: 'p1',
        exitCode: 0,
        waitForExit: async () => ({ exitCode: 0 }),
        getStatus: async () => 'exited',
      }),
      getProcessLogs: async () => ({ stdout: '', stderr: '' }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => ({ content: '', exitCode: 0 }),
      writeFile: async () => ({ exitCode: 0 }),
      listFiles: async () => ({ files: [], exitCode: 0 }),
      deleteFile: async () => ({ exitCode: 0 }),
      exposePort: async () => ({}),
      unexposePort: () => {},
      getExposedPorts: async () => [],
      createBackup: async () => null,
      restoreBackup: async () => { restoresPerformed += 1; },
      // Egress interception is configured before the container can run
      // anything, so every handle-backed operation reaches this. A hosted actor
      // rides the configuration its ROOT installed, so a head configuring the
      // container would be a defect of the same shape as a head deciding its
      // own restore.
      configureEgress: async () => {},
    };
  },
});
afterAll(() => { setSandboxSdk(null); });

// After the sandbox double above, and it has to be after: the harness imports
// the orchestrator at module scope and that graph reaches the sandbox SDK.
const { hostedExplorationHarness, orchestratorHarness } = await import('./helpers/actor-harness');

/**
 * A REAL hosted head over a REAL workspace, with the parent's files already in
 * the canonical tree and the container binding declared.
 *
 * `declareContainerBinding()` BEFORE the head is acquired, because
 * `ActorHostDeps.runtimeFor` memoizes one runtime per handle and
 * `createCFRuntime` gates the whole sandbox handle on `if (env.Sandbox)` — a
 * binding declared afterwards arrives too late for the runtime under test to
 * read it.
 */
async function hostedHead(files: Record<string, string> = {}, id = 'head-1') {
  const workspace = orchestratorHarness();
  workspace.agent.declareContainerBinding();
  for (const [path, content] of Object.entries(files)) {
    const written = await workspace.agent.writeWorkspaceFile({ kind: 'file', path, data: content });
    if (!written.ok) throw new Error(`the fixture could not seed ${path}`);
  }
  const head = await hostedExplorationHarness(workspace, 'head', id);
  /* SAFETY: this backend CONSTRUCTS every hosted runtime with `createCFRuntime`
   * — `ActorHostDeps.runtimeFor` here IS that function, so the value is a
   * CFRuntime at the construction site. Core's `AgentRuntime` narrows the
   * declared return type and never the value, which is why the concrete type
   * has to be recovered rather than inferred. `exploration-hosting.ts`'s
   * `hostHead` and the harness's `observeHostedTaskTools` state the same. */
  const rt = head.actor.runtime as CFRuntime;
  const home = agentHome(headAgentName(parseActorKey(head.actor.record.storageKey).id));
  return { workspace, head, rt, home };
}

/** The workspace plane a head's tools act on. Absent means the fork never
 *  acquired the parent's file plane at all, which is the original defect. */
function workspacePlane(rt: CFRuntime) {
  const provider = rt.executionRouter?.getProvider('workspace');
  if (!provider) throw new Error('the hosted head acquired no workspace execution plane');
  return provider;
}

describe('a head forks its parent workspace', () => {
  test("the canonical workspace's files are readable without a parent executor", async () => {
    const { rt } = await hostedHead({ 'repo/README.md': '# cloned project' });

    const workspace = workspacePlane(rt);
    expect(await workspace.tools.readFile.execute('/home/user/repo/README.md')).toBe('# cloned project');
    // No `parent` executor, and that absence is the fix: the head reads the one
    // workspace tree directly instead of forwarding every operation to another
    // Durable Object over async RPC.
    expect(rt.executionRouter?.listExecutors().map((executor) => executor.name))
      .not.toContain('parent');
  });

  test('the canonical workspace directory listing reaches the head', async () => {
    const { rt } = await hostedHead({ 'repo/src/index.ts': 'x', 'repo/package.json': '{}' });

    const names = v.parse(
      v.array(v.string()),
      await workspacePlane(rt).tools.readdir.execute('/home/user/repo'),
    );
    expect(names.sort()).toEqual(['package.json', 'src']);
  });

  test("searching the workspace is one real shell call in the head's own shell", async () => {
    const { rt, head, home } = await hostedHead({ 'repo/a.ts': 'needle here', 'repo/b.ts': 'nothing' });

    const found = await workspacePlane(rt).tools.exec.execute('grep -rl needle /home/user/repo');
    expect(String(found)).toContain('repo/a.ts');

    // The head's OWN shell, and the identity is the observable: its `$HOME` and
    // `$TMPDIR` are the ones the host provisioned for this actor, not the
    // workspace user's. That is what a per-actor `shellId` buys — the shell
    // state a head accumulates is its own, over a tree it shares.
    const shell = rt.shell;
    if (!shell) throw new Error('a hosted head runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' '))
      .toEqual([home, agentTmpRoot(headAgentName(parseActorKey(head.actor.record.storageKey).id))]);
  });

  test('exec planes are keyed to the PARENT workspace, not the head actor', async () => {
    requestedSandboxId = null;
    const { head } = await hostedHead();

    // The container the workspace works in — `kinu-${workspaceName}` in
    // runtime.ts — and emphatically not one named after the fork. The file
    // plane is keyed by the REGISTERED workspace precisely so a self-named
    // child cannot derive a second, empty filesystem.
    expect(lastRequestedSandboxId()).toBe('kinu-harness-parent');
    expect(lastRequestedSandboxId()).not.toContain(head.actor.record.storageKey);
  });

  test('a head never decides the restore of the container it only rides', async () => {
    restoresPerformed = 0;
    const { rt, head, workspace } = await hostedHead();
    // A backup handle recorded under the HEAD's own actor rows. It is not the
    // shared container's history: `kinu-harness-parent` belongs to the
    // workspace, so acting on it would roll that container back to whatever
    // this head last happened to record.
    workspace.db.prepare("INSERT INTO actor_config (actor_id,key,value) VALUES (?,'workspace_backup',?)")
      .run(head.actor.handle.actorId, JSON.stringify({ id: 'bk-1', dir: '/workspace' }));

    const handle = rt.sandboxHandle;
    if (!handle) throw new Error('a hosted head runtime rides the workspace container');
    await handle.exec('true');
    await handle.exec('true');

    // Zero, and the second touch is what makes it a regression test: with an
    // EMPTY key the old wrapper marked the container restored having restored
    // nothing, one-shot and never retried, so every later call execed against
    // whatever state it found. An actor that cannot mark the container restored
    // cannot mark it falsely.
    expect(restoresPerformed).toBe(0);
  });

  /**
   * The write half, and the one expectation the cutover genuinely reversed.
   *
   * A facet shared its parent's uid on the workspace tree, so a head's write
   * landed in the canonical filesystem and the test here asserted exactly that.
   * A hosted head is provisioned its own home and its own credential — the same
   * `hostedHomeKind` arm a hired subordinate takes — so the shared tree is
   * READ-ONLY to it and its writes go to its own subtree. Asserted as a pair,
   * because a refusal alone would also hold for a head with no file plane at
   * all, which is the original defect wearing a different face.
   */
  test('a head reads the canonical workspace and writes only its own home', async () => {
    const { rt, home, workspace } = await hostedHead({ 'repo/parser.ts': 'one\ntwo\n' });
    const plane = workspacePlane(rt);

    expect(await plane.tools.readFile.execute('/home/user/repo/parser.ts')).toBe('one\ntwo\n');
    // Its own subtree accepts the write, and the WORKSPACE sees it: one tree,
    // one database, a credential boundary inside them.
    await rt.storage.vfs.writeFile(`${home}/notes.md`, 'visible');
    expect(await workspace.agent.readWorkspaceFile(`${home}/notes.md`))
      .toMatchObject({ ok: true });
    // The origin's own tree refuses it.
    await expect(rt.storage.vfs.writeFile('/home/user/repo/parser.ts', 'one\ntwo\nthree\n'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(await workspace.agent.readWorkspaceFile('/home/user/repo/parser.ts'))
      .toMatchObject({ ok: true, value: new TextEncoder().encode('one\ntwo\n') });
  });

  /**
   * A head's SQL ledgers are `actor_id`-scoped rows in the workspace's one
   * database, and `listTools` reads the crafted-tool quality columns ON
   * `crafted_tools` while `createTool` seeds them — so with the memory and
   * craft stores alone a head raised `no such table: crafted_tools` on its
   * first call. Pinned on both backends: the CLI head hit exactly this inside a
   * paid delegation run.
   */
  test("the head's own workspace plane scores the tools it crafts", async () => {
    const { rt } = await hostedHead();
    const plane = workspacePlane(rt);

    expect(await plane.tools.listTools.execute()).toEqual([]);
    expect(await plane.tools.createTool.execute(
      'echo_back', 'Return its argument.', 'async (args) => args',
    )).toEqual({ ok: true, name: 'echo_back', action: 'created' });
    expect(await plane.tools.listTools.execute()).toEqual([
      { name: 'echo_back', description: 'Return its argument.', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });
});

/**
 * FOUR BOOTSTRAP TESTS ARE GONE WITH THE BOOTSTRAP THEY DESCRIBED.
 *
 * They were:
 *   • 'a facet cannot change its registered parent workspace' — `setSharedParent`
 *     was a seed RPC pushed at a fresh facet, and a second call had to be
 *     refused because the facet's parent lived in its own `actor_identity` row.
 *     A hosted head's parent is `workspace_actors.parent_actor_id`, written by
 *     the directory under the parent's authority and re-validated on every
 *     binding, so there is no seed to send twice.
 *   • 'an MCTS branch — seeded without a parent workspace — cannot fork at all'
 *     — `spawnBranchFacet` seeded `setOwner` and nothing else. A branch is a
 *     `'branch'` directory row now and `hostBranch` hands it two model calls;
 *     the containment property is asserted in
 *     unit-exploration-containment.test.ts, which drives `hostBranch` and shows
 *     it acquires no home.
 *   • 'a facet evicted between initHead and runAsHead activates from its stored
 *     row' and 'a stored activation that no longer matches its schema refuses by
 *     name' — both were about `facet_activation`, the durable row a two-RPC
 *     bootstrap needed because the Durable Object could hibernate between
 *     `initHead` and `runAsHead`. `hostHead` takes its `HeadInput` as an
 *     argument and runs in the caller's isolate: there is one call, no window to
 *     hibernate in, and no persisted work spec to re-validate. Recovery of an
 *     interrupted head is a journal question now (`markInterrupted`, and
 *     `ActorHost.resumable` over unsettled claims), which is where it is tested.
 *
 * Each of those refusals was correct for the shape it guarded. Re-pointing them
 * would have meant inventing a seed sequence the backend no longer has.
 */
