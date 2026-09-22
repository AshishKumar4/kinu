// Oversize tool outputs are clamped head+tail after offloading the full output to the VFS.
// The cap covers the whole string the model receives, marker and producer prefix included.
import { describe, test, expect } from 'bun:test';
import { toolExecute, createMemoryVfs } from '@kinu.run/test-utils';
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
import { estimateTokens } from '../src/llm';
import { TurnContextBudget } from '../src/context-budget';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { VFS } from '../src/types/primitives';
import { decodeJsonValue, parseJsonValue, type JsonValue } from '../src/utils/json';

interface ShellToolInput {
  command: string;
  runtime?: string;
}

interface FileToolInput {
  action: string;
  path: string;
  content?: string;
  offset?: number;
  limit?: number;
}

function markerPath(clamped: string): string {
  const m = /full result at (\S+)\]/.exec(clamped);

  if (!m?.[1]) throw new Error(`clamped result did not include a restorable output path: ${clamped.slice(-200)}`);

  return m[1];
}

describe('the shared budget', () => {
  test('is ~2,000 estimated tokens, and the whole result is what it pays for', async () => {
    expect(estimateTokens(DEFAULT_TOOL_RESULT_MAX_CHARS)).toBe(2_000);

    const { rt } = createTestRuntime();
    const clamped = await clampToolResult('y'.repeat(500_000), { vfs: rt.storage.vfs });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(clamped).toContain('[truncated;');
  });
});

describe('clampToolResult', () => {
  test('below, exactly at, and one char over the cap', async () => {
    const { rt } = createTestRuntime();
    const under = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS - 1);
    const exact = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS);
    const over = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 1);

    expect(await clampToolResult(under, { vfs: rt.storage.vfs })).toBe(under);
    expect(await clampToolResult(exact, { vfs: rt.storage.vfs })).toBe(exact);

    const clamped = await clampToolResult(over, { vfs: rt.storage.vfs });
    expect(clamped).not.toBe(over);
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
  });

  test('500KB output → clamped head+tail; the full output round-trips via the VFS path in the marker', async () => {
    const { rt } = createTestRuntime();
    const head = 'HEAD-OF-OUTPUT '.repeat(10);
    const tail = ' TAIL-OF-OUTPUT'.repeat(10);
    const original = head + 'y'.repeat(500_000) + tail;

    const clamped = await clampToolResult(original, { vfs: rt.storage.vfs });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(clamped).toContain('HEAD-OF-OUTPUT');
    expect(clamped).toContain('TAIL-OF-OUTPUT');

    const path = markerPath(clamped);
    expect(path).toStartWith(`${TOOL_OUTPUT_DIR}/`);
    const restored = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
    expect(restored).toBe(original);
  });

  test('the marker itself is inside the budget, not charged on top of it', async () => {
    const { rt } = createTestRuntime();

    for (const size of [DEFAULT_TOOL_RESULT_MAX_CHARS + 1, 50_000, 2_000_000]) {
      const clamped = await clampToolResult('z'.repeat(size), { vfs: rt.storage.vfs });
      expect(clamped.length, `input ${size}`).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
      expect(clamped, `input ${size}`).toContain('[truncated;');
    }
  });

  test('an unsaved result says so rather than naming a path that holds nothing', async () => {
    const clamped = await clampToolResult('z'.repeat(100_000), {});
    expect(clamped).toContain('was not saved');
    expect(clamped).not.toContain('ranged reads');
  });

  test('a failed offload is visible: no path, no reference credited', async () => {
    const budget = new TurnContextBudget();

    const failing: VFS = {
      ...createMemoryVfs().vfs,
      writeFile: () => Promise.reject(new Error('EROFS: read-only workspace')),
    };

    const clamped = await clampToolResult('z'.repeat(100_000), { vfs: failing, budget, producer: 'shell' });
    expect(clamped).toContain('was not saved');
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(budget.snapshot()).toMatchObject({ trips: { shell: 1 }, referenced: 0 });
  });

  test('the shared budget is honoured', async () => {
    const clamped = await clampToolResult('a'.repeat(50_000));
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
  });

  test('never splits an astral character, and spills it intact', async () => {
    const { rt } = createTestRuntime();
    const original = '🙂🚀'.repeat(20_000);

    const clamped = await clampToolResult(original, { vfs: rt.storage.vfs, budget: new TurnContextBudget() });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clamped)).toBe(false);
    expect(await rt.storage.vfs.readFile(markerPath(clamped), { encoding: 'utf8' })).toBe(original);
  });

  test('a standalone surrogate in the source is data, not something to trim away', async () => {
    // A lone surrogate already in the text is left alone; only a real high+low pair is protected.
    const original = `\uD83D\uDE42\uD800${'x'.repeat(50_000)}`;
    const clamped = await clampToolResult(original);
    expect(clamped).toStartWith('\uD83D\uDE42\uD800');
  });

  test('the ledger balances on a surrogate boundary: admitted + omitted is the whole input', async () => {
    const budget = new TurnContextBudget();
    const { rt } = createTestRuntime();
    const original = '🙂'.repeat(30_000);
    const clamped = await clampToolResult(original, { vfs: rt.storage.vfs, budget, producer: 'shell' });
    const [head, , tail] = clamped.split('\n\n');
    expect(budget.snapshot().omittedChars)
      .toBe(original.length - (head?.length ?? 0) - (tail?.length ?? 0));
  });
  test('the ledger counts what the root ingested and what it never saw', async () => {
    const { rt } = createTestRuntime();
    const budget = new TurnContextBudget();
    const original = 'L'.repeat(200_000);
    const clamped = await clampToolResult(original, { vfs: rt.storage.vfs, budget, producer: 'shell' });
    const [head, , tail] = clamped.split('\n\n');
    const snapshot = budget.snapshot();

    expect(snapshot.admittedChars).toBe(clamped.length);
    expect(snapshot.omittedChars).toBe(original.length - (head?.length ?? 0) - (tail?.length ?? 0));
    expect(snapshot).toMatchObject({ trips: { shell: 1 }, referenced: 1 });
  });
});

describe('clampSerializedToolResult', () => {
  test('structured results within budget pass through with their shape intact', async () => {
    const value = { result: [1, 2, 3], logs: ['ok'] };
    expect(await clampSerializedToolResult({ output: value }, {})).toBe(value);
    expect(await clampSerializedToolResult({ output: null }, {})).toBeNull();
    expect(await clampSerializedToolResult({ output: undefined }, {})).toBeUndefined();
    expect(await clampSerializedToolResult({ output: '' }, {})).toBe('');
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
    expect(clampedText.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);

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
    expect(String(out)).toContain('[truncated;');
    expect(String(out).length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
  });
});

describe('tool result budget (behavior through the public tool surface)', () => {
  test('a huge stdout is clamped and the full output is readable back via the file surface', async () => {
    const { rt } = createTestRuntime();
    const original = 'BEGIN UNIQUE-MIDDLE-MARKER-' + 'log line\n'.repeat(80_000) + ' FINAL-ERROR-LINE';
    const realShell = rt.shell;

    if (!realShell) throw new Error('test runtime did not provide its workspace shell');

    const fakeShellExec = async (command: string) => {
      if (command.startsWith('grep ')) return realShell.exec(command);

      return { stdout: original, stderr: '', exitCode: 0 };
    };

    const rtWithShell: AgentRuntime = { ...rt, shell: { exec: fakeShellExec } };
    const tools = buildBuiltinTools({ rt: rtWithShell, history: storesFor(rtWithShell).history });
    const invoke = toolExecute<ShellToolInput, string>(tools.shell);

    const clamped = await invoke({ command: 'generate-huge-log' });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(clamped).toContain('FINAL-ERROR-LINE');

    const path = markerPath(clamped);
    const restored = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
    expect(restored).toBe(original);
    const grepped = await invoke({ command: `grep UNIQUE-MIDDLE-MARKER ${path}` });
    expect(grepped).toContain('UNIQUE-MIDDLE-MARKER');
  });

  test('huge stderr on failure is clamped too', async () => {
    const { rt } = createTestRuntime();

    const shell = {
      exec: async () => ({ stdout: '', stderr: 'E'.repeat(150_000), exitCode: 2 }),
    };

    const rtWithShell: AgentRuntime = { ...rt, shell };
    const tools = buildBuiltinTools({ rt: rtWithShell, history: storesFor(rtWithShell).history });
    const invoke = toolExecute<ShellToolInput, string>(tools.shell);
    const pending = invoke({ command: 'boom' });
    await expect(pending).rejects.toMatchObject({ code: 'io', execution: { exitCode: 2 } });
    await expect(pending).rejects.toThrow('Error (exit 2)\n--- stderr ---');
    await expect(pending).rejects.toThrow('[truncated;');
    await expect(pending).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`^[\\s\\S]{0,${DEFAULT_TOOL_RESULT_MAX_CHARS}}$`)),
    });
  });

  test('the file steer is part of the clamped string, and of the spilled original', async () => {
    // The steer is composed before the clamp, keeping the cap honest and the spill equal to the digest.
    const { rt } = createTestRuntime();
    const stdout = 'L'.repeat(200_000);
    const shell = { exec: async () => ({ stdout, stderr: '', exitCode: 0 }) };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const invoke = toolExecute<ShellToolInput, string>(buildBuiltinTools({ rt: rtWithShell, history: storesFor(rtWithShell).history }).shell);

    const steered = await invoke({ command: "sed -i 's/a/b/' src/app.ts" });
    expect(steered).toStartWith('[Kinu note: that command used an in-place stream edit.');
    expect(steered).toContain('[truncated;');
    expect(steered.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);

    const restored = v.parse(v.string(), await rt.storage.vfs.readFile(markerPath(steered), { encoding: 'utf8' }));
    expect(restored).toStartWith('[Kinu note:');
    expect(restored).toEndWith(stdout.slice(-50));
  });

  test('a ranged file read is bounded by the same cap and spills nothing twice', async () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt, history: storesFor(rt).history });
    const file = toolExecute<FileToolInput, JsonValue>(tools.file);
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1} ${'padding '.repeat(5)}`);
    await file({ action: 'write', path: 'big.txt', content: lines.join('\n') });

    const page = v.parse(v.string(), await file({ action: 'read', path: 'big.txt' }));
    expect(page.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(page).toContain('continue with action=read offset=');

    const next = Number(/offset=(\d+)/.exec(page)?.[1]);
    const second = v.parse(v.string(), await file({ action: 'read', path: 'big.txt', offset: next }));
    expect(second.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(second.split('\n')[0]).toBe(lines[next - 1]);

    expect(await rt.storage.vfs.stat(TOOL_OUTPUT_DIR)).toBeNull();
  });

  test('every result rides the one cap, and the turn ledger counts all of them', async () => {
    const { rt } = createTestRuntime();
    const budget = new TurnContextBudget();
    const shell = { exec: async () => ({ stdout: 'L'.repeat(200_000), stderr: '', exitCode: 0 }) };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const invoke = toolExecute<ShellToolInput, string>(buildBuiltinTools({ rt: rtWithShell, contextBudget: budget, history: storesFor(rtWithShell).history }).shell);

    const sizes: number[] = [];

    for (let i = 0; i < 5; i++) sizes.push((await invoke({ command: `big-${i}` })).length);

    expect(sizes.every((n) => n <= DEFAULT_TOOL_RESULT_MAX_CHARS)).toBe(true);
    const snapshot = budget.snapshot();
    expect(snapshot.trips.shell).toBe(5);
    expect(snapshot.referenced).toBe(5);
    expect(snapshot.admittedChars).toBe(sizes.reduce((sum, n) => sum + n, 0));
  });

  test('small results accumulate toward the admitted total without ever tripping the counters', async () => {
    const { rt } = createTestRuntime();
    const budget = new TurnContextBudget();
    const shell = { exec: async () => ({ stdout: 'ok'.repeat(10), stderr: '', exitCode: 0 }) };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const invoke = toolExecute<ShellToolInput, string>(buildBuiltinTools({ rt: rtWithShell, contextBudget: budget, history: storesFor(rtWithShell).history }).shell);
    await invoke({ command: 'small' });
    expect(budget.snapshot()).toMatchObject({ admittedChars: 20, omittedChars: 0, trips: {} });
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
      const out = String(await toolExecute(wrapped[key])({}));
      expect(out).toContain('[truncated;');
      expect(out.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
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

describe('the JSON boundary refuses what JSON cannot carry', () => {
  test('decodeJsonValue rejects non-finite numbers', () => {
    // Infinity would serialize as null, silently corrupting the result.
    expect(() => decodeJsonValue({ value: Number.POSITIVE_INFINITY })).toThrow(
      'Invalid finite: Received Infinity',
    );
    expect(() => decodeJsonValue({ value: Number.NaN })).toThrow(
      'Invalid type: Expected (string | number | boolean | null | Array | Object) but received NaN',
    );
  });
});
