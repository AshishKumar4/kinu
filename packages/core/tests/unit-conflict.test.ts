/**
 * Unit tests: CraftStore conflict detection.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { checkConflictsBeforeAdding, upsertCraftedTool } from '../src/craft/conflict.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { ExecuteResult, Executor } from '../src/types/primitives.js';

describe('CraftStore conflict detection', () => {
  test('detects exact name conflict', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'parse_csv', description: 'Parse CSV files', params: null, code: 'fn()', scope: 'local' });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'parse_csv', description: 'Different desc', code: 'other()', score: 0.9,
    });
    expect(result.conflicting).toContain('parse_csv');
  });

  test('detects semantic conflict (>85% word overlap)', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'extract_csv', description: 'parse and extract CSV data from files with headers',
      params: null, code: 'fn()', scope: 'local',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'csv_parser',
      description: 'parse and extract CSV data from files with headers and delimiters',
      code: 'other()', score: 0.9,
    });
    // High word overlap → should detect conflict
    expect(result.conflicting.length).toBeGreaterThan(0);
  });

  test('no conflict for unrelated tools', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'parse_csv', description: 'parse CSV files',
      params: null, code: 'fn()', scope: 'local',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'send_email', description: 'send transactional email via SMTP',
      code: 'other()', score: 0.9,
    });
    expect(result.conflicting).toHaveLength(0);
  });
});

/**
 * What both backends actually do with a stored tool: compile the source as an
 * expression and CALL what it produces (cli-backend/src/craft-executor.ts; the
 * CF sandbox splices the same expression). The shared test executor only
 * parses, which is precisely the half of the admission check every broken
 * production tool slipped through.
 */
function evaluatingExecutor(): Executor {
  return {
    async execute(code: string): Promise<ExecuteResult> {
      try {
        const compile = new Function(`return (${code})`);
        return { result: await compile()() };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

describe('upsertCraftedTool — the admission check', () => {
  // Seven tools were crafted in one production session; the two inspected were
  // both non-functional, and both were stored, scored and offered to later
  // turns. The only admission test was "has a name, and does not start with
  // `//`" — nothing ever compiled the code the runtime would have to compile.
  function runtime(): AgentRuntime {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);
    return { ...rt, executor: evaluatingExecutor() };
  }

  const scored = (rt: AgentRuntime, name: string): number =>
    rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM craft_scores WHERE tool_name = ${name}`[0]?.n ?? 0;

  test('rejects the verbatim production body that calls an object literal', async () => {
    const rt = runtime();
    const result = await upsertCraftedTool(rt, {
      name: 'run_command', description: 'run a shell command',
      code: 'await ({ runtime })(command)', score: 0.7,
    });

    expect(result.accepted).toBe(false);
    expect(result.vetoReason).toContain('run_command');
    expect(rt.craftStore.get('run_command')).toBeFalsy();
    expect(scored(rt, 'run_command')).toBe(0);
  });

  test('rejects code that cannot parse', async () => {
    const rt = runtime();
    const result = await upsertCraftedTool(rt, {
      name: 'broken_parse', description: 'half a tool',
      code: 'async (args) => { return args.', score: 0.9,
    });

    expect(result.accepted).toBe(false);
    expect(rt.craftStore.get('broken_parse')).toBeFalsy();
  });

  test('rejects code that parses but is not a function', async () => {
    const rt = runtime();
    const result = await upsertCraftedTool(rt, {
      name: 'not_a_tool', description: 'a statement, not a tool',
      code: '42', score: 0.9,
    });

    expect(result.accepted).toBe(false);
    expect(result.vetoReason).toContain('not a function');
    expect(rt.craftStore.get('not_a_tool')).toBeFalsy();
  });

  test('a tool the runtime can actually call is stored and scored', async () => {
    const rt = runtime();
    const result = await upsertCraftedTool(rt, {
      name: 'fetch_changelog', description: 'read a changelog',
      code: 'async (args) => args.url', score: 0.8,
    });

    expect(result.accepted).toBe(true);
    expect(rt.craftStore.get('fetch_changelog')?.code).toBe('async (args) => args.url');
    expect(scored(rt, 'fetch_changelog')).toBe(1);
  });
});
