import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Connection } from 'agents';
import { AwaitedList, scriptedTurnModel } from '@kinu.run/test-utils';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import * as v from 'valibot';
import {
  NIMBUS_WORKSPACE_ROOT, TurnContextBudget, WORKSPACE_ROOT, createFileDispatcher, nimbusSessionFiles, settleWorkspaceRoot,
} from '@kinu.run/core';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';
import { TurnFileLedger } from '../../core/src/vfs/file-ledger';
import { mockAgentsSdk } from './helpers/agents-sdk';

// `agents` reaches `cloudflare:email`: mock first, then the harness.
mockAgentsSdk();

const { orchestratorHarness } = await import('./helpers/actor-harness');

import { socketConnection } from './helpers/bindings';

interface AdmissionSocket {
  readonly wire: Connection;
  readonly sent: string[];
  readonly frame: (holds: (sent: readonly string[]) => boolean) => Promise<void>;
}

function connection(agent: { broadcast: (message: string, exclude?: string[]) => void }): AdmissionSocket {
  const frames = new AwaitedList<string>();
  const sent = frames.items;
  const wire = socketConnection({ id: 'soul-conn', send: (data: string) => { frames.push(data); } });
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes('soul-conn')) frames.push(message);
      fanout(message, exclude);
    },
  });

  return { wire, sent, frame: (holds) => frames.until(holds) };
}

function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }) },
  });
}

function doneFrames(sent: readonly string[]): Array<{ id: string }> {
  // Every frame on this socket is JSON the actor wrote; a non-JSON line is a harness failure, not a done frame.
  return sent.flatMap((raw) => {
    const done = v.safeParse(v.object({ type: v.literal('cf_agent_use_chat_response'), id: v.string(), done: v.optional(v.boolean()) }), JSON.parse(raw));

    return done.success && done.output.done === true ? [{ id: done.output.id }] : [];
  });
}

/** A workspace booted as Kinu boots one: Nimbus's default home links to /home/main. */
async function linkedWorkspace(db: Database): Promise<NimbusWorkspace> {
  const workspace = await NimbusWorkspace.create({
    ...inlineWorkspaceStorage(db),
    generation: 1,
    cwd: WORKSPACE_ROOT,
    env: { HOME: WORKSPACE_ROOT },
  });

  settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));

  return workspace;
}

/** Every name a directory lists. */
const namesIn = (vfs: CredentialedVfs, path: string): string[] => vfs.readdir(path).map((entry) => entry.name);

describe('installed Nimbus dependency integrity', () => {
  test('the SDK preserves runtime policy enforcement', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
      }),
    };

    const box = Nimbus.fromEnv(
      { NIMBUS_SESSION: namespace },
      { sandboxes: { default: { runtimes: { allow: ['node'], onDemand: true } } } },
    ).sandbox('patched-sdk');

    await expect(box.runtimes.install('python')).rejects.toThrow(
      "Nimbus runtime 'python' is not allowed",
    );
  });

  test('xargs null mode preserves leading whitespace in the first argument', async () => {
    const db = new Database(':memory:');

    const workspace = await NimbusWorkspace.create({
      ...inlineWorkspaceStorage(db),
      generation: 1,
      cwd: '/home/main',
    });

    const result = await workspace.exec('xargs -0 -n 1 echo', { stdin: ' leading\0second\0' });

    expect(result).toMatchObject({ exitCode: 0, stdout: ' leading\nsecond\n' });
    db.close();
  });

  // Nimbus ask N21, fixed in core 0.13.0: SqliteVFS.readdir keyed its children on the path as given, so a directory
  // reached through a link listed nothing.
  test('the workspace root, reached through the Nimbus home link, lists what the root holds', async () => {
    const db = new Database(':memory:');
    const workspace = await linkedWorkspace(db);

    workspace.vfs.as(CRED_SESSION_USER).writeFile(`${WORKSPACE_ROOT}/flow-probe.txt`, new TextEncoder().encode('probe'));

    const listed = workspace.vfs.as(CRED_SESSION_USER).readdir(NIMBUS_WORKSPACE_ROOT).map((entry) => entry.name);

    const shell = await workspace.exec(`ls ${NIMBUS_WORKSPACE_ROOT}`);

    const file = createFileDispatcher({
      vfs: nimbusSessionFiles({
        files: workspaceBoxFiles(async () => workspace.vfs),
        ready: async () => undefined,
        exec: async () => { throw new Error('the file tool runs no commands'); },
      }, { home: WORKSPACE_ROOT }),
      ledger: new TurnFileLedger(),
      budget: new TurnContextBudget(),
    });

    const tool = v.parse(v.object({ entries: v.array(v.string()) }), await file({ action: 'list', path: NIMBUS_WORKSPACE_ROOT }));

    expect(listed).toContain('flow-probe.txt');
    expect(shell).toMatchObject({ exitCode: 0 });
    expect(shell.stdout.split(/\s+/u)).toContain('flow-probe.txt');
    expect(tool.entries).toContain('flow-probe.txt');
    db.close();
  });

  // Nimbus ask N22, fixed in core 0.13.0: SqliteVFS keyed a new entry on the path as given, so one made through the
  // link landed under the link's own name, where nothing reached through the link finds it; rmdir and revision read
  // that name too. Nimbus's own PATH and XDG defaults still name /home/user.
  describe('through the Nimbus home link, an entry lands where the root holds it', () => {
    test('the file plane writes into a directory that does not exist yet', async () => {
      const db = new Database(':memory:');
      const workspace = await linkedWorkspace(db);

      const plane = nimbusSessionFiles({
        files: workspaceBoxFiles(async () => workspace.vfs),
        ready: async () => undefined,
        exec: async () => { throw new Error('the plane runs no commands'); },
      }, { home: WORKSPACE_ROOT });

      await writeText(plane, `${NIMBUS_WORKSPACE_ROOT}/slates/a/package.json`, '{}');

      expect(workspace.vfs.as(CRED_SESSION_USER).readFileString(`${WORKSPACE_ROOT}/slates/a/package.json`)).toBe('{}');
      db.close();
    });

    test('mkdir makes the directory under the root, listed by both names, recursive or not', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdir(`${NIMBUS_WORKSPACE_ROOT}/a/b`, { recursive: true });
      vfs.mkdir(`${NIMBUS_WORKSPACE_ROOT}/c`);

      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/a/b`)).toBe(true);
      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/c`)).toBe(true);
      expect(namesIn(vfs, `${WORKSPACE_ROOT}/a`)).toEqual(['b']);
      expect(namesIn(vfs, `${NIMBUS_WORKSPACE_ROOT}/a`)).toEqual(['b']);
      db.close();
    });

    test('mkdirBatch makes every missing directory under the root', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdirBatch([`${NIMBUS_WORKSPACE_ROOT}/pkg/lib`]);

      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/pkg/lib`)).toBe(true);
      db.close();
    });

    test('a batch writes, and deletes, where the root holds its paths', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);
      const bytes = new TextEncoder().encode('export {};');
      const at = (path: string) => ({ path, parentPath: path.slice(0, path.lastIndexOf('/')) });

      vfs.writeBatch({
        inodes: [
          { ...at(`${NIMBUS_WORKSPACE_ROOT}/mod`), isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
          { ...at(`${NIMBUS_WORKSPACE_ROOT}/mod/index.js`), isDir: false, size: bytes.length, mtime: 1, mode: 0o644, chunkCount: 1 },
        ],
        chunks: [{ path: `${NIMBUS_WORKSPACE_ROOT}/mod/index.js`, chunkId: 0, data: bytes }],
      });

      expect(vfs.readFileString(`${WORKSPACE_ROOT}/mod/index.js`)).toBe('export {};');

      vfs.writeBatch({ inodes: [], chunks: [], deletePaths: [`${NIMBUS_WORKSPACE_ROOT}/mod/index.js`] });

      expect(vfs.exists(`${WORKSPACE_ROOT}/mod/index.js`)).toBe(false);
      db.close();
    });

    test('a link made through the link lands under the root', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.writeFile(`${WORKSPACE_ROOT}/target.txt`, 'target');
      vfs.symlink(`${WORKSPACE_ROOT}/target.txt`, `${NIMBUS_WORKSPACE_ROOT}/shortcut`);

      expect(vfs.readlink(`${WORKSPACE_ROOT}/shortcut`)).toBe(`${WORKSPACE_ROOT}/target.txt`);
      db.close();
    });

    test('rmdir removes the directory the link reaches', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdir(`${WORKSPACE_ROOT}/emptied`);
      vfs.rmdir(`${NIMBUS_WORKSPACE_ROOT}/emptied`);

      expect(vfs.exists(`${WORKSPACE_ROOT}/emptied`)).toBe(false);
      db.close();
    });

    test('a directory the user may not write stays shut through the link', async () => {
      const db = new Database(':memory:');
      const workspace = await linkedWorkspace(db);
      const kernel = workspace.vfs.as(CRED_KERNEL);
      const vfs = workspace.vfs.as(CRED_SESSION_USER);

      kernel.mkdir(`${WORKSPACE_ROOT}/locked`);
      kernel.chmod(`${WORKSPACE_ROOT}/locked`, 0o555);

      expect(() => vfs.mkdir(`${NIMBUS_WORKSPACE_ROOT}/locked/made`)).toThrow('EACCES');
      expect(() => vfs.mkdirBatch([`${NIMBUS_WORKSPACE_ROOT}/locked/batch/deep`])).toThrow('EACCES');
      expect(() => vfs.writeFile(`${NIMBUS_WORKSPACE_ROOT}/locked/written.txt`, 'x')).toThrow('EACCES');
      expect(namesIn(kernel, `${WORKSPACE_ROOT}/locked`)).toEqual([]);
      db.close();
    });

    test('a revision read through the link moves when the file does', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.writeFile(`${WORKSPACE_ROOT}/watched.txt`, 'one');
      const before = vfs.revision(`${NIMBUS_WORKSPACE_ROOT}/watched.txt`);

      vfs.writeFile(`${WORKSPACE_ROOT}/watched.txt`, 'two');

      expect(vfs.revision(`${NIMBUS_WORKSPACE_ROOT}/watched.txt`)).toBeGreaterThan(before);
      expect(vfs.revision(`${NIMBUS_WORKSPACE_ROOT}/watched.txt`)).toBe(vfs.revision(`${WORKSPACE_ROOT}/watched.txt`));
      db.close();
    });
  });

  // The installed filesystem keeps the main agent at home: the root is 1000:1000 0755, and SOUL.md is a
  // kernel-owned 444 view of the workspace_soul row, resealed from it at every boot and turn start.
  test('a forged SOUL.md never reaches a prompt: the next turn start reseals it from the row', async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    // The root is the main agent's own directory, so its rm and its rewrite land.
    const removed = await agent.execWorkspaceCommand('rm -f /home/main/SOUL.md; echo "exit=$?"');

    expect(removed.stdout.trim()).toBe('exit=0');

    const rewritten = await agent.execWorkspaceCommand('echo rewritten > /home/main/SOUL.md; echo "exit=$?"');

    expect(rewritten.stdout.trim()).toBe('exit=0');

    // The next turn start reseals the file from the row: kernel 444, the owner's bytes.
    agent.harnessSupplyTurnModel(scriptedTurnModel({ doGenerate: () => ({
      content: [{ type: 'text', text: 'noted' }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    }) }));
    const gate = agent.harnessChatGate();
    const { wire, sent, frame } = connection(agent);

    await gate(wire, chatRequest('req-soul', 'hello'));
    await frame((frames) => doneFrames(frames).length > 0);
    expect(doneFrames(sent)).toEqual([{ id: 'req-soul' }]);
    const kept = await agent.execWorkspaceCommand('cat /home/main/SOUL.md; stat -c %a /home/main/SOUL.md');

    expect(kept.stdout).toBe(`${soul}444\n`);

    // Neither the prompt's soul nor the status read ever sees the forged text.
    const status = await agent.getAgentStatus();

    expect(status.soul).toBe(soul);
    expect(status.purpose).toBe('Audit the checkout flow.');
  });

  test("an owner's Drive save of SOUL.md updates the row; a Drive delete is refused", async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    const revised = '# Checkout\n\n## Mission\n\nAudit the refunds flow.';


    const saved = await agent.writeExecutorFileChunk({
      executorId: 'workspace', path: 'SOUL.md', transferId: 'soul-save', offset: 0,
      chunk: new TextEncoder().encode(revised), final: true,
    });

    expect(saved).toEqual({ ok: true });
    expect((await agent.getAgentStatus()).soul).toBe(revised);

    const deleted = await agent.deleteExecutorFile('workspace', 'SOUL.md');

    expect(deleted).toMatchObject({ error: expect.stringContaining('Settings') });
    expect((await agent.getAgentStatus()).soul).toBe(revised);
  });
});
