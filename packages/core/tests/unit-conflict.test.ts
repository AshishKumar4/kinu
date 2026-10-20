import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { checkConflictsBeforeAdding, upsertCraftedTool } from '../src/craft/conflict';
import { craftPreferences, markCraftBroken } from '../src/craft/preference';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { ExecuteResult, Executor } from '../src/types/primitives';

describe('CraftStore conflict detection', () => {
  test('detects exact name conflict', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'parse_csv', description: 'Parse CSV files', code: 'fn()' });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'parse_csv', description: 'Different desc', code: 'other()',
    });

    expect(result.conflicting).toContain('parse_csv');
  });

  test('detects semantic conflict (>85% word overlap)', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'extract_csv', description: 'parse and extract CSV data from files with headers',
      code: 'fn()',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'csv_parser',
      description: 'parse and extract CSV data from files with headers and delimiters',
      code: 'other()',
    });

    expect(result.conflicting.length).toBeGreaterThan(0);
  });

  test('no conflict for unrelated tools', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'parse_csv', description: 'parse CSV files',
      code: 'fn()',
    });

    const result = checkConflictsBeforeAdding(rt, {
      name: 'send_email', description: 'send transactional email via SMTP',
      code: 'other()',
    });

    expect(result.conflicting).toHaveLength(0);
  });
});

/** Compiles and calls the stored expression as a program defines it (`renderCraftedDefinitions`); the shared executor only parses. */
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

/** Admission must compile the code the runtime will compile, not just check for a name. */
function runtime(): AgentRuntime {
  const { rt } = createTestRuntime();
  initCraftedToolsTables(rt.storage.sql);

  return { ...rt, executor: evaluatingExecutor() };
}

describe('upsertCraftedTool — the admission check', () => {
  const stored = (rt: AgentRuntime, name: string): number =>
    rt.craftStore.list().filter((t) => t.name === name).length;

  test('rejects the verbatim production body that calls an object literal', async () => {
    const rt = runtime();

    const result = await upsertCraftedTool(rt, {
      name: 'run_command', description: 'run a shell command',
      code: 'await ({ runtime })(command)',
    });

    expect(result.accepted).toBe(false);
    expect(result.vetoReason).toContain('run_command');
    expect(rt.craftStore.get('run_command')).toBeFalsy();
    expect(stored(rt, 'run_command')).toBe(0);
  });

  test.each([
    ['cannot parse', { name: 'broken_parse', description: 'half a tool', code: 'async (args) => { return args.' }],
    ['parses but is not a function', { name: 'not_a_tool', description: 'a statement, not a tool', code: '42' }],
  ])('rejects code that %s', async (_what, tool) => {
    const rt = runtime();

    const result = await upsertCraftedTool(rt, tool);

    expect(result.accepted).toBe(false);
    expect(rt.craftStore.get(tool.name)).toBeFalsy();
  });

  // core-rest review P1-10: evolution stored a reserved name that every injection then skipped; the workspace refused it.
  test('a reserved name is refused at the write, as the workspace refuses it', async () => {
    const rt = runtime();

    const result = await upsertCraftedTool(rt, { name: 'shell', description: 'run a command', code: 'async (args) => args' });

    expect(result.accepted).toBe(false);
    expect(result.vetoReason).toContain('reserved');
    expect(rt.craftStore.get('shell')).toBeFalsy();
  });

  test('a tool the runtime can actually call is stored', async () => {
    const rt = runtime();

    const result = await upsertCraftedTool(rt, {
      name: 'fetch_changelog', description: 'read a changelog',
      code: 'async (args) => args.url',
    });

    expect(result.accepted).toBe(true);
    expect(rt.craftStore.get('fetch_changelog')?.code).toBe('async (args) => args.url');
    expect(stored(rt, 'fetch_changelog')).toBe(1);
  });
});

describe('upsertCraftedTool — a pattern that conflicts with a tool', () => {
  test('replaces it only while it is broken, which the rewrite clears; a working tool stays the agent\'s own', async () => {
    const rt = runtime();
    rt.craftStore.create({ name: 'fetch_changelog', description: 'read a changelog', code: 'async (args) => args.old' });
    const pattern = { name: 'fetch_changelog', description: 'read a changelog', code: 'async (args) => args.url' };

    expect((await upsertCraftedTool(rt, pattern)).accepted).toBe(true);
    expect(rt.craftStore.get('fetch_changelog')?.code).toBe('async (args) => args.old');

    markCraftBroken(rt.storage.sql, 'fetch_changelog', 'TypeError: args.old is undefined');
    expect((await upsertCraftedTool(rt, pattern)).accepted).toBe(true);
    expect(rt.craftStore.get('fetch_changelog')?.code).toBe('async (args) => args.url');
    expect(craftPreferences(rt.storage.sql).get('fetch_changelog')?.broken).toBeNull();
  });
});
