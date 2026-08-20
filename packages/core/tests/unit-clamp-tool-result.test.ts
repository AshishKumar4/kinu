// Restorable tool-result compression (the at-source budget): oversize tool
// outputs are clamped head+tail with the FULL output offloaded to the
// workspace VFS first — the marker carries the path and the file round-trips
// through the real file surface, so nothing is irrecoverable.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu/test-utils';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';
import {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
} from '../src/tools/clamp';
import { TurnContextBudget } from '../src/context-budget';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { parseJsonValue, type JsonValue } from '../src/utils/json';

interface RunInput {
  command: string;
  runtime?: string;
}

function markerPath(clamped: string): string {
  const m = clamped.match(/full output saved to (\S+) —/);
  if (!m?.[1]) throw new Error('clamped result did not include a restorable output path');
  return m[1];
}

describe('clampToolResult', () => {
  test('passes small outputs through untouched', async () => {
    const { rt } = createTestRuntime();
    const text = 'x'.repeat(1000);
    expect(await clampToolResult(text, { vfs: rt.storage.vfs })).toBe(text);
  });

  test('500KB output → clamped head+tail; the full output round-trips via the VFS path in the marker', async () => {
    const { rt } = createTestRuntime();
    const head = 'HEAD-OF-OUTPUT '.repeat(10);
    const tail = ' TAIL-OF-OUTPUT'.repeat(10);
    const original = head + 'y'.repeat(500_000) + tail;

    const clamped = await clampToolResult(original, { vfs: rt.storage.vfs });
    expect(clamped.length).toBeLessThan(original.length);
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(clamped).toContain('HEAD-OF-OUTPUT');   // head preserved
    expect(clamped).toContain('TAIL-OF-OUTPUT');   // tail preserved
    expect(clamped).toContain('chars omitted');

    // Restorable: the marker path holds the FULL original output.
    const path = markerPath(clamped);
    expect(path).toStartWith(`${TOOL_OUTPUT_DIR}/`);
    const restored = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
    expect(restored).toBe(original);
  });

  test('without a VFS the marker stays honest — no fabricated path', async () => {
    const clamped = await clampToolResult('z'.repeat(100_000), {});
    expect(clamped).toContain('chars omitted');
    expect(clamped).not.toContain('saved to');
  });

  test('honours a custom budget', async () => {
    const clamped = await clampToolResult('a'.repeat(5_000), { maxChars: 1_000 });
    expect(clamped.length).toBeLessThan(1_400);
  });
});

describe('clampSerializedToolResult', () => {
  test('structured results within budget pass through with their shape intact', async () => {
    const value = { result: [1, 2, 3], logs: ['ok'] };
    expect(await clampSerializedToolResult({ output: value }, {})).toBe(value);
    expect(await clampSerializedToolResult({ output: null }, {})).toBeNull();
  });

  test('normalizes undefined object fields with JSON omission semantics', async () => {
    const output = { result: undefined, error: '[crafted:brokenIt] nope' };
    expect(await clampSerializedToolResult({ output }, {})).toEqual({
      error: '[crafted:brokenIt] nope',
    });
  });

  test('oversize structured results are offloaded as JSON and clamped', async () => {
    const { rt } = createTestRuntime();
    const value = { result: 'r'.repeat(200_000), logs: [] };
    const clamped = await clampSerializedToolResult({ output: value }, { vfs: rt.storage.vfs });
    const clampedText = v.parse(v.string(), clamped);
    expect(clampedText).toContain('chars omitted');
    const restored = v.parse(
      v.string(),
      await rt.storage.vfs.readFile(markerPath(clampedText), { encoding: 'utf8' }),
    );
    expect(parseJsonValue(restored)).toEqual(value);
  });

  test('withClampedToolResult wraps execute without touching schema/description', async () => {
    const { rt } = createTestRuntime();
    const entry = tool({
      description: 'desc',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => 'b'.repeat(120_000),
    });
    const wrapped = withClampedToolResult(entry, { vfs: rt.storage.vfs });
    expect(wrapped.description).toBe('desc');
    const out = await toolExecute(wrapped)({});
    expect(String(out)).toContain('chars omitted');
  });
});

describe('run tool result budget (behavior through the public tool surface)', () => {
  test('a huge stdout is clamped and the full output is readable back via the file surface', async () => {
    const { rt } = createTestRuntime();
    const original = 'BEGIN UNIQUE-MIDDLE-MARKER-' + 'log line\n'.repeat(80_000) + ' FINAL-ERROR-LINE';
    // The runtime's OWN shell, over the same bytes `rt.storage.vfs` reads.
    const realShell = rt.shell;
    if (!realShell) throw new Error('test runtime did not provide its workspace shell');
    const fakeShellExec = async (command: string) => {
      // First call: the huge command output. Filtered reads of the marker
      // path go through the REAL workspace shell over the same VFS.
      if (command.startsWith('grep ')) return realShell.exec(command);
      return { stdout: original, stderr: '', exitCode: 0 };
    };
    const rtWithShell: AgentRuntime = { ...rt, shell: { exec: fakeShellExec } };
    const tools = buildBuiltinTools({ rt: rtWithShell });
    const run = toolExecute<RunInput, string>(tools.run);

    const clamped = await run({ command: 'generate-huge-log' });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(clamped).toContain('FINAL-ERROR-LINE'); // the tail survives
    expect(clamped).toContain('chars omitted');

    // Restorable: the marker path round-trips via the file surface
    // (workspace.readFile) and is filterable through the run tool's shell —
    // exactly what the marker tells the model to do.
    const path = markerPath(clamped);
    const restored = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
    expect(restored).toBe(original);
    const grepped = await run({ command: `grep UNIQUE-MIDDLE-MARKER ${path}` });
    expect(grepped).toContain('UNIQUE-MIDDLE-MARKER');
  });

  test('huge stderr on failure is clamped too', async () => {
    const { rt } = createTestRuntime();
    const shell = {
      exec: async () => ({ stdout: '', stderr: 'E'.repeat(150_000), exitCode: 2 }),
    };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const tools = buildBuiltinTools({ rt: rtWithShell });
    const run = toolExecute<RunInput, string>(tools.run);
    const out = await run({ command: 'boom' });
    expect(out).toStartWith('Error (exit 2)\n--- stderr ---');
    expect(out.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(out).toContain('chars omitted');
  });
});

// The turn-cumulative half of the same seam: the per-result cap is not the
// whole policy, because eight in-budget results still bury the root. Once a
// turn has admitted its budget the remaining results clamp to the floor —
// full text still spilled, marker recipe unchanged.
describe('turn-cumulative egress budget (through the run tool)', () => {
  function runToolWithBudget(budget: TurnContextBudget, output: () => string) {
    const { rt } = createTestRuntime();
    const shell = { exec: async () => ({ stdout: output(), stderr: '', exitCode: 0 }) };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const tools = buildBuiltinTools({
      rt: rtWithShell,
      contextBudget: budget,
    });
    return { run: toolExecute<RunInput, string>(tools.run), rt };
  }

  test('the first results keep full fidelity; once the turn is heavy the rest clamp to the floor', async () => {
    const budget = new TurnContextBudget();
    const { run } = runToolWithBudget(budget, () => 'L'.repeat(200_000));

    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) sizes.push((await run({ command: `big-${i}` })).length);

    // 40k per result until 120k cumulative is admitted → three full, then floor.
    expect(sizes.slice(0, 3).every((n) => n > 39_000)).toBe(true);
    expect(sizes.slice(3).every((n) => n < 9_000)).toBe(true);
    const snapshot = budget.snapshot();
    expect(snapshot.trips.run).toBe(5);
    expect(snapshot.referenced).toBe(5);
    expect(snapshot.tightened).toBe(2);
  });

  test('the tightened result still spills the whole output and keeps the same recipe', async () => {
    const budget = new TurnContextBudget();
    const { run, rt } = runToolWithBudget(budget, () => `UNIQUE-${'M'.repeat(200_000)}-END`);
    for (let i = 0; i < 4; i++) await run({ command: `big-${i}` });
    const tightened = await run({ command: 'big-last' });

    expect(tightened.length).toBeLessThan(9_000);
    expect(tightened).toContain('slice + llm.query each slice, aggregate');
    const restored = await rt.storage.vfs.readFile(markerPath(tightened), { encoding: 'utf8' });
    const restoredText = v.parse(v.string(), restored);
    expect(restoredText).toStartWith('UNIQUE-');
    expect(restoredText).toEndWith('-END');
  });

  test('the tightened result says WHY it tightened, and an ordinary clamp does not', async () => {
    // The system prompt used to carry this as doctrine in its Delegation
    // section, thousands of tokens before any result could trip it — where a
    // measured 0% of trials acted on it. The fact is only actionable at the
    // trip, so the marker states it there, and costs nothing on the turns
    // (most turns) that never reach the floor.
    const budget = new TurnContextBudget();
    const { run } = runToolWithBudget(budget, () => 'L'.repeat(200_000));

    const first = await run({ command: 'big-0' });
    expect(first).toContain('output truncated');
    expect(first).not.toContain('the cap tightened');

    for (let i = 1; i < 4; i++) await run({ command: `big-${i}` });
    const tightened = await run({ command: 'big-last' });
    expect(tightened).toContain('This turn has already admitted enough tool output that the cap tightened');
    // And it names the lever, at the moment the signal is real.
    expect(tightened).toContain('hand the bulk to a search or a subordinate');
  });

  test('a fresh turn starts at full fidelity again', async () => {
    const budget = new TurnContextBudget();
    const { run } = runToolWithBudget(budget, () => 'L'.repeat(200_000));
    for (let i = 0; i < 4; i++) await run({ command: `big-${i}` });
    budget.reset();
    expect((await run({ command: 'next-turn' })).length).toBeGreaterThan(39_000);
  });

  test('small results accumulate toward the budget without ever tripping the counters', async () => {
    const budget = new TurnContextBudget();
    const { run } = runToolWithBudget(budget, () => 'ok'.repeat(10));
    await run({ command: 'small' });
    expect(budget.snapshot()).toMatchObject({ admittedChars: 20, omittedChars: 0, trips: {} });
  });

  test('a toolset built without a budget still budgets — per root, by construction', async () => {
    const { rt } = createTestRuntime();
    const shell = { exec: async () => ({ stdout: 'L'.repeat(200_000), stderr: '', exitCode: 0 }) };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const run = toolExecute<RunInput, string>(buildBuiltinTools({ rt: rtWithShell }).run);
    for (let i = 0; i < 3; i++) await run({ command: `big-${i}` });
    expect((await run({ command: 'big-4' })).length).toBeLessThan(9_000);
  });
});

describe('withClampedToolResults (external/MCP tool surfaces)', () => {
  test('every entry rides the same budget, and the counters name the producer', async () => {
    const { rt } = createTestRuntime();
    const budget = new TurnContextBudget();
    const entry = (payload: JsonValue) => tool({
      description: 'd',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => payload,
    });

    const wrapped = withClampedToolResults(
      { mcp_srv_a: entry('A'.repeat(300_000)), mcp_srv_b: entry({ rows: 'B'.repeat(300_000) }) },
      { vfs: rt.storage.vfs, budget, producer: 'external_tool' },
    );
    expect(Object.keys(wrapped)).toEqual(['mcp_srv_a', 'mcp_srv_b']);

    for (const key of Object.keys(wrapped)) {
      const out = await toolExecute(wrapped[key])({});
      expect(String(out)).toContain('chars omitted');
    }
    expect(budget.snapshot().trips).toEqual({ external_tool: 2 });
    expect(budget.snapshot().referenced).toBe(2);
  });

  test('an entry with no execute (a provider-native tool) passes through untouched', () => {
    const budget = new TurnContextBudget();
    const declarative = tool({
      description: 'd',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    });
    const wrapped = withClampedToolResults({ native: declarative }, { budget });
    expect(wrapped.native).toBe(declarative);
  });
});
