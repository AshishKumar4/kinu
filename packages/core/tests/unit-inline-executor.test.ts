/** workspace.* provider (InlineExecutor): listTools shape, case-preserving upserting createTool. */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { createInlineExecutor, type InlineExecutorDeps } from '../src/execution/inline';
import { DefaultExecutionRouter } from '../src/execution/router';
import { CRAFT_NEUTRAL_PRIOR } from '../src/craft/in-episode';
import { createFileTool, type FileToolInput } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '../src/utils/json';
import type { CraftedTool } from '../src/types/craft';
import { callCodemodeMember } from '../src/tools/sandbox-contract';

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

function buildExec(rt: ReturnType<typeof createTestRuntime>['rt'], slate?: InlineExecutorDeps['slate']) {
  const deps: InlineExecutorDeps = {
    vfs: rt.storage.vfs,
    memory: rt.memory,
    craftStore: rt.craftStore,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    sql: rt.storage.sql,
  };

  if (slate !== undefined) deps.slate = slate;

  return createInlineExecutor(deps);
}

describe('workspace provider (InlineExecutor)', () => {
  test('invalid file and memory arguments are classified binding values, never refusal-shaped text', async () => {
    const { rt } = createTestRuntime();
    const provider = buildExec(rt);

    for (const name of ['readFile', 'searchMemory', 'saveNote']) {
      expect(await callCodemodeMember([provider], 'workspace', name, [null])).toMatchObject({ success: false, reason: 'bad_input' });
    }
  });

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
    expect(result.name).toBe('multiplyNumbers');
    expect(result.name).not.toBe('multiplynumbers');
    expect(result.action).toBe('created');

    const stored = rt.craftStore.get('multiplyNumbers');

    if (!stored) throw new Error('created tool was not stored');
    expect(stored.name).toBe('multiplyNumbers');
  });

  const SANITIZED_NAMES = [
    {
      name: 'createTool sanitizes invalid identifier chars without lowercasing',
      asked: 'Weird Name-With.Chars!', got: 'Weird_Name_With_Chars_',
    },
    {
      name: 'createTool prepends _ when name starts with a digit',
      asked: '2ndAttempt', got: '_2ndAttempt',
    },
  ];

  for (const sanitized of SANITIZED_NAMES) {
    test(sanitized.name, async () => {
      const { rt } = createTestRuntime();
      const exec = buildExec(rt);

      const result = v.parse(ToolNamedSchema, await exec.tools.createTool.execute(
        sanitized.asked,
        'test',
        'async () => 1',
      ));

      expect(result.ok).toBe(true);
      expect(result.name).toBe(sanitized.got);
    });
  }

  test('createTool upserts — re-creating the SAME name updates the code, no duplicate row', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    const first = v.parse(ToolActionSchema, await exec.tools.createTool.execute(
      'greet',
      'Say hi',
      'async () => "hello"',
    ));

    expect(first.action).toBe('created');
    expect(rt.craftStore.list().length).toBe(1);

    const second = v.parse(ToolActionSchema, await exec.tools.createTool.execute(
      'greet',
      'Say hi v2',
      'async () => "hello v2"',
    ));

    expect(second.action).toBe('updated');
    expect(rt.craftStore.list().length).toBe(1);

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

    for (const name of ['shell', 'mcp_github_get']) {
      const result = await exec.tools.createTool.execute(name, 'shadow', 'async () => 1');
      expect(result).toMatchObject({ ok: false, reason: 'bad_input', error: expect.stringContaining(name) });
      expect(rt.craftStore.get(name)).toBeUndefined();
    }
  });

  test('createTool refuses statements over args and stores nothing, so no later program can break on them', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);
    // The body m905 saved. Spliced into the sandbox as `tools.textStats = (<source>)`, it failed every later
    // program with "Unexpected token 'const'", `return 42` included.
    const statements = "const text = String((args && args.text) || '');\nconst words = text.split(' ');\nreturn { words: words.length };";

    const result = await exec.tools.createTool.execute('textStats', 'counts words', statements);

    expect(result).toMatchObject({ ok: false, reason: 'bad_input', error: expect.stringContaining('createTool("textStats")') });
    expect(rt.craftStore.get('textStats')).toBeUndefined();
  });

  // Same-turn `tools.<name>()` is unsupported by design: createTool, then `tools.<name>` next turn.
});

/** workspace.writeFile over the real file plane: every path shape must survive the parent mkdir. */
describe('workspace.writeFile over the workspace filesystem — what both backends register', () => {
  function buildPlane() {
    const { rt } = createTestRuntime();
    const dirs: string[] = [];

    const sandbox = {
      files: new Map<string, string>(),
      dirs,
    };

    // The container is reached only through `sandbox.*`, never from here.
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
    expect(result).toContain('Written');
    expect(await vfs.readFile('notes/deep/todo.md', { encoding: 'utf8' })).toBe('from codemode');
  });

  test('an existing file cannot be overwritten before workspace.readFile shows it', async () => {
    const { vfs, exec } = buildPlane();
    await vfs.writeFile('victim.txt', 'keep me');

    // Callers branch on `reason`, and the declared codemode type promises it.
    expect(await exec.tools.writeFile.execute('victim.txt', 'destroyed blind')).toEqual({
      success: false,
      error: expect.stringContaining('has not been read here yet'),
      reason: 'unread',
    });
    expect(await vfs.readFile('victim.txt', { encoding: 'utf8' })).toBe('keep me');

    await exec.tools.readFile.execute('victim.txt');
    expect(await exec.tools.writeFile.execute('victim.txt', 'replacement')).toContain('Written');
    expect(await vfs.readFile('victim.txt', { encoding: 'utf8' })).toBe('replacement');
  });

  test('relative and absolute name the same file — one namespace, no prefixes', async () => {
    const { vfs, exec } = buildPlane();
    await exec.tools.writeFile.execute('src/main.ts', 'a');
    expect(await vfs.readFile('src/main.ts', { encoding: 'utf8' })).toBe('a');
    expect(await vfs.readFile('/home/main/src/main.ts', { encoding: 'utf8' })).toBe('a');
  });

  test('another environment is not addressable from here at all', async () => {
    const { exec, sandbox } = buildPlane();
    // "/sandbox/app.ts" is an ordinary local file: no path silently means two places.
    expect(await exec.tools.writeFile.execute('/sandbox/app.ts', 'top')).toContain('Written');
    expect(sandbox.files.size).toBe(0);
  });
});

/** workspace.editFile shares the native `file` tool's read-before-write gate and, with a ledger thunk, its state. */
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

    // Naming anchor, count and file lets the model widen the anchor on retry.
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

    await exec.tools.readFile.execute('shared.md');
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
    // Without `ledger`, workspace.* has a private ledger that does not satisfy the native gate.
    const { rt } = createTestRuntime();
    await rt.storage.vfs.writeFile('unshared.md', 'content');
    const exec = buildExec(rt);
    await exec.tools.readFile.execute('unshared.md');
    const fileTool = createFileTool({ vfs: rt.storage.vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<FileToolInput, JsonValue>(fileTool);
    await expect(execute({ action: 'edit', path: 'unshared.md', edits: [{ old_text: 'content', new_text: 'changed' }] }))
      .rejects.toThrow('has not been read here yet');
  });
});

describe('declared resource limits', () => {
  test('the executor carries the limits of wherever its shell really runs, through listExecutors', () => {
    // The CLI shell passes its cgroup limits; the router must carry them to the prompt.
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

/** `workspace.*` is not the container: a bare ENOENT for '/app' must teach why. */
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
    expect(err.code).toBe('ENOENT');
    expect(err.message).toContain('ENOENT');
    expect(err.message).toContain('own virtual filesystem');
    expect(err.message).toContain('NOT the machine or container');
    expect(err.message).toContain('`shell` tool');
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

describe('workspace.slates', () => {
  test('an absent host is omitted from callable and declared capabilities', () => {
    const exec = buildExec(createTestRuntime().rt);
    expect(exec.tools.slates).toBeUndefined();
    expect(exec.types).not.toContain('const slates');
  });

  test('invalid operation fields are refused before the available host is called', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt, async () => { throw new Error('invalid operation reached the host'); });
    expect(await exec.tools.slates.execute({ op: 'commit', id: '../outside' })).toMatchObject({ success: false, reason: 'bad_input' });
    expect(await exec.tools.slates.execute({ op: 'call', id: 'notes', method: 'echo', args: [() => 1] })).toMatchObject({ success: false, reason: 'bad_input' });
  });
});
