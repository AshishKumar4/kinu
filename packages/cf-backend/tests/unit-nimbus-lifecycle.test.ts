import { describe, expect, test } from 'bun:test';
import {
  archiveSqlFromDatabase,
  restoreWorkspaceArchive,
  type ArchiveCursor,
} from '@proteus/core';
import { createInlineWorkspace } from '@proteus/core/identity';
import { Database } from 'bun:sqlite';
import { orchestratorHarness } from './helpers/actor-harness.js';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do.js';
import { createNimbusWorkspaceSandbox } from '../src/nimbus-route.js';
import * as v from 'valibot';

const OWNER = '0123456789abcdef0123456789abcdef';

type Entry = { readonly type: 'file' | 'directory'; readonly bytes?: Uint8Array };
type HarnessAgent = ReturnType<typeof orchestratorHarness>['agent'];
interface SandboxNamespaceProbe {
  idFromName(name: string): string;
  get(): { destroy(): Promise<void> };
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  const bytes = v.safeParse(v.instance(Uint8Array), content);
  if (bytes.success) return bytes.output.slice();
  return new TextEncoder().encode(v.parse(v.string(), content));
}

class MemoryNimbusNamespace {
  readonly events: string[] = [];
  private readonly sessions = new Map<string, Map<string, Entry>>();

  idFromName(name: string): string { return name; }

  get(id: string) {
    const session = (): Map<string, Entry> => {
      let entries = this.sessions.get(id);
      if (!entries) {
        entries = new Map([['/home/user', { type: 'directory' }]]);
        this.sessions.set(id, entries);
      }
      return entries;
    };
    return {
      _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
      _rpcWriteFile: async (path: string, content: string | Uint8Array) => {
        session().set(path, { type: 'file', bytes: contentBytes(content) });
      },
      _rpcWriteProtectedRootFile: async (
        rootPath: string,
        path: string,
        content: string | Uint8Array,
      ) => {
        expect(rootPath).toBe('/home/user');
        expect(path).toBe('/home/user/SOUL.md');
        session().set(path, { type: 'file', bytes: contentBytes(content) });
        this.events.push('nimbus.soul.write');
      },
      _rpcReadFileBytes: async (path: string) => session().get(path)?.bytes?.slice() ?? null,
      _rpcReaddir: async (path: string) => {
        const prefix = `${path.replace(/\/$/, '')}/`;
        const children = new Map<string, 'file' | 'directory'>();
        for (const [entryPath, entry] of session()) {
          if (!entryPath.startsWith(prefix)) continue;
          const rest = entryPath.slice(prefix.length);
          if (!rest) continue;
          const [name, ...tail] = rest.split('/');
          if (!name) continue;
          children.set(name, tail.length > 0 ? 'directory' : entry.type);
        }
        return [...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name, type }));
      },
      _rpcMkdir: async (path: string) => { session().set(path, { type: 'directory' }); },
      _rpcDestroy: async () => {
        this.events.push('nimbus.destroy');
        this.sessions.delete(id);
        return { ok: true as const, killed: 0, destroyedAt: Date.now(), reason: null };
      },
    };
  }
}

function actorEnvironment(agent: HarnessAgent): object {
  const environment = Object.getOwnPropertyDescriptor(agent, 'env')?.value;
  if (!v.is(v.object({}), environment)) throw new Error('actor environment is missing');
  return environment;
}

function installNimbus(agent: HarnessAgent, binding: MemoryNimbusNamespace): void {
  if (!Reflect.set(actorEnvironment(agent), 'NIMBUS_SESSION', binding)) {
    throw new Error('failed to install Nimbus binding');
  }
}

function installSandbox(agent: HarnessAgent, binding: SandboxNamespaceProbe): void {
  if (!Reflect.set(actorEnvironment(agent), 'Sandbox', binding)) {
    throw new Error('failed to install Sandbox binding');
  }
}

function nimbusEnvironment(binding: MemoryNimbusNamespace): Env {
  const environment: Partial<Env> = {};
  Object.assign(environment, { NIMBUS_SESSION: binding });
  // SAFETY: this constructed test environment supplies the exact Nimbus
  // binding methods exercised by createNimbusWorkspaceSandbox.
  return environment as Env;
}

async function writeWorkspaceFiles(binding: MemoryNimbusNamespace): Promise<void> {
  const box = createNimbusWorkspaceSandbox(nimbusEnvironment(binding), OWNER, 'harness-actor');
  await box.files.write('/home/user/SOUL.md', '# Project soul\n');
  await box.files.write('/home/user/scaffold/agent.js', 'export default "scaffold";\n');
  await box.files.write('/home/user/memory/project.md', 'remember this\n');
  await box.files.write('/home/user/project/data.bin', new Uint8Array([0, 255, 1, 2]));
}

describe('canonical Nimbus workspace lifecycle', () => {
  test('the owner RPC writes SOUL.md through the protected Nimbus host path', async () => {
    const harness = orchestratorHarness();
    const nimbus = new MemoryNimbusNamespace();
    installNimbus(harness.agent, nimbus);
    harness.db.prepare('UPDATE workspace_identity SET owner_user_id = ?').run(OWNER);

    await harness.agent.setSoul('# Owner identity\n\n## Mission\n\nKeep the workspace coherent.');

    const box = createNimbusWorkspaceSandbox(
      nimbusEnvironment(nimbus),
      OWNER,
      'harness-actor',
    );
    expect(new TextDecoder().decode(await box.files.readBytes('/home/user/SOUL.md') ?? undefined)).toBe(
      '# Owner identity\n\n## Mission\n\nKeep the workspace coherent.',
    );
    expect(nimbus.events).toEqual(['nimbus.soul.write']);
    expect(harness.db.prepare('SELECT mission FROM workspace_identity').get()).toEqual({
      mission: 'Keep the workspace coherent.',
    });
    harness.db.close();
  });

  test('destroying a workspace tears down external planes before actor storage and same-name recreation is fresh', async () => {
    const harness = orchestratorHarness();
    const nimbus = new MemoryNimbusNamespace();
    installNimbus(harness.agent, nimbus);
    harness.db.prepare('UPDATE workspace_identity SET owner_user_id = ?').run(OWNER);
    await writeWorkspaceFiles(nimbus);

    installSandbox(harness.agent, {
      idFromName: (name: string) => name,
      get: () => ({ async destroy() { nimbus.events.push('sandbox.destroy'); } }),
    });
    Object.defineProperty(harness.agent, 'destroy', {
      value: async () => { nimbus.events.push('actor.destroy'); },
    });
    await harness.agent.destroyAgent(OWNER);

    expect(nimbus.events).toEqual(['sandbox.destroy', 'nimbus.destroy', 'actor.destroy']);
    const recreated = createNimbusWorkspaceSandbox(
      nimbusEnvironment(nimbus),
      OWNER,
      'harness-actor',
    );
    expect(await recreated.files.readBytes('/home/user/SOUL.md')).toBeNull();
    harness.db.close();
  });

  test('a Nimbus teardown failure preserves actor storage and the user registry', async () => {
    const harness = createTestUserDO({ destroyWorkspaceError: 'Nimbus destroy failed' });
    const token = await provisionTestWorkspace(harness, 'doomed');

    await expect(harness.userDO.removeWorkspace(await testOwner(), 'doomed', OWNER))
      .rejects.toThrow('Nimbus destroy failed');

    expect((await harness.userDO.listWorkspaces(await testOwner())).map((row) => row.name)).toContain('doomed');
    expect(await harness.userDO.hasWorkspace({ workspaceToken: token }, 'doomed')).toBe(true);
    harness.close();
  });

  test('a configured Sandbox teardown failure preserves Nimbus files and actor storage', async () => {
    const harness = orchestratorHarness();
    const nimbus = new MemoryNimbusNamespace();
    installNimbus(harness.agent, nimbus);
    harness.db.prepare('UPDATE workspace_identity SET owner_user_id = ?').run(OWNER);
    await writeWorkspaceFiles(nimbus);
    installSandbox(harness.agent, {
      idFromName: (name: string) => name,
      get: () => ({ async destroy() { throw new Error('Sandbox destroy failed'); } }),
    });
    let actorDestroyed = false;
    Object.defineProperty(harness.agent, 'destroy', {
      value: async () => { actorDestroyed = true; },
    });

    await expect(harness.agent.destroyAgent(OWNER)).rejects.toThrow('Sandbox destroy failed');
    expect(nimbus.events).toEqual([]);
    expect(actorDestroyed).toBe(false);
    const preserved = createNimbusWorkspaceSandbox(
      nimbusEnvironment(nimbus),
      OWNER,
      'harness-actor',
    );
    expect(new TextDecoder().decode(await preserved.files.readBytes('/home/user/SOUL.md') ?? undefined))
      .toBe('# Project soul\n');
    harness.db.close();
  });

  test('the public cloud archive exports and restores authoritative Nimbus files byte-exactly', async () => {
    const harness = orchestratorHarness();
    const nimbus = new MemoryNimbusNamespace();
    installNimbus(harness.agent, nimbus);
    harness.db.prepare('UPDATE workspace_identity SET owner_user_id = ?').run(OWNER);
    await writeWorkspaceFiles(nimbus);

    const lines: string[] = [];
    let cursor: ArchiveCursor | undefined;
    do {
      const page = await harness.agent.exportWorkspaceArchive(cursor);
      lines.push(...page.lines);
      cursor = page.next ?? undefined;
    } while (cursor);

    const targetDb = new Database(':memory:');
    const targetFiles = createInlineWorkspace(targetDb).vfs;
    const restored = await restoreWorkspaceArchive(archiveSqlFromDatabase(targetDb), lines, {
      files: () => targetFiles,
    });
    const vfs = targetFiles;
    expect(restored.files).toBe(4);
    expect(await vfs.readFile('SOUL.md', { encoding: 'utf8' })).toBe('# Project soul\n');
    expect(await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toBe('export default "scaffold";\n');
    expect(await vfs.readFile('memory/project.md', { encoding: 'utf8' })).toBe('remember this\n');
    expect(await vfs.readFile('project/data.bin')).toEqual(new Uint8Array([0, 255, 1, 2]));
    targetDb.close();
    harness.db.close();
  });
});
