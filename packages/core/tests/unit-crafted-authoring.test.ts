// A live eval tried three times to save a file-reading tool, met three errors that never named the way a tool reads a
// file, and concluded crafted tools cannot. They can, with `workspace.readFile`: the recorded programs, replayed, now
// meet errors that name it, and the declaration the model reads states the contract they broke.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createInlineExecutor, executorNamespace, explainSandboxError, renderCodemodeDescription } from '../src/index';
import { createTestRuntime } from './helpers';
import { RECORDED_ATTEMPTS } from './fixtures/crafted-file-attempts';

const [IMPORTED, WRAPPED, REQUIRED] = RECORDED_ATTEMPTS;

/** The file attempt 1 read: the tool as a declaration, which the agent then wrapped in an eval script. */
const REPORT_TOTALS_SOURCE = 'async function report_totals(args) {\n  return { total: 0, path: args.path };\n}\n';

const BINDING = 'workspace.readFile(';

const RefusalSchema = v.object({ ok: v.boolean(), error: v.string() });

function workspaceOf() {
  const { rt, db } = createTestRuntime();

  const provider = createInlineExecutor({
    filesOwner: 'agent', vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql, actor: rt.actor,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  });

  return { rt, db, provider };
}

/** Runs a recorded program as `eval` would, with `require('fs/promises')` reading the file the agent read. */
async function replay(
  program: string, provider: ReturnType<typeof workspaceOf>['provider'],
): Promise<v.InferOutput<typeof RefusalSchema>> {
  const workspace = { createTool: provider.tools.createTool.execute };
  const require = () => ({ readFile: async () => REPORT_TOTALS_SOURCE });
  const run = new Function('workspace', 'require', `return (async () => {\n${program}\n})();`);

  return v.parse(RefusalSchema, await run(workspace, require));
}

describe('saving a tool that reads a file', () => {
  test('a module import refused by the sandbox names the binding a program reads files with', () => {
    expect(explainSandboxError(IMPORTED.error)).toContain(BINDING);
  });

  test('a tool written as an eval script is refused with the shape of a tool body', async () => {
    const { db, provider } = workspaceOf();

    try {
      const { ok, error } = await replay(WRAPPED.program, provider);

      expect({ ok, body: error.includes('not an eval script'), binding: error.includes(BINDING) })
        .toEqual({ ok: false, body: true, binding: true });
    } finally {
      db.close();
    }
  });

  test('a tool body that requires fs is refused naming require, and the binding to use instead', async () => {
    const { db, provider } = workspaceOf();

    try {
      const { ok, error } = await replay(REQUIRED.program, provider);

      expect({ ok, construct: error.includes('references require'), binding: error.includes(BINDING) })
        .toEqual({ ok: false, construct: true, binding: true });
    } finally {
      db.close();
    }
  });

  test('the declaration the model reads says what a tool body is and how it reads a file', () => {
    const { db, provider } = workspaceOf();

    try {
      const declared = renderCodemodeDescription([executorNamespace(provider)], {});

      expect(declared).toContain('async (args) => JSON.parse(await workspace.readFile(args.path))');
      expect(declared).toContain('not an eval script');
      expect(provider.tools.createTool.description).not.toContain('`require(');
    } finally {
      db.close();
    }
  });
});
