// The cloud backend's codemode write path, wired exactly as createCFRuntime
// wires it: core's inline `workspace.*` executor over a CompositeVFS whose
// /sandbox mount is the container's REAL root (createSandboxMountVFS over the
// raw @cloudflare/sandbox handle).
//
// workspace.writeFile creates parent directories before writing, so every
// path shape the agent can name has to survive that mkdir — not just the
// write. `/workspace/x` (a top-level non-mount name, which COMPAT-routes to
// /local) used to die with EROFS at the mkdir, on a path whose write worked.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  CompositeVFS, createInlineExecutor, createSandboxMountVFS,
  type MountPolicy, type SandboxHandle, type SqlExecutor,
} from '@proteus/core';
import { SqliteFS, VFS_SCHEMA_DDL } from '@proteus/agent-utils/vfs';

function makeSql(db: Database): SqlExecutor {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // bun:sqlite binds TypedArrays, not the ArrayBuffers the VFS stores blobs as.
    const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound as never[]);
    stmt.run(...bound as never[]);
    return [];
  }) as unknown as SqlExecutor;
}

/** The cf sandbox mount: the container's real root, ephemeral. */
const SANDBOX_POLICY: MountPolicy =
  { readOnly: false, rootPath: '/', consistency: 'ephemeral', credentialsStayInHost: true };

/** A raw sandbox handle that records the shell commands the adapter issues. */
function fakeSandbox() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const handle = {
    async exec(command: string) { commands.push(command); return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile(path: string) { return { content: files.get(path) ?? '', encoding: 'utf-8', exitCode: 0 }; },
    async writeFile(path: string, content: string) { files.set(path, content); return {}; },
    async listFiles() { return { files: [] }; },
    async deleteFile(path: string) { files.delete(path); return {}; },
  } as unknown as SandboxHandle;
  return { handle, files, commands };
}

function buildPlane() {
  const db = new Database(':memory:');
  for (const ddl of VFS_SCHEMA_DDL) db.exec(ddl);
  const sql = makeSql(db);
  const vfs = new CompositeVFS({ local: new SqliteFS(sql as never) });
  const sandbox = fakeSandbox();
  vfs.mount('sandbox', {
    vfs: createSandboxMountVFS(sandbox.handle),
    policy: SANDBOX_POLICY,
    workingDir: '/workspace',
  });
  const exec = createInlineExecutor({
    vfs,
    memory: { index: async () => {}, search: async () => [], write: async () => {} } as never,
    craftStore: { list: () => [], get: () => null, create: () => {}, update: () => {} } as never,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  });
  return { vfs, exec, sandbox };
}

describe("the cloud backend's workspace.writeFile plane", () => {
  test('REGRESSION: an absolute non-mount path writes instead of failing EROFS', async () => {
    const { vfs, exec } = buildPlane();
    const result = await exec.tools.writeFile.execute('/workspace/plan.md', 'from codemode');
    expect(String(result)).toContain('Written');
    expect(await vfs.readFile('/local/workspace/plan.md', { encoding: 'utf8' })).toBe('from codemode');
  });

  test('a file at the sandbox mount root never asks the container to mkdir /', async () => {
    const { exec, sandbox } = buildPlane();
    expect(String(await exec.tools.writeFile.execute('/sandbox/app.ts', 'top'))).toContain('Written');
    expect(sandbox.files.get('/app.ts')).toBe('top');
    expect(sandbox.commands.filter((c) => c.startsWith('mkdir'))).toEqual([]);
  });

  test('a deeper sandbox path creates its parent INSIDE the container', async () => {
    const { exec, sandbox } = buildPlane();
    expect(String(await exec.tools.writeFile.execute('/sandbox/workspace/app.ts', 'deep'))).toContain('Written');
    expect(sandbox.files.get('/workspace/app.ts')).toBe('deep');
    expect(sandbox.commands.some((c) => c.startsWith("mkdir -p -- '/workspace'"))).toBe(true);
  });
});
