/** The `file` tool: exact-match editor, honest read, read-before-write gate. Asserts the model-facing contract. */

import { describe, expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { applyFileEdits, formatFileSlice, type FileEditFailure } from '../src/tools/file-edit';
import { scanFileWindow } from '../src/tools/file-scan';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { createFileTool, type FileToolInput } from '../src/tools/file-tool';
import { SPILL_DIRS, TurnContextBudget } from '../src/context-budget';
import { JsonObjectSchema } from '../src/utils/json';
import { makeVfsError } from '../src/vfs/errno';
import { RESIDENT_TEXT_MAX_BYTES } from '../src/vfs/mounts';
import type { Memory, VFS, VfsEntryStat } from '../src/types/primitives';
import { fnv1a64 } from '../src/utils/fnv1a';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../src/tools/clamp';
import type { JsonValue } from '../src/utils/json';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { classifyToolFailure } from '../src/read-models/tool-failures';
import type { RunEvent, RunEventBase } from '../src/events/types';
import { KinuError } from '../src/obs/index';
import { failedToolOutcome } from '../src/tools/outcome';


describe('applyFileEdits', () => {
  test('replaces the one occurrence and leaves the rest byte-identical', () => {
    const out = applyFileEdits('a\nTARGET\nb\n', [{ oldText: 'TARGET', newText: 'REPLACED' }], '/f');
    expect(out.ok).toBe(true);

    if (!out.ok) return;
    expect(out.content).toBe('a\nREPLACED\nb\n');
    expect(out.applied).toEqual([{ line: 2, removedLines: 1, addedLines: 1 }]);
  });

  /** Each refusal: the anchor as typed, the file, and what the message must say to recover without another read. */
  const REFUSALS: ReadonlyArray<{
    name: string;
    file: string;
    edits: ReadonlyArray<{ oldText: string; newText: string }>;
    reason: FileEditFailure;
    says: readonly string[];
  }> = [
    {
      name: 'refuses an anchor that appears more than once, naming the count',
      file: 'x\nx\n', edits: [{ oldText: 'x', newText: 'y' }],
      reason: 'ambiguous', says: ['appears 2 times', 'unique'],
    },
    {
      name: 'refuses an anchor that is absent, and says to re-read',
      file: 'hello\n', edits: [{ oldText: 'goodbye', newText: 'x' }],
      reason: 'not_found', says: ['does not appear'],
    },
    {
      name: 'refuses an empty anchor rather than matching everywhere',
      file: 'hello\n', edits: [{ oldText: '', newText: 'x' }],
      reason: 'empty_anchor', says: [],
    },
    {
      name: 'is atomic: one bad edit in a batch applies none of them',
      file: 'alpha\nbeta\n',
      edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'missing', newText: 'x' }],
      reason: 'not_found', says: ['edits[1].old_text'],
    },
    {
      name: 'rejects two edits that cover overlapping text',
      file: 'abcdef\n',
      edits: [{ oldText: 'abcd', newText: 'X' }, { oldText: 'cdef', newText: 'Y' }],
      reason: 'overlap', says: ['edits[0] and edits[1]'],
    },
    {
      name: 'a replacement that changes nothing is a failure, not a silent no-op',
      file: 'same\n', edits: [{ oldText: 'same', newText: 'same' }],
      reason: 'no_change', says: [],
    },
    {
      // Overlapping matches count: "aa" in "aaa" is ambiguous and must be refused.
      name: 'an anchor that overlaps itself is ambiguous, not a silent first-match',
      file: 'aaa\n', edits: [{ oldText: 'aa', newText: 'b' }],
      reason: 'ambiguous', says: ['appears 2 times'],
    },
  ];

  for (const refusal of REFUSALS) {
    test(refusal.name, () => {
      const out = applyFileEdits(refusal.file, refusal.edits, '/f');

      expect(out.ok).toBe(false);

      if (out.ok) return;
      expect(out.reason).toBe(refusal.reason);

      for (const phrase of refusal.says) expect(out.message).toContain(phrase);
    });
  }

  test('matches every edit against the file as read, not against a sibling result', () => {
    // Matching is against the original, so a replacement never feeds a later edit.
    const out = applyFileEdits(
      'one\ntwo\n',
      [{ oldText: 'one', newText: 'two' }, { oldText: 'two', newText: 'three' }],
      '/f',
    );

    expect(out.ok).toBe(true);

    if (!out.ok) return;
    expect(out.content).toBe('two\nthree\n');
  });

  /** A successful edit keeps line endings, an untyped BOM, and every line outside the anchor. */
  const REWRITES = [
    {
      name: 'preserves CRLF line endings and a BOM the model never typed',
      file: '﻿a\r\nTARGET\r\nb\r\n', edits: [{ oldText: 'TARGET', newText: 'NEW' }],
      content: '﻿a\r\nNEW\r\nb\r\n',
    },
    {
      name: 'an anchor typed with LF still matches a CRLF file',
      file: 'x\r\ny\r\n', edits: [{ oldText: 'x\ny', newText: 'z' }],
      content: 'z\r\n',
    },
    {
      name: 'a mixed-ending file keeps every ending it had outside the replaced span',
      file: 'crlf\r\nlf\nTARGET\r\n', edits: [{ oldText: 'TARGET', newText: 'NEW' }],
      content: 'crlf\r\nlf\nNEW\r\n',
    },
    {
      name: 'a multi-line replacement takes the file\'s ending, and only for what it inserts',
      file: 'a\r\nb\r\n', edits: [{ oldText: 'a', newText: 'x\ny' }],
      content: 'x\r\ny\r\nb\r\n',
    },
  ];

  for (const rewrite of REWRITES) {
    test(rewrite.name, () => {
      const out = applyFileEdits(rewrite.file, rewrite.edits, '/f');

      expect(out.ok).toBe(true);

      if (!out.ok) return;
      expect(out.content).toBe(rewrite.content);
    });
  }

  test('an empty file and a file with no trailing newline both edit cleanly', () => {
    expect(applyFileEdits('', [{ oldText: 'x', newText: 'y' }], '/f')).toMatchObject({ reason: 'not_found' });
    const out = applyFileEdits('last line', [{ oldText: 'last', newText: 'final' }], '/f');
    expect(out.ok).toBe(true);

    if (!out.ok) return;
    expect(out.content).toBe('final line');
  });

  test('does not normalize away characters it merely failed to match', () => {
    // A fuzzy fallback would rewrite the whole file out of normalized space; refuse instead.
    const original = 'const a = “quoted”;\nconst b = "plain";\n';
    const out = applyFileEdits(original, [{ oldText: 'const a = "quoted";', newText: 'x' }], '/f');
    expect(out.ok).toBe(false);

    if (out.ok) return;
    expect(out.reason).toBe('not_found');
  });
});


describe('the honest read, scanned rather than made resident', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1} ${'.'.repeat(12)}`);
  const file = lines.join('\n');
  // Above the continuation marker's length and below the file, so the cap truncates. Under the marker, the marker wins.
  const CAP = 180;

  /**
   * The tool's real read: range-only plane scanned seven bytes at a time to cross chunk boundaries.
   * Every case asserts no unbounded read happened.
   */
  const slice = async (content: string, opts: { offset?: number; limit?: number; maxChars: number; path?: string }) => {
    const path = opts.path ?? '/f';
    const vfs = memoryVfs({ [path]: content }, { perRead: 7 });
    const scanned = await scanFileWindow(vfs, path, opts);

    expect(vfs.wholeReads).toEqual([]);
    // The ledger keys on the whole file, never the shown window.
    expect(scanned.fingerprint).toBe(fnv1a64(content));

    return formatFileSlice(scanned.window, { path, limit: opts.limit, maxChars: opts.maxChars });
  };

  test('returns the whole file unmarked when it fits', async () => {
    expect(await slice(file, { maxChars: 10_000 }))
      .toEqual({ output: file, omitted: 0, first: 1, last: 10, total: 10 });
  });

  test('a cap-truncated read names the offset that continues it, marker inside the cap', async () => {
    const capped = await slice(file, { maxChars: CAP });
    expect(capped.omitted).toBeGreaterThan(0);
    expect(capped.output).toContain('of 10 in /f');
    expect(capped.output).toMatch(/action=read offset=\d+/);
    // The marker counts against the budget.
    expect(capped.output.length).toBeLessThanOrEqual(CAP);
  });

  test('continuing from the named offset reaches the end', async () => {
    const first = await slice(file, { maxChars: CAP });
    const offsetMatch = /offset=(\d+)/.exec(first.output);

    if (!offsetMatch) throw new Error('truncated read did not include its continuation offset');
    const next = Number(offsetMatch[1]);
    const second = await slice(file, { offset: next, maxChars: 10_000 });
    expect(second.omitted).toBe(0);
    expect(second.output.split('\n')[0]).toBe(lines[next - 1]);
  });

  test('a limit that stops early says so too', async () => {
    const limited = await slice(file, { limit: 3, maxChars: 10_000 });
    expect(limited.output).toContain('limit=3');
    expect(limited.output).toContain('offset=4');
  });

  test('a limit that reaches the end is not marked', async () => {
    expect((await slice(file, { offset: 8, limit: 3, maxChars: 10_000 })).output)
      .toBe(lines.slice(7).join('\n'));
  });

  test('one line larger than the cap hands over a recipe instead of clipping silently', async () => {
    const huge = await slice('x'.repeat(500), { maxChars: 300 });
    expect(huge.output).toContain('is 500 chars and does not fit');
    expect(huge.output).toContain('workspace.readFile inside eval');
    expect(huge.output.length).toBeLessThanOrEqual(300);
    expect(huge.omitted).toBe(500 - huge.output.indexOf('\n\n['));
  });

  test('a leading blank line does not make the next line look free', async () => {
    // The joining newline costs a char per line after the first; at this cap the rule keeps 2 lines, not 3.
    const rows = ['', ...Array.from({ length: 29 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(10))];
    const blank = await slice(rows.join('\n'), { maxChars: 121 });

    expect(blank.output.split('\n\n[')[0]).toBe('\naaaaaaaaaa');
    expect(blank.last).toBe(2);
    expect(blank.output).toContain('offset=3');
    expect(blank.output.length).toBeLessThanOrEqual(121);
  });

  test('an offset past the end says so rather than returning empty', async () => {
    expect((await slice(file, { offset: 99, maxChars: 10_000 })).output).toContain('past the end');
  });

  test('a trailing newline ends the last line — no phantom line, no empty continuation', async () => {
    expect(await slice('a\nb\n', { limit: 2, maxChars: 1000 }))
      .toEqual({ output: 'a\nb\n', omitted: 0, first: 1, last: 2, total: 2 });
  });

  test('a whole read that only just fits keeps the file byte-identical', async () => {
    // The file's trailing newline counts toward the cap.
    const content = 'ab\ncd\n';
    expect((await slice(content, { maxChars: content.length })).output).toBe(content);
    expect((await slice(content, { maxChars: content.length - 1 })).output).not.toBe(content);
  });

  test('multibyte text survives the slice as characters, not halves', async () => {
    const emoji = await slice('🙂'.repeat(500), { maxChars: 300 });
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji.output)).toBe(false);
    expect(emoji.output.length).toBeLessThanOrEqual(300);
  });

  test('an empty file says it is empty rather than returning nothing', async () => {
    expect((await slice('', { maxChars: 100 })).output).toBe('[/f is empty]');
  });

  test('a fractional or non-positive limit is one line, never an empty range', async () => {
    for (const limit of [0.5, 0, -3]) {
      const one = await slice('a\nb\nc\n', { limit, maxChars: 100 });
      expect(one.output.split('\n')[0]).toBe('a');
      expect(one.last).toBe(1);
      expect(one.output).toContain('limit=1');
    }
  });

  test('paging with the offsets it hands back reassembles the file exactly', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
    let offset = 1;
    let rebuilt = '';

    for (let guard = 0; guard < 50; guard++) {
      const page = await slice(big, { offset, maxChars: CAP });
      expect(page.output.length).toBeLessThanOrEqual(CAP);
      rebuilt += page.output.split('\n\n[')[0];

      if (page.last >= page.total) break;
      rebuilt += '\n';
      offset = page.last + 1;
    }

    expect(rebuilt).toBe(big);
  });

  test('never numbers lines — old_text is copied out of this output', async () => {
    expect((await slice(file, { maxChars: 10_000 })).output.split('\n')[0]).toBe(lines[0]);
  });

  test('a path too long for the cap leaves the marker, never the other way round', async () => {
    const deep = `/${'deep-directory-name/'.repeat(12)}file.ts`;
    expect(deep.length).toBeGreaterThan(CAP);

    const capped = await slice(file, { maxChars: CAP, path: deep });
    expect(capped.output.length).toBeLessThanOrEqual(CAP);
    expect(capped.output).toContain(`continue with action=read offset=${capped.last + 1}`);
    expect(capped.output).not.toContain(deep);

    const empty = await slice('', { maxChars: CAP, path: deep });
    expect(empty.output.length).toBeLessThanOrEqual(CAP);
    expect(empty.output).toContain('is empty');

    const huge = await slice('z'.repeat(500), { maxChars: CAP, path: deep });
    expect(huge.output.length).toBeLessThanOrEqual(CAP);
    expect(huge.output).toContain('does not fit');
    expect(huge.output).toContain('is 500 chars');

    const past = await slice(file, { offset: 99, maxChars: CAP, path: deep });
    expect(past.output.length).toBeLessThanOrEqual(CAP);
    expect(past.output).toContain('past the end');
  });

  test('a read where no whole line fits claims no coverage at all', async () => {
    const original = 'z'.repeat(500);
    const giant = await slice(original, { maxChars: CAP });

    // `last` < `first` means no line shown; the ledger records no page.
    expect(giant.last).toBe(giant.first - 1);

    const ledger = new TurnFileLedger();
    ledger.observeRange('/f', { fingerprint: fnv1a64(original), first: giant.first, last: giant.last, total: giant.total });
    // That content is known and unread: an overwrite discarding it is refused.
    expect(ledger.seenState('/f', original, 'whole')).toEqual({ state: 'partial', coveredTo: 0, total: 1 });
  });

  test('the window reports the range the file has, not the part that was kept', async () => {
    const vfs = memoryVfs({ '/f': file }, { perRead: 7 });
    const { window } = await scanFileWindow(vfs, '/f', { maxChars: CAP });
    // Counts describe the whole requested range; `lines` is only the head that fit.
    expect(window).toMatchObject({ first: 1, total: 10, trailingNewline: false, requestedLines: 10 });
    const [firstLine = ''] = lines;

    expect(window.requestedChars).toBe(file.length);
    expect(window.firstLineChars).toBe(firstLine.length);
    expect(window.lines.length).toBeLessThan(window.requestedLines);
  });
});


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
    ledger.observeRange('/f', { fingerprint: fnv1a64(content), first: 1, last: 2, total: 4 });
    expect(ledger.seenState('/f', content, 'whole')).toMatchObject({ state: 'partial', coveredTo: 2 });
    ledger.observeRange('/f', { fingerprint: fnv1a64(content), first: 4, last: 4, total: 4 });  // a gap: line 3 still unseen
    expect(ledger.seenState('/f', content, 'whole')).toMatchObject({ state: 'partial', coveredTo: 2 });
    ledger.observeRange('/f', { fingerprint: fnv1a64(content), first: 3, last: 4, total: 4 });  // continues the prefix
    expect(ledger.seenState('/f', content, 'whole').state).toBe('seen');
  });

  test('a partial read still authorizes an edit — the anchor carries its own proof', () => {
    const ledger = new TurnFileLedger();
    const content = 'a\nb\nc\n';
    ledger.observeRange('/f', { fingerprint: fnv1a64(content), first: 1, last: 1, total: 3 });
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


/**
 * Plane with a ranged read like every production plane. `perRead` caps bytes per `readRange` so small
 * fixtures cross chunk and multi-byte boundaries; `wholeReads` records every unbounded `readFile`.
 */
function memoryVfs(seed: Record<string, string> = {}, opts: { perRead?: number; revisions?: boolean } = {}) {
  const files = new Map(Object.entries(seed));
  // Starts with a revision so a later write bumps it to a new value.
  const revisions = new Map(Object.keys(seed).map((path) => [path, 1]));
  const wholeReads: string[] = [];
  const encoder = new TextEncoder();

  /** Replace a file as a peer process would: new content and, where supported, a new revision. */
  const write = (path: string, content: string): void => {
    files.set(path, content);
    revisions.set(path, (revisions.get(path) ?? 0) + 1);
  };

  const bytesOf = (path: string): Uint8Array => {
    const content = files.get(path);

    if (content === undefined) throw makeVfsError('ENOENT', `no such file, open '${path}'`, path);

    return encoder.encode(content);
  };

  return {
    files,
    wholeReads,
    write,
    async readFile(path: string) {
      wholeReads.push(path);
      const content = files.get(path);

      if (content === undefined) throw makeVfsError('ENOENT', `no such file, open '${path}'`, path);

      return content;
    },
    readRange: async (path: string, offset: number, length: number) => bytesOf(path)
      .subarray(offset, offset + Math.min(length, opts.perRead ?? length)),
    async writeFile(path: string, data: string | Uint8Array) { write(path, String(data)); },
    async readdir() { return ['local']; },
    async stat(path: string): Promise<VfsEntryStat | null> {
      const content = files.get(path);

      if (content === undefined) return null;
      const stat: VfsEntryStat = { size: encoder.encode(content).byteLength, mtimeMs: 0, isDir: false };

      if (opts.revisions) stat.revision = revisions.get(path) ?? 1;


      return stat;
    },
    async unlink(path: string) { files.delete(path); },
    async mkdir() {},
    async exists(path: string) { return files.has(path); },
  };
}

/** What the model can emit: the AI SDK does not validate jsonSchema tool input, so actions and paths may be off-schema. */
type FileToolTestInput = FileToolInput | { action: string; path: string | number };

function toolFor(vfs: VFS, ledger = new TurnFileLedger()) {
  const entry = createFileTool({ vfs, ledger, budget: new TurnContextBudget() });

  return { call: toolExecute<FileToolTestInput, JsonValue>(entry), ledger };
}

const StringResultSchema = v.string();


describe('file tool', () => {
  test('read returns the content and authorizes the edit that follows', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'a.ts' })).toBe('const x = 1;\n');

    const edited = await call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    });

    expect(edited).toEqual({ ok: true, path: 'a.ts', reference: 'vfs://a.ts', applied: [{ line: 1, removed_lines: 1, added_lines: 1 }] });
    expect(vfs.files.get('a.ts')).toBe('const x = 2;\n');
  });

  test('an edit without a read is refused, and the refusal names the call to make', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call, ledger } = toolFor(vfs);

    const result = call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    });

    await expect(result).rejects.toThrow('action=read path=a.ts');
    expect(vfs.files.get('a.ts')).toBe('const x = 1;\n');
    expect(ledger.snapshot().failures).toEqual({ unread: 1 });
  });

  test('an edit after the file moved on is refused as stale, not applied blind', async () => {
    const vfs = memoryVfs({ 'a.ts': 'const x = 1;\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    vfs.files.set('a.ts', 'const x = 1;\nconst y = 2;\n');

    const result = call({
      action: 'edit', path: 'a.ts',
      edits: [{ old_text: 'const x = 1;', new_text: 'const x = 3;' }],
    });

    await expect(result).rejects.toThrow('changed since you read it');
    expect(vfs.files.get('a.ts')).toBe('const x = 1;\nconst y = 2;\n');
    expect(ledger.snapshot().failures).toEqual({ stale: 1 });
  });

  test('a failed edit leaves the file untouched and is counted by reason', async () => {
    const vfs = memoryVfs({ 'a.ts': 'x\nx\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });

    const result = call({
      action: 'edit', path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }],
    });

    await expect(result).rejects.toThrow('appears 2 times');
    expect(vfs.files.get('a.ts')).toBe('x\nx\n');
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, applied: 0, failures: { ambiguous: 1 }, abandonedPaths: 1 });
  });

  test('the recovery after a failed edit is visible in the turn snapshot', async () => {
    const vfs = memoryVfs({ 'a.ts': 'x\nx\n' });
    const { call, ledger } = toolFor(vfs);
    await call({ action: 'read', path: 'a.ts' });
    await expect(call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }] })).rejects.toBeInstanceOf(KinuError);
    await call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'x\nx', new_text: 'y\nx' }] });
    expect(ledger.snapshot()).toMatchObject({ attempts: 2, applied: 1, recoveredPaths: 1, abandonedPaths: 0 });
  });

  test('a paged read does NOT authorize discarding the lines it never showed', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const vfs = memoryVfs({ 'big.ts': body });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 'big.ts', limit: 3 });
    const refused = call({ action: 'write', path: 'big.ts', content: 'wiped\n' });
    await expect(refused).rejects.toThrow('read only lines 1-3 of 200');
    await expect(refused).rejects.toThrow('offset=4');
    expect(vfs.files.get('big.ts')).toBe(body);
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
    const result = call({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'alpha' }] });
    await expect(result).rejects.toThrow('needs both old_text and new_text');
    expect(vfs.files.get('a.ts')).toBe('alpha\n');
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
      async tail() { return null; },
    };

    for (const path of ['memory/a.md', '/memory/a.md', 'memory/a.md']) {
      const entry = createFileTool({ vfs: memoryVfs(), ledger: new TurnFileLedger(), budget: new TurnContextBudget(), memory });
      await toolExecute(entry)({ action: 'write', path, content: 'x' });
    }

    expect(indexed).toEqual(['memory/a.md', 'memory/a.md', 'memory/a.md']);
  });

  test('a file that reads back as bytes is decoded, not thrown out of the tool', async () => {
    // Only an unranged plane is asked for a whole file, so bytes-for-utf8 must be survivable there.
    const bytes = new TextEncoder().encode('hello\n');
    const { readRange: _ranged, ...unranged } = memoryVfs({ 'a.bin': 'hello\n' });
    const { call } = toolFor({ ...unranged, readFile: async () => bytes });
    expect(await call({ action: 'read', path: 'a.bin' })).toBe('hello\n');
  });

  test('write creates a new file without a prior read', async () => {
    const vfs = memoryVfs();
    const { call } = toolFor(vfs);
    expect(await call({ action: 'write', path: 'new.txt', content: 'hi' }))
      .toEqual({ ok: true, path: 'new.txt', reference: 'vfs://new.txt', bytes: 2, action: 'created' });
    expect(vfs.files.get('new.txt')).toBe('hi');
  });

  test('write over an existing file is refused until it has been read', async () => {
    const vfs = memoryVfs({ 'a.txt': 'original' });
    const { call } = toolFor(vfs);
    const refused = call({ action: 'write', path: 'a.txt', content: 'replacement' });
    await expect(refused).rejects.toThrow('has not been read here yet');
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
    const result = call({ action: 'read', path: '/app/main.py' });
    await expect(result).rejects.toThrow('ENOENT');
    await expect(result).rejects.toThrow('NOT the machine or container');
    await expect(result).rejects.toThrow('roots are: local');
  });

  test('a read counts against the turn budget like any other bulk result', async () => {
    const vfs = memoryVfs({ 'big.txt': 'x'.repeat(500) });
    const ledger = new TurnFileLedger();
    const budget = new TurnContextBudget();
    const entry = createFileTool({ vfs, ledger, budget });
    await toolExecute(entry)({ action: 'read', path: 'big.txt' });
    expect(budget.snapshot().admittedChars).toBe(500);
  });


  test('a path of the wrong type is refused, not fed to `path.trim()`', async () => {
    // A non-string path must be answered, not thrown as a TypeError.
    const { call } = toolFor(memoryVfs());
    await expect(call({ action: 'read', path: 7 })).rejects.toMatchObject({ code: 'bad_input', message: 'file requires `path`.' });
  });
});

/**
 * The read is bounded in memory, not I/O: only the requested window is kept, but every byte is hashed
 * because the ledger keys on the whole-content fingerprint.
 */
describe('a `file` read never makes the file resident', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  const exactly: ReadonlyArray<{ what: string; body: string; shown: string }> = [
    { what: 'multi-byte UTF-8 split across reads', body: 'héllo 😀\nκόσμε\nlast\n', shown: 'héllo 😀\nκόσμε\nlast\n' },
    { what: 'CRLF line endings', body: 'a\r\nb\r\nc\r\n', shown: 'a\r\nb\r\nc\r\n' },
    { what: 'a trailing newline', body: 'alpha\nbeta\n', shown: 'alpha\nbeta\n' },
    { what: 'no trailing newline', body: 'alpha\nbeta', shown: 'alpha\nbeta' },
    { what: 'an empty file', body: '', shown: '[f.txt is empty]' },
  ];

  for (const { what, body, shown } of exactly) {
    test(`three bytes at a time returns ${what} exactly`, async () => {
      const vfs = memoryVfs({ 'f.txt': body }, { perRead: 3 });
      const { call } = toolFor(vfs);
      expect(await call({ action: 'read', path: 'f.txt' })).toBe(shown);
      expect(vfs.wholeReads).toEqual([]);
    });
  }

  test('a BOM split from its own line still never reaches the model, and survives the edit', async () => {
    const vfs = memoryVfs({ 'a.cs': '\uFEFFusing System;\nclass A {}\n' }, { perRead: 2 });
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'a.cs' })).toBe('using System;\nclass A {}\n');
    expect(await call({ action: 'edit', path: 'a.cs', edits: [{ old_text: 'using System;', new_text: 'using X;' }] }))
      .toMatchObject({ ok: true });
    expect(vfs.files.get('a.cs')).toBe('\uFEFFusing X;\nclass A {}\n');
  });

  test('a windowed read of a large file returns that window and reads no whole file', async () => {
    const vfs = memoryVfs({ 'big.ts': numbered(4000) }, { perRead: 997 });
    const { call } = toolFor(vfs);
    const out = v.parse(StringResultSchema, await call({ action: 'read', path: 'big.ts', offset: 5, limit: 3 }));
    expect(out.split('\n\n[')[0]).toBe('line 5\nline 6\nline 7');
    expect(out).toContain('of 4000 in big.ts');
    expect(out).toContain('offset=8');
    expect(vfs.wholeReads).toEqual([]);
  });

  test('an offset past the end says so instead of returning empty, and authorizes nothing', async () => {
    const vfs = memoryVfs({ 'f.txt': numbered(12) }, { perRead: 5 });
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'f.txt', offset: 900 })).toContain('past the end');
    expect(vfs.wholeReads).toEqual([]);
    await expect(call({ action: 'write', path: 'f.txt', content: 'wiped\n' }))
      .rejects.toThrow('you have not seen');
  });

  test('one line bigger than the cap is truncated honestly and does not authorize an overwrite', async () => {
    const giant = 'z'.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 1000);
    const vfs = memoryVfs({ 'one.txt': `${giant}\ntail\n` }, { perRead: 1024 });
    const { call } = toolFor(vfs);
    const out = v.parse(StringResultSchema, await call({ action: 'read', path: 'one.txt' }));
    expect(out).toContain('does not fit');
    expect(out).toContain(String(giant.length));
    expect(out.length).toBeLessThan(giant.length);
    expect(vfs.wholeReads).toEqual([]);
    // Seeing a prefix of one enormous line is not seeing the file.
    await expect(call({ action: 'write', path: 'one.txt', content: 'wiped\n' }))
      .rejects.toThrow('you have not seen');
  });

  test('paging the file in contiguous windows earns the overwrite', async () => {
    const body = numbered(200);
    const vfs = memoryVfs({ 'big.ts': body }, { perRead: 128 });
    const { call } = toolFor(vfs);

    for (const offset of [1, 51, 101, 151]) await call({ action: 'read', path: 'big.ts', offset, limit: 50 });

    // Four windows, no whole read (the later overwrite does read the file).
    expect(vfs.wholeReads).toEqual([]);
    expect(await call({ action: 'write', path: 'big.ts', content: 'replacement\n' }))
      .toMatchObject({ ok: true, action: 'replaced' });
  });

  test('a gap between windows does not, and the refusal names the line to resume from', async () => {
    const vfs = memoryVfs({ 'big.ts': numbered(200) }, { perRead: 128 });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 'big.ts', offset: 1, limit: 50 });
    await call({ action: 'read', path: 'big.ts', offset: 101, limit: 50 });

    const refused = call({ action: 'write', path: 'big.ts', content: 'replacement\n' });
    await expect(refused).rejects.toThrow('read only lines 1-50 of 200');
    await expect(refused).rejects.toThrow('offset=51');
  });

  test('content that changed to the same length is still refused — the key is the content, not its size', async () => {
    const vfs = memoryVfs({ 'f.txt': 'alpha\nbeta\n' }, { perRead: 4 });
    const { call } = toolFor(vfs);
    await call({ action: 'read', path: 'f.txt' });
    vfs.files.set('f.txt', 'alpha\nbetX\n');

    await expect(call({ action: 'edit', path: 'f.txt', edits: [{ old_text: 'alpha', new_text: 'ALPHA' }] }))
      .rejects.toThrow('changed since you read it');
    expect(vfs.files.get('f.txt')).toBe('alpha\nbetX\n');
  });

  test('a file rewritten mid-scan is refused, not reported as a version that never existed', async () => {
    const plane = memoryVfs({ 'f.txt': `${'a'.repeat(40)}\nsecond\n` }, { perRead: 8, revisions: true });
    let moved = false;

    const vfs = {
      ...plane,
      async readRange(path: string, offset: number, length: number) {
        if (offset > 0 && !moved) {
          moved = true;
          plane.write(path, `${'b'.repeat(40)}\nsecond\n`);
        }

        return plane.readRange(path, offset, length);
      },
    };

    const { call } = toolFor(vfs);
    await expect(call({ action: 'read', path: 'f.txt' })).rejects.toThrow('changed while it was being read');
    await expect(call({ action: 'edit', path: 'f.txt', edits: [{ old_text: 'second', new_text: 'third' }] }))
      .rejects.toThrow('has not been read here yet');
  });

  test('a stable revision across the scan is not mistaken for a change', async () => {
    const vfs = memoryVfs({ 'f.txt': 'alpha\nbeta\n' }, { perRead: 3, revisions: true });
    const { call } = toolFor(vfs);
    expect(await call({ action: 'read', path: 'f.txt' })).toBe('alpha\nbeta\n');
  });

  test('a ranged read the credential may not make is reported as denied, not as a broken file', async () => {
    const plane = memoryVfs({ 'f.txt': 'secret\n' });

    const denying = {
      ...plane,
      async readRange(path: string) { throw makeVfsError('EACCES', `permission denied, open '${path}'`, path); },
    };

    const { call } = toolFor(denying);

    await expect(call({ action: 'read', path: 'f.txt' })).rejects.toMatchObject({ code: 'denied' });
    expect(plane.wholeReads).toEqual([]);
  });

  test('a plane with no ranged read serves a small file and refuses a large one rather than fetching it', async () => {
    const { readRange: _small, ...small } = memoryVfs({ 'f.txt': 'alpha\nbeta\n' });
    expect(await toolFor(small).call({ action: 'read', path: 'f.txt' })).toBe('alpha\nbeta\n');
    expect(small.wholeReads).toEqual(['f.txt']);

    const { readRange: _big, ...big } = memoryVfs({ 'f.txt': 'x'.repeat(RESIDENT_TEXT_MAX_BYTES + 1) });
    const refused = toolFor(big).call({ action: 'read', path: 'f.txt' });
    await expect(refused).rejects.toMatchObject({ code: 'denied' });
    await expect(refused).rejects.toThrow('no ranged read');
    // The refusal must not read the file.
    expect(big.wholeReads).toEqual([]);
  });

  /** Unranged plane with an honest stat and a dishonest read: the file grew in between. */
  const racingVfs = (grown: string) => {
    const { readRange: _none, ...unranged } = memoryVfs({ 'f.txt': 'small\n' });

    return { ...unranged, async readFile() { return grown; } };
  };

  test('a file that grew between the stat and the read is refused, not carried', async () => {
    const refused = toolFor(racingVfs('x'.repeat(RESIDENT_TEXT_MAX_BYTES + 1))).call({ action: 'read', path: 'f.txt' });
    await expect(refused).rejects.toMatchObject({ code: 'denied' });
    await expect(refused).rejects.toThrow('characters cannot be read within');
  });

  test('the budget is bytes, so multibyte text over it is refused however few characters it is', async () => {
    // Three-byte chars: under the budget counted as chars, over it counted as bytes.
    const cjk = '\u4e2d'.repeat(Math.floor(RESIDENT_TEXT_MAX_BYTES / 2));
    expect(cjk.length).toBeLessThan(RESIDENT_TEXT_MAX_BYTES);

    const refused = toolFor(racingVfs(cjk)).call({ action: 'read', path: 'f.txt' });
    await expect(refused).rejects.toMatchObject({ code: 'denied' });
    await expect(refused).rejects.toThrow('bytes cannot be read within');
  });

  test('a result of exactly the budget is served; one byte more is not', async () => {
    const exact = 'a'.repeat(RESIDENT_TEXT_MAX_BYTES);
    expect(await toolFor(racingVfs(exact)).call({ action: 'read', path: 'f.txt' })).toContain('aaa');

    const over = toolFor(racingVfs(`${exact}a`)).call({ action: 'read', path: 'f.txt' });
    await expect(over).rejects.toMatchObject({ code: 'denied' });
  });

  test('a path that is not there is reported missing even by a plane that cannot stat it', async () => {
    const { readRange: _none, ...unranged } = memoryVfs();
    await expect(toolFor(unranged).call({ action: 'read', path: 'gone.txt' }))
      .rejects.toMatchObject({ code: 'missing' });
  });
});

/** Attribution: a real dispatcher call through the real accumulator must classify why `tool_call_end` failed. */
describe('a `file` failure is attributable from the durable row alone', () => {
  /** Run one call through dispatcher and accumulator; classify the emitted `tool_call_end`. */
  async function ledgerRow(
    call: (input: FileToolTestInput) => Promise<JsonValue>, input: FileToolTestInput,
  ) {
    const events: Array<Omit<Extract<RunEvent, { type: 'tool_call_end' }>, keyof RunEventBase | 'type'>> = [];
    const acc = new TurnAccumulator({ onToolCallEvent: (e) => events.push(e) });
    let output: JsonValue | undefined;
    const args = v.parse(JsonObjectSchema, input);

    try {
      output = await call(input);
      acc.recordToolCall({ toolCallId: 'fixture-1', toolName: 'file', input: args, success: true, output });
    } catch (error) {
      acc.recordToolCall({ toolCallId: 'fixture-2', toolName: 'file', input: args, error, ...failedToolOutcome({ cause: error }) });
    }

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
    // The tool decided nothing here, so this stays a candidate defect.
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

/**
 * Producer-side caps on the bulk reads: an uncontrolled directory or file must not become an allocation
 * proportional to its size. The context cap (clamp.ts) only limits what reaches the model.
 */
describe('a bulk read is bounded where it is produced', () => {
  /** The `list` answer for a declared directory, read back from the spill when the context cap replaced it. */
  const listed = async (entries: readonly string[]): Promise<Record<string, JsonValue>> => {
    const vfs = { ...memoryVfs(), async readdir() { return [...entries]; } };
    const { call } = toolFor(vfs);
    const result = await call({ action: 'list', path: '/d' });
    const clamped = v.safeParse(v.string(), result);

    if (!clamped.success) return v.parse(JsonObjectSchema, result);
    const spilled = [...vfs.files].find(([path]) => path.startsWith(`${SPILL_DIRS.toolOutput}/`));

    if (spilled === undefined) throw new Error(`no spill for a clamped listing: ${clamped.output}`);

    return v.parse(JsonObjectSchema, JSON.parse(spilled[1]));
  };

  const plainNames = (count: number): string[] =>
    Array.from({ length: count }, (_, at) => `f${String(at)}.ts`);

  test('a directory the agent does not control is cut at the entry ceiling', async () => {
    const big = await listed(plainNames(3_000));
    const bigger = await listed(plainNames(9_000));
    const shown = v.parse(v.array(v.string()), big.entries);

    // An absolute entry cap: three times the directory returns the same names and says so.
    expect(shown.length).toBeLessThan(3_000);
    expect(v.parse(v.array(v.string()), bigger.entries)).toEqual(shown);
    expect(big.truncated).toEqual({ shown: shown.length, total: 3_000 });
    expect(bigger.truncated).toEqual({ shown: shown.length, total: 9_000 });
  });

  test('the byte ceiling bites on its own — few entries, enormous names', async () => {
    const wide = Array.from({ length: 40 }, (_, at) => `${String(at)}${'n'.repeat(64 * 1024)}`);
    const body = await listed(wide);
    const shown = v.parse(v.array(v.string()), body.entries);

    expect(shown.length).toBeLessThan(wide.length);
    expect(body.truncated).toEqual({ shown: shown.length, total: wide.length });
    // Control: the same count of ordinary names comes back whole.
    expect(await listed(plainNames(wide.length))).toEqual({ path: '/d', entries: plainNames(wide.length) });
  });

  test('a listing that fits is whole, and says nothing about truncation', async () => {
    const body = await listed(['a.ts', 'b.ts']);
    expect(body.entries).toEqual(['a.ts', 'b.ts']);
    expect('truncated' in body).toBe(false);
  });

  test('search reads the head of a file, not the file', async () => {
    const line = `${'x'.repeat(200)}\n`;
    const hit = 'NEEDLE\n';
    // Query in the first line and again past the ceiling; the second proves the read stopped.
    const head = hit + line.repeat(Math.ceil(RESIDENT_TEXT_MAX_BYTES / line.length) + 4_000);
    const vfs = memoryVfs({ 'big.log': head + hit });
    const { call } = toolFor(vfs);
    const body = v.parse(JsonObjectSchema, await call({ action: 'search', path: 'big.log', query: 'NEEDLE' }));

    expect(body.matches).toEqual([{ line: 1, text: 'NEEDLE' }]);
    expect(body.truncated).toEqual({ shown: RESIDENT_TEXT_MAX_BYTES, total: (head + hit).length });
  });

  test('a file that fits is searched whole, and says nothing about truncation', async () => {
    const vfs = memoryVfs({ 's.txt': 'alpha\nNEEDLE\nomega\n' });
    const { call } = toolFor(vfs);
    const body = v.parse(JsonObjectSchema, await call({ action: 'search', path: 's.txt', query: 'NEEDLE' }));

    expect(body.matches).toEqual([{ line: 2, text: 'NEEDLE' }]);
    expect('truncated' in body).toBe(false);
  });
});
