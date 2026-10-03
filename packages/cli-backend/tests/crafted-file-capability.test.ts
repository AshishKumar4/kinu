// A live eval's third attempt at `report_totals`, with its file read written the supported way: saved by one program,
// run by the next, it reads and writes workspace files. A crafted body is defined in the calling program's scope, so
// it sees that program's `workspace` here as in the cf sandbox (`renderCraftedDefinitions`).
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createInlineExecutor, initWorkspaceSchema, selectInjectableCraftedTools, type JsonValue, type LLMProviderConfig,
} from '@kinu.run/core';
import { scratchPath, toolExecute } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { RECORDED_ATTEMPTS } from '../../core/tests/fixtures/crafted-file-attempts';

/** The tool body the recorded program passed to `createTool`. */
function savedBody(program: string): string {
  const start = program.indexOf('const code = `') + 'const code = `'.length;

  return program.slice(start, program.indexOf('`;\n', start));
}

const CORRECTED = savedBody(RECORDED_ATTEMPTS[2].program)
  .replace("  const fs = require('fs');\n", '')
  .replace("fs.readFileSync(args.path, 'utf8')", 'await workspace.readFile(args.path)');

const REPORT = JSON.stringify({ testResults: [{ assertionResults: [
  { status: 'passed', duration: 2.5 },
  { status: 'failed', duration: 1.25 },
  { status: 'todo', duration: null },
] }] });

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

/** Successive `eval` programs over a real CLI runtime's workspace and crafted-tool store. */
function programs() {
  const db = new Database(scratchPath('crafted-file-capability', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { llm: DUMMY_LLM });

  const workspace = createInlineExecutor({
    vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql, actor: rt.actor,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }, filesOwner: 'agent',
  });

  const built = createNodeCodemodeToolFactory({ extraProviders: [workspace] })({
    native: {}, external: () => ({}), craftedTools: () => selectInjectableCraftedTools(rt.craftStore, rt.storage.sql), providers: [],
  });

  return toolExecute<{ code: string }, { result: JsonValue }>(built);
}

describe('a crafted tool reads and writes workspace files on the CLI', () => {
  test('the corrected body is saved by one program and reads the report in the next', async () => {
    const run = programs();

    await run({ code: `return await workspace.writeFile('reports/trial.json', ${JSON.stringify(REPORT)});` });
    expect((await run({ code: `return await workspace.createTool('report_totals', 'totals', ${JSON.stringify(CORRECTED)});` })).result)
      .toEqual({ ok: true, name: 'report_totals', action: 'created' });

    expect((await run({ code: "return await tools.report_totals({ path: 'reports/trial.json' });" })).result)
      .toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, durationMs: 3.75 });
  });

  test('a body that writes awaits the write, and reads back what it wrote', async () => {
    const run = programs();
    const writer = 'async (args) => { await workspace.writeFile(args.path, args.text); return await workspace.readFile(args.path); }';

    await run({ code: `return await workspace.createTool('write_result', 'write output', ${JSON.stringify(writer)});` });

    expect((await run({ code: "return await tools.write_result({ path: 'reports/output.txt', text: 'saved' });" })).result).toBe('saved');
    expect((await run({ code: "return await workspace.readFile('reports/output.txt');" })).result).toBe('saved');
  });
});
