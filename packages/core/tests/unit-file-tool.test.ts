/**
 * The `file` tool: the exact-match editor, the honest read, and the
 * read-before-write gate.
 *
 * These assert the CONTRACT the model sees — what a call returns and what the
 * file looks like afterwards — not how the engine is factored.
 */

import { describe, expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { applyFileEdits, readFileSlice } from '../src/tools/file-edit';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { createFileTool, type FileToolInput } from '../src/tools/file-tool';
import { TurnContextBudget } from '../src/context-budget';
import { JsonObjectSchema } from '../src/utils/json';
import { makeVfsError } from '../src/vfs/errno';
import type { Memory, VFS } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { classifyToolFailure } from '../src/read-models/tool-failures';
import type { RunEvent, RunEventBase } from '../src/events/types';

// ── the engine ──────────────────────────────────────────────────────────────

describe('applyFileEdits', () => {
  test('replaces the one occurrence and leaves the rest byte-identical', () => {
    const out = applyFileEdits('a\nTARGET\nb\n', [{ oldText: 'TARGET', newText: 'REPLACED' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('a\nREPLACED\nb\n');
    expect(out.applied).toEqual([{ line: 2, removedLines: 1, addedLines: 1 }]);
  });

  test('refuses an anchor that appears more than once, naming the count', () => {
    const out = applyFileEdits('x\nx\n', [{ oldText: 'x', newText: 'y' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('ambiguous');
    expect(out.message).toContain('appears 2 times');
    expect(out.message).toContain('unique');
  });

  test('refuses an anchor that is absent, and says to re-read', () => {
    const out = applyFileEdits('hello\n', [{ oldText: 'goodbye', newText: 'x' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_found');
    expect(out.message).toContain('does not appear');
  });

  test('refuses an empty anchor rather than matching everywhere', () => {
    const out = applyFileEdits('hello\n', [{ oldText: '', newText: 'x' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('empty_anchor');
  });

  test('is atomic: one bad edit in a batch applies none of them', () => {
    const out = applyFileEdits(
      'alpha\nbeta\n',
      [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'missing', newText: 'x' }],
      '/f',
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_found');
    expect(out.message).toContain('edits[1].old_text');
  });

  test('matches every edit against the file as read, not against a sibling result', () => {
    // Naive sequential application would find "b" inside the first edit's own
    // replacement; matching against the original cannot.
    const out = applyFileEdits(
      'one\ntwo\n',
      [{ oldText: 'one', newText: 'two' }, { oldText: 'two', newText: 'three' }],
      '/f',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('two\nthree\n');
  });

  test('rejects two edits that cover overlapping text', () => {
    const out = applyFileEdits(
      'abcdef\n',
      [{ oldText: 'abcd', newText: 'X' }, { oldText: 'cdef', newText: 'Y' }],
      '/f',
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('overlap');
    expect(out.message).toContain('edits[0] and edits[1]');
  });

  test('a replacement that changes nothing is a failure, not a silent no-op', () => {
    const out = applyFileEdits('same\n', [{ oldText: 'same', newText: 'same' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no_change');
  });

  test('preserves CRLF line endings and a BOM the model never typed', () => {
    const out = applyFileEdits('﻿a\r\nTARGET\r\nb\r\n', [{ oldText: 'TARGET', newText: 'NEW' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('﻿a\r\nNEW\r\nb\r\n');
  });

  test('an anchor typed with LF still matches a CRLF file', () => {
    const out = applyFileEdits('x\r\ny\r\n', [{ oldText: 'x\ny', newText: 'z' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('z\r\n');
  });

  test('an anchor that overlaps itself is ambiguous, not a silent first-match', () => {
    // Non-overlapping counting reports "aa" in "aaa" once and quietly edits at
    // index 0. Which of the two placements the caller meant is exactly the
    // ambiguity the count exists to refuse.
    const out = applyFileEdits('aaa\n', [{ oldText: 'aa', newText: 'b' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('ambiguous');
    expect(out.message).toContain('appears 2 times');
  });

  test('a mixed-ending file keeps every ending it had outside the replaced span', () => {
    // Normalize-edit-and-rewrite would convert the LF line to CRLF — the same
    // class of silent collateral damage as pi's fuzzy path.
    const out = applyFileEdits('crlf\r\nlf\nTARGET\r\n', [{ oldText: 'TARGET', newText: 'NEW' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('crlf\r\nlf\nNEW\r\n');
  });

  test('a multi-line replacement takes the file\'s ending, and only for what it inserts', () => {
    const out = applyFileEdits('a\r\nb\r\n', [{ oldText: 'a', newText: 'x\ny' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('x\r\ny\r\nb\r\n');
  });

  test('an empty file and a file with no trailing newline both edit cleanly', () => {
    expect(applyFileEdits('', [{ oldText: 'x', newText: 'y' }], '/f')).toMatchObject({ reason: 'not_found' });
    const out = applyFileEdits('last line', [{ oldText: 'last', newText: 'final' }], '/f');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('final line');
  });

  test('does not normalize away characters it merely failed to match', () => {
    // pi's fuzzy fallback would rewrite the WHOLE file out of normalized space,
    // silently converting the unrelated smart quote on line 1. We refuse instead.
    const original = 'const a = “quoted”;\nconst b = "plain";\n';
    const out = applyFileEdits(original, [{ oldText: 'const a = "quoted";', newText: 'x' }], '/f');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_found');
  });
});

// ── the read ────────────────────────────────────────────────────────────────

describe('readFileSlice', () => {
  const file = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

  test('returns the whole file unmarked when it fits', () => {
    expect(readFileSlice(file, { path: '/f', maxChars: 10_000 }))
      .toEqual({ output: file, omitted: 0, first: 1, last: 10, total: 10 });
  });

  test('a cap-truncated read names the offset that continues it', () => {
    const slice = readFileSlice(file, { path: '/f', maxChars: 20 });
    expect(slice.omitted).toBeGreaterThan(0);
    expect(slice.output).toContain('of 10 in /f');
    expect(slice.output).toMatch(/action=read offset=\d+/);
  });

  test('continuing from the named offset reaches the end', () => {
    const first = readFileSlice(file, { path: '/f', maxChars: 20 });
    const offsetMatch = /offset=(\d+)/.exec(first.output);
    if (!offsetMatch) throw new Error('truncated read did not include its continuation offset');
    const next = Number(offsetMatch[1]);
    const second = readFileSlice(file, { path: '/f', offset: next, maxChars: 10_000 });
    expect(second.omitted).toBe(0);
    expect(second.output.split('\n')[0]).toBe(`line ${next}`);
  });

  test('a limit that stops early says so too', () => {
    const slice = readFileSlice(file, { path: '/f', limit: 3, maxChars: 10_000 });
    expect(slice.output).toContain('limit=3');
    expect(slice.output).toContain('offset=4');
  });

  test('a limit that reaches the end is not marked', () => {
    expect(readFileSlice(file, { path: '/f', offset: 8, limit: 3, maxChars: 10_000 }).output)
      .toBe('line 8\nline 9\nline 10');
  });

  test('one line larger than the cap hands over a recipe instead of clipping silently', () => {
    const slice = readFileSlice('x'.repeat(500), { path: '/f', maxChars: 100 });
    expect(slice.output).toContain('does not fit');
    expect(slice.output).toContain('workspace.readFile inside execute_tools');
    expect(slice.omitted).toBe(400);
  });

  test('a leading blank line does not make the next line look free', () => {
    // The joining newline is keyed on the line count, not the running total.
    const slice = readFileSlice('\nabcde\nfghij', { path: '/f', maxChars: 6 });
    expect(slice.output.split('\n\n')[0]).toBe('\nabcde'.slice(0, 6));
    expect(slice.output).toContain('offset=');
  });

  test('an offset past the end says so rather than returning empty', () => {
    expect(readFileSlice(file, { path: '/f', offset: 99, maxChars: 10_000 }).output)
      .toContain('past the end');
  });

  test('a trailing newline ends the last line — no phantom line, no empty continuation', () => {
    const slice = readFileSlice('a\nb\n', { path: '/f', limit: 2, maxChars: 1000 });
    expect(slice).toEqual({ output: 'a\nb\n', omitted: 0, first: 1, last: 2, total: 2 });
  });

  test('an empty file says it is empty rather than returning nothing', () => {
    expect(readFileSlice('', { path: '/f', maxChars: 100 }).output).toBe('[/f is empty]');
  });

  test('a fractional or non-positive limit is one line, never an empty range', () => {
    for (const limit of [0.5, 0, -3]) {
      const slice = readFileSlice('a\nb\nc\n', { path: '/f', limit, maxChars: 100 });
      expect(slice.output.split('\n')[0]).toBe('a');
      expect(slice.last).toBe(1);
      expect(slice.omitted).toBeGreaterThanOrEqual(0);
    }
  });

  test('paging with the offsets it hands back reassembles the file exactly', () => {
    const big = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
    let offset = 1;
    let rebuilt = '';
    for (let guard = 0; guard < 50; guard++) {
      const slice = readFileSlice(big, { path: '/f', offset, maxChars: 30 });
      rebuilt += slice.output.split('\n\n[')[0];
      if (slice.last >= slice.total) break;
      rebuilt += '\n';
      offset = slice.last + 1;
    }
    expect(rebuilt).toBe(big);
  });

  test('never numbers lines — old_text is copied out of this output', () => {
    expect(readFileSlice(file, { path: '/f', maxChars: 10_000 }).output.split('\n')[0]).toBe('line 1');
  });
});

// ── the ledger ──────────────────────────────────────────────────────────────

describe('TurnFileLedger', () => {
  test('authorizes by content, so a different spelling of the same path is fine', () => {
    const ledger = new TurnFileLedger();
    ledger.observeWhole('a.ts', 'body');
    expect(ledger.seenState('a.ts', 'body', 'part').state).toBe('seen');
  });

  test('tells a file that moved on from one never read', () => {
    const ledger = new TurnFileLedger();
    ledger.observeWhole('/a', 'v1');
    expect(ledger.seenState('/a', 'v2', 'part').state).toBe('stale');
    expect(ledger.seenState('/b', 'v2', 'part').state).toBe('never');
  });

  test('counts attempts, failures by reason, and recovery on the same path', () => {
    const ledger = new TurnFileLedger();
    ledger.recordEdit('/a', 'not_found');
    ledger.recordEdit('/a', null);
    ledger.recordEdit('/b', 'ambiguous');
    expect(ledger.snapshot()).toEqual({
      attempts: 3,
      applied: 1,
      failures: { not_found: 1, ambiguous: 1 },
      recoveredPaths: 1,
      abandonedPaths: 1,
    });
  });

  test('coverage extends only when a read continues the prefix already paged', () => {
    const ledger = new TurnFileLedger();
    const content = 'a\nb\nc\nd\n';
    ledger.observeRange('/f', content, 1, 2, 4);
    expect(ledger.seenState('/f', content, 'whole')).toMatchObject({ state: 'partial', coveredTo: 2 });
    ledger.observeRange('/f', content, 4, 4, 4);  // a gap — line 3 still unseen
    expect(ledger.seenState('/f', content, 'whole')).toMatchObject({ state: 'partial', coveredTo: 2 });
    ledger.observeRange('/f', content, 3, 4, 4);  // continues the prefix
    expect(ledger.seenState('/f', content, 'whole').state).toBe('seen');
  });

  test('a partial read still authorizes an edit — the anchor carries its own proof', () => {
    const ledger = new TurnFileLedger();
    const content = 'a\nb\nc\n';
    ledger.observeRange('/f', content, 1, 1, 3);
    expect(ledger.seenState('/f', content, 'part').state).toBe('seen');
  });

  test('a turn with no edit attempt writes no row', () => {
    const ledger = new TurnFileLedger();
    expect(ledger.active).toBe(false);
    ledger.observeWhole('/a', 'x');
    expect(ledger.active).toBe(false);
    ledger.recordEdit('/a', null);
    expect(ledger.active).toBe(true);
  });
});

// ── the tool ────────────────────────────────────────────────────────────────

function memoryVfs(seed: Record<string, string> = {}): VFS & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw makeVfsError('ENOENT', `no such file, open '${path}'`, path);
      return content;
    },
    async writeFile(path: string, data: string | Uint8Array) { files.set(path, String(data)); },
    async readdir() { return ['local']; },
    async stat() { return null; },
    async unlink(path: string) { files.delete(path); },
    async mkdir() {},
    async exists(path: string) { return files.has(path); },
  };
}

/** What the MODEL can emit, which is wider than the declared `FileToolInput`:
 *  the AI SDK does not validate a jsonSchema-declared tool input, so the tests
 *  that pin the dispatcher's refusals have to be able to send an action outside
 *  the enum and a path that is not a string. */
type FileToolTestInput = FileToolInput | { action: string; path: string | number };

function toolFor(vfs: VFS, ledger = new TurnFileLedger()) {
  const entry = createFileTool({ vfs, ledger, budget: new TurnContextBudget() });
  return { call: toolExecute<FileToolTestInput, JsonValue>(entry), ledger };
}

const ErrorResultSchema = v.object({ error: v.string() });
const StringResultSchema = v.string();

function errorResult(value: JsonValue): { error: string } {
  return v.parse(ErrorResultSchema, value);
}

describe('file tool', () => {
  test('read returns the content and authorizes the edit that follows', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'a.ts' })).toBe('const x = 1;\n');
    const edited = await call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    });
    expect(edited).toEqual({ ok: true, path: 'a.ts', applied: [{ line: 1, removed_lines: 1, added_lines: 1 }] });
    expect(vfs.files.get('a.ts')).toBe('const x = 2;\n');
  });

  test('an edit without a read is refused, and the refusal names the call to make', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call, ledger } = toolFor(vfs);
    const result = errorResult(await call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    }));
    expect(result.error).toContain('action=read path=a.ts');
    expect(vfs.files.get('a.ts')).toBe('const x = 1;\n');
    expect(ledger.snapshot().failures).toEqual({ unread: 1 });
  });

  test('an edit after the file moved on is refused as stale, not applied blind', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    vfs.files.set('a.ts', 'const x = 1;\nconst y = 2;\n');
    const result = errorResult(await call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 3;' }],
    }));
    expect(result.error).toContain('changed since you read it');
    expect(vfs.files.get('a.ts')).toBe('const x = 1;\nconst y = 2;\n');
    expect(ledger.snapshot().failures).toEqual({ stale: 1 });
  });

  test('a failed edit leaves the file untouched and is counted by reason', async () => {
    const vfs = memoryVfs({ 'a.ts': 'x\nx\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    const result = errorResult(await call({
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }],
    }));
    expect(result.error).toContain('appears 2 times');
    expect(vfs.files.get('a.ts')).toBe('x\nx\n');
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, applied: 0, failures: { ambiguous: 1 }, abandonedPaths: 1 });
  });

  test('the recovery after a failed edit is visible in the turn snapshot', async () => {
    const vfs = memoryVfs({ 'a.ts': 'x\nx\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    await call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }] });
    await call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'x\nx', new_text: 'y\nx' }] });
    expect(ledger.snapshot()).toMatchObject({ attempts: 2, applied: 1, recoveredPaths: 1, abandonedPaths: 0 });
  });

  test('a paged read does NOT authorize discarding the lines it never showed', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const vfs = memoryVfs({ 'big.ts': body });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 'big.ts', limit: 3 });
    const refused = errorResult(await call({ action: 'write', path: 'big.ts', content: 'wiped\n' }));
    expect(refused.error).toContain('read only lines 1-3 of 200');
    expect(refused.error).toContain('offset=4');
    expect(vfs.files.get('big.ts')).toBe(body);
    // …but it does authorize an edit, whose anchor carries its own proof.
    expect(await call({
      action: 'edit', path: 'big.ts', edits: [{ old_text: 'line 1\nline 2\n', new_text: 'line 1\nLINE 2\n' }],
    })).toMatchObject({ ok: true });
  });

  test('paging to the end earns the overwrite — the gate is never a dead end', async () => {
    const body = 'a\nb\nc\n';
    const vfs = memoryVfs({ 's.txt': body });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 's.txt', limit: 1 });
    await call({ action: 'read', path: 's.txt', offset: 2 });
    expect(await call({ action: 'write', path: 's.txt', content: 'z\n' })).toMatchObject({ ok: true, action: 'replaced' });
  });

  test('a BOM is never shown, so the first line the read returns can be matched', async () => {
    const vfs = memoryVfs({ 'a.cs': '\uFEFFusing System;\nclass A {}\n' });
    const { call } = toolFor(vfs);
    const shown = v.parse(StringResultSchema, await call({ action: 'read', path: 'a.cs' }));
    expect(shown.startsWith('\uFEFF')).toBe(false);
    const firstLine = shown.split('\n')[0];
    if (firstLine === undefined) throw new Error('file read returned no first line');
    expect(await call({ action: 'edit', path: 'a.cs', edits: [{ old_text: firstLine, new_text: 'using X;' }] }))
      .toMatchObject({ ok: true });
    expect(vfs.files.get('a.cs')).toBe('\uFEFFusing X;\nclass A {}\n');
  });

  test('an edit missing new_text is refused, never read as a deletion', async () => {
    const vfs = memoryVfs({ 'a.ts': 'alpha\n' });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    const result = errorResult(await call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'alpha' }] }));
    expect(result.error).toContain('needs both old_text and new_text');
    expect(vfs.files.get('a.ts')).toBe('alpha\n');
    // An explicit empty string still deletes.
    expect(await call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'alpha', new_text: '' }] }))
      .toMatchObject({ ok: true });
    expect(vfs.files.get('a.ts')).toBe('\n');
  });

  test('a bare filename does not create a mangled parent directory', async () => {
    const vfs = memoryVfs();
    const dirs: string[] = [];
    const spy: VFS = { ...vfs, mkdir: async (p: string) => { dirs.push(p); } };
    const { call } = toolFor(spy);
    await call({ action: 'write', path: 'notes.txt', content: 'x' });
    expect(dirs).toEqual([]);
  });

  test('a memory write re-indexes however the path is spelled', async () => {
    const indexed: string[] = [];
    const memory: Memory = {
      async write() {},
      async append() {},
      async index(path: string) { indexed.push(path); },
      async search() { return []; },
      async read() { return null; },
    };
    for (const path of ['memory/a.md', '/memory/a.md', 'memory/a.md']) {
      const entry = createFileTool({ vfs: memoryVfs(), ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory });
      await toolExecute(entry)({ action: 'write', path, content: 'x' });
    }
    expect(indexed).toEqual(['memory/a.md', 'memory/a.md', 'memory/a.md']);
  });

  test('a file that reads back as bytes is decoded, not thrown out of the tool', async () => {
    const bytes = new TextEncoder().encode('hello\n');
    const vfs: VFS = { ...memoryVfs(), readFile: async () => bytes };
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'a.bin' })).toBe('hello\n');
  });

  test('write creates a new file without a prior read', async () => {
    const vfs = memoryVfs();
    const { call } = toolFor(vfs);
    expect(await call({ action: 'write', path: 'new.txt', content: 'hi' }))
      .toEqual({ ok: true, path: 'new.txt', bytes: 2, action: 'created' });
    expect(vfs.files.get('new.txt')).toBe('hi');
  });

  test('write over an existing file is refused until it has been read', async () => {
    const vfs = memoryVfs({ 'a.txt': 'original' });
    const { call } = toolFor(vfs);
    const refused = errorResult(await call({ action: 'write', path: 'a.txt', content: 'replacement' }));
    expect(refused.error).toContain('has not been read here yet');
    expect(vfs.files.get('a.txt')).toBe('original');
    await call({ action: 'read', path: 'a.txt' });
    expect(await call({ action: 'write', path: 'a.txt', content: 'replacement' }))
      .toMatchObject({ ok: true, action: 'replaced' });
    expect(vfs.files.get('a.txt')).toBe('replacement');
  });

  test('a write authorizes the edit that follows it — the model authored the content', async () => {
    const vfs = memoryVfs();
    const { call } = toolFor(vfs);
    await call({ action: 'write', path: 'a.txt', content: 'alpha\n' });
    expect(await call({ action: 'edit', path: 'a.txt', edits: [{ old_text: 'alpha', new_text: 'beta' }] }))
      .toMatchObject({ ok: true });
  });

  test('a missing file reports the VFS error with the addressing correction', async () => {
    const { call } = toolFor(memoryVfs());
    const result = errorResult(await call({ action: 'read', path: '/app/main.py' }));
    expect(result.error).toContain('ENOENT');
    expect(result.error).toContain('NOT the machine or container');
    expect(result.error).toContain('roots are: local');
  });

  test('a read counts against the turn budget like any other bulk result', async () => {
    const vfs = memoryVfs({ 'big.txt': 'x'.repeat(500) });
    const ledger = new TurnFileLedger();
    const budget = new TurnContextBudget();
    const entry = createFileTool({ vfs, ledger, budget });
    await toolExecute(entry)({ action: 'read', path: 'big.txt' });
    expect(budget.snapshot().admittedChars).toBe(500);
  });

  test('an unknown action is refused with the three that work, not just echoed', async () => {
    // It used to answer `unknown file action 'append'` — true, and useless: the
    // model was told what it typed and none of the words that would have
    // worked. Same wording as every other native dispatcher now
    // (registry.unknownActionError).
    const { call } = toolFor(memoryVfs());
    expect(await call({ action: 'append', path: 'a' })).toEqual({
      reason: 'bad_input',
      error: 'file requires `action` — one of read, write, edit; got "append"',
    });
  });

  test('a path of the wrong type is refused, not fed to `path.trim()`', async () => {
    // `args.path.trim()` was the first statement in the dispatcher, so a
    // non-string path threw a TypeError out of the tool instead of answering.
    const { call } = toolFor(memoryVfs());
    expect(await call({ action: 'read', path: 7 })).toEqual({
      reason: 'bad_input',
      error: 'file requires `path`.',
    });
  });
});

/**
 * The attribution chain, end to end, on the row an investigation actually reads.
 *
 * The dispatcher has always COMPUTED why a call failed — nine distinct reasons —
 * and returned only prose, recording the reason in per-TURN counters and nowhere
 * per call. So a durable `tool_call_end` said `file` failed and a reader could
 * not tell a refusal it was right to make from a broken filesystem. This drives
 * the real dispatcher, through the real accumulator, to the real event, and
 * classifies that event: every link is production code.
 */
describe('a `file` failure is attributable from the durable row alone', () => {
  /** Run one call through the dispatcher and the accumulator, and classify the
   *  `tool_call_end` the accumulator emitted. */
  async function ledgerRow(
    call: (input: FileToolTestInput) => Promise<JsonValue>, input: FileToolTestInput,
  ) {
    const events: Array<Omit<Extract<RunEvent, { type: 'tool_call_end' }>, keyof RunEventBase | 'type'>> = [];
    const acc = new TurnAccumulator({ onToolCallEvent: (e) => events.push(e) });
    const output = await call(input);
    // `input` is an interface union, so it lacks the index signature `JsonObject`
    // requires even though every value in it IS json — including the
    // deliberately-bad `path: number` fixture. Parsed at the boundary rather
    // than asserted: a fixture that ever stops being json fails here loudly.
    acc.recordToolCall({ toolName: 'file', input: v.parse(JsonObjectSchema, input), success: true, output });
    const emitted = events[0];
    if (!emitted) throw new Error('the accumulator emitted no tool_call_end');
    return {
      output,
      failure: classifyToolFailure({
        type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
        timestamp: new Date().toISOString(), ...emitted,
      }),
    };
  }

  test('an unread edit lands as file·edit·unread, refused', async () => {
    const { call } = toolFor(memoryVfs({ 'a.ts': 'const x = 1;\n' }));
    const { failure } = await ledgerRow(call, {
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    });
    expect(failure).toEqual({
      tool: 'file', action: 'edit', reason: 'unread', refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('an absent anchor lands as file·edit·not_found, refused', async () => {
    const { call } = toolFor(memoryVfs({ 'a.ts': 'const x = 1;\n' }));
    await call({ action: 'read', path: 'a.ts' });
    const { failure } = await ledgerRow(call, {
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'const y = 9;', new_text: 'z' }],
    });
    expect(failure).toEqual({
      tool: 'file', action: 'edit', reason: 'not_found', refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('a repeated anchor lands as file·edit·ambiguous, refused', async () => {
    const { call } = toolFor(memoryVfs({ 'a.ts': 'x\nx\n' }));
    await call({ action: 'read', path: 'a.ts' });
    const { failure } = await ledgerRow(call, {
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }],
    });
    expect(failure).toMatchObject({ action: 'edit', reason: 'ambiguous', refused: true });
  });

  test('an unread overwrite lands as file·write·unread, refused', async () => {
    const { call } = toolFor(memoryVfs({ 'a.txt': 'original' }));
    const { failure } = await ledgerRow(call, { action: 'write', path: 'a.txt', content: 'replacement' });
    expect(failure).toEqual({
      tool: 'file', action: 'write', reason: 'unread', refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('a path that does not exist lands as missing and is NOT a refusal', async () => {
    // The line that keeps the split honest: the tool did not decide anything
    // here, so this stays in the candidate-defect bucket.
    const { call } = toolFor(memoryVfs());
    const { failure } = await ledgerRow(call, { action: 'read', path: 'gone.ts' });
    expect(failure).toMatchObject({ tool: 'file', action: 'read', reason: 'missing', refused: false });
  });

  test('malformed edits land as bad_input, refused', async () => {
    const { call } = toolFor(memoryVfs({ 'a.ts': 'x\n' }));
    const { failure } = await ledgerRow(call, { action: 'edit', path: 'a.ts', edits: [] });
    expect(failure).toEqual({
      tool: 'file', action: 'edit', reason: 'bad_input', refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('a successful edit produces no failure at all', async () => {
    const { call } = toolFor(memoryVfs({ 'a.ts': 'const x = 1;\n' }));
    await call({ action: 'read', path: 'a.ts' });
    const { failure } = await ledgerRow(call, {
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    });
    expect(failure).toBeNull();
  });
});
