/**
 * FEAT-17: the workspace root is `/home/main`. A workspace made when it was `/home/user` boots with its
 * whole tree moved there, and `/home/user` stays a link to it, so an absolute path written before still
 * reaches its file. A new workspace gets the same layout, and a move cut short finishes on the next boot.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type SqlDatabase, type SqlRow, type SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { agentIdentity, provisionAgentHome, subordinateAgentName } from '../src/vfs/agent-home';
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
  test('boots with its files, slates and SOUL.md at /home/main', async () => {
    const { kernel } = await boot(await legacyWorkspace());

    expect(kernel.isDirectory('/home/main')).toBe(true);
    expect(kernel.readFileString('/home/main/notes.md')).toBe('# coupon regression\n');
    expect(kernel.readFileString('/home/main/slates/queue/package.json')).toBe('{"name":"queue"}');
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
    expect(booted.readFileString('/home/main/slates/queue/package.json')).toBe('{"name":"queue"}');
    expect(booted.readFileString('/home/main/SOUL.md')).toBe(SOUL);
    expect(booted.readlink('/home/user')).toBe('/home/main');
  });

  test('finishes on the next boot when /home/user holds only what was not yet retired', async () => {
    const database = await legacyWorkspace();
    await boot(database);
    // A boot that published everything and stopped while retiring the old name, deepest first.
    const { user } = await substrate(database);
    user.unlink('/home/user');
    user.mkdir('/home/user/data', { recursive: true });

    const booted = (await boot(database)).kernel;

    expect(booted.readFileString('/home/main/data/2026/rows.csv')).toBe('id,kind\n1,percent\n');
    expect(booted.readlink('/home/user')).toBe('/home/main');
  });

  test('a removed link comes back on the next boot', async () => {
    const database = await legacyWorkspace();
    const { user } = await boot(database);
    // The session user owns /home, so the agent can remove the link.
    user.unlink('/home/user');

    const booted = (await boot(database)).kernel;

    expect(booted.readlink('/home/user')).toBe('/home/main');
    expect(booted.readFileString('/home/user/notes.md')).toBe('# coupon regression\n');
  });
});
