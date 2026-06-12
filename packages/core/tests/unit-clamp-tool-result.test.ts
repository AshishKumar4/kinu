// Restorable tool-result compression (the at-source budget): oversize tool
// outputs are clamped head+tail with the FULL output offloaded to the
// workspace VFS first — the marker carries the path and the file round-trips
// through the real file surface, so nothing is irrecoverable.
import { describe, test, expect } from 'bun:test';
import { createShell } from '@proteus/agent-utils/shell';
import {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
} from '../src/tools/clamp.js';
import { buildBuiltinTools } from '../src/tools/builtins.js';
import { createTestRuntime } from './helpers.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { ToolSet } from 'ai';

type RunTool = { execute: (args: { command: string; runtime?: string }, options?: unknown) => Promise<string> };

function markerPath(clamped: string): string {
  const m = clamped.match(/full output saved to (\S+) —/);
  expect(m).not.toBeNull();
  return m![1]!;
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
    expect(path).toStartWith(`/${TOOL_OUTPUT_DIR}/`);
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
    expect(await clampSerializedToolResult(value, {})).toBe(value);
    expect(await clampSerializedToolResult(null, {})).toBeNull();
  });

  test('oversize structured results are offloaded as JSON and clamped', async () => {
    const { rt } = createTestRuntime();
    const value = { result: 'r'.repeat(200_000), logs: [] };
    const clamped = await clampSerializedToolResult(value, { vfs: rt.storage.vfs });
    expect(typeof clamped).toBe('string');
    expect(clamped as string).toContain('chars omitted');
    const restored = await rt.storage.vfs.readFile(markerPath(clamped as string), { encoding: 'utf8' });
    expect(JSON.parse(restored as string)).toEqual(value);
  });

  test('withClampedToolResult wraps execute without touching schema/description', async () => {
    const { rt } = createTestRuntime();
    const entry = {
      description: 'desc', inputSchema: { type: 'object' },
      execute: async () => 'b'.repeat(120_000),
    } as unknown as ToolSet[string];
    const wrapped = withClampedToolResult(entry, rt.storage.vfs);
    expect((wrapped as { description?: string }).description).toBe('desc');
    const out = await (wrapped as { execute: () => Promise<unknown> }).execute();
    expect(String(out)).toContain('chars omitted');
  });
});

describe('run tool result budget (behavior through the public tool surface)', () => {
  test('a huge stdout is clamped and the full output is readable back via the file surface', async () => {
    const { rt } = createTestRuntime();
    const original = 'BEGIN UNIQUE-MIDDLE-MARKER-' + 'log line\n'.repeat(80_000) + ' FINAL-ERROR-LINE';
    const fakeShellExec = async (command: string) => {
      // First call: the huge command output. Filtered reads of the marker
      // path go through the REAL workspace shell over the same VFS.
      if (command.startsWith('grep ')) return realShell.exec(command);
      return { stdout: original, stderr: '', exitCode: 0 };
    };
    const realShell = createShell(rt.storage.vfs);
    const rtWithShell = { ...rt, shell: { exec: fakeShellExec } } as AgentRuntime;
    const tools = buildBuiltinTools({ rt: rtWithShell });
    const run = tools.run as unknown as RunTool;

    const clamped = await run.execute({ command: 'generate-huge-log' });
    expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(clamped).toContain('FINAL-ERROR-LINE'); // the tail survives
    expect(clamped).toContain('chars omitted');

    // Restorable: the marker path round-trips via the file surface
    // (workspace.readFile) and is filterable through the run tool's shell —
    // exactly what the marker tells the model to do.
    const path = markerPath(clamped);
    const restored = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
    expect(restored).toBe(original);
    const grepped = await run.execute({ command: `grep UNIQUE-MIDDLE-MARKER ${path}` });
    expect(grepped).toContain('UNIQUE-MIDDLE-MARKER');
  });

  test('huge stderr on failure is clamped too', async () => {
    const { rt } = createTestRuntime();
    const shell = {
      exec: async () => ({ stdout: '', stderr: 'E'.repeat(150_000), exitCode: 2 }),
    };
    const tools = buildBuiltinTools({ rt: { ...rt, shell } as AgentRuntime });
    const run = tools.run as unknown as RunTool;
    const out = await run.execute({ command: 'boom' });
    expect(out).toStartWith('Error (exit 2):');
    expect(out.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS + 300);
    expect(out).toContain('chars omitted');
  });
});
