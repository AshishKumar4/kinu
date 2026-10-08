import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * A workspace's home is `/home/main`, seeded by Nimbus from HOME (it keeps no /home/user), and root owns `/home`.
 * Slates are shared at `/slates`, where every agent makes and changes them.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER, type SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import {
  SESSION_UID, agentCred, agentIdentity, provisionAgentHome, actorHomeName } from '../src/vfs/agent-home';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';
import { inlineWorkspaceStorage } from '../src/identity/inline-primitives';

const SOUL = 'I keep this workspace small and proven.\n';

const workspaceSql = (database: Database): SqlDatabase => inlineWorkspaceStorage(database).sql;

const transactions = (database: Database) => inlineWorkspaceStorage(database).transactions;

/** Nimbus's own boot of the stored workspace, before Kinu settles its layout. */
async function substrate(database: Database) {
  const workspace = await NimbusWorkspace.create({
    sql: workspaceSql(database), transactions: transactions(database), generation: 1_000, cwd: '/home/main', env: { HOME: '/home/main' },
  });

  return { kernel: workspace.vfs.as(CRED_KERNEL), user: workspace.vfs.as(CRED_SESSION_USER) };
}

/** One Kinu boot of the workspace stored in `database`. */
async function boot(database: Database) {
  const sql = workspaceSql(database);
  const bundle = createWorkspace({ sql, transactions: transactions(database), generation: workspaceGenerationStorage(sql) });
  const session = await bundle.session();

  return { bundle, kernel: session.vfs.as(CRED_KERNEL), user: session.vfs.as(CRED_SESSION_USER) };
}

/** Files in the home Nimbus seeded, before Kinu initializes its layout. */
async function nimbusSeededWorkspace(): Promise<Database> {
  const database = new Database(':memory:');
  const { kernel, user } = await substrate(database);

  kernel.writeFile('/home/main/SOUL.md', SOUL);
  kernel.chmod('/home/main/SOUL.md', 0o444);
  user.mkdir('/home/main/slates/queue', { recursive: true });
  user.writeFile('/home/main/slates/queue/package.json', '{"name":"queue"}');
  user.writeFile('/home/main/notes.md', '# coupon regression\n');
  user.mkdir('/home/main/data/2026', { recursive: true });
  user.writeFile('/home/main/data/2026/rows.csv', 'id,kind\n1,percent\n');

  return database;
}



describe('a new workspace', () => {
  test('has /home/main and no /home/user', async () => {
    const { kernel, bundle } = await boot(new Database(':memory:'));

    expect(kernel.readdir('/home').map((entry) => entry.name)).toEqual(['main']);
    await writeText(bundle.vfs, 'notes.md', 'fresh');
    expect(kernel.readFileString('/home/main/notes.md')).toBe('fresh');
  });
});

describe('/home', () => {
  test("a workspace whose /home an agent came to own takes it back on its next boot", async () => {
    const database = new Database(':memory:');
    const settled = await boot(database);
    // As a boot before this one left it.
    settled.kernel.chown('/home', SESSION_UID, SESSION_UID);

    const { kernel } = await boot(database);

    expect(kernel.stat('/home')).toMatchObject({ uid: 0, gid: 0 });
  });
});

describe('a subagent', () => {
  test('keeps its own home at /home/<name>, beside the main agent\'s', async () => {
    const database = await nimbusSeededWorkspace();
    const { kernel } = await boot(database);
    const name = actorHomeName({ origin: 'agent', name: 'reviewer', storageKey: 'reviewer' });

    const home = provisionAgentHome(kernel, name, agentIdentity(workspaceSql(database), name));

    expect(home).toBe('/home/reviewer');
    expect(kernel.readdir('/home').map((entry) => entry.name).sort((a, b) => a.localeCompare(b))).toEqual(['main', 'reviewer']);
  });
});

/** One boot with an agent hired into the workspace, and the plane as each credential reaches it. */
async function withHire(database: Database) {
  const { bundle, kernel, user } = await boot(database);
  const agent = actorHomeName({ origin: 'agent', name: 'builder', storageKey: 'builder' });
  const identity = agentIdentity(workspaceSql(database), agent);
  const home = provisionAgentHome(kernel, agent, identity);
  const builder = (await bundle.session()).vfs.as(agentCred(identity));

  return { kernel, user, builder, home };
}

describe('slates', () => {
  test('a hired agent makes a slate at /slates, and the main agent and it each change the other\'s', async () => {
    const { kernel, user, builder, home } = await withHire(await nimbusSeededWorkspace());

    builder.mkdir('/slates/widgets/src', { recursive: true });
    builder.writeFile('/slates/widgets/package.json', '{"name":"widgets"}');
    // Past one storage transaction, so the substrate stages it rather than writing one batch.
    builder.writeFile('/slates/widgets/src/atlas.bin', new Uint8Array(3 * 1024 * 1024).fill(7));
    user.writeFile('/slates/widgets/package.json', '{"name":"widgets","title":"Widgets"}');
    user.writeFile('/slates/widgets/src/atlas.bin', new Uint8Array(3 * 1024 * 1024).fill(9));
    builder.writeFile('/slates/queue/package.json', '{"name":"queue","title":"Queue"}');

    expect(kernel.readFileString('/slates/widgets/package.json')).toBe('{"name":"widgets","title":"Widgets"}');
    expect(kernel.readFile('/slates/widgets/src/atlas.bin')[0]).toBe(9);
    expect(kernel.readFileString('/slates/queue/package.json')).toBe('{"name":"queue","title":"Queue"}');
    // Each home is still its own agent's.
    expect(() => builder.writeFile('/home/main/notes.md', 'mine now')).toThrow('EACCES');
    expect(() => user.writeFile(`${home}/draft.md`, 'mine now')).toThrow('EACCES');
  });

  test('a slate built in a hired agent\'s home and moved to /slates is shared as if made there', async () => {
    const { kernel, user, builder, home } = await withHire(await nimbusSeededWorkspace());

    builder.mkdir(`${home}/gauges/src`, { recursive: true });
    builder.writeFile(`${home}/gauges/package.json`, '{"name":"gauges"}');
    builder.writeFile(`${home}/gauges/src/app.tsx`, 'export default null;\n');
    builder.rename(`${home}/gauges`, '/slates/gauges');

    user.writeFile('/slates/gauges/src/app.tsx', 'export default () => null;\n');
    user.mkdir('/slates/gauges/assets');
    builder.writeFile('/slates/gauges/assets/logo.svg', '<svg/>');

    expect(kernel.readFileString('/slates/gauges/src/app.tsx')).toBe('export default () => null;\n');
    expect(kernel.readFileString('/slates/gauges/assets/logo.svg')).toBe('<svg/>');
  });

  test('every agent renames and removes a slate, whichever agent made it', async () => {
    const { kernel, user, builder } = await withHire(await nimbusSeededWorkspace());

    builder.mkdir('/slates/widgets/src', { recursive: true });
    builder.writeFile('/slates/widgets/src/app.tsx', 'export default null;\n');
    user.rename('/slates/widgets', '/slates/gadgets');
    builder.rename('/slates/queue', '/slates/backlog');
    user.removeRecursive('/slates/gadgets');
    builder.removeRecursive('/slates/backlog');

    expect(kernel.readdir('/slates')).toEqual([]);
  });

  test('no agent changes who shares /slates, and a /slates an agent made is the workspace\'s on the next boot', async () => {
    const database = await nimbusSeededWorkspace();
    const { kernel, user, builder } = await withHire(database);

    expect(() => user.chmod('/slates', 0o755)).toThrow('EPERM');
    expect(() => builder.chmod('/slates', 0o755)).toThrow('EPERM');

    // As an agent could have made it before /slates was the workspace's: its own, and a slate in it.
    kernel.chown('/slates', SESSION_UID, SESSION_UID);
    kernel.chmod('/slates', 0o755);
    kernel.chmod('/slates/queue', 0o755);
    kernel.chmod('/slates/queue/package.json', 0o644);

    const booted = await withHire(database);

    booted.builder.writeFile('/slates/queue/package.json', '{"name":"queue","title":"Queue"}');
    booted.builder.mkdir('/slates/tracker');
    expect(booted.kernel.readFileString('/slates/queue/package.json')).toBe('{"name":"queue","title":"Queue"}');
  });

  test('a slates move cut short finishes on the next boot', async () => {
    const database = await nimbusSeededWorkspace();
    await boot(database);
    // What a boot that stopped after moving the first slate left behind: the rest still under the old root.
    const { kernel } = await substrate(database);
    kernel.mkdir('/home/main/slates/board', { recursive: true });
    kernel.writeFile('/home/main/slates/board/package.json', '{"name":"board"}');

    for (const path of ['/home/main/slates', '/home/main/slates/board', '/home/main/slates/board/package.json']) {
      kernel.chown(path, SESSION_UID, SESSION_UID);
    }

    const booted = await withHire(database);

    expect(booted.kernel.readdir('/slates').map((entry) => entry.name).sort((a, b) => a.localeCompare(b))).toEqual(['board', 'queue']);
    expect(booted.kernel.exists('/home/main/slates')).toBe(false);
    booted.builder.writeFile('/slates/board/package.json', '{"name":"board","title":"Board"}');
    expect(booted.kernel.readFileString('/slates/board/package.json')).toBe('{"name":"board","title":"Board"}');
  });
});
