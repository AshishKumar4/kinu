/**
 * The `eval` sandbox under workerd: DynamicWorkerExecutor launched by `CodemodeLauncher`, with `kinu-node.js` and the `tools` prelude.
 * The loader, child isolate, `nodejs_compat` builtins and sandbox RPC hop are platform, so `bun test` cannot host this.
 */
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { admitCraftedSource, cloudPlanes, decodeJsonValue, failedToolOutcome, successfulToolOutcome, withCodemodeProgram, craftedFailureFunctions, nativeToolFunctions, WORKSPACE_ROOT, type ToolOutcome, type JsonValue } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { generateText, isStepCount, tool, jsonSchema } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { KinuSandboxExecutor, codemodeLauncher, renderToolsPrelude } from '../../src/codemode-sandbox';
import { BROWSER_PRELUDE } from '../../src/browser-prelude';
import { createWebCodemodeProvider, type WebSearchProvider } from '@kinu.run/core';

const files = new Map<string, string>([[`${WORKSPACE_ROOT}/notes.md`, 'hello from the workspace']]);

/** Arguments arrive positionally over the sandbox RPC, as every production provider parses them. */
const text = (args: unknown[], at: number): string => v.parse(v.string(), args[at]);

/** Immediate children of `dir` by name, as the workspace VFS lists them; a directory with nothing under it is absent. */
function children(dir: string): string[] {
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  const names = [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split('/')[0]);

  if (names.length === 0) throw new Error('no such directory');

  return [...new Set(names)];
}

const workspace = {
  name: 'workspace',
  fns: {
    readFile: async (...args: unknown[]) => {
      const path = text(args, 0);
      const stored = files.get(path);

      if (stored === undefined) throw new Error(`ENOENT: no such file: ${path}`);

      return stored;
    },
    writeFile: async (...args: unknown[]) => {
      files.set(text(args, 0), text(args, 1));

      return 'ok';
    },
    readdir: async (...args: unknown[]) => children(text(args, 0)),
    exists: async (...args: unknown[]) => files.has(text(args, 0)),
    exec: async (...args: unknown[]) => `ran: ${text(args, 0)}`,
  },
};

function toolsProvider(crafted: Array<{ name: string; code: string; description: string }>, cwd = WORKSPACE_ROOT) {
  return {
    name: 'tools',
    fns: {
      ...Object.fromEntries(Object.entries(craftedFailureFunctions(crafted)).map(([name, entry]) => [name, entry.execute])),
      file: async (...args: unknown[]) => ({ echoed: decodeJsonValue({ value: args[0] }) }),
    },
    prelude: renderToolsPrelude(crafted, { cwd, workspace: 'probe' }),
  };
}

const state = new Map<string, JsonValue>();

const stateProvider = {
  name: 'state',
  fns: {
    get: async (...args: unknown[]) => state.get(text(args, 0)) ?? null,
    set: async (...args: unknown[]) => {
      state.set(text(args, 0), decodeJsonValue({ value: args[1] }));

      return { ok: true };
    },
  },
};

describe('the eval sandbox under workerd', () => {
  const executor = new KinuSandboxExecutor(codemodeLauncher({ kinuNode: true, egress: null }));

  test('hosted codemode distinguishes returned data, handled refusal, and unhandled failure', async () => {
    const outcomes: ToolOutcome[] = [];

    const program = createCodeTool({
      executor,
      tools: [{ name: 'workspace', types: '', tools: {
        exec: { description: 'Return a branchable command refusal', execute: async () => ({ reason: 'denied', error: 'not run' }) },
      } }],
    });

    const invoke = async (code: string) => {
      let step = 0;

      const model = scriptedTurnModel({ doGenerate: () => ({
        content: ++step === 1
          ? [{ type: 'tool-call', toolCallId: 'program-1', toolName: 'program', input: JSON.stringify({ code }) }]
          : [{ type: 'text', text: 'done' }],
        finishReason: { unified: step === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
      }) });

      return generateText({ model, prompt: 'Run the program', tools: { program }, stopWhen: isStepCount(2),
        onToolExecutionEnd: ({ toolOutput }) => { outcomes.push(toolOutput.type === 'tool-result' ? { success: true } : failedToolOutcome({ cause: toolOutput.error })); },
      });
    };

    await invoke('return { reason: "denied", error: "historical incident", exitCode: 7 };');
    await invoke('const refusal = await workspace.exec("blocked"); return refusal.reason;');
    const failed = await invoke('console.log("before failure"); throw new Error("denied is just diagnostic text");');
    expect(outcomes).toEqual([{ success: true }, { success: true }, { success: false, reason: null }]);
    expect(JSON.stringify(failed.responseMessages)).toContain('before failure');
    expect(JSON.stringify(failed.responseMessages)).toContain('denied is just diagnostic text');
  });

  test('require("fs/promises") and require("path") work over the workspace, and console output comes back', async () => {
    const program = [
      '// Read a note through the Node fs shim',
      "const fs = require('fs/promises');",
      "const path = require('node:path');",
      "const text = await fs.readFile('notes.md', 'utf8');",
      "await fs.writeFile(path.join('out', 'copy.md'), text.toUpperCase());",
      "await fs.appendFile('./out/copy.md', '!');",
      "console.log('read', text.length, 'bytes');",
      "const kinds = [(await fs.stat('notes.md')).isFile(), (await fs.stat('out')).isDirectory()];",
      "return { text, kinds, listing: await fs.readdir('.'), workspace: env.workspace };",
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider([]), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      text: 'hello from the workspace',
      kinds: [true, true],
      listing: ['notes.md', 'out'],
      workspace: 'probe',
    });
    expect(result.logs).toEqual(['read 24 bytes']);
    expect(files.get(`${WORKSPACE_ROOT}/out/copy.md`)).toBe('HELLO FROM THE WORKSPACE!');
  });

  test('process.cwd() is the working root, where fs resolves a relative path and names it in its errors', async () => {
    const program = [
      '// Probe the working directory and a relative directory that is not there',
      "const fs = require('fs/promises');",
      "const missing = await fs.readdir('skills').then(() => 'listed', (error) => error.message);",
      'return { cwd: process.cwd(), nextTick: typeof process.nextTick, missing };',
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider([]), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      cwd: WORKSPACE_ROOT,
      nextTick: 'function',
      missing: `ENOENT: no such directory, scandir '${WORKSPACE_ROOT}/skills'`,
    });
  });

  test('a native tool is tools.<name>(input), a crafted tool is defined by the prelude and sees its siblings', async () => {
    const crafted = [
      { name: 'double', code: 'async (n) => n * 2', description: 'doubles' },
      { name: 'quad', code: 'async (n) => (await tools.double(n)) * 2', description: 'quadruples' },
    ];

    const program = [
      '// Call a native tool and two crafted tools',
      "const native = await tools.file({ action: 'read', path: 'notes.md' });",
      'return { native, quad: await tools.quad(3) };',
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ native: { echoed: { action: 'read', path: 'notes.md' } }, quad: 12 });
  });

  test('admitted crafted source retains the module metadata of its hosted runtime', async () => {
    const admitted = admitCraftedSource('async () => import.meta', 'metadata');

    if (!admitted.ok) throw new Error(admitted.error);

    const result = await executor.execute(
      'const metadata = await tools.metadata(); return { type: typeof metadata, same: metadata === import.meta };',
      [toolsProvider([{ name: 'metadata', code: admitted.code, description: '' }])],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ type: 'object', same: true });
  });

  test('a crafted tool that does not parse breaks only itself, with the parse error on call', async () => {
    const crafted = [
      { name: 'broken', code: 'const broken = async () => 1', description: '' },
      { name: 'fine', code: 'async () => 2', description: '' },
    ];

    const program = [
      '// One broken tool must not take the sandbox down',
      'let failure = null;',
      'const refused = await tools.broken(); if (refused.success === false) failure = refused.error;',
      'return { fine: await tools.fine(), failure };',
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      fine: 2,
      failure: expect.stringContaining('[crafted:broken] failed to load: stored source does not parse'),
    });
  });

  test('a stored body may await at its top level, and one that evaluates to a value fails by name', async () => {
    // An awaiting body passes the host parse gate, so the factory must be async; a non-function value poisons only itself.
    const crafted = [
      { name: 'waited', code: 'await Promise.resolve(async (n) => n * 3)', description: '' },
      { name: 'value', code: '42', description: '' },
    ];

    const program = [
      '// An awaited definition is callable; a value is a named failure',
      'let failure = null;',
      'const refused = await tools.value(); if (refused.success === false) failure = refused.error;',
      'return { waited: await tools.waited(5), failure };',
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      waited: 15,
      failure: expect.stringContaining('[crafted:value] is not a function: its stored source evaluates to number'),
    });
  });

  test('state survives between two programs, and a host failure is attributed to its namespace member', async () => {
    const first = await executor.execute("// save\nawait state.set('n', 41); return 'saved'", [toolsProvider([]), stateProvider, workspace]);
    expect(first.result).toBe('saved');
    const second = await executor.execute("// load\nreturn (await state.get('n')) + 1", [toolsProvider([]), stateProvider, workspace]);
    expect(second.result).toBe(42);

    const failed = await executor.execute(
      "// read a file that is not there\nreturn await workspace.readFile('absent.md')",
      [toolsProvider([]), stateProvider, workspace],
    );

    expect(failed.error).toBeUndefined();
    expect(failed.result).toEqual({ success: false, reason: null, error: 'ENOENT: no such file: absent.md' });
  });

  test('host rejections and native refusals use one value; recovery and propagation keep their binding census', async () => {
    const native = nativeToolFunctions({ file: tool({
      inputSchema: jsonSchema<{ action: string }>({ type: 'object' }),
      execute: async (): Promise<string> => { throw new KinuError('unavailable', 'file plane offline'); },
    }) }, undefined);

    const providers = [{ name: 'tools', fns: Object.fromEntries(Object.entries(native).map(([name, entry]) => [name, entry.execute])) }];
    const run = (code: string) => withCodemodeProgram(() => executor.execute(code, providers));
    const recovered = await run('const failure = await tools.file({action:"read"}); if (failure.success === false) return failure.reason; throw new Error("missing failure shape");');
    expect(recovered.result).toBe('unavailable');
    expect(successfulToolOutcome('eval', { output: recovered })).toEqual({ success: true, failures: [
      { success: false, tool: 'file', action: 'read', reason: 'unavailable', error: 'file plane offline' },
    ] });

    for (const code of ['return await tools.file({action:"read"});', 'throw await tools.file({action:"read"});']) {
      let caught: unknown;

      try { await run(code); } catch (cause) { caught = cause; }

      expect(caught).toBeInstanceOf(Error);
      expect(failedToolOutcome({ cause: caught })).toMatchObject({ success: false, reason: 'unavailable', failures: [
        { tool: 'file', action: 'read', reason: 'unavailable' },
      ] });
    }
  });

  test('fetch is absent without egress and reaches the network stack through the loopback entrypoint', async () => {
    const program = "// probe the network\ntry { await fetch('https://example.invalid/'); return 'reached'; } catch (e) { return 'threw: ' + e.message; }";
    const offline = await executor.execute(program, [toolsProvider([]), stateProvider, workspace]);
    expect(String(offline.result)).toContain('threw: ');

    // The loopback stub `enable_ctx_exports` mints for the exported class.
    const online = new KinuSandboxExecutor(codemodeLauncher({ kinuNode: true, egress: { workspace: null, actor: null } }));
    const result = await online.execute(program, [toolsProvider([]), stateProvider, workspace]);
    // `.invalid` resolves for nobody: the network's own failure comes back via the marked 502, not a sandbox refusal.
    expect(String(offline.result)).toContain('not permitted to access the internet');
    expect(String(result.result)).toContain('threw: fetch failed: ');
    expect(String(result.result)).not.toContain('not permitted to access the internet');
  });

  test('a program cannot reach cloud metadata, and is told why', async () => {
    // Refused by the shared classifier before any DNS lookup or socket, as shell and `web.fetch` refuse it.
    const online = new KinuSandboxExecutor(codemodeLauncher({ kinuNode: true, egress: { workspace: null, actor: null } }));
    const program = "// probe the metadata service\ntry { await fetch('http://169.254.169.254/latest/meta-data/'); return 'reached'; } catch (e) { return 'threw: ' + e.message; }";

    const result = await online.execute(program, [toolsProvider([]), stateProvider, workspace]);

    expect(String(result.result)).toContain('threw: fetch failed: ');
    expect(String(result.result)).toContain('blocked private/internal address');
    expect(String(result.result)).not.toContain('reached');
  });

  test("a browser member's sandbox-side refusal is recorded as the program's failure, as a host member's is", async () => {
    const unused = async (): Promise<never> => { throw new Error('this program reaches no web provider'); };

    const provider: WebSearchProvider = { search: unused, fetch: unused, render: unused, screenshot: unused };

    const web = createWebCodemodeProvider({ provider, files: null, sessions: { missing: 'no sessions here' }, prelude: { source: BROWSER_PRELUDE } });
    const fns = Object.fromEntries(Object.entries(web.tools).map(([name, entry]) => [name, (...args: unknown[]) => entry.execute(...args)]));
    const online = new KinuSandboxExecutor(codemodeLauncher({ kinuNode: true, egress: { workspace: null, actor: null } }));

    const ran = await withCodemodeProgram(() => online.execute(
      "// reach a browser this agent did not open, then list tools on something that is no page\n"
      + "const browser = await web.connectBrowser('not-mine'); const tools = await web.pageTools({}); return { browser, tools };",
      [{ name: 'web', fns, prelude: web.prelude }],
    ));

    expect(ran.result).toMatchObject({
      browser: { success: false, reason: 'denied', error: expect.stringContaining('is not one this agent opened') },
      tools: { success: false, reason: 'unavailable' },
    });
    expect(successfulToolOutcome('eval', { output: ran })).toMatchObject({ success: true, failures: [
      { tool: 'web', action: 'connectBrowser', reason: 'denied' },
      { tool: 'web', action: 'pageTools', reason: 'unavailable' },
    ] });
  });

  test('a module import names the workspace binding, and a crafted body reads and writes files through it', async () => {
    // The live eval's first and corrected attempts at `report_totals` (packages/cli-backend/tests/crafting-flow.test.ts).
    const imported = await executor.execute("// read with node:fs\nconst fs = await import('fs');\nreturn fs.readFileSync('notes.md');", [toolsProvider([]), workspace]);
    expect(imported.error).toContain('No such module "node:fs"');
    expect(imported.error).toContain('`await workspace.readFile(path)`');

    const crafted = [{
      name: 'copy_notes',
      code: 'async (args) => { await workspace.writeFile(args.to, (await workspace.readFile(args.from)).toUpperCase()); return await workspace.readFile(args.to); }',
      description: '',
    }];

    const copied = await executor.execute(
      `return await tools.copy_notes({ from: '${WORKSPACE_ROOT}/notes.md', to: '${WORKSPACE_ROOT}/copy.md' });`,
      [toolsProvider(crafted), workspace],
    );

    expect(copied.error).toBeUndefined();
    expect(copied.result).toBe('HELLO FROM THE WORKSPACE');
  });

  test("child_process, fs and path are Node's over the workspace: output is text, only a refusal fails a call", async () => {
    // Members answer as the binding delivers them: output as text, a failed command as a refusal carrying its exit.
    const read: string[] = [];

    const shell = {
      name: 'workspace',
      fns: {
        exec: async (...args: unknown[]) => {
          const command = text(args, 0);

          if (command.startsWith('false')) return { success: false, reason: 'io', error: 'Error (exit 1)\n--- stderr ---\nnope', execution: { exitCode: 1 } };

          return command.startsWith('printf') ? 'Error (exit 3)\n--- stderr ---\nprinted, not failed' : `ran: ${command}`;
        },
        readFile: async (...args: unknown[]) => {
          read.push(text(args, 0));

          return '{"reason":"io","error":"a saved API error"}';
        },
      },
    };

    const program = [
      '// Node builtins over the workspace binding',
      "const { exec } = require('child_process');",
      "const fs = require('fs/promises');",
      "const ran = await exec('ls -la');",
      "const failed = await exec('false').then(() => null, (error) => ({ code: error.code, stderr: error.stderr, message: error.message }));",
      "const viaCallback = await new Promise((resolve) => exec('echo hi', (error, stdout) => resolve(error ? error.message : stdout)));",
      "const looksFailed = await exec('printf x');",
      "const saved = await fs.readFile('saved.json', 'utf8');",
      "await fs.readFile('vfs://notes/a.md', 'utf8'); await fs.readFile('local://src/b.ts', 'utf8');",
      "let missing = null; try { require('left-pad'); } catch (error) { missing = error.message; }",
      "return { ran, failed, viaCallback, looksFailed, saved, joined: require('path').join('a', 'b'), prefixed: require('node:path') === require('path'), missing, available: require.available };",
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider([]), shell]);

    expect(result.error).toBeUndefined();
    const ran = v.parse(v.record(v.string(), v.unknown()), result.result);

    expect(ran.ran).toEqual({ stdout: 'ran: ls -la', stderr: '' });
    expect(ran.failed).toMatchObject({ code: 1, stderr: 'nope', message: expect.stringContaining('Command failed: false') });
    expect(ran.viaCallback).toBe('ran: echo hi');
    expect(ran.looksFailed).toEqual({ stdout: 'Error (exit 3)', stderr: 'printed, not failed' });
    expect(ran.saved).toBe('{"reason":"io","error":"a saved API error"}');
    expect([ran.joined, ran.prefixed]).toEqual(['a/b', true]);
    expect(ran.missing).toContain("Cannot find module 'left-pad'");
    // The shim's own modules beside the platform's nodejs_compat builtins.
    expect(ran.available).toEqual(expect.arrayContaining(['buffer', 'child_process', 'fs', 'fs/promises', 'path']));
    // A prefixed path reaches the host's resolver as written; a relative one joins the working directory.
    expect(read).toEqual([`${WORKSPACE_ROOT}/saved.json`, 'vfs://notes/a.md', 'local://src/b.ts']);
  });

  test("a crafted body that raises, or throws while it loads, or awaits what is not there, breaks only its own name", async () => {
    const crafted = [
      { name: 'boom', code: 'async () => { throw new Error("inner"); }', description: '' },
      { name: 'dead', code: '(() => { throw new Error("no such helper"); })()', description: '' },
      { name: 'waiter', code: 'await foo()', description: '' },
      { name: 'fine', code: 'async () => 2', description: '' },
    ];

    const program = [
      '// Each broken tool fails by its own name; its sibling still runs',
      'const failures = {};',
      "for (const name of ['boom', 'dead', 'waiter']) { const refused = await tools[name](); failures[name] = refused.success === false ? refused.error : refused; }",
      'return { fine: await tools.fine(), failures };',
    ].join('\n');

    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      fine: 2,
      failures: {
        boom: expect.stringContaining('[crafted:boom] inner'),
        dead: expect.stringContaining('[crafted:dead] failed to load: no such helper'),
        waiter: expect.stringContaining('foo is not defined'),
      },
    });
  });

  // Release review, 2026-10-04: every program's `process` started in the workspace root, so a hosted actor's
  // relative paths missed its own home.
  test("a hosted actor's program starts in its own home, where a relative path lands", async () => {
    const home = cloudPlanes('/home/sub-hosted').cwd;

    files.set(`${home}/plan.md`, 'the hire\'s own plan');

    const program = "// read a relative path\nconst fs = require('fs/promises');\nreturn { cwd: process.cwd(), plan: await fs.readFile('plan.md', 'utf8') };";
    const result = await executor.execute(program, [toolsProvider([], home), stateProvider, workspace]);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ cwd: '/home/sub-hosted', plan: 'the hire\'s own plan' });
  });

  test("agents.swarm's typed caps cross the sandbox boundary as numbers", async () => {
    // A number dropped or stringified on the crossing would fall back to the preset's defaults, not refuse.
    const received: unknown[] = [];

    const swarm = async (...args: unknown[]) => {
      received.push(args[0]);

      return { ok: true };
    };

    const agents = { name: 'agents', fns: { swarm } };

    const result = await executor.execute(
      "// ask for a small swarm\nreturn await agents.swarm({ task: 'review the diff', preset: 'ideate', branches: 2, depth: 1 });",
      [toolsProvider([]), agents],
    );

    expect(result.error).toBeUndefined();
    expect(received).toEqual([{ task: 'review the diff', preset: 'ideate', branches: 2, depth: 1 }]);
  });

  test('a bare native tool name is corrected toward tools.<name>', async () => {
    const result = await executor.execute("// misuse\nreturn await shell({ command: 'ls' })", [toolsProvider([]), stateProvider, workspace]);
    expect(result.error).toContain('"shell" is a native Kinu tool');
    expect(result.error).toContain('`tools.shell(input)`');
  });
});
