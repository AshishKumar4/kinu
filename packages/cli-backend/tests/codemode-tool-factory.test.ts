// The Node `eval` factory runs the model's code in-process. Two
// behaviours it must match the CF codemode sandbox on: capture console.* (so it
// never leaks to the CLI's stdout, which under `kinu exec --json` IS the
// event stream) and return it as `logs`; and implicit-return a trailing bare
// expression so the model gets its value.
// The transform reads JavaScript structure, including multiline expressions.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';
import type { CodemodeProvider, CraftedToolSet, JsonValue } from '@kinu.run/core';
import { CODEMODE_CODE_DESCRIPTION } from '@kinu.run/core';
import { scratchDir, toolExecute, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { inWorkMode, successfulToolOutcome, renderDynamicContextBlock, runChat, DynamicContextLedger, craftedToolDeclarations } from '@kinu.run/core';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

  // The shared description tells the model the Node builtins and `require`
  // are the machine's own, and its example is `require('fs/promises')`. Red on
  // 2026-09-05: a `new Function` body sees no module scope and Bun has no
  // `require` global, so the example answered a bare ReferenceError.
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

  // `shell` is a native top-level tool, not a codemode binding — reaching for
  // it here is a ReferenceError, and a bare "run is not defined" gives the
  // model no idea why. Real evidence from production (2026-08-12 debug
  // audit): a model wrote exactly this and got only the bare V8 message back.
  test('calling the native `shell` tool from inside eval gets an actionable hint, not a bare ReferenceError', async () => {
    const pending = makeTool()({ code: 'return await shell({ runtime: "sandbox", command: "ls" });' });
    await expect(pending).rejects.toThrow('shell is not defined');
    await expect(pending).rejects.toThrow('"shell" is a native Kinu tool');
    await expect(pending).rejects.toThrow('`tools.shell(input)`');
    // Where the capability actually is now comes from TOOL_REACH, so the
    // pointer is the namespace rather than one hand-picked member — and it is
    // right for all eight native tools instead of only `shell`.
    await expect(pending).rejects.toThrow('through the `workspace` namespace');
  });

  test('an unrelated ReferenceError for a name that is not a native tool stays a bare message', async () => {
    const pending = makeTool()({ code: 'return totallyUndefinedThing;' });
    await expect(pending).rejects.toThrow('totallyUndefinedThing is not defined');
    await expect(pending).rejects.not.toThrow('native Kinu tool');
  });
});

/** A provider namespace whose calls reject, like the host-bridged `workspace.*`
 *  VFS does when the model addresses a path the agent's filesystem has no idea
 *  about. */
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

  const tool = toolExecute<{ code: string }, ExecuteToolResult>(
    factory({ native: {}, craftedTools: () => ({}), providers: [] }),
  );

  return { tool, calls };
}

describe('createNodeCodemodeToolFactory — a failing host call can never kill the process', () => {
  test('a FLOATED rejecting provider call does not become an unhandled rejection', async () => {
    // The production crash: the model forgets `await`, workspace.readdir('/app')
    // rejects with ENOENT, nothing is handling that promise, and Bun kills the
    // CLI mid-turn. bun:test fails this test if the rejection escapes, which is
    // exactly the signal we want.
    const { tool, calls } = makeToolWithFailingProvider(
      new Error("ENOENT: no such file or directory, scandir '/app'"),
    );

    const out = await tool({ code: 'workspace.readdir("/app");\n"kept going"' });

    expect(calls).toEqual(['/app']);
    expect(out.result).toBe('kept going');
    // Give the rejection every chance to surface before the test ends.
    await new Promise((r) => setTimeout(r, 20));
  });

  test('an AWAITED rejecting provider call still returns the real error to the model', async () => {
    const { tool } = makeToolWithFailingProvider(
      new Error("ENOENT: no such file or directory, scandir '/app' — workspace.* is the agent's own virtual filesystem"),
    );

    const pending = tool({ code: 'const e = await workspace.readdir("/app");\ne' });
    await expect(pending).rejects.toThrow('ENOENT');
    await expect(pending).rejects.toThrow("workspace.* is the agent's own virtual filesystem");
  });

  test('a host rejection is an inspectable failure value; recovery preserves the inner census', async () => {
    const { tool } = makeToolWithFailingProvider(new Error('ENOENT: nope'));

    const out = await tool({
      code: 'const failure = await workspace.readdir("/app"); if (failure.success === false) return "caught:" + failure.error; throw new Error("missing failure discriminant");',
    });

    expect(out.result).toBe('caught:ENOENT: nope');
    expect(successfulToolOutcome('eval', out)).toEqual({ success: true, failures: [
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
    // The defect this locks: the description was BUILTIN_TOOL_DESCRIPTIONS
    // .eval alone, and adaptExecutorProvider collected each provider's
    // `types` without ever reading one. So the CLI model was handed
    // `memory.*`, `tasks.*`, `agents.*`, `web.*` and `llm.*` as live callables
    // and told about none of them — a whole reachable surface it could not
    // discover. Both a capability provider and an executor provider are
    // included here because the two arrive by different routes.
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
    // And the registry doctrine is still there — this added a half, not replaced one.
    expect(built.description).toContain('canonical durable workspace');
  });
});

describe('createNodeCodemodeToolFactory — crafted tools, on the episode clock', () => {
  /** A crafted set that changes between calls, the way the CraftStore does
   *  when the model crafts a tool mid-turn. */
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
    const tool = makeToolOverStore(store);

    const before = await tool({ code: 'return typeof tools.double;' });
    expect(before.result).toBe('undefined');

    // What workspace.createTool does to the store, mid-turn.
    store.set('double', async (n) => Number(n) * 2);

    const after = await tool({ code: 'return await tools.double(21);' });
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
    // `new Function` rejects duplicate parameter names, so a provider called
    // `tools` would be a crash rather than a shadowed name.
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
  /** A finished surface the way buildActorTools hands it in: the sandbox's own
   *  entry beside the native tools it declares. */
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
    // The defect this locks, reproduced 2026-09-05: the shared docstring said
    // every native tool is `tools.<name>(input)` and the CLI bound none of
    // them, so `tools.shell(...)` answered `tools.shell is not a function`.
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

test('Plan refuses native JavaScript before it can use machine require, while Build stays native', async () => {
  const directory = scratchDir('plan-native');
  const path = join(directory, 'native-write');

  const execute = makeTool();
  const code = 'require("node:fs").writeFileSync(' + JSON.stringify(path) + ', "native effect"); return "done";';
  await expect(inWorkMode('plan', () => execute({ code }))).rejects.toMatchObject({ code: 'denied' });
  expect(existsSync(path)).toBe(false);
  expect(await execute({ code })).toMatchObject({ result: 'done' });
  expect(await readFile(path, 'utf8')).toBe('native effect');
});
