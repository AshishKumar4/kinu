// The Node `eval` factory must match the CF codemode sandbox: capture console.* as `logs` (stdout is the
// `kinu exec --json` event stream) and implicit-return a trailing expression.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';
import type { CodemodeProvider, CraftedToolSet, JsonValue } from '@kinu.run/core';
import { CODEMODE_CODE_DESCRIPTION, WORKSPACE_ROOT } from '@kinu.run/core';
import { toolExecute, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { inWorkMode, successfulToolOutcome, renderDynamicContextBlock, runChat, DynamicContextLedger, craftedToolDeclarations } from '@kinu.run/core';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface ExecuteToolResult {
  result: JsonValue | undefined;
  logs?: string[];
  error?: string;
}

type ExecuteTool = (args: { code: string }) => Promise<ExecuteToolResult>;

function makeTool(): ExecuteTool {
  const factory = createNodeCodemodeToolFactory();

  return toolExecute(factory({ native: {}, craftedTools: () => ({}), providers: [] }));
}

describe('createNodeCodemodeToolFactory — the code field the model reads', () => {
  test('the input schema describes a script body, not an arrow function', () => {
    const built = createNodeCodemodeToolFactory()({ native: {}, craftedTools: () => ({}), providers: [] });

    const schema = v.parse(v.object({
      jsonSchema: v.object({
        properties: v.object({ code: v.object({ description: v.string() }) }),
        required: v.array(v.string()),
      }),
    }), built.inputSchema).jsonSchema;

    expect(schema.properties.code.description).toBe(CODEMODE_CODE_DESCRIPTION);
    expect(schema.required).toEqual(['code']);
  });
});

describe('createNodeCodemodeToolFactory — console capture + implicit return', () => {
  test('saving a crafted tool preserves the native description and makes the next call usable', async () => {
    let crafted: CraftedToolSet = {};
    const factory = createNodeCodemodeToolFactory();
    const surface = { native: {}, craftedTools: () => crafted, providers: [] };
    const first = factory(surface);
    crafted = { cache_echo: { description: 'Return the supplied text', execute: async (text) => text } };
    const next = factory(surface);

    expect(next.description).toBe(first.description);
    expect(craftedToolDeclarations({ eval: first }, { workMode: 'build', allowedTools: ['eval'] }))
      .toEqual([{ name: 'cache_echo', description: 'Return the supplied text' }]);
    expect(craftedToolDeclarations({ eval: first }, { workMode: 'build', allowedTools: [] })).toEqual([]);
    expect(await toolExecute<{ code: string }, ExecuteToolResult>(next)({ code: 'return await tools.cache_echo("CACHE_ECHO_OK");' }))
      .toEqual({ result: 'CACHE_ECHO_OK' });
  });

  test('the provider sees the callable declaration in the ledger and a real call returns its output', async () => {
    const codemode = createNodeCodemodeToolFactory()({ native: {}, providers: [], craftedTools: () => ({
      cache_echo: { description: 'Return the supplied text', execute: async (text) => text },
    }) });

    const tools = { eval: codemode };
    let calls = 0;

    const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
      const invoke = calls++ === 0;

      return {
        content: invoke
          ? [{ type: 'tool-call', toolName: 'eval', toolCallId: 'echo', input: JSON.stringify({ code: 'return await tools.cache_echo("CACHE_ECHO_OK");' }) }]
          : [{ type: 'text', text: 'done' }],
        finishReason: { unified: invoke ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
      };
    } });

    for await (const event of runChat({ model, system: 'Use the available tools.', history: [{ role: 'user', content: 'Invoke the echo function.' }], tools,
      dynamicContext: { ledger: new DynamicContextLedger(), snapshot: () => ({
        craftedTools: craftedToolDeclarations(tools, { workMode: 'build', allowedTools: ['eval'] }),
      }) },
    })) {
      if (event.type === 'error') throw new Error(event.message);
    }

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('cache_echo(...args');
    expect(JSON.stringify(model.doStreamCalls[0]?.tools)).not.toContain('cache_echo');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt.filter((message) => message.role === 'tool'))).toContain('CACHE_ECHO_OK');
  });

  test('console output is captured and returned as logs, not written to stdout', async () => {
    const out = await makeTool()({
      code: 'const a = "hello";\nconsole.log(a, 42);\nconsole.log({ x: 1 });',
    });

    expect(out.logs).toEqual(['hello 42', '{"x":1}']);
  });

  test('a trailing bare expression is the tool result (implicit return)', async () => {
    const out = await makeTool()({ code: 'const x = 6 * 7;\nx' });
    expect(out.result).toBe(42);
  });

  test('executes a codemode callable with trailing comments once', async () => {
    const out = await makeTool()({ code: 'async () => { console.log("once"); return 42; } // result' });
    expect(out.result).toBe(42);
    expect(out.logs).toEqual(['once']);
  });

  test('code that prints its answer without an explicit return still reaches the model via logs', async () => {
    const out = await makeTool()({ code: 'const x = 21 + 21;\nconsole.log(x)' });
    expect(out.logs).toEqual(['42']);
  });

  // A `new Function` body sees no module scope and Bun has no `require` global, yet the description advertises `require`.
  test('require resolves the Node builtins inside the sandbox', async () => {
    const out = await makeTool()({ code: 'const path = require("node:path");\nreturn path.join("a", "b");' });
    expect(out).toEqual({ result: 'a/b' });
  });

  test('a throw still surfaces the console output produced before it', async () => {
    const pending = makeTool()({ code: 'console.log("before");\nthrow new Error("boom");' });
    await expect(pending).rejects.toThrow('boom');
    await expect(pending).rejects.toThrow('Console output:\nbefore');
  });

  test('no console call means no logs field', async () => {
    const out = await makeTool()({ code: 'return 1 + 1;' });
    expect(out.result).toBe(2);
    expect(out.logs).toBeUndefined();
  });

  // `shell` is a native tool, not a codemode binding; the error must say where it lives, not a bare ReferenceError.
  test('calling the native `shell` tool from inside eval gets an actionable hint, not a bare ReferenceError', async () => {
    const pending = makeTool()({ code: 'return await shell({ runtime: "sandbox", command: "ls" });' });
    await expect(pending).rejects.toThrow('shell is not defined');
    await expect(pending).rejects.toThrow('"shell" is a native Kinu tool');
    await expect(pending).rejects.toThrow('`tools.shell(input)`');
    // The pointer comes from TOOL_REACH, so it is right for every native tool.
    await expect(pending).rejects.toThrow('through the `workspace` namespace');
  });

  test('an unrelated ReferenceError for a name that is not a native tool stays a bare message', async () => {
    const pending = makeTool()({ code: 'return totallyUndefinedThing;' });
    await expect(pending).rejects.toThrow('totallyUndefinedThing is not defined');
    await expect(pending).rejects.not.toThrow('native Kinu tool');
  });
});

function makeToolWithFailingProvider(error: Error) {
  const calls: string[] = [];

  const provider: CodemodeProvider = {
    name: 'workspace',
    tools: {
      readdir: {
        description: 'list',
        execute: async (path) => { calls.push(String(path)); throw error; },
      },
    },
  };

  const factory = createNodeCodemodeToolFactory({
    extraProviders: [provider],
  });

  const execute = toolExecute<{ code: string }, ExecuteToolResult>(
    factory({ native: {}, craftedTools: () => ({}), providers: [] }),
  );

  return { execute, calls };
}

describe('createNodeCodemodeToolFactory — a failing host call can never kill the process', () => {
  test('a FLOATED rejecting provider call does not become an unhandled rejection', async () => {
    // An unawaited rejecting call must not escape: Bun kills the CLI mid-turn on an unhandled rejection.
    const { execute, calls } = makeToolWithFailingProvider(
      new Error("ENOENT: no such file or directory, scandir '/app'"),
    );

    const out = await execute({ code: 'workspace.readdir("/app");\n"kept going"' });

    expect(calls).toEqual(['/app']);
    expect(out.result).toBe('kept going');
    await new Promise((r) => setTimeout(r, 20));
  });

  test('an AWAITED rejecting provider call still returns the real error to the model', async () => {
    const { execute } = makeToolWithFailingProvider(
      new Error("ENOENT: no such file or directory, scandir '/app' — workspace.* is the agent's own virtual filesystem"),
    );

    const pending = execute({ code: 'const e = await workspace.readdir("/app");\ne' });
    await expect(pending).rejects.toThrow('ENOENT');
    await expect(pending).rejects.toThrow("workspace.* is the agent's own virtual filesystem");
  });

  test('a host rejection is an inspectable failure value; recovery preserves the inner census', async () => {
    const { execute } = makeToolWithFailingProvider(new Error('ENOENT: nope'));

    const out = await execute({
      code: 'const failure = await workspace.readdir("/app"); if (failure.success === false) return "caught:" + failure.error; throw new Error("missing failure discriminant");',
    });

    expect(out.result).toBe('caught:ENOENT: nope');
    expect(successfulToolOutcome('eval', { output: out })).toEqual({ success: true, failures: [
      { success: false, tool: 'file', action: null, reason: null, error: 'ENOENT: nope' },
    ] });
  });

  test('the tool description tells the model what workspace.* actually is', async () => {
    const factory = createNodeCodemodeToolFactory();
    const built = factory({ native: {}, craftedTools: () => ({}), providers: [] });
    expect(built.description).toContain('canonical durable workspace');
    expect(built.description).toContain('`shell` with runtime "workspace"');
  });

  test('every wired namespace is DECLARED to the model, not just bound', async () => {
    // Each provider's `types` must reach the description, or its callables are reachable but undiscoverable.
    // Capability and executor providers arrive by different routes.
    const factory = createNodeCodemodeToolFactory({
      extraProviders: [{
        name: 'memory',
        types: 'export declare const memory: {\n  save(content: string): Promise<unknown>;\n};\n',
        tools: { save: { description: 'save a note', execute: async () => 'ok' } },
      }],
    });

    const built = factory({
      native: {},
      craftedTools: () => ({}),
      providers: [{
        name: 'workspace',
        types: 'export declare const workspace: {\n  readdir(path: string): Promise<string[]>;\n};\n',
        tools: { readdir: { description: 'list a directory', execute: async () => [] } },
      }],
    });

    expect(built.description).toContain('export declare const memory: {');
    expect(built.description).toContain('save(content: string)');
    expect(built.description).toContain('export declare const workspace: {');
    expect(built.description).toContain('Namespaces bound in this sandbox:');
    expect(built.description).toContain('canonical durable workspace');
  });
});

describe('createNodeCodemodeToolFactory — crafted tools, on the episode clock', () => {
  function makeToolOverStore(store: Map<string, CraftedToolSet[string]['execute']>): ExecuteTool {
    const built = createNodeCodemodeToolFactory()({
      native: {},
      craftedTools: () => Object.fromEntries(
        [...store].map(([name, execute]) => [name, { description: name, execute }]),
      ),
      providers: [],
    });

    return toolExecute(built);
  }

  test('a tool crafted mid-turn is callable on the very next execute', async () => {
    const store = new Map<string, CraftedToolSet[string]['execute']>();
    const execute = makeToolOverStore(store);

    const before = await execute({ code: 'return typeof tools.double;' });
    expect(before.result).toBe('undefined');

    store.set('double', async (n) => Number(n) * 2);

    const after = await execute({ code: 'return await tools.double(21);' });
    expect(after.result).toBe(42);
  });

  test('`tools.<name>` is the one callable form — the cross-backend contract', async () => {
    const store = new Map<string, CraftedToolSet[string]['execute']>([
      ['double', async (n) => Number(n) * 2],
    ]);

    const out = await makeToolOverStore(store)({ code: 'return await tools.double(2);' });
    expect(out.result).toBe(4);
  });

  test('a provider may not take one of the fixed namespaces', async () => {
    // `new Function` rejects duplicate parameter names, so a provider named `tools` would crash.
    const provider: CodemodeProvider = {
        name: 'tools',
        tools: { hijack: { description: 'x', execute: async () => 'provider' } },
    };

    const built = createNodeCodemodeToolFactory({ extraProviders: [provider] })({
      native: {},
      craftedTools: () => ({ real: { description: 'r', execute: async () => 'crafted' } }),
      providers: [],
    });

    const execute = toolExecute<{ code: string }, ExecuteToolResult>(built);
    const out = await execute({ code: 'return await tools.real();' });
    expect(out.result).toBe('crafted');
  });
});

describe('createNodeCodemodeToolFactory — native tools under tools.<name>', () => {
  function surfaceWith(shellExec: (input: { command: string }) => Promise<string>) {
    return {
      eval: tool({
        description: 'the sandbox itself',
        inputSchema: jsonSchema<{ code: string }>({ type: 'object' }),
        execute: async () => 'never',
      }),
      shell: tool({
        description: 'Run a shell command over the canonical durable workspace.',
        inputSchema: jsonSchema<{ command: string }>({
          type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
        }),
        execute: async (input) => shellExec(input),
      }),
    };
  }

  test('a native tool is callable as tools.<name>(input) with the native input object', async () => {
    // The shared docstring promises `tools.<name>(input)` for every native tool.
    const seen: string[] = [];

    const built = createNodeCodemodeToolFactory()({
      native: surfaceWith(async ({ command }) => {
        seen.push(command);

        return `ran ${command}`;
      }),
      craftedTools: () => ({}),
      providers: [],
    });

    const out = await toolExecute<{ code: string }, ExecuteToolResult>(built)({
      code: 'return await tools.shell({ command: "ls" });',
    });

    expect(out.error).toBeUndefined();
    expect(out.result).toBe('ran ls');
    expect(seen).toEqual(['ls']);
  });

  test('native declarations stay in the tool and crafted declarations ride the live ledger', () => {
    const built = createNodeCodemodeToolFactory()({
      native: surfaceWith(async () => ''),
      craftedTools: () => ({ double: { description: 'Doubles a number', execute: async () => 2 } }),
      providers: [],
    });

    expect(built.description).toContain('export declare const tools: {');
    expect(built.description).toContain('shell(input: { command: string }): Promise<unknown>;');
    expect(built.description).not.toContain('double(...args: unknown[]): Promise<unknown>;');
    expect(renderDynamicContextBlock({ craftedTools: [{ name: 'double', description: 'Doubles a number' }] }))
      .toContain('double(...args: unknown[]): Promise<unknown>;');
    expect(built.description).not.toContain('eval(input');
  });

  test('the sandbox does not bind its own entry', async () => {
    const built = createNodeCodemodeToolFactory()({
      native: surfaceWith(async () => ''),
      craftedTools: () => ({}),
      providers: [],
    });

    const out = await toolExecute<{ code: string }, ExecuteToolResult>(built)({
      code: 'return typeof tools.eval;',
    });

    expect(out.result).toBe('undefined');
  });
});

/** A workspace over a map that answers a missing file the way the host does: a refusal value, not a throw. */
function mapWorkspace(files: Map<string, string>, commands: string[]): CodemodeProvider {
  return {
    name: 'workspace',
    tools: {
      readFile: {
        description: 'read',
        execute: async (path) => files.get(String(path))
          ?? { success: false, reason: 'missing', error: `ENOENT: no such file or directory, open '${String(path)}'` },
      },
      writeFile: {
        description: 'write',
        execute: async (path, content) => {
          files.set(String(path), String(content));

          return 'ok';
        },
      },
      exists: { description: 'exists', execute: async (path) => files.has(String(path)) },
      exec: {
        description: 'run',
        execute: async (command) => {
          commands.push(String(command));

          return 'ran';
        },
      },
    },
  };
}

test('a program writes only into the workspace it was given, and Plan refuses before any effect', async () => {
  // The eval-harness leak: `solution.mjs` landed in the CLI process's cwd, the repo root.
  const name = `kinu-leak-probe-${crypto.randomUUID()}.mjs`;
  const machinePath = join(process.cwd(), name);
  const files = new Map<string, string>();
  const commands: string[] = [];

  const execute = toolExecute<{ code: string }, ExecuteToolResult>(
    createNodeCodemodeToolFactory({ extraProviders: [mapWorkspace(files, commands)] })({ native: {}, craftedTools: () => ({}), providers: [] }),
  );

  const code = [
    '// Write the solution beside the program and run its test',
    `await require('fs/promises').writeFile(${JSON.stringify(name)}, 'export const solve = () => 1;');`,
    "await require('child_process').exec('echo ran');",
    'return process.cwd();',
  ].join('\n');

  try {
    await expect(inWorkMode('plan', () => execute({ code }))).rejects.toMatchObject({ code: 'denied' });
    expect(files.size).toBe(0);
    expect(await execute({ code })).toMatchObject({ result: WORKSPACE_ROOT });
    expect(files.get(`${WORKSPACE_ROOT}/${name}`)).toBe('export const solve = () => 1;');
    expect(commands).toEqual(['echo ran']);
    expect(existsSync(machinePath)).toBe(false);
  } finally {
    rmSync(machinePath, { force: true });
  }
});
