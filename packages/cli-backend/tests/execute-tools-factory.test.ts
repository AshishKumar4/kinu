// The Node `execute_tools` factory runs the model's code in-process. Two
// behaviours it must match the CF codemode sandbox on: capture console.* (so it
// never leaks to the CLI's stdout, which under `kinu exec --json` IS the
// event stream) and return it as `logs`; and implicit-return a trailing bare
// expression so the model gets its value instead of undefined. Code is
// multi-line — one statement per line — as the model actually writes it, which
// is what the shared addImplicitReturn is built for.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import type { CodemodeProvider, CraftedToolSet, JsonValue } from '@kinu.run/core';
import { toolExecute } from '@kinu.run/test-utils';
import { createNodeExecuteToolFactory } from '../src/execute-tools-factory';

interface ExecuteToolResult {
  result: JsonValue | undefined;
  logs?: string[];
  error?: string;
}

type ExecuteTool = (args: { code: string }) => Promise<ExecuteToolResult>;

function makeTool(): ExecuteTool {
  const factory = createNodeExecuteToolFactory();
  return toolExecute(factory({ native: {}, craftedTools: () => ({}), providers: [] }));
}

describe('createNodeExecuteToolFactory — console capture + implicit return', () => {
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

  test('code that prints its answer without an explicit return still reaches the model via logs', async () => {
    const out = await makeTool()({ code: 'const x = 21 + 21;\nconsole.log(x)' });
    expect(out.logs).toEqual(['42']);
  });

  test('a throw still surfaces the console output produced before it', async () => {
    const out = await makeTool()({ code: 'console.log("before");\nthrow new Error("boom");' });
    expect(out.error).toContain('boom');
    expect(out.logs).toEqual(['before']);
  });

  test('no console call means no logs field', async () => {
    const out = await makeTool()({ code: 'return 1 + 1;' });
    expect(out.result).toBe(2);
    expect(out.logs).toBeUndefined();
  });

  // `run` is a native top-level tool, not a codemode binding — reaching for
  // it here is a ReferenceError, and a bare "run is not defined" gives the
  // model no idea why. Real evidence from production (2026-08-12 debug
  // audit): a model wrote exactly this and got only the bare V8 message back.
  test('calling the native `run` tool from inside execute_tools gets an actionable hint, not a bare ReferenceError', async () => {
    const out = await makeTool()({ code: 'return await run({ runtime: "sandbox", command: "ls" });' });
    expect(out.error).toContain('run is not defined');
    expect(out.error).toContain('"run" is a native Kinu tool');
    expect(out.error).toContain('`tools.run(input)`');
    // Where the capability actually is now comes from TOOL_REACH, so the
    // pointer is the namespace rather than one hand-picked member — and it is
    // right for all eight native tools instead of only `run`.
    expect(out.error).toContain('through the `workspace` namespace');
  });

  test('an unrelated ReferenceError for a name that is not a native tool stays a bare message', async () => {
    const out = await makeTool()({ code: 'return totallyUndefinedThing;' });
    expect(out.error).toContain('totallyUndefinedThing is not defined');
    expect(out.error).not.toContain('native Kinu tool');
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
  const factory = createNodeExecuteToolFactory({
    extraProviders: [provider],
  });
  const tool = toolExecute<{ code: string }, ExecuteToolResult>(
    factory({ native: {}, craftedTools: () => ({}), providers: [] }),
  );
  return { tool, calls };
}

describe('createNodeExecuteToolFactory — a failing host call can never kill the process', () => {
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
    const out = await tool({ code: 'const e = await workspace.readdir("/app");\ne' });

    expect(out.result).toBeUndefined();
    expect(out.error).toContain('ENOENT');
    expect(out.error).toContain("workspace.* is the agent's own virtual filesystem");
  });

  test('a rejection caught by the model\'s own code is handled there, not swallowed', async () => {
    const { tool } = makeToolWithFailingProvider(new Error('ENOENT: nope'));
    const out = await tool({
      code: 'try { await workspace.readdir("/app"); } catch (e) { return "caught:" + e.message }',
    });
    expect(out.result).toBe('caught:ENOENT: nope');
  });

  test('the tool description tells the model what workspace.* actually is', async () => {
    const factory = createNodeExecuteToolFactory();
    const built = factory({ native: {}, craftedTools: () => ({}), providers: [] });
    expect(built.description).toContain('canonical durable workspace');
    expect(built.description).toContain('`run` with runtime "workspace"');
  });

  test('every wired namespace is DECLARED to the model, not just bound', async () => {
    // The defect this locks: the description was BUILTIN_TOOL_DESCRIPTIONS
    // .execute_tools alone, and adaptExecutorProvider collected each provider's
    // `types` without ever reading one. So the CLI model was handed
    // `memory.*`, `tasks.*`, `agents.*`, `web.*` and `llm.*` as live callables
    // and told about none of them — a whole reachable surface it could not
    // discover. Both a capability provider and an executor provider are
    // included here because the two arrive by different routes.
    const factory = createNodeExecuteToolFactory({
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

describe('createNodeExecuteToolFactory — crafted tools, on the episode clock', () => {
  /** A crafted set that changes between calls, the way the CraftStore does
   *  when the model crafts a tool mid-turn. */
  function makeToolOverStore(store: Map<string, CraftedToolSet[string]['execute']>): ExecuteTool {
    const built = createNodeExecuteToolFactory()({
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
    // `tools` used to be a crash waiting to happen rather than a shadowed name.
    const provider: CodemodeProvider = {
        name: 'tools',
        tools: { hijack: { description: 'x', execute: async () => 'provider' } },
    };
    const built = createNodeExecuteToolFactory({ extraProviders: [provider] })({
      native: {},
      craftedTools: () => ({ real: { description: 'r', execute: async () => 'crafted' } }),
      providers: [],
    });
    const execute = toolExecute<{ code: string }, ExecuteToolResult>(built);
    const out = await execute({ code: 'return await tools.real();' });
    expect(out.result).toBe('crafted');
  });
});

describe('createNodeExecuteToolFactory — native tools under tools.<name>', () => {
  /** A finished surface the way buildActorTools hands it in: the sandbox's own
   *  entry beside the native tools it declares. */
  function surfaceWith(run: (input: { command: string }) => Promise<string>) {
    return {
      execute_tools: tool({
        description: 'the sandbox itself',
        inputSchema: jsonSchema<{ code: string }>({ type: 'object' }),
        execute: async () => 'never',
      }),
      run: tool({
        description: 'Run a shell command over the canonical durable workspace.',
        inputSchema: jsonSchema<{ command: string }>({
          type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
        }),
        execute: async (input) => run(input),
      }),
    };
  }

  test('a native tool is callable as tools.<name>(input) with the native input object', async () => {
    // The defect this locks, reproduced 2026-09-05: the shared docstring said
    // every native tool is `tools.<name>(input)` and the CLI bound none of
    // them, so `tools.run(...)` answered `tools.run is not a function`.
    const seen: string[] = [];
    const built = createNodeExecuteToolFactory()({
      native: surfaceWith(async ({ command }) => { seen.push(command); return `ran ${command}`; }),
      craftedTools: () => ({}),
      providers: [],
    });
    const out = await toolExecute<{ code: string }, ExecuteToolResult>(built)({
      code: 'return await tools.run({ command: "ls" });',
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toBe('ran ls');
    expect(seen).toEqual(['ls']);
  });

  test('the declaration lists the native tools and the crafted tools, and never the sandbox itself', () => {
    const built = createNodeExecuteToolFactory()({
      native: surfaceWith(async () => ''),
      craftedTools: () => ({ double: { description: 'Doubles a number', execute: async () => 2 } }),
      providers: [],
    });
    expect(built.description).toContain('export declare const tools: {');
    expect(built.description).toContain('run(input: { command: string }): Promise<unknown>;');
    expect(built.description).toContain('double(...args: unknown[]): Promise<unknown>;');
    expect(built.description).not.toContain('execute_tools(input');
  });

  test('the sandbox does not bind its own entry', async () => {
    const built = createNodeExecuteToolFactory()({
      native: surfaceWith(async () => ''),
      craftedTools: () => ({}),
      providers: [],
    });
    const out = await toolExecute<{ code: string }, ExecuteToolResult>(built)({
      code: 'return typeof tools.execute_tools;',
    });
    expect(out.result).toBe('undefined');
  });
});
