/**
 * Unit tests for workspace.* provider (InlineExecutor) — locks in the
 * post-regression-fix contract:
 *   - listTools() returns Array<{name, description, qualityScore}>, NOT a string
 *   - createTool() preserves original case, does not lowercase
 *   - createTool() upserts: re-creating an existing tool updates it, no duplicate row
 *   - invokeCrafted() looks up CraftStore at call-time — works same-turn as createTool()
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { createInlineExecutor } from '../src/execution/inline.js';
import { CompositeVFS } from '../src/vfs/index.js';
import { DefaultExecutionRouter } from '../src/execution/router.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import { CRAFT_NEUTRAL_PRIOR } from '../src/craft/in-episode.js';
import { VIEW_DATA_SOURCES, initViewTables, listViews, readView } from '../src/views/index.js';
import { createFileTool } from '../src/tools/file-tool.js';
import { TurnFileLedger } from '../src/tools/file-ledger.js';
import { TurnContextBudget } from '../src/context-budget.js';
import { toolExecute } from '@proteus/test-utils';

function buildExec(rt: ReturnType<typeof createTestRuntime>['rt']) {
  return createInlineExecutor({
    vfs: rt.storage.vfs,
    memory: rt.memory,
    craftStore: rt.craftStore,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    sql: rt.storage.sql,
  });
}

describe('workspace provider (InlineExecutor)', () => {
  test('listTools returns an array (not a string)', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'alpha', description: 'first', params: null,
      code: 'async () => "a"', scope: 'local',
    });
    rt.craftStore.create({
      name: 'beta', description: 'second', params: null,
      code: 'async () => "b"', scope: 'local',
    });

    const exec = buildExec(rt);
    const result = await exec.tools.listTools.execute();

    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ name: string; description: string; qualityScore: number }>;
    expect(arr.length).toBe(2);
    expect(arr.map(t => t.name).sort()).toEqual(['alpha', 'beta']);
    for (const t of arr) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.qualityScore).toBe('number');
    }
  });

  test('listTools returns empty array when no tools', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    const result = await exec.tools.listTools.execute();
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });

  test('createTool preserves camelCase — does not lowercase', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = await exec.tools.createTool.execute(
      'multiplyNumbers',
      'Multiply two numbers',
      'async (a, b) => a * b',
    ) as { ok: boolean; name: string; action: string };

    expect(result.ok).toBe(true);
    expect(result.name).toBe('multiplyNumbers');        // original case preserved
    expect(result.name).not.toBe('multiplynumbers');    // NOT lowercased
    expect(result.action).toBe('created');

    // Verify in CraftStore — exact name preserved
    const stored = rt.craftStore.get('multiplyNumbers');
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe('multiplyNumbers');
  });

  test('createTool sanitizes invalid identifier chars without lowercasing', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = await exec.tools.createTool.execute(
      'Weird Name-With.Chars!',
      'test',
      'async () => 1',
    ) as { ok: boolean; name: string };

    // Non-identifier chars become _; case preserved.
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Weird_Name_With_Chars_');
  });

  test('createTool prepends _ when name starts with a digit', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = await exec.tools.createTool.execute(
      '2ndAttempt',
      'test',
      'async () => 1',
    ) as { ok: boolean; name: string };

    expect(result.ok).toBe(true);
    expect(result.name).toBe('_2ndAttempt');
  });

  test('createTool upserts — re-creating the SAME name updates the code, no duplicate row', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    // First create
    const first = await exec.tools.createTool.execute(
      'greet',
      'Say hi',
      'async () => "hello"',
    ) as { ok: boolean; action: string };
    expect(first.action).toBe('created');
    expect(rt.craftStore.list().length).toBe(1);

    // Recreate with same name — should UPDATE, not add a row
    const second = await exec.tools.createTool.execute(
      'greet',
      'Say hi v2',
      'async () => "hello v2"',
    ) as { ok: boolean; action: string };
    expect(second.action).toBe('updated');
    expect(rt.craftStore.list().length).toBe(1);

    // The stored code reflects the latest version
    const stored = rt.craftStore.get('greet')!;
    expect(stored.description).toBe('Say hi v2');
    expect(stored.code).toBe('async () => "hello v2"');
  });

  test('createTool rejects missing args with ok: false', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const noName = await exec.tools.createTool.execute('', 'desc', 'code') as { ok: boolean };
    expect(noName.ok).toBe(false);

    const noDesc = await exec.tools.createTool.execute('name', '', 'code') as { ok: boolean };
    expect(noDesc.ok).toBe(false);

    const noCode = await exec.tools.createTool.execute('name', 'desc', '') as { ok: boolean };
    expect(noCode.ok).toBe(false);
  });

  // v2.1(E): invokeCrafted removed. Same-turn codemode.<name>() access is
  // unsupported by design — the LLM must use two turns (createTool, then
  // codemode.<name>). Tests for createTool alone remain above.
});

/**
 * workspace.writeFile over the REAL file plane. Both backends register this
 * executor with the CompositeVFS (cf/cli runtime.ts), and the tool creates
 * parent directories before writing — so every path shape the agent can name
 * has to survive that mkdir, not just the write.
 */
describe('workspace.writeFile over the CompositeVFS — the file plane both backends register', () => {
  function buildPlane() {
    const { rt } = createTestRuntime();
    const sandbox = {
      files: new Map<string, string>(),
      dirs: [] as string[],
    };
    const sandboxVfs = {
      async readFile(path: string) { return sandbox.files.get(path) ?? ''; },
      async writeFile(path: string, data: string | Uint8Array) { sandbox.files.set(path, String(data)); },
      async readdir() { return [...sandbox.files.keys()]; },
      async stat() { return { size: 0, mtimeMs: 0, isDir: false }; },
      async unlink(path: string) { sandbox.files.delete(path); },
      async mkdir(path: string) { sandbox.dirs.push(path); },
      async exists(path: string) { return sandbox.files.has(path); },
    };
    const vfs = new CompositeVFS({ local: rt.storage.vfs });
    // The cf backend's sandbox mount: the container's REAL root.
    vfs.mount('sandbox', {
      vfs: sandboxVfs,
      policy: { readOnly: false, rootPath: '/', consistency: 'ephemeral' },
      workingDir: '/workspace',
    });
    const exec = createInlineExecutor({
      vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });
    return { vfs, exec, sandbox };
  }

  test('REGRESSION: an absolute non-mount path writes instead of failing EROFS', async () => {
    // `/workspace/x` has always COMPAT-routed to /local — but ensureDir's
    // mkdir of its parent was refused as a mount-table entry, so the whole
    // call died with EROFS on a path whose write would have succeeded.
    const { vfs, exec } = buildPlane();
    const result = await exec.tools.writeFile.execute('/workspace/notes.md', 'from codemode');
    expect(String(result)).toContain('Written');
    expect(await vfs.readFile('/local/workspace/notes.md', { encoding: 'utf8' })).toBe('from codemode');
  });

  test('writing at a mount root does not require creating the root', async () => {
    const { exec, sandbox } = buildPlane();
    expect(String(await exec.tools.writeFile.execute('/sandbox/app.ts', 'top'))).toContain('Written');
    expect(sandbox.files.get('/app.ts')).toBe('top');
    // The composite absorbed mkdir('/sandbox') — the environment was never asked.
    expect(sandbox.dirs).toEqual([]);

    // A deeper sandbox path DOES create its parent, inside the environment.
    expect(String(await exec.tools.writeFile.execute('/sandbox/workspace/app.ts', 'deep'))).toContain('Written');
    expect(sandbox.files.get('/workspace/app.ts')).toBe('deep');
    expect(sandbox.dirs).toEqual(['/workspace']);
  });

  test('the /local base and relative paths keep working unchanged', async () => {
    const { vfs, exec } = buildPlane();
    await exec.tools.writeFile.execute('/local/src/main.ts', 'a');
    await exec.tools.writeFile.execute('notes/todo.md', 'b');
    expect(await vfs.readFile('/local/src/main.ts', { encoding: 'utf8' })).toBe('a');
    expect(await vfs.readFile('/local/notes/todo.md', { encoding: 'utf8' })).toBe('b');
  });
});

/**
 * workspace.editFile — the codemode reach for the native `file` tool's
 * exact-match, read-before-write-enforced edit (createFileDispatcher, core
 * tools/file-tool.ts). Same gate, and — when a ledger thunk is shared — the
 * SAME state a native `file` call would see, so a read/write on one surface
 * is known to the other.
 */
describe('workspace.editFile — the same gate the native `file` tool enforces', () => {
  test('refuses to edit a file never read or written in this scope', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('/local/blind.md', 'original');
    const exec = buildExec(rt);
    const result = await exec.tools.editFile.execute('/local/blind.md', [
      { old_text: 'original', new_text: 'changed' },
    ]) as { ok?: boolean; error?: string };
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain('has not been read here yet');
    expect(await rt.storage.vfs.readFile('/local/blind.md', { encoding: 'utf8' })).toBe('original');
  });

  test('readFile then editFile: the read counts, the edit lands', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('/local/notes.md', 'Hello world');
    const exec = buildExec(rt);
    await exec.tools.readFile.execute('/local/notes.md');
    const result = await exec.tools.editFile.execute('/local/notes.md', [
      { old_text: 'world', new_text: 'proteus' },
    ]) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('/local/notes.md', { encoding: 'utf8' })).toBe('Hello proteus');
  });

  test('writeFile then editFile in the same script: the write counts as having read it', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    await exec.tools.writeFile.execute('/local/fresh.md', 'v1 content');
    const result = await exec.tools.editFile.execute('/local/fresh.md', [
      { old_text: 'v1', new_text: 'v2' },
    ]) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('/local/fresh.md', { encoding: 'utf8' })).toBe('v2 content');
  });

  test('refuses a non-unique old_text, touching nothing', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    await exec.tools.writeFile.execute('/local/dup.md', 'foo\nfoo\n');
    const result = await exec.tools.editFile.execute('/local/dup.md', [
      { old_text: 'foo', new_text: 'bar' },
    ]) as { ok?: boolean; error?: string };
    expect(result.ok).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(await rt.storage.vfs.readFile('/local/dup.md', { encoding: 'utf8' })).toBe('foo\nfoo\n');
  });

  test('a shared ledger thunk makes workspace.readFile and the native `file` tool see the SAME read state', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('/local/shared.md', 'shared content');
    const ledger = new TurnFileLedger();
    const exec = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
      ledger: () => ledger,
    });
    // Read via workspace.*...
    await exec.tools.readFile.execute('/local/shared.md');
    // ...then edit via the NATIVE `file` tool, over the SAME shared ledger.
    const fileTool = createFileTool({ vfs: rt.storage.vfs, ledger, budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<Record<string, unknown>, { ok?: boolean; error?: string }>(fileTool);
    const result = await execute({
      action: 'edit', path: '/local/shared.md',
      edits: [{ old_text: 'shared', new_text: 'REPLACED' }],
    });
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('/local/shared.md', { encoding: 'utf8' })).toBe('REPLACED content');
  });

  test('without a shared ledger, workspace.* and the native `file` tool have INDEPENDENT read state', async () => {
    // Documents the fallback: omitting `ledger` gives workspace.* its own
    // private ledger, so a workspace.readFile does not satisfy the native
    // `file` tool's read-before-edit gate.
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('/local/unshared.md', 'content');
    const exec = buildExec(rt); // no ledger thunk
    await exec.tools.readFile.execute('/local/unshared.md');
    const fileTool = createFileTool({ vfs: rt.storage.vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<Record<string, unknown>, { ok?: boolean; error?: string }>(fileTool);
    const result = await execute({
      action: 'edit', path: '/local/unshared.md',
      edits: [{ old_text: 'content', new_text: 'changed' }],
    });
    expect(result.error).toContain('has not been read here yet');
  });
});

describe('declared resource limits', () => {
  test('the executor carries the limits of wherever its shell really runs, through listExecutors', () => {
    // The cf workspace shell is emulated in a Worker and declares nothing; the
    // CLI's is the host process, so it passes its own cgroup's limits — and
    // the router must carry them to the prompt's execution-status block.
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      resourceLimits: { cpus: 1, memBytes: 2 * 1024 ** 3 },
    }));
    expect(router.listExecutors()[0]?.resourceLimits).toEqual({ cpus: 1, memBytes: 2 * 1024 ** 3 });

    const unbounded = new DefaultExecutionRouter();
    unbounded.register(buildExec(rt));
    expect(unbounded.listExecutors()[0]).not.toHaveProperty('resourceLimits');
  });
});

/**
 * The recurring mental-model error, and what the error has to teach.
 *
 * Models read `workspace.*` as the filesystem of the machine the agent runs on
 * and call `workspace.readdir('/app')` against a container path. A bare
 * `ENOENT: … scandir '/app'` says nothing about why, so the model retries the
 * same shape; under a benchmark it also escaped as an unhandled rejection and
 * ended two whole trials.
 */
describe('workspace.* VFS errors carry the addressing correction', () => {
  function buildPlane() {
    const { rt } = createTestRuntime();
    const vfs = new CompositeVFS({ local: rt.storage.vfs });
    vfs.reserve('sandbox', 'the sandbox container is a Cloudflare binding', {
      readOnly: false, rootPath: '/', consistency: 'ephemeral',
    });
    return createInlineExecutor({
      vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });
  }

  test('readdir of a container path explains what workspace.* is and where to go instead', async () => {
    const exec = buildPlane();
    let raised: unknown;
    try { await exec.tools.readdir.execute('/app'); } catch (err) { raised = err; }

    const err = raised as { message: string; code: string; errno: number; path: string };
    expect(err.code).toBe('ENOENT');                 // the closed taxonomy survives
    expect(err.message).toContain('ENOENT');         // the original cause survives
    expect(err.message).toContain('own virtual filesystem');
    expect(err.message).toContain('NOT the machine or container');
    expect(err.message).toContain('`run` tool');
    // The roots come from the live mount table, so the hint cannot drift from
    // the runtime it is describing.
    expect(err.message).toContain("roots are: local");
  });

  test('a reserved-but-unavailable mount gets the same correction, with its own code', async () => {
    const exec = buildPlane();
    let raised: unknown;
    try { await exec.tools.readFile.execute('/sandbox/app/gblock.txt'); } catch (err) { raised = err; }

    const err = raised as { message: string; code: string };
    expect(err.code).toBe('ENXIO');
    expect(err.message).toContain('own virtual filesystem');
  });

  test('a successful call is untouched by the guidance wrapper', async () => {
    const exec = buildPlane();
    await exec.tools.writeFile.execute('/notes/a.md', 'hello');
    expect(await exec.tools.readFile.execute('/notes/a.md')).toBe('hello');
    expect(await exec.tools.exists.execute('/notes/a.md')).toBe(true);
  });

  test('a non-VFS failure is not dressed up as an addressing problem', async () => {
    const { rt } = createTestRuntime();
    const exec = createInlineExecutor({
      vfs: new CompositeVFS({ local: rt.storage.vfs }), memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => { throw new Error('shell is not available'); } },
      sql: rt.storage.sql,
    });
    let raised: unknown;
    try { await exec.tools.exec.execute('ls'); } catch (err) { raised = err; }
    expect((raised as Error).message).toBe('shell is not available');
  });
});

describe('workspace.createTool — the tool is born scorable', () => {
  test('a created tool gets a neutral prior, so the floor can ever see it', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'summarizes', 'async (x) => x');

    const row = rt.storage.sql<{ score: number; uses: number }>`
      SELECT score, uses FROM craft_scores WHERE tool_name = 'summarize'`[0];
    expect(row).toBeDefined();
    expect(row!.score).toBe(CRAFT_NEUTRAL_PRIOR);
    expect(row!.uses).toBe(0);
  });

  test('re-crafting an existing tool never wipes what it earned', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'v1', 'async (x) => x');
    rt.storage.sql`UPDATE craft_scores SET score = 0.88, uses = 7 WHERE tool_name = 'summarize'`;
    await exec.tools.createTool.execute('summarize', 'v2', 'async (x) => x + 1');

    const row = rt.storage.sql<{ score: number; uses: number }>`
      SELECT score, uses FROM craft_scores WHERE tool_name = 'summarize'`[0];
    expect(row!.score).toBe(0.88);
    expect(row!.uses).toBe(7);
  });

  test('a vetoed tool is neither stored nor scored', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    const res = await exec.tools.createTool.execute(
      'sneaky', 'bypass', 'async () => sql`DELETE FROM scaffold_versions`',
    ) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(rt.craftStore.get('sneaky')).toBeUndefined();
    expect(rt.storage.sql`SELECT score FROM craft_scores WHERE tool_name = 'sneaky'`).toEqual([]);
  });
});

// ── views ───────────────────────────────────────────────────────────────────

describe('workspace.createView / deleteView', () => {
  const spec = {
    v: 1,
    title: 'Deploy health',
    blocks: [{ type: 'stat', label: 'Open changes', source: { rpc: 'getReleaseBoard', path: 'changes' }, agg: 'count' }],
  };

  test('publishes a view the host can list and read back', async () => {
    const { rt } = createTestRuntime();
    initViewTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    const made = await exec.tools.createView.execute('Deploy Health', spec);
    expect(made).toMatchObject({ ok: true, slug: 'deploy-health', version: 1, action: 'created' });

    expect(listViews(rt.storage.sql).map((v) => v.title)).toEqual(['Deploy health']);
    const read = await readView({ vfs: rt.storage.vfs, sql: rt.storage.sql }, 'deploy-health');
    expect(read.ok).toBe(true);
  });

  test('refuses a spec the vocabulary does not cover, and stores nothing', async () => {
    const { rt } = createTestRuntime();
    initViewTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    const out = await exec.tools.createView.execute('evil', {
      v: 1, title: 'Approve', blocks: [{ type: 'html', text: '<script>1</script>' }],
    }) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('view spec invalid');
    expect(listViews(rt.storage.sql)).toEqual([]);
  });

  test('deleting through the bridge takes the tab away', async () => {
    const { rt } = createTestRuntime();
    initViewTables(rt.storage.execRaw);
    const exec = buildExec(rt);

    await exec.tools.createView.execute('Deploy Health', spec);
    expect(await exec.tools.deleteView.execute('Deploy Health')).toMatchObject({ ok: true });
    expect(listViews(rt.storage.sql)).toEqual([]);
  });

  test('the codemode declarations name every source the schema accepts', () => {
    // The model authors against `types`; the validator enforces VIEW_DATA_SOURCES.
    // A source in one and not the other is a spec the model writes and we reject.
    const exec = buildExec(createTestRuntime().rt);
    for (const source of VIEW_DATA_SOURCES) expect(exec.types).toContain(`'${source}'`);
  });
});
