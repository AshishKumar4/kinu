/**
 * Unit tests for workspace.* provider (InlineExecutor) — locks in the
 * post-regression-fix contract:
 *   - listTools() returns Array<{name, description, qualityScore}>, NOT a string
 *   - createTool() preserves original case, does not lowercase
 *   - createTool() upserts: re-creating an existing tool updates it, no duplicate row
 *   - invokeCrafted() looks up CraftStore at call-time — works same-turn as createTool()
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { createInlineExecutor } from '../src/execution/inline';
import { DefaultExecutionRouter } from '../src/execution/router';
import { CRAFT_NEUTRAL_PRIOR } from '../src/craft/in-episode';
import { VIEW_DATA_SOURCES, initViewTables, listViews, readView } from '../src/views/index';
import { createFileTool, type FileToolInput } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '../src/utils/json';
import type { CraftedTool } from '../src/types/craft';

const ToolSummarySchema = v.object({
  name: v.string(),
  description: v.string(),
  qualityScore: v.number(),
});
const ToolCreatedSchema = v.object({ ok: v.boolean(), name: v.string(), action: v.string() });
const ToolNamedSchema = v.object({ ok: v.boolean(), name: v.string() });
const ToolActionSchema = v.object({ ok: v.boolean(), action: v.string() });
const ToolOkSchema = v.object({ ok: v.boolean() });
const FileSuccessSchema = v.object({ ok: v.boolean() });
const ErrorResultSchema = v.object({ error: v.string() });
const VfsMessageSchema = v.object({ message: v.string(), code: v.string() });

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

    const arr = v.parse(v.array(ToolSummarySchema), result);
    expect(arr.length).toBe(2);
    expect(arr.map(t => t.name).sort()).toEqual(['alpha', 'beta']);
  });

  test('listTools returns empty array when no tools', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    const result = await exec.tools.listTools.execute();
    expect(v.parse(v.array(ToolSummarySchema), result)).toEqual([]);
  });

  test('listTools reads a tool with no quality row as the neutral prior', async () => {
    const { rt } = createTestRuntime();
    const ghost: CraftedTool = {
      name: 'ghost', description: 'no row yet', params: null,
      code: 'async () => 1', scope: 'local', createdAt: 0, updatedAt: 0,
    };
    const exec = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: { ...rt.craftStore, list: () => [ghost] },
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });
    expect(v.parse(v.array(ToolSummarySchema), await exec.tools.listTools.execute())).toEqual([
      { name: 'ghost', description: 'no row yet', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });

  test('createTool preserves camelCase — does not lowercase', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = v.parse(ToolCreatedSchema, await exec.tools.createTool.execute(
      'multiplyNumbers',
      'Multiply two numbers',
      'async (a, b) => a * b',
    ));

    expect(result.ok).toBe(true);
    expect(result.name).toBe('multiplyNumbers');        // original case preserved
    expect(result.name).not.toBe('multiplynumbers');    // NOT lowercased
    expect(result.action).toBe('created');

    // Verify in CraftStore — exact name preserved
    const stored = rt.craftStore.get('multiplyNumbers');
    if (!stored) throw new Error('created tool was not stored');
    expect(stored.name).toBe('multiplyNumbers');
  });

  test('createTool sanitizes invalid identifier chars without lowercasing', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = v.parse(ToolNamedSchema, await exec.tools.createTool.execute(
      'Weird Name-With.Chars!',
      'test',
      'async () => 1',
    ));

    // Non-identifier chars become _; case preserved.
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Weird_Name_With_Chars_');
  });

  test('createTool prepends _ when name starts with a digit', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const result = v.parse(ToolNamedSchema, await exec.tools.createTool.execute(
      '2ndAttempt',
      'test',
      'async () => 1',
    ));

    expect(result.ok).toBe(true);
    expect(result.name).toBe('_2ndAttempt');
  });

  test('createTool upserts — re-creating the SAME name updates the code, no duplicate row', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    // First create
    const first = v.parse(ToolActionSchema, await exec.tools.createTool.execute(
      'greet',
      'Say hi',
      'async () => "hello"',
    ));
    expect(first.action).toBe('created');
    expect(rt.craftStore.list().length).toBe(1);

    // Recreate with same name — should UPDATE, not add a row
    const second = v.parse(ToolActionSchema, await exec.tools.createTool.execute(
      'greet',
      'Say hi v2',
      'async () => "hello v2"',
    ));
    expect(second.action).toBe('updated');
    expect(rt.craftStore.list().length).toBe(1);

    // The stored code reflects the latest version
    const stored = rt.craftStore.get('greet');
    if (!stored) throw new Error('updated tool was not stored');
    expect(stored.description).toBe('Say hi v2');
    expect(stored.code).toBe('async () => "hello v2"');
  });

  test('createTool rejects missing args with ok: false', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const noName = v.parse(ToolOkSchema, await exec.tools.createTool.execute('', 'desc', 'code'));
    expect(noName.ok).toBe(false);

    const noDesc = v.parse(ToolOkSchema, await exec.tools.createTool.execute('name', '', 'code'));
    expect(noDesc.ok).toBe(false);

    const noCode = v.parse(ToolOkSchema, await exec.tools.createTool.execute('name', 'desc', ''));
    expect(noCode.ok).toBe(false);
  });

  test('createTool refuses a name that shadows a builtin or MCP tool', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    for (const name of ['run', 'mcp_github_get']) {
      const result = await exec.tools.createTool.execute(name, 'shadow', 'async () => 1');
      expect(result).toMatchObject({ ok: false, reason: 'bad_input', error: expect.stringContaining(name) });
      expect(rt.craftStore.get(name)).toBeUndefined();
    }
  });

  // v2.1(E): invokeCrafted removed. Same-turn `tools.<name>()` access is
  // unsupported by design — the LLM must use two turns (createTool, then
  // `tools.<name>`). Tests for createTool alone remain above.
});

/**
 * workspace.writeFile over the REAL file plane. Both backends register this
 * executor with the workspace filesystem (cf/cli runtime.ts), and the tool creates
 * parent directories before writing — so every path shape the agent can name
 * has to survive that mkdir, not just the write.
 */
describe('workspace.writeFile over the workspace filesystem — what both backends register', () => {
  function buildPlane() {
    const { rt } = createTestRuntime();
    const dirs: string[] = [];
    const sandbox = {
      files: new Map<string, string>(),
      dirs,
    };
    // The workspace's own filesystem. The container is a separate environment
    // reached through `sandbox.*` in its own paths, so it is deliberately NOT
    // addressable from here.
    const vfs = rt.storage.vfs;
    const exec = createInlineExecutor({
      vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });
    return { vfs, exec, sandbox };
  }

  test('a deep path creates its parents and round-trips', async () => {
    const { vfs, exec } = buildPlane();
    const result = await exec.tools.writeFile.execute('notes/deep/todo.md', 'from codemode');
    expect(String(result)).toContain('Written');
    expect(await vfs.readFile('notes/deep/todo.md', { encoding: 'utf8' })).toBe('from codemode');
  });

  test('an existing file cannot be overwritten before workspace.readFile shows it', async () => {
    const { vfs, exec } = buildPlane();
    await vfs.writeFile('victim.txt', 'keep me');

    // The classification is part of the contract, not incidental: a caller
    // branches on `reason` to tell "read it first" from a genuine IO failure,
    // and the declared codemode type promises it.
    expect(await exec.tools.writeFile.execute('victim.txt', 'destroyed blind')).toEqual({
      error: expect.stringContaining('has not been read here yet'),
      reason: 'unread',
    });
    expect(await vfs.readFile('victim.txt', { encoding: 'utf8' })).toBe('keep me');

    await exec.tools.readFile.execute('victim.txt');
    expect(String(await exec.tools.writeFile.execute('victim.txt', 'replacement'))).toContain('Written');
    expect(await vfs.readFile('victim.txt', { encoding: 'utf8' })).toBe('replacement');
    // The declared codemode type is the promise the model reads, so it has to
    // name the whole vocabulary a refusal can carry. The union it used to name
    // was three of ten reasons the dispatcher already returned.
    expect(exec.types).toContain('function writeFile(path: string, content: string): Promise<string | Refusal>;');
    for (const reason of ['unread', 'stale', 'io', 'missing', 'not_found', 'ambiguous', 'bad_input']) {
      expect(exec.types).toContain(`'${reason}'`);
    }
  });

  test('relative and absolute name the same file — one namespace, no prefixes', async () => {
    const { vfs, exec } = buildPlane();
    await exec.tools.writeFile.execute('src/main.ts', 'a');
    // Relative paths resolve at the workspace root, which is where the shell
    // starts too, so both spellings are the same bytes.
    expect(await vfs.readFile('src/main.ts', { encoding: 'utf8' })).toBe('a');
    expect(await vfs.readFile('/home/user/src/main.ts', { encoding: 'utf8' })).toBe('a');
  });

  test('another environment is not addressable from here at all', async () => {
    const { exec, sandbox } = buildPlane();
    // The container is reached through `sandbox.*` in its own paths. Writing
    // "/sandbox/app.ts" makes an ordinary file called sandbox/app.ts in this
    // filesystem, and the container never hears about it — which is the point:
    // there is no path that silently means two places.
    expect(String(await exec.tools.writeFile.execute('/sandbox/app.ts', 'top'))).toContain('Written');
    expect(sandbox.files.size).toBe(0);
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
    await rt.storage.vfs.writeFile('blind.md', 'original');
    const exec = buildExec(rt);
    const result = v.parse(ErrorResultSchema, await exec.tools.editFile.execute('blind.md', [
      { old_text: 'original', new_text: 'changed' },
    ]));
    expect(result.error).toContain('has not been read here yet');
    expect(await rt.storage.vfs.readFile('blind.md', { encoding: 'utf8' })).toBe('original');
  });

  test('readFile then editFile: the read counts, the edit lands', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('notes.md', 'Hello world');
    const exec = buildExec(rt);
    await exec.tools.readFile.execute('notes.md');
    const result = v.parse(FileSuccessSchema, await exec.tools.editFile.execute('notes.md', [
      { old_text: 'world', new_text: 'kinu' },
    ]));
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('notes.md', { encoding: 'utf8' })).toBe('Hello kinu');
  });

  test('writeFile then editFile in the same script: the write counts as having read it', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    await exec.tools.writeFile.execute('fresh.md', 'v1 content');
    const result = v.parse(FileSuccessSchema, await exec.tools.editFile.execute('fresh.md', [
      { old_text: 'v1', new_text: 'v2' },
    ]));
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('fresh.md', { encoding: 'utf8' })).toBe('v2 content');
  });

  test('refuses a non-unique old_text, touching nothing', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    await exec.tools.writeFile.execute('dup.md', 'foo\nfoo\n');
    const result = v.parse(ErrorResultSchema, await exec.tools.editFile.execute('dup.md', [
      { old_text: 'foo', new_text: 'bar' },
    ]));
    // The refusal names the anchor, its count and the file. That wording lets
    // the model widen the anchor on retry.
    expect(result.error).toContain('appears 2 times in dup.md');
    expect(result.error).toContain('ambiguous');
    expect(await rt.storage.vfs.readFile('dup.md', { encoding: 'utf8' })).toBe('foo\nfoo\n');
  });

  test('a shared ledger thunk makes workspace.readFile and the native `file` tool see the SAME read state', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('shared.md', 'shared content');
    const ledger = new TurnFileLedger();
    const exec = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
      ledger: () => ledger,
    });
    // Read via workspace.*...
    await exec.tools.readFile.execute('shared.md');
    // ...then edit via the NATIVE `file` tool, over the SAME shared ledger.
    const fileTool = createFileTool({ vfs: rt.storage.vfs, ledger, budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<FileToolInput, JsonValue>(fileTool);
    const result = v.parse(FileSuccessSchema, await execute({
      action: 'edit', path: 'shared.md',
      edits: [{ old_text: 'shared', new_text: 'REPLACED' }],
    }));
    expect(result.ok).toBe(true);
    expect(await rt.storage.vfs.readFile('shared.md', { encoding: 'utf8' })).toBe('REPLACED content');
  });

  test('without a shared ledger, workspace.* and the native `file` tool have INDEPENDENT read state', async () => {
    // Documents the fallback: omitting `ledger` gives workspace.* its own
    // private ledger, so a workspace.readFile does not satisfy the native
    // `file` tool's read-before-edit gate.
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('unshared.md', 'content');
    const exec = buildExec(rt); // no ledger thunk
    await exec.tools.readFile.execute('unshared.md');
    const fileTool = createFileTool({ vfs: rt.storage.vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<FileToolInput, JsonValue>(fileTool);
    const result = v.parse(ErrorResultSchema, await execute({
      action: 'edit', path: 'unshared.md',
      edits: [{ old_text: 'content', new_text: 'changed' }],
    }));
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
    const vfs = rt.storage.vfs;
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

    const err = v.parse(VfsMessageSchema, raised);
    expect(err.code).toBe('ENOENT');                 // the closed taxonomy survives
    expect(err.message).toContain('ENOENT');         // the original cause survives
    expect(err.message).toContain('own virtual filesystem');
    expect(err.message).toContain('NOT the machine or container');
    expect(err.message).toContain('`run` tool');
    // The roots come from the live filesystem, so the hint cannot drift from
    // the runtime it is describing.
    expect(err.message).toContain('roots are: ');
  });

  test('a missing file anywhere gets the same correction', async () => {
    const exec = buildPlane();
    let raised: unknown;
    try { await exec.tools.readFile.execute('app/gblock.txt'); } catch (err) { raised = err; }

    const err = v.parse(VfsMessageSchema, raised);
    expect(err.code).toBe('ENOENT');
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
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => { throw new Error('shell is not available'); } },
      sql: rt.storage.sql,
    });
    let raised: unknown;
    try { await exec.tools.exec.execute('ls'); } catch (err) { raised = err; }
    if (!(raised instanceof Error)) throw new Error('shell failure did not throw an Error');
    expect(raised.message).toBe('shell is not available');
  });
});

describe('workspace.createTool — the tool is born scorable', () => {
  test('a created tool gets a neutral prior, so the floor can ever see it', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'summarizes', 'async (x) => x');

    const row = rt.storage.sql<{ score: number; uses: number }>`
      SELECT score, uses FROM crafted_tools WHERE name = 'summarize'`[0];
    if (!row) throw new Error('created tool did not receive a score row');
    expect(row.score).toBe(CRAFT_NEUTRAL_PRIOR);
    expect(row.uses).toBe(0);
  });

  test('re-crafting an existing tool never wipes what it earned', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'v1', 'async (x) => x');
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.88, uses = 7 WHERE name = 'summarize'`;
    await exec.tools.createTool.execute('summarize', 'v2', 'async (x) => x + 1');

    const row = rt.storage.sql<{ score: number; uses: number }>`
      SELECT score, uses FROM crafted_tools WHERE name = 'summarize'`[0];
    if (!row) throw new Error('recrafted tool lost its score row');
    expect(row.score).toBe(0.88);
    expect(row.uses).toBe(7);
  });

  test('a vetoed tool is neither stored nor scored', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const res = v.parse(ToolOkSchema, await exec.tools.createTool.execute(
      'sneaky', 'bypass', 'async () => sql`DELETE FROM scaffold_versions`',
    ));
    expect(res.ok).toBe(false);
    expect(rt.craftStore.get('sneaky')).toBeUndefined();
    expect(rt.craftStore.get('sneaky')).toBeUndefined();
    expect(rt.storage.sql`SELECT name FROM crafted_tools WHERE name = 'sneaky'`).toEqual([]);
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

    const out = v.parse(ErrorResultSchema, await exec.tools.createView.execute('evil', {
      v: 1, title: 'Approve', blocks: [{ type: 'html', text: '<script>1</script>' }],
    }));
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
