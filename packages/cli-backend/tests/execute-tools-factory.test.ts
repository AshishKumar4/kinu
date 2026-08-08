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
  return factory({ tools: {}, providers: [], loader: {} }) as unknown as ExecTool;
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
});
