import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** workspace.* provider (InlineExecutor): listTools shape, case-preserving upserting createTool. */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { createTestRuntime, fileNamespaceFor, fileNamespaceOver, fileToolOver } from './helpers';
import { createInlineExecutor, type InlineExecutorDeps } from '../src/tools/inline-executor';
import { DefaultExecutionRouter } from '../src/execution/router';
import { craftPreference, craftPreferences } from '../src/craft/preference';

import { type FileDeps } from '../src/tools/file-operations';
import { FILE_READ_LINE_CHARS } from '../src/types/file-edits';

type FileToolInput = JsonObject & { readonly op: string };

import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { present, toolExecute } from '@kinu.run/test-utils';
import type { JsonValue, JsonObject } from '../src/utils/json';
import type { CraftedTool } from '../src/types/craft';
import { callCodemodeMember } from '../src/tools/sandbox-contract';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { cloudPlanes } from '../src/vfs/resolve';
import { namespaceDeclaration, nestedMembers } from '../src/tools/operation-surfaces';
import { describeProgramSource, programDeclarations } from '../src/tools/registry';
import { KINU_NODE_MODULE_SOURCE } from '../src/execution/codemode-node-shim';

/** A tool nothing has offered yet: chosen once in two offers, rated 3 of 5, by the smoothing. */
const UNMEASURED = craftPreference({ offered: 0, chosen: 0, rated: 0, rating_sum: 0 });

const ToolSummarySchema = v.object({
  name: v.string(),
  description: v.string(),
  preference: v.number(),
  broken: v.nullable(v.string()),
});

const ToolCreatedSchema = v.object({ ok: v.boolean(), name: v.string(), action: v.string() });

const ToolNamedSchema = v.object({ ok: v.boolean(), name: v.string() });

const ToolActionSchema = v.object({ ok: v.boolean(), action: v.string() });

const ToolOkSchema = v.object({ ok: v.boolean() });

function withFileTools(rt: ReturnType<typeof createTestRuntime>['rt'], exec: ReturnType<typeof createInlineExecutor>, files: Partial<FileDeps> = {}) {
  return { ...exec, tools: { ...fileNamespaceFor(rt, exec, files).tools, ...exec.tools } };
}

function buildExec(rt: ReturnType<typeof createTestRuntime>['rt'], slate?: InlineExecutorDeps['slate']) {
  const deps: InlineExecutorDeps = {
    filesOwner: 'agent',
    vfs: rt.storage.vfs,
    craftStore: rt.craftStore,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    sql: rt.storage.sql,
  };

  if (slate !== undefined) deps.slate = slate;

  return withFileTools(rt, createInlineExecutor(deps));
}

describe('workspace provider (InlineExecutor)', () => {
  test('a retired member called from a program names workspace.fs.text(path)', async () => {
    const workspace = buildExec(createTestRuntime().rt);
    const run = new Function('workspace', 'return (async () => await workspace.readFile("notes.md"))();');
    expect(await run(nestedMembers(Object.fromEntries(Object.entries(workspace.tools).map(([name, entry]) => [name, entry.execute])))))
      .toMatchObject({ success: false, reason: 'bad_input', error: expect.stringContaining('workspace.fs.text(path)') });
  });

  test('the Node fs adapter readdir returns entries past one file.list page', async () => {
    const { rt } = createTestRuntime();
    await rt.toolFiles.mkdir('many');
    const names = Array.from({ length: 1_007 }, (_, at) => `entry-${String(at).padStart(4, '0')}`);

    for (const name of names) await writeText(rt.toolFiles, `many/${name}`, name);
    const workspace = buildExec(rt);
    expect(await workspace.tools['fs.list'].execute('many')).toMatchObject({
      entries: names.slice(0, 1_000), truncated: { total: names.length, next: 1_000 },
    });
    const kinu: unknown = await import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`);
    const run = new Function('__kinu', 'workspace', 'cwd', 'const require = __kinu.createRequire({ workspace, builtins: {}, cwd }); return require("fs").promises.readdir("many");');

    expect(await run(kinu, nestedMembers(Object.fromEntries(Object.entries(workspace.tools).map(([name, entry]) => [name, entry.execute]))), WORKSPACE_ROOT)).toEqual(names);
  });

  // A program's `fs.appendFile` reads the file, joins, and writes it whole. A read that failed but did not say the file
  // is absent was ENOENT, so the append wrote the new bytes over the file's (the rc27 review).
  test('the Node fs adapter\'s append fails on a read that failed, and leaves the file as it was', async () => {
    const { rt } = createTestRuntime();
    await writeText(rt.toolFiles, 'journal.md', 'kept line\n');
    const members = Object.fromEntries(Object.entries(buildExec(rt).tools).map(([name, entry]) => [name, entry.execute]));
    const workspace = nestedMembers(members);
    const kinu: unknown = await import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`);

    // Read once this turn, so the plane would take a whole-file write over it; then the host's next read refused as
    // unavailable, as a store that did not answer refuses, and every other member as it is.
    expect(await present(members['fs.text'], 'fs.text')('journal.md')).toBe('kept line\n');
    const failingReads = nestedMembers({ ...members, 'fs.text': async () => ({ success: false, reason: 'unavailable', error: 'the file plane did not answer' }) });

    const append = new Function('__kinu', 'workspace', 'cwd', `const fs = __kinu.createRequire({ workspace, builtins: {}, cwd })("fs").promises;
      return fs.appendFile("journal.md", "new line\\n").then(() => null, (error) => error.code);`);

    expect(await append(kinu, failingReads, WORKSPACE_ROOT)).toBe('EIO');
    expect(await readText(rt.toolFiles, `${WORKSPACE_ROOT}/journal.md`)).toBe('kept line\n');
    // The real plane: an existing file is appended to, and a file stated absent starts empty.
    expect(await append(kinu, workspace, WORKSPACE_ROOT)).toBeNull();
    expect(await readText(rt.toolFiles, `${WORKSPACE_ROOT}/journal.md`)).toBe('kept line\nnew line\n');
    const fresh = new Function('__kinu', 'workspace', 'cwd', 'return __kinu.createRequire({ workspace, builtins: {}, cwd })("fs").promises.appendFile("fresh.md", "first\\n");');
    await fresh(kinu, workspace, WORKSPACE_ROOT);
    expect(await readText(rt.toolFiles, `${WORKSPACE_ROOT}/fresh.md`)).toBe('first\n');
  });

  test('the Node fs adapter reads ENOENT only where the host said the file is absent', async () => {
    const kinu: unknown = await import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`);

    const codeOf = new Function('__kinu', 'answer', `const fs = __kinu.createRequire({ workspace: { fs: { text: async () => answer, stat: async () => answer } }, builtins: {}, cwd: "/w" })("fs").promises;
      return Promise.all([fs.readFile("a.md", "utf8"), fs.readFile("a.md"), fs.stat("a.md"), fs.exists("a.md")].map((read) => read.then((value) => value, (error) => error.code)));`);

    expect(await codeOf(kinu, { success: false, reason: 'missing', error: 'no such file' })).toEqual(['ENOENT', 'ENOENT', 'ENOENT', false]);
    expect(await codeOf(kinu, { success: false, reason: 'unavailable', error: 'the file plane did not answer' })).toEqual(['EIO', 'EIO', 'EIO', 'EIO']);
    expect(await codeOf(kinu, { success: false, reason: 'denied', error: 'not yours' })).toEqual(['EACCES', 'EACCES', 'EACCES', 'EACCES']);
    expect(await codeOf(kinu, { success: false, reason: null, error: 'ENOENT: no such file: a.md' })).toEqual(['ENOENT', 'ENOENT', 'ENOENT', false]);
  });

  test('invalid file arguments are classified binding values, never refusal-shaped text', async () => {
    const { rt } = createTestRuntime();
    const provider = buildExec(rt);

    for (const name of ['fs.text', 'fs.write', 'fs.list']) {
      expect(await callCodemodeMember([provider], 'workspace', name, [null])).toMatchObject({ success: false, reason: 'bad_input' });
    }
  });

  test('listTools returns an array (not a string)', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'alpha', description: 'first',
      code: 'async () => "a"',
    });
    rt.craftStore.create({
      name: 'beta', description: 'second',
      code: 'async () => "b"',
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
      name: 'ghost', description: 'no row yet',
      code: 'async () => 1', createdAt: 0, updatedAt: 0,
    };

    const exec = createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, craftStore: { ...rt.craftStore, list: () => [ghost] },
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });

    expect(v.parse(v.array(ToolSummarySchema), await exec.tools.listTools.execute())).toEqual([
      { name: 'ghost', description: 'no row yet', preference: UNMEASURED, broken: null },
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

  test('createTool refuses statements over args, names the form a tool takes, and stores nothing', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    // The first is the body m905 saved. Spliced into the sandbox as `tools.textStats = (<source>)`, it failed every
    // later program with "Unexpected token 'const'", `return 42` included. The second parses and declares nothing.
    const statements = [
      "const text = String((args && args.text) || '');\nconst words = text.split(' ');\nreturn { words: words.length };",
      'for (const word of args.words) console.log(word);',
    ];

    for (const code of statements) {
      const result = await exec.tools.createTool.execute('textStats', 'counts words', code);

      expect(result).toMatchObject({ ok: false, reason: 'bad_input', error: expect.stringContaining('async (args) => {') });
      expect(rt.craftStore.get('textStats')).toBeUndefined();
    }
  });

  // Same-turn `tools.<name>()` is unsupported by design: createTool, then `tools.<name>` next turn.
});

/** workspace.fs.write over the real file plane: every path shape must survive the parent mkdir. */
describe('workspace.fs.write over the workspace filesystem — what both backends register', () => {
  function buildPlane() {
    const { rt, workspace } = createTestRuntime();

    // No machines are mounted in this fixture: absolute paths stay in its own workspace plane.
    const vfs = rt.storage.vfs;

    const exec = createInlineExecutor({
      filesOwner: 'agent',
      vfs, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });

    return { rt, vfs, exec: withFileTools(rt, exec), workspace };
  }

  test('a deep path creates its parents and round-trips', async () => {
    const { vfs, exec } = buildPlane();
    const result = await exec.tools["fs.write"].execute('notes/deep/todo.md', 'from codemode');
    expect(result).toMatchObject({ action: 'created' });
    expect(await readText(vfs, 'notes/deep/todo.md')).toBe('from codemode');
  });

  // The versioned store creates on revision 0 (nothing there), and checks every overwrite by the revision read.
  test('a create is checked by revision 0, an overwrite is checked by the revision read, and a peer\'s write refused', async () => {
    const { rt, vfs } = buildPlane();
    let peer: (() => Promise<void>) | null = null;
    const check = present(vfs.writeFileIfRevision?.bind(vfs), 'the store\'s check');

    // A peer's write that lands after the tool's own checks and before the store's: only the revision catches it.
    const racing: typeof vfs = {
      ...vfs,
      writeFileIfRevision: async (path, data, expected) => {
        const landing = peer;

        peer = null;
        await landing?.();

        return await check(path, data, expected);
      },
    };

    const file = toolExecute<FileToolInput, JsonValue>(fileToolOver({
      home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: racing, ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory: rt.memory,
    }));

    expect(await file({ op: 'write', path: 'plan.md', content: 'first\n' })).toMatchObject({ action: 'created', checked: 'revision' });
    await file({ op: 'read', path: 'plan.md' });
    expect(await file({ op: 'write', path: 'plan.md', content: 'second\n' })).toMatchObject({ action: 'replaced', checked: 'revision' });

    await file({ op: 'read', path: 'plan.md' });
    peer = async () => { await writeText(vfs, 'plan.md', 'the owner saved this\n'); };

    await expect(file({ op: 'write', path: 'plan.md', content: 'third\n' })).rejects.toMatchObject({ verdict: 'stale' });
    expect(await readText(vfs, 'plan.md')).toBe('the owner saved this\n');
  });

  test('an existing file cannot be overwritten before workspace.fs.text shows it', async () => {
    const { vfs, exec } = buildPlane();
    await writeText(vfs, 'victim.txt', 'keep me');

    // Callers branch on `reason`, and the declared codemode type promises it.
    expect(await exec.tools["fs.write"].execute('victim.txt', 'destroyed blind')).toEqual({
      success: false,
      error: expect.stringContaining('has no read that still counts'),
      reason: 'unread',
    });
    expect(await readText(vfs, 'victim.txt')).toBe('keep me');

    await exec.tools["fs.text"].execute('victim.txt');
    expect(await exec.tools["fs.write"].execute('victim.txt', 'replacement')).toMatchObject({ action: 'replaced' });
    expect(await readText(vfs, 'victim.txt')).toBe('replacement');
  });

  test('relative and absolute name the same file — one namespace, no prefixes', async () => {
    const { vfs, exec } = buildPlane();
    await exec.tools["fs.write"].execute('src/main.ts', 'a');
    expect(await readText(vfs, 'src/main.ts')).toBe('a');
    expect(await readText(vfs, '/home/main/src/main.ts')).toBe('a');
  });

  test('an unmounted /computer path remains an ordinary workspace path', async () => {
    const { exec, workspace } = buildPlane();
    // `/` is root's: a top-level directory is the kernel's to make and hand over, as a boot does.
    const { root } = await workspace.privileged();
    root.mkdir('computer');
    root.chown('computer', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    // "/computer/app.ts" is an ordinary local file: no path silently means two places.
    expect(await exec.tools["fs.write"].execute('/computer/app.ts', 'top')).toMatchObject({ action: 'created' });
    expect(await exec.tools['fs.text'].execute('/computer/app.ts')).toBe('top');
  });
});

/** workspace.fs and file share the actor's one served read-before-write ledger. */
describe('workspace.* and file.* share the read-before-write gate', () => {
  function sharedScope(rt: ReturnType<typeof createTestRuntime>['rt']) {
    const ledger = new TurnFileLedger();

    const exec = withFileTools(rt, createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    }), { ledger });

    const file = fileNamespaceOver(() => ({
      home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: rt.storage.vfs, ledger, budget: new TurnContextBudget(), memory: rt.memory,
    }));

    return {
      exec,
      edit: present(file.tools.edit, 'file.edit').execute,
      read: present(file.tools.read, 'file.read').execute,
      write: present(file.tools.write, 'file.write').execute,
    };
  }

  test('workspace.fs.text then file.edit: the read counts, the edit lands', async () => {
    const { rt } = createTestRuntime();
    await writeText(rt.storage.vfs, 'notes.md', 'Hello world');
    const { exec, edit } = sharedScope(rt);
    await exec.tools["fs.text"].execute('notes.md');

    expect(await edit('notes.md', [{ old_text: 'world', new_text: 'kinu' }])).toMatchObject({ path: 'notes.md' });
    expect(await readText(rt.storage.vfs, 'notes.md')).toBe('Hello kinu');
  });

  test('a line the file tool cut is covered once workspace.fs.text hands the program the whole file', async () => {
    const { rt } = createTestRuntime();
    await writeText(rt.storage.vfs, 'wide.md', `head\n${'w'.repeat(FILE_READ_LINE_CHARS + 500)}\ntail\n`);
    const { exec, read, write } = sharedScope(rt);

    await read('wide.md');
    expect(await write('wide.md', 'replacement')).toMatchObject({ success: false, reason: 'unread' });

    await exec.tools["fs.text"].execute('wide.md');
    expect(await write('wide.md', 'replacement')).toMatchObject({ action: 'replaced' });
    expect(await readText(rt.storage.vfs, 'wide.md')).toBe('replacement');
  });

  test('workspace.fs.text and the file gate agree on a BOM file for writes and edits', async () => {
    const { rt } = createTestRuntime();
    const body = `head\n${'w'.repeat(FILE_READ_LINE_CHARS + 500)}\ntail\n`;
    await writeText(rt.storage.vfs, 'bom.md', `\uFEFF${body}`);
    const { exec, read, write, edit } = sharedScope(rt);

    await read('bom.md');
    expect(await write('bom.md', 'wiped')).toMatchObject({ success: false, reason: 'unread' });
    expect(await exec.tools["fs.text"].execute('bom.md')).toBe(body);
    expect(await write('bom.md', 'replacement')).toMatchObject({ action: 'replaced' });
    expect(await readText(rt.storage.vfs, 'bom.md')).toBe('replacement');

    await writeText(rt.storage.vfs, 'bom-edit.md', '\uFEFFHello world\n');
    expect(await exec.tools["fs.text"].execute('bom-edit.md')).toBe('Hello world\n');
    expect(await edit('bom-edit.md', [{ old_text: 'world', new_text: 'kinu' }])).toMatchObject({ path: 'bom-edit.md' });
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await rt.storage.vfs.readFile('bom-edit.md'))).toBe('\uFEFFHello kinu\n');
  });

  test('workspace.fs.write then file.edit in the same program: the write counts as having read it', async () => {
    const { rt } = createTestRuntime();
    const { exec, edit } = sharedScope(rt);
    await exec.tools["fs.write"].execute('fresh.md', 'v1 content');

    expect(await edit('fresh.md', [{ old_text: 'v1', new_text: 'v2' }])).toMatchObject({ path: 'fresh.md' });
    expect(await readText(rt.storage.vfs, 'fresh.md')).toBe('v2 content');
  });

  test('the actor\'s served workspace.fs and native file tool see the same read state', async () => {
    const { rt } = createTestRuntime();
    await writeText(rt.storage.vfs, 'shared.md', 'shared content');
    const ledger = new TurnFileLedger();

    const exec = withFileTools(rt, createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    }), { ledger });

    await exec.tools["fs.text"].execute('shared.md');
    const fileTool = fileToolOver({ home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: rt.storage.vfs, ledger, budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<FileToolInput, JsonValue>(fileTool);

    expect(await execute({ op: 'edit', path: 'shared.md', edits: [{ old_text: 'shared', new_text: 'REPLACED' }] })).toMatchObject({ path: 'shared.md' });
    expect(await readText(rt.storage.vfs, 'shared.md')).toBe('REPLACED content');
  });

  test('independently served actors do not share read-before-write state', async () => {
    // These fixtures serve different actors' file operations and must not borrow each other's reads.
    const { rt } = createTestRuntime();
    await writeText(rt.storage.vfs, 'unshared.md', 'content');
    const exec = buildExec(rt);
    await exec.tools["fs.text"].execute('unshared.md');
    const fileTool = fileToolOver({ home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: rt.storage.vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory: rt.memory });
    const execute = toolExecute<FileToolInput, JsonValue>(fileTool);
    await expect(execute({ op: 'edit', path: 'unshared.md', edits: [{ old_text: 'content', new_text: 'changed' }] }))
      .rejects.toThrow('has no read that still counts');
  });
});

describe('declared resource limits', () => {
  test('the executor carries the limits of wherever its shell really runs, through listExecutors', () => {
    // The CLI shell passes its cgroup limits; the router must carry them to the prompt.
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      resourceLimits: { cpus: 1, memBytes: 2 * 1024 ** 3 },
    }));
    expect(router.listExecutors()[0]?.resourceLimits).toEqual({ cpus: 1, memBytes: 2 * 1024 ** 3 });

    const unbounded = new DefaultExecutionRouter();
    unbounded.register(createInlineExecutor({ filesOwner: 'agent', vfs: rt.storage.vfs, craftStore: rt.craftStore, shell: present(rt.shell, 'workspace shell') }));
    expect(unbounded.listExecutors()[0]).not.toHaveProperty('resourceLimits');
  });
});

/** A path `workspace.*` finds nothing at says how paths are read on this backend's planes. */
describe('workspace.* VFS errors carry how paths are read here', () => {
  function buildPlane() {
    const { rt } = createTestRuntime();
    const vfs = rt.storage.vfs;

    const exec = createInlineExecutor({
      filesOwner: 'agent',
      vfs, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      sql: rt.storage.sql,
    });

    return withFileTools(rt, exec);
  }

  test('a missing path keeps its errno and names where a relative path starts', async () => {
    const exec = buildPlane();

    for (const name of ['fs.list', 'fs.text']) {
      expect(await exec.tools[name].execute('app/gblock.txt')).toMatchObject({
        success: false, reason: 'missing', error: expect.stringContaining(cloudPlanes(WORKSPACE_ROOT).cwd),
      });
    }
  });

  test('a successful call is untouched by the guidance wrapper', async () => {
    const exec = buildPlane();
    await exec.tools["fs.write"].execute('notes/a.md', 'hello');
    expect(await exec.tools["fs.text"].execute('notes/a.md')).toBe('hello');
    expect(await exec.tools["fs.stat"].execute('notes/a.md')).toMatchObject({ isDir: false, size: 5 });
  });

  test('a non-VFS failure is not dressed up as an addressing problem', async () => {
    const { rt } = createTestRuntime();

    const exec = createInlineExecutor({
      filesOwner: 'agent',
      vfs: rt.storage.vfs, craftStore: rt.craftStore,
      shell: { exec: async () => { throw new Error('shell is not available'); } },
      sql: rt.storage.sql,
    });

    let raised: unknown;

    try { await exec.tools.exec.execute('ls'); } catch (err) { raised = err; }

    if (!(raised instanceof Error)) throw new Error('shell failure did not throw an Error');
    expect(raised.message).toBe('shell is not available');
  });
});

describe('workspace.createTool — the tool is born unmeasured', () => {
  test('a created tool has been offered nowhere and has not raised', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'summarizes', 'async (x) => x');

    expect(craftPreferences(rt.storage.sql).get('summarize')).toMatchObject({ offered: 0, chosen: 0, rated: 0, broken: null });
  });

  test('re-crafting an existing tool keeps what it earned and clears its broken flag', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'v1', 'async (x) => x');
    void rt.storage.sql`UPDATE crafted_tools SET offered = 9, chosen = 4, broken = 'TypeError: x is undefined' WHERE name = 'summarize'`;
    await exec.tools.createTool.execute('summarize', 'v2', 'async (x) => x + 1');

    expect(craftPreferences(rt.storage.sql).get('summarize')).toMatchObject({ offered: 9, chosen: 4, broken: null });
  });

  test('retireTool deletes the tool; a name nothing holds is refused', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt);

    await exec.tools.createTool.execute('summarize', 'summarizes', 'async (x) => x');
    expect(await exec.tools.retireTool.execute('summarize')).toEqual({ name: 'summarize', action: 'retired' });
    expect(rt.craftStore.get('summarize')).toBeUndefined();
    await expect(exec.tools.retireTool.execute('summarize')).rejects.toMatchObject({ code: 'missing' });
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
    const rt = createTestRuntime().rt;
    const exec = createInlineExecutor({ filesOwner: 'agent', vfs: rt.storage.vfs, craftStore: rt.craftStore, shell: present(rt.shell, 'workspace shell') });
    expect(exec.tools.slates).toBeUndefined();
    expect(namespaceDeclaration(exec.name, fileNamespaceFor(rt, exec).declarations ?? {})).not.toContain('  slates: {');
  });

  // The slates skill calls `workspace.slates.$list()`; on staging 5c522f12d describe() answered no `$` member at all.
  test("describe declares the `$` members the skill documents, and answers a member's name with the declaration holding it", () => {
    const { rt } = createTestRuntime();
    const exec = createInlineExecutor({ filesOwner: 'agent', vfs: rt.storage.vfs, craftStore: rt.craftStore, shell: present(rt.shell, 'workspace shell'), slate: async () => ({ ok: true, value: null }) });
    const declared = v.parse(v.function(), new Function(`${describeProgramSource(programDeclarations([fileNamespaceFor(rt, exec)]))}\nreturn describe;`)());
    const slates = v.parse(v.string(), declared('workspace.slates'));

    for (const member of ['$list()', '$fork(version)', '$preview()', '$restore(version)', '$share(options)']) expect(slates).toContain(member);
    // rc22 dashboards: describe('workspace.slates.$list') answers the declaration that declares it.
    expect(declared('workspace.slates.$list')).toBe(slates);
    expect(() => declared('workspace.slates.$nothing')).toThrow('describe: nothing is named "workspace.slates.$nothing"; describe(\'workspace.slates\') declares what it holds');
  });

  test('invalid operation fields are refused before the available host is called', async () => {
    const { rt } = createTestRuntime();
    const exec = buildExec(rt, async () => { throw new Error('invalid operation reached the host'); });
    expect(await exec.tools.slates.execute({ op: 'commit', id: '../outside' })).toMatchObject({ success: false, reason: 'bad_input' });
    expect(await exec.tools.slates.execute({ op: 'call', id: 'notes', method: 'echo', args: [() => 1] })).toMatchObject({ success: false, reason: 'bad_input' });
  });
});
