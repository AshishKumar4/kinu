import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { checkConflictsBeforeAdding, upsertCraftedTool } from '../src/craft/conflict';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { ExecuteResult, Executor } from '../src/types/primitives';

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

/** Compiles and calls the stored expression as both backends do (cli-backend/src/craft-executor.ts); the shared executor only parses. */
function evaluatingExecutor(): Executor {
  return {
    languages: ['javascript'],
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
  // Admission must compile the code the runtime will compile, not just check for a name.
  function runtime(): AgentRuntime {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    return { ...rt, executor: evaluatingExecutor() };
  }

  const scored = (rt: AgentRuntime, name: string): number =>
    rt.craftStore.list().filter((t) => t.name === name).length;

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
