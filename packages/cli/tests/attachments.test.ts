// Prompt-attachment resolution for the CLI chat surfaces: @path mentions
// (plus quoted / ~-prefixed tokens) that stat to real files become data-URL
// PromptFiles (images/PDFs) or path references (everything else).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_INLINE_ATTACHMENT_BYTES } from '@proteus/core';
import {
  describePromptAttachment,
  extractPathTokens,
  resolvePromptAttachments,
} from '../src/attachments.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-attach-'));
  tempDirs.push(dir);
  return dir;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('extractPathTokens', () => {
  test('finds @mentions, quoted tokens, and ~ paths — bare words stay prose', () => {
    const tokens = extractPathTokens(`look at @/tmp/shot.png and "/home/u/my notes.txt" plus ~/docs/spec.pdf but not src/index.ts`);
    expect(tokens.map((t) => ({ path: t.path, mention: t.mention }))).toEqual([
      { path: '/tmp/shot.png', mention: true },
      { path: '/home/u/my notes.txt', mention: false },
      { path: '~/docs/spec.pdf', mention: false },
    ]);
  });

  test('supports quoted @mentions for paths with spaces', () => {
    const tokens = extractPathTokens(`compare @"/tmp/two words.png" please`);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe('/tmp/two words.png');
    expect(tokens[0]!.mention).toBe(true);
  });

  test('an email-style @ inside a word is not a mention', () => {
    expect(extractPathTokens('mail me@example.com today')).toEqual([]);
  });
});

describe('resolvePromptAttachments', () => {
  test('an @mentioned image inlines as a data-URL file and the @ is stripped', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`describe @${img} please`, dir);
    expect(result.text).toBe(`describe ${img} please`);
    expect(result.errors).toEqual([]);
    expect(result.files).toEqual([{
      filename: 'shot.png',
      mediaType: 'image/png',
      url: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    }]);
    expect(result.attached).toEqual([
      { path: img, filename: 'shot.png', mediaType: 'image/png', size: PNG_BYTES.length },
    ]);
  });

  test('a quoted path with spaces resolves (terminal drag-drop)', async () => {
    const dir = makeDir();
    const pdf = join(dir, 'two words.pdf');
    writeFileSync(pdf, '%PDF-1.4');

    const result = await resolvePromptAttachments(`summarize "${pdf}"`, dir);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.mediaType).toBe('application/pdf');
    expect(result.text).toBe(`summarize "${pdf}"`); // only @mentions are rewritten
  });

  test('relative @mentions resolve against the provided cwd', async () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'logo.png'), PNG_BYTES);

    const result = await resolvePromptAttachments('use @assets/logo.png here', dir);
    expect(result.files).toHaveLength(1);
    expect(result.attached[0]!.path).toBe(join(dir, 'assets', 'logo.png'));
    expect(result.text).toBe('use assets/logo.png here');
  });

  test('trailing punctuation after a mention does not break resolution', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`what is in @${img}?`, dir);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filename).toBe('shot.png');
  });

  test('non-multimodal files become path references with a chip, not parts', async () => {
    const dir = makeDir();
    const notes = join(dir, 'notes.txt');
    writeFileSync(notes, 'remember the milk');

    const result = await resolvePromptAttachments(`read @${notes}`, dir);
    expect(result.files).toEqual([]);
    expect(result.attached).toEqual([
      { path: notes, filename: 'notes.txt', mediaType: null, size: 17 },
    ]);
    expect(result.text).toBe(`read ${notes}`);
    expect(describePromptAttachment(result.attached[0]!)).toBe('notes.txt (17 B, referenced)');
  });

  test('an over-cap image is left as a reference with a visible error', async () => {
    const dir = makeDir();
    const big = join(dir, 'huge.png');
    writeFileSync(big, Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1));

    const result = await resolvePromptAttachments(`look at @${big}`, dir);
    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('huge.png is too large to attach');
    expect(result.attached[0]!.mediaType).toBeNull();
  });

  test('the inline cap is a per-message aggregate: a second image that no longer fits falls back to a path reference', async () => {
    const dir = makeDir();
    const first = join(dir, 'first.png');
    const second = join(dir, 'second.png');
    writeFileSync(first, Buffer.alloc(Math.ceil(MAX_INLINE_ATTACHMENT_BYTES * 0.7)));
    writeFileSync(second, Buffer.alloc(Math.ceil(MAX_INLINE_ATTACHMENT_BYTES * 0.7)));

    const result = await resolvePromptAttachments(`compare @${first} with @${second}`, dir);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filename).toBe('first.png');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('second.png is too large to attach');
    expect(result.errors[0]).toContain('per-message budget');
    expect(result.attached).toEqual([
      { path: first, filename: 'first.png', mediaType: 'image/png', size: Math.ceil(MAX_INLINE_ATTACHMENT_BYTES * 0.7) },
      { path: second, filename: 'second.png', mediaType: null, size: Math.ceil(MAX_INLINE_ATTACHMENT_BYTES * 0.7) },
    ]);
  });

  test('nonexistent paths and directories are ignored', async () => {
    const dir = makeDir();
    const result = await resolvePromptAttachments(`see @${join(dir, 'missing.png')} and @${dir}`, dir);
    expect(result.files).toEqual([]);
    expect(result.attached).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('a repeated mention attaches once', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`diff @${img} with @${img}`, dir);
    expect(result.files).toHaveLength(1);
    expect(result.attached).toHaveLength(1);
    expect(result.text).toBe(`diff ${img} with ${img}`); // both mentions rewritten
  });
});
