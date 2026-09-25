/**
 * FEAT-17: the workspace root is `/home/main`. A workspace made when it was `/home/user` boots with its
 * whole tree moved there, and `/home/user` stays a link to it, so an absolute path written before still
 * reaches its file. A new workspace gets the same layout, and a move cut short finishes on the next boot.
 * Slates are the workspace's, at `/slates`, where every agent makes and changes them; they move there too.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type SqlDatabase, type SqlRow, type SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import {
  SESSION_UID, agentCred, agentIdentity, provisionAgentHome, settleWorkspaceRoot, subordinateAgentName, type RootMoveVfs,
} from '../src/vfs/agent-home';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';

const SOUL = 'I keep this workspace small and proven.\n';

function workspaceSql(database: Database): SqlDatabase {
  const binding = (value: SqlValue): SQLQueryBindings => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);

    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

    return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
  };

  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bindings.map(binding));
      statement.run(...bindings.map(binding));

      return [];
    },
  };
}

function transactions(database: Database) {
  return { storage: { transactionSync: <T,>(write: () => T): T => database.transaction(write)() } };
}

/** The substrate alone, as every workspace ran before the move: its tree lives under `/home/user`. */
async function substrate(database: Database) {
  const workspace = await NimbusWorkspace.create({
    sql: workspaceSql(database), transactions: transactions(database), generation: 1_000, cwd: '/home/user',
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

/** A workspace as its agent left it before the move: the agent's files, and SOUL.md kernel-owned. */
async function legacyWorkspace(): Promise<Database> {
  const database = new Database(':memory:');
  const { kernel, user } = await substrate(database);

  kernel.writeFile('/home/user/SOUL.md', SOUL);
  kernel.chmod('/home/user/SOUL.md', 0o444);
  user.mkdir('/home/user/slates/queue', { recursive: true });
  user.writeFile('/home/user/slates/queue/package.json', '{"name":"queue"}');
  user.writeFile('/home/user/notes.md', '# coupon regression\n');
  user.mkdir('/home/user/data/2026', { recursive: true });
  user.writeFile('/home/user/data/2026/rows.csv', 'id,kind\n1,percent\n');

  return database;
}

const utf8 = { encoding: 'utf8' } as const;

describe('a workspace made before the move', () => {
  test('boots with its files and SOUL.md at /home/main, and its slates at /slates', async () => {
    const { kernel } = await boot(await legacyWorkspace());

    expect(kernel.isDirectory('/home/main')).toBe(true);
    expect(kernel.readFileString('/home/main/notes.md')).toBe('# coupon regression\n');
    expect(kernel.readFileString('/slates/queue/package.json')).toBe('{"name":"queue"}');
    // One path: the old one is gone, not a link.
    expect(kernel.exists('/home/main/slates')).toBe(false);
    expect(kernel.readFileString('/home/main/data/2026/rows.csv')).toBe('id,kind\n1,percent\n');
    expect(kernel.readFileString('/home/main/SOUL.md')).toBe(SOUL);
    // Moved, not copied: SOUL.md keeps the kernel ownership that protects it.
    expect(kernel.stat('/home/main/SOUL.md')).toMatchObject({ uid: 0, mode: expect.any(Number) });
    expect(kernel.stat('/home/main/SOUL.md').mode & 0o777).toBe(0o444);
  });

  test('still reaches every file by its old absolute path, from every plane', async () => {
    const { bundle, user } = await boot(await legacyWorkspace());

    expect(user.isSymlink('/home/user')).toBe(true);
    expect(user.readlink('/home/user')).toBe('/home/main');
    expect(user.readFileString('/home/user/data/2026/rows.csv')).toBe('id,kind\n1,percent\n');
    expect(await bundle.vfs.readFile('/home/user/notes.md', utf8)).toBe('# coupon regression\n');

    // A write by the old name lands in the one tree.
    await bundle.vfs.writeFile('/home/user/notes.md', '# fixed\n');
    expect(await bundle.vfs.readFile('/home/main/notes.md', utf8)).toBe('# fixed\n');
  });

  test('runs its shell from /home/main', async () => {
    const { bundle } = await boot(await legacyWorkspace());
    const ran = await bundle.shell.exec('pwd && cat /home/user/notes.md && echo "$HOME"');

    expect(ran.stdout).toBe('/home/main\n# coupon regression\n/home/main\n');
  });

  test('moves once: a second boot finds the same tree and changes nothing', async () => {
    const database = await legacyWorkspace();
    await boot(database);
    const { kernel } = await boot(database);

    expect(kernel.readdir('/home').map((entry) => `${entry.name}:${entry.type}`).sort((a, b) => a.localeCompare(b)))
      .toEqual(['main:directory', 'user:symlink']);
    expect(kernel.readFileString('/home/main/notes.md')).toBe('# coupon regression\n');
  });
});

describe('a new workspace', () => {
  test('has /home/main and the link from /home/user', async () => {
    const { kernel, bundle } = await boot(new Database(':memory:'));

    expect(kernel.isDirectory('/home/main')).toBe(true);
    expect(kernel.readlink('/home/user')).toBe('/home/main');
    await bundle.vfs.writeFile('notes.md', 'fresh');
    expect(kernel.readFileString('/home/main/notes.md')).toBe('fresh');
  });
});

describe('the link', () => {
  test('the agent can neither remove nor replace it', async () => {
    const { bundle, kernel, user } = await boot(new Database(':memory:'));

    user.writeFile('/home/main/notes.md', 'mine');

    expect(() => user.unlink('/home/user')).toThrow('EACCES');
    expect(() => user.rename('/home/main/notes.md', '/home/user')).toThrow('EACCES');
    expect((await bundle.shell.exec('rm /home/user')).exitCode).not.toBe(0);
    expect(kernel.readlink('/home/user')).toBe('/home/main');
  });

  test("a workspace settled while /home was its agent's takes /home back on its next boot", async () => {
    const database = await legacyWorkspace();
    const settled = await boot(database);
    // As a boot before this one left it.
    settled.kernel.chown('/home', SESSION_UID, SESSION_UID);

    const { user } = await boot(database);

    expect(() => user.unlink('/home/user')).toThrow('EACCES');
  });
});

describe('a subagent', () => {
  test('keeps its own home at /home/<name>, beside the main agent\'s', async () => {
    const database = await legacyWorkspace();
    const { kernel } = await boot(database);
    const name = subordinateAgentName('reviewer');

    const home = provisionAgentHome(kernel, name, agentIdentity(workspaceSql(database), name));

    expect(home).toBe('/home/sub-reviewer');
    expect(kernel.readdir('/home').map((entry) => entry.name).sort((a, b) => a.localeCompare(b)))
      .toEqual(['main', 'sub-reviewer', 'user']);
  });
});

describe('a move cut short', () => {
  test('finishes on the next boot when /home/main holds only part of the tree', async () => {
    const database = await legacyWorkspace();
    const { user } = await substrate(database);
    // What a boot that stopped after publishing the first entries left behind.
    user.mkdir('/home/main/data', { recursive: true });
    user.writeFile('/home/main/notes.md', '# coupon regression\n');

    const booted = (await boot(database)).kernel;

    expect(booted.readFileString('/home/main/data/2026/rows.csv')).toBe('id,kind\n1,percent\n');
    expect(booted.readFileString('/slates/queue/package.json')).toBe('{"name":"queue"}');
    expect(booted.readFileString('/home/main/SOUL.md')).toBe(SOUL);
    expect(booted.readlink('/home/user')).toBe('/home/main');
  });

  test('finishes on the next boot when /home/user holds only what was not yet retired', async () => {
    const database = await legacyWorkspace();
    await boot(database);
    // A boot that published everything and stopped while retiring the old name, deepest first, so before /home
    // was taken from the agent.
    const { kernel, user } = await substrate(database);
    kernel.chown('/home', SESSION_UID, SESSION_UID);
    user.unlink('/home/user');
    user.mkdir('/home/user/data', { recursive: true });

    const booted = (await boot(database)).kernel;

    expect(booted.readFileString('/home/main/data/2026/rows.csv')).toBe('id,kind\n1,percent\n');
    expect(booted.readlink('/home/user')).toBe('/home/main');
  });

  test('a boot that stops before the link leaves /home to the agent, so the next boot still starts', async () => {
    const database = await legacyWorkspace();
    const { kernel } = await substrate(database);
    const stopping: RootMoveVfs = { ...kernel, symlink: () => { throw new Error('stopped before the link'); } };

    expect(() => settleWorkspaceRoot(stopping)).toThrow('stopped before the link');
    expect(kernel.stat('/home').uid).toBe(SESSION_UID);

    const booted = (await boot(database)).kernel;

    expect(booted.readlink('/home/user')).toBe('/home/main');
    expect(booted.readFileString('/home/main/notes.md')).toBe('# coupon regression\n');
  });

  test('a removed link comes back on the next boot', async () => {
    const database = await legacyWorkspace();
    const { kernel, user } = await boot(database);
    // Its agent could remove the link while /home was its own, as every boot before this one left it.
    kernel.chown('/home', SESSION_UID, SESSION_UID);
    user.unlink('/home/user');

    const booted = (await boot(database)).kernel;

    expect(booted.readlink('/home/user')).toBe('/home/main');
    expect(booted.readFileString('/home/user/notes.md')).toBe('# coupon regression\n');
  });
});

/** One boot with an agent hired into the workspace, and the plane as each credential reaches it. */
async function withHire(database: Database) {
  const { bundle, kernel, user } = await boot(database);
  const agent = subordinateAgentName('builder');
  const identity = agentIdentity(workspaceSql(database), agent);
  const home = provisionAgentHome(kernel, agent, identity);
  const builder = (await bundle.session()).vfs.as(agentCred(identity));

  return { kernel, user, builder, home };
}

describe('slates', () => {
  test('a hired agent makes a slate at /slates, and the main agent and it each change the other\'s', async () => {
    const { kernel, user, builder, home } = await withHire(await legacyWorkspace());

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
    const { kernel, user, builder, home } = await withHire(await legacyWorkspace());

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
    const { kernel, user, builder } = await withHire(await legacyWorkspace());

    builder.mkdir('/slates/widgets/src', { recursive: true });
    builder.writeFile('/slates/widgets/src/app.tsx', 'export default null;\n');
    user.rename('/slates/widgets', '/slates/gadgets');
    builder.rename('/slates/queue', '/slates/backlog');
    user.removeRecursive('/slates/gadgets');
    builder.removeRecursive('/slates/backlog');

    expect(kernel.readdir('/slates')).toEqual([]);
  });

  test('no agent changes who shares /slates, and a /slates an agent made is the workspace\'s on the next boot', async () => {
    const database = await legacyWorkspace();
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
    const database = await legacyWorkspace();
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
