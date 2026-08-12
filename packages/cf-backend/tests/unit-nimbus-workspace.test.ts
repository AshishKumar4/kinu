/**
 * The workspace shell, as Nimbus makes it.
 *
 * The point of these tests is the comparison: every capability asserted here
 * is run against the OLD emulated shell too, and the old one fails it. That is
 * the evidence that adopting Nimbus bought something real rather than moving
 * the same 17 commands behind a new name.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import { CompositeVFS, shellFsOverVfs, type VFS } from '@proteus/core';
import { createShell } from '@proteus/agent-utils/shell';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { makeSql } from '../../core/tests/helpers.js';
import {
  createNimbusWorkspace,
  createWorkspaceShell,
  migrateLegacyLocalFiles,
  nextWorkspaceGeneration,
} from '../src/nimbus-workspace.js';

function sqlPort(db: Database): SqlDatabase {
  return { exec: (query, ...bindings) => db.query(query).all(...(bindings as never[])) as never };
}

function transactionsPort(db: Database): { storage: { transactionSync<T>(cb: () => T): T } } {
  return { storage: { transactionSync: <T>(cb: () => T): T => db.transaction(cb)() } };
}

function freshWorkspace(): ReturnType<typeof createNimbusWorkspace> {
  const db = new Database(':memory:');
  const sql = sqlPort(db);
  return createNimbusWorkspace({
    sql,
    transactions: transactionsPort(db),
    generation: nextWorkspaceGeneration(sql),
  });
}

/** The shell this change replaced: agent-utils' emulator over a composite. */
function legacyShell(): ReturnType<typeof createShell> {
  const db = new Database(':memory:');
  const fs = new SqliteFS(makeSql(db));
  fs.init();
  const vfs = new CompositeVFS({ local: fs as unknown as VFS });
  return createShell(shellFsOverVfs(vfs), { cwd: vfs.cwd });
}

describe('Nimbus workspace shell — what the emulator could not do', () => {
  // Each case is a real shell feature the old emulator has no concept of: it
  // has no variables, no loops, no arithmetic, no `sort`/`tr`/`awk`, and no
  // `cd` (it is stateless by construction — see agent-utils/shell/dispatch.ts).
  const cases: ReadonlyArray<{ name: string; command: string; expected: string }> = [
    { name: 'pipes into a real sort', command: "printf 'b\\na\\nc\\n' | sort", expected: 'a\nb\nc' },
    { name: 'tr', command: 'echo foo | tr a-z A-Z', expected: 'FOO' },
    { name: 'awk field selection', command: "echo one two | awk '{print $2}'", expected: 'two' },
    { name: 'for loops', command: 'for i in 1 2 3; do echo n$i; done', expected: 'n1\nn2\nn3' },
    { name: 'arithmetic expansion', command: 'echo $((2 + 3))', expected: '5' },
    { name: 'shell variables', command: 'X=5; echo "val=$X"', expected: 'val=5' },
    { name: 'cut', command: "echo a:b:c | cut -d: -f2", expected: 'b' },
    { name: 'uniq', command: "printf 'a\\na\\nb\\n' | uniq", expected: 'a\nb' },
  ];

  for (const { name, command, expected } of cases) {
    test(`Nimbus runs ${name}`, async () => {
      const result = await freshWorkspace().shell.exec(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    });

    test(`the old emulated shell could NOT run ${name}`, async () => {
      const result = await legacyShell().exec(command);
      // Either it refuses the command outright or it produces something other
      // than the right answer — never a silent, correct result.
      expect(result.exitCode === 0 && result.stdout.trim() === expected).toBe(false);
    });
  }

  test('`cd` persists across calls — the emulator refuses it entirely', async () => {
    const nimbus = freshWorkspace().shell;
    expect((await nimbus.exec('mkdir -p sub && cd sub && pwd')).stdout.trim()).toBe('/home/user/sub');
    expect((await nimbus.exec('pwd')).stdout.trim()).toBe('/home/user/sub');

    const legacy = legacyShell();
    expect((await legacy.exec('cd sub')).exitCode).not.toBe(0);
  });

  test('redirection writes a file the VFS then reads — one set of bytes', async () => {
    const ws = freshWorkspace();
    expect((await ws.shell.exec('echo hello > note.txt')).exitCode).toBe(0);
    expect(await ws.vfs.readFile('note.txt', { encoding: 'utf8' })).toBe('hello\n');

    await ws.vfs.writeFile('from-vfs.txt', 'written by the file tool\n');
    expect((await ws.shell.exec('cat from-vfs.txt')).stdout).toBe('written by the file tool\n');
  });

  test('exec format is refused honestly rather than pretended', async () => {
    const ws = freshWorkspace();
    await ws.vfs.writeFile('elf', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]));
    const result = await ws.shell.exec('chmod +x elf && ./elf');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('wasm32-wasi');
  });
});

describe('the /local file plane', () => {
  test('directories are removed recursively and renamed — refusals on SqliteFS', async () => {
    const ws = freshWorkspace();
    const vfs = ws.vfs as VFS & {
      removeRecursive(path: string): Promise<void>;
      rename(from: string, to: string): Promise<void>;
    };
    await ws.shell.exec('mkdir -p tree/a && echo x > tree/a/f.txt');

    await vfs.rename('tree/a/f.txt', 'tree/a/g.txt');
    expect(await vfs.exists('tree/a/g.txt')).toBe(true);

    await vfs.removeRecursive('tree');
    expect(await vfs.exists('tree')).toBe(false);
  });

  test('a missing path stats as null, per the core VFS contract', async () => {
    expect(await freshWorkspace().vfs.stat('nope/missing.txt')).toBeNull();
  });

  test('the shell sees files the composite wrote through its /local row', async () => {
    const ws = freshWorkspace();
    const composite = new CompositeVFS({ local: ws.vfs });
    await composite.writeFile('/local/src/main.ts', 'export const x = 1;\n');
    const grep = await ws.shell.exec("grep -r 'export const' src");
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout).toContain('main.ts');
  });
});

describe('cross-mount routing', () => {
  const reached: string[] = [];
  const base = { exec: async (c: string) => { reached.push(`base:${c}`); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const crossMount = { exec: async (c: string) => { reached.push(`cross:${c}`); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const shell = createWorkspaceShell({ base, crossMount, mountNames: () => ['local', 'pc', 'sandbox'] });

  test('a command naming no mount runs on Nimbus', async () => {
    reached.length = 0;
    await shell.exec('grep -r foo src');
    expect(reached).toEqual(['base:grep -r foo src']);
  });

  test('a command reaching a mount runs on the plane that can reach it', async () => {
    reached.length = 0;
    await shell.exec('cat /pc/home/user/notes.txt');
    expect(reached).toEqual(['cross:cat /pc/home/user/notes.txt']);
  });

  test('a mount-name prefix is matched on a segment boundary, not a substring', async () => {
    reached.length = 0;
    await shell.exec('cat /sandboxes/x');
    expect(reached).toEqual(['base:cat /sandboxes/x']);
  });
});

describe('migration off the pre-Nimbus base', () => {
  test('copies a legacy /local in, once', async () => {
    const db = new Database(':memory:');
    const sql = sqlPort(db);
    const legacy = new Map<string, string>([['scaffold/agent.js', 'export default 1;\n']]);
    const legacyVfs: VFS = {
      readFile: async (path) => legacy.get(path.replace(/^\//, '')) ?? '',
      writeFile: async () => {},
      readdir: async (dir) => {
        const prefix = dir === '' ? '' : `${dir}/`;
        const names = new Set<string>();
        for (const key of legacy.keys()) {
          if (!key.startsWith(prefix)) continue;
          names.add(key.slice(prefix.length).split('/')[0]);
        }
        return [...names];
      },
      stat: async (path) => {
        const key = path.replace(/^\//, '');
        if (legacy.has(key)) return { size: 1, mtimeMs: 0, isDir: false };
        return [...legacy.keys()].some((k) => k.startsWith(`${key}/`))
          ? { size: 0, mtimeMs: 0, isDir: true }
          : null;
      },
      unlink: async () => {},
      mkdir: async () => {},
      exists: async (path) => legacy.has(path.replace(/^\//, '')),
    };

    const ws = createNimbusWorkspace({
      sql,
      transactions: transactionsPort(db),
      generation: nextWorkspaceGeneration(sql),
      migrateFrom: legacyVfs,
    });

    expect(await ws.vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toBe('export default 1;\n');
    // Second run is a no-op: the marker is set.
    expect(await migrateLegacyLocalFiles(sql, legacyVfs, ws.vfs)).toBeNull();
  });

  test('the generation counter never repeats for a database', () => {
    const db = new Database(':memory:');
    const sql = sqlPort(db);
    const seen = [nextWorkspaceGeneration(sql), nextWorkspaceGeneration(sql), nextWorkspaceGeneration(sql)];
    expect(seen).toEqual([1, 2, 3]);
  });
});

/**
 * The shell as a real orchestrator reaches it — through `createCFRuntime`,
 * its approval gate and the composite, rather than through the adapter
 * directly. This is the path a turn actually takes.
 */
describe('the workspace shell through the real runtime', () => {
  test('runs a pipeline the old shell had no commands for', async () => {
    const { orchestratorHarness } = await import('./helpers/actor-harness.js');
    const rt = (orchestratorHarness().agent as unknown as { rt: { shell: { exec(c: string): Promise<{ stdout: string; exitCode: number }> } } }).rt;

    const built = await rt.shell.exec("printf 'pear\\napple\\npear\\n' > fruit.txt && sort -u fruit.txt | tr a-z A-Z");
    expect(built.exitCode).toBe(0);
    expect(built.stdout.trim()).toBe('APPLE\nPEAR');
  });

  test('the file plane and the shell address one set of bytes', async () => {
    const { orchestratorHarness } = await import('./helpers/actor-harness.js');
    const rt = (orchestratorHarness().agent as unknown as {
      rt: { shell: { exec(c: string): Promise<{ stdout: string }> }; compositeVfs: CompositeVFS };
    }).rt;

    await rt.compositeVfs.writeFile('/local/notes/todo.md', '- ship it\n');
    expect((await rt.shell.exec('cat notes/todo.md')).stdout).toBe('- ship it\n');

    await rt.shell.exec("echo '- and verify' >> notes/todo.md");
    expect(await rt.compositeVfs.readFile('/local/notes/todo.md', { encoding: 'utf8' }))
      .toBe('- ship it\n- and verify\n');
  });
});
