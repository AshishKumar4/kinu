// The Node `execute_tools` factory runs the model's code in-process. Two
// behaviours it must match the CF codemode sandbox on: capture console.* (so it
// never leaks to the CLI's stdout, which under `proteus exec --json` IS the
// event stream) and return it as `logs`; and implicit-return a trailing bare
// expression so the model gets its value instead of undefined. Code is
// multi-line — one statement per line — as the model actually writes it, which
// is what the shared addImplicitReturn is built for.
import { describe, expect, test } from 'bun:test';
import { createNodeExecuteToolFactory } from '../src/execute-tools-factory.js';

interface ExecTool {
  execute: (args: { code: string }, options?: unknown) => Promise<{ result: unknown; logs?: string[]; error?: string }>;
}

function makeTool(): ExecTool {
  const factory = createNodeExecuteToolFactory();
  return factory({ craftedTools: () => ({}), providers: [], loader: {} }) as unknown as ExecTool;
}

describe('createNodeExecuteToolFactory — console capture + implicit return', () => {
  test('console output is captured and returned as logs, not written to stdout', async () => {
    const out = await makeTool().execute({
      code: 'const a = "hello";\nconsole.log(a, 42);\nconsole.log({ x: 1 });',
    });
    expect(out.logs).toEqual(['hello 42', '{"x":1}']);
  });

  test('a trailing bare expression is the tool result (implicit return)', async () => {
    const out = await makeTool().execute({ code: 'const x = 6 * 7;\nx' });
    expect(out.result).toBe(42);
  });

  test('code that prints its answer without an explicit return still reaches the model via logs', async () => {
    const out = await makeTool().execute({ code: 'const x = 21 + 21;\nconsole.log(x)' });
    expect(out.logs).toEqual(['42']);
  });

  test('a throw still surfaces the console output produced before it', async () => {
    const out = await makeTool().execute({ code: 'console.log("before");\nthrow new Error("boom");' });
    expect(out.error).toContain('boom');
    expect(out.logs).toEqual(['before']);
  });

  test('no console call means no logs field', async () => {
    const out = await makeTool().execute({ code: 'return 1 + 1;' });
    expect(out.result).toBe(2);
    expect(out.logs).toBeUndefined();
  });

  // `run` is a native top-level tool, not a codemode binding — reaching for
  // it here is a ReferenceError, and a bare "run is not defined" gives the
  // model no idea why. Real evidence from production (2026-08-12 debug
  // audit): a model wrote exactly this and got only the bare V8 message back.
  test('calling the native `run` tool from inside execute_tools gets an actionable hint, not a bare ReferenceError', async () => {
    const out = await makeTool().execute({ code: 'return await run({ runtime: "sandbox", command: "ls" });' });
    expect(out.error).toContain('run is not defined');
    expect(out.error).toContain('"run" is a native Proteus tool, not a codemode member');
    expect(out.error).toContain('workspace.exec(...)');
  });

  test('an unrelated ReferenceError for a name that is not a native tool stays a bare message', async () => {
    const out = await makeTool().execute({ code: 'return totallyUndefinedThing;' });
    expect(out.error).toContain('totallyUndefinedThing is not defined');
    expect(out.error).not.toContain('native Proteus tool');
  });
});

/** A provider namespace whose calls reject, like the host-bridged `workspace.*`
 *  VFS does when the model addresses a path the agent's filesystem has no idea
 *  about. */
function makeToolWithFailingProvider(error: Error) {
  const calls: string[] = [];
  const factory = createNodeExecuteToolFactory({
    extraProviders: [{
      name: 'workspace',
      tools: {
        readdir: { description: 'list', execute: async (path: unknown) => { calls.push(String(path)); throw error; } },
      },
    } as never],
  });
  return { tool: factory({ craftedTools: () => ({}), providers: [], loader: {} }) as unknown as ExecTool, calls };
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
    const out = await tool.execute({ code: 'workspace.readdir("/app");\n"kept going"' });

    expect(calls).toEqual(['/app']);
    expect(out.result).toBe('kept going');
    // Give the rejection every chance to surface before the test ends.
    await new Promise((r) => setTimeout(r, 20));
  });

  test('an AWAITED rejecting provider call still returns the real error to the model', async () => {
    const { tool } = makeToolWithFailingProvider(
      new Error("ENOENT: no such file or directory, scandir '/app' — workspace.* is the agent's own virtual filesystem"),
    );
    const out = await tool.execute({ code: 'const e = await workspace.readdir("/app");\ne' });

    expect(out.result).toBeUndefined();
    expect(out.error).toContain('ENOENT');
    expect(out.error).toContain("workspace.* is the agent's own virtual filesystem");
  });

  test('a rejection caught by the model\'s own code is handled there, not swallowed', async () => {
    const { tool } = makeToolWithFailingProvider(new Error('ENOENT: nope'));
    const out = await tool.execute({
      code: 'try { await workspace.readdir("/app"); } catch (e) { return "caught:" + e.message }',
    });
    expect(out.result).toBe('caught:ENOENT: nope');
  });

  test('the tool description tells the model what workspace.* actually is', async () => {
    const factory = createNodeExecuteToolFactory();
    const built = factory({ craftedTools: () => ({}), providers: [], loader: {} }) as unknown as { description: string };
    expect(built.description).toContain('OWN virtual filesystem');
    expect(built.description).toContain('`run` tool');
  });
});

describe('createNodeExecuteToolFactory — crafted tools, on the episode clock', () => {
  /** A crafted set that changes between calls, the way the CraftStore does
   *  when the model crafts a tool mid-turn. */
  function makeToolOverStore(store: Map<string, (arg: unknown) => Promise<unknown>>): ExecTool {
    return createNodeExecuteToolFactory()({
      craftedTools: () => Object.fromEntries(
        [...store].map(([name, execute]) => [name, { description: name, execute }]),
      ),
      providers: [],
      loader: {},
    }) as unknown as ExecTool;
  }

  test('a tool crafted mid-turn is callable on the very next execute', async () => {
    const store = new Map<string, (arg: unknown) => Promise<unknown>>();
    const tool = makeToolOverStore(store);

    const before = await tool.execute({ code: 'return typeof codemode.double;' });
    expect(before.result).toBe('undefined');

    // What workspace.createTool does to the store, mid-turn.
    store.set('double', async (n) => Number(n) * 2);

    const after = await tool.execute({ code: 'return await codemode.double(21);' });
    expect(after.result).toBe(42);
  });

  test('`tools.<name>` is the same binding as `codemode.<name>` — the CF contract', async () => {
    const store = new Map<string, (arg: unknown) => Promise<unknown>>([
      ['double', async (n) => Number(n) * 2],
    ]);
    const out = await makeToolOverStore(store).execute({
      code: 'return [await tools.double(2), await codemode.double(3)];',
    });
    expect(out.result).toEqual([4, 6]);
  });

  test('a provider may not take one of the fixed namespaces', async () => {
    // `new Function` rejects duplicate parameter names, so a provider called
    // `tools` used to be a crash waiting to happen rather than a shadowed name.
    const tool = createNodeExecuteToolFactory({
      extraProviders: [{
        name: 'tools',
        tools: { hijack: { description: 'x', execute: async () => 'provider' } },
      } as never],
    })({
      craftedTools: () => ({ real: { description: 'r', execute: async () => 'crafted' } }),
      providers: [],
      loader: {},
    }) as unknown as ExecTool;
    const out = await tool.execute({ code: 'return await tools.real();' });
    expect(out.result).toBe('crafted');
  });
});
