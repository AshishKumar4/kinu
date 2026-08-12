/**
 * The workspace shell and the workspace file tools address ONE filesystem.
 *
 * The regression this pins is a measured production failure. A fork's parent
 * files arrive as the `/workspace` MOUNT of its composite file plane, and the
 * head prompt says so — but the emulated shell behind `run` and
 * `workspace.exec` was constructed over the raw SqliteFS, i.e. the head's own
 * empty private scratch. So `workspace.readdir('/workspace')` listed the
 * repository while `run "ls -la /workspace/…"` answered ENOENT, and the head
 * concluded the repository did not exist and stopped. Six heads, zero
 * findings.
 *
 * `shellFsOverVfs` puts the shell on the composite, so every mount is
 * readable and greppable by the same path the file tools use, and `ls /` IS
 * the mount table.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createShell } from '@proteus/agent-utils/shell';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { CompositeVFS, shellFsOverVfs } from '../src/vfs/index.js';
import type { VFS } from '../src/types/primitives.js';
import { makeSql } from './helpers.js';

/** A second, independent plane to mount — stands in for the parent workspace
 *  RPC mount a head gets, or a container's /sandbox. */
function memoryMount(files: Record<string, string>): VFS {
  const store = new Map(Object.entries(files));
  const children = (dir: string): string[] => {
    const prefix = dir === '' || dir === '/' ? '' : `${dir.replace(/^\//, '')}/`;
    const names = new Set<string>();
    for (const path of store.keys()) {
      if (!path.startsWith(prefix)) continue;
      names.add(path.slice(prefix.length).split('/')[0]!);
    }
    return [...names];
  };
  const key = (path: string) => path.replace(/^\//, '');
  return {
    async readFile(path) {
      const hit = store.get(key(path));
      if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return hit;
    },
    async writeFile(path, data) { store.set(key(path), typeof data === 'string' ? data : new TextDecoder().decode(data)); },
    async readdir(path) { return children(path); },
    async stat(path) {
      const k = key(path);
      if (store.has(k)) return { size: store.get(k)!.length, mtimeMs: 1, isDir: false };
      return children(path).length > 0 ? { size: 0, mtimeMs: 1, isDir: true } : null;
    },
    async unlink(path) { store.delete(key(path)); },
    async mkdir() { /* directories are implicit here */ },
    async exists(path) { return store.has(key(path)) || children(path).length > 0; },
  };
}

function createPlane() {
  const sql = makeSql(new Database(':memory:'));
  // SqliteFS as the /local base, exactly as both backends mount it — it
  // implements the core VFS directly, and knows its own recursive delete.
  const local = new SqliteFS(sql);
  local.init();
  const vfs = new CompositeVFS({ local });
  vfs.mount('workspace', {
    vfs: memoryMount({
      'packages/core/src/engine.ts': 'export const NEEDLE = 1;\n',
      'packages/core/README.md': '# core\n',
    }),
    policy: { readOnly: false, rootPath: '', consistency: 'durable' },
  });
  return { vfs, shell: createShell(shellFsOverVfs(vfs), { cwd: vfs.cwd }) };
}

describe('the shell sees the whole file plane, not just /local', () => {
  test('`ls /` is the mount table — the discovery the head never got', async () => {
    const { shell } = createPlane();
    const out = await shell.exec('ls /');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('local');
    expect(out.stdout).toContain('workspace');
  });

  test('a mounted file is readable by the SAME path the file tools use', async () => {
    const { vfs, shell } = createPlane();
    expect(await vfs.readFile('/workspace/packages/core/README.md', { encoding: 'utf8' })).toBe('# core\n');
    const out = await shell.exec('cat /workspace/packages/core/README.md');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('# core\n');
  });

  test('the exact shape that failed in production now works: find and grep under a mount', async () => {
    const { shell } = createPlane();
    const found = await shell.exec('find /workspace/packages/core -name "*.ts"');
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain('/workspace/packages/core/src/engine.ts');

    const grepped = await shell.exec('grep -rn NEEDLE /workspace');
    expect(grepped.exitCode).toBe(0);
    expect(grepped.stdout).toContain('engine.ts');
  });

  test('writes through the shell land on the mount the path names', async () => {
    const { vfs, shell } = createPlane();
    const out = await shell.exec('echo hello > /workspace/note.txt');
    expect(out.exitCode).toBe(0);
    expect(await vfs.readFile('/workspace/note.txt', { encoding: 'utf8' })).toBe('hello\n');
  });

  test('compat addressing is unchanged: a bare path is still /local', async () => {
    const { vfs, shell } = createPlane();
    await vfs.writeFile('scaffold/agent.js', 'v1');
    expect((await shell.exec('cat /scaffold/agent.js')).stdout).toBe('v1');
    expect((await shell.exec('cat /local/scaffold/agent.js')).stdout).toBe('v1');
  });

  test('pwd answers with the plane cwd instead of leaving the agent to guess', async () => {
    const { shell } = createPlane();
    expect((await shell.exec('pwd')).stdout.trim()).toBe('/local');
  });
});

describe('mutations the core VFS has no primitive for still behave', () => {
  test('rm -r removes the directory itself, not just the files under it', async () => {
    const { vfs, shell } = createPlane();
    await vfs.writeFile('/local/junk/a.txt', 'a');
    await vfs.writeFile('/local/junk/nested/b.txt', 'b');
    expect(await vfs.exists('/local/junk')).toBe(true);

    const out = await shell.exec('rm -rf /local/junk');
    expect(out.exitCode).toBe(0);
    // The regression: unlinking the files while leaving the directory rows
    // behind would list an "empty" junk/ forever — SqliteFS refuses unlink on
    // a directory, so the mount has to do its own recursive delete.
    expect(await vfs.exists('/local/junk')).toBe(false);
    expect(await vfs.readdir('/local')).not.toContain('junk');
  });

  test('mv moves a file, and refuses a directory instead of half-moving it', async () => {
    const { vfs, shell } = createPlane();
    await vfs.writeFile('/local/notes/a.md', 'hello');

    expect((await shell.exec('mv /local/notes/a.md /local/notes/b.md')).exitCode).toBe(0);
    expect(await vfs.readFile('/local/notes/b.md', { encoding: 'utf8' })).toBe('hello');
    expect(await vfs.exists('/local/notes/a.md')).toBe(false);

    const dir = await shell.exec('mv /local/notes /local/archive');
    expect(dir.exitCode).toBe(1);
    expect(dir.stderr).toContain('EISDIR');
  });

  test('mv carries a file ACROSS mounts — one plane, so one move', async () => {
    const { vfs, shell } = createPlane();
    await vfs.writeFile('/local/report.md', 'findings');

    expect((await shell.exec('mv /local/report.md /workspace/report.md')).exitCode).toBe(0);
    expect(await vfs.readFile('/workspace/report.md', { encoding: 'utf8' })).toBe('findings');
    expect(await vfs.exists('/local/report.md')).toBe(false);
  });

  test('a mount with no recursive delete of its own still has its files removed', async () => {
    const { vfs, shell } = createPlane();
    const out = await shell.exec('rm -r /workspace/packages/core');
    expect(out.exitCode).toBe(0);
    expect(await vfs.exists('/workspace/packages/core/src/engine.ts')).toBe(false);
    expect(await vfs.exists('/workspace/packages/core/README.md')).toBe(false);
  });

  test('a mount root cannot be removed', async () => {
    const { shell } = createPlane();
    const out = await shell.exec('rm -r /workspace');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('cannot remove the /workspace mount');
  });
});

describe('a shell failure says what this shell IS', () => {
  test('a missing binary names the shell, its real command set, and where real binaries live', async () => {
    const { shell } = createPlane();
    const out = await shell.exec('xargs echo hi');
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toContain('emulated shell');
    expect(out.stderr).toContain('grep');
    expect(out.stderr).toContain('sandbox');
    expect(out.stderr).toContain('run');
  });

  test('a real program points at the executors rather than a tool name that does not exist', async () => {
    const { shell } = createPlane();
    const out = await shell.exec('npm test');
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toContain('no real binaries');
    // The old message named `sandbox_exec`, which has not been a tool for a
    // long time — an error that tells the model to call something nonexistent.
    expect(out.stderr).not.toContain('sandbox_exec');
  });

  test('a path failure carries the addressing correction, with the live mount list', async () => {
    const { shell } = createPlane();
    const out = await shell.exec('cat /app/main.py');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('ENOENT');
    expect(out.stderr).toContain('NOT the machine or container');
    expect(out.stderr).toContain('workspace');
  });
});
