import { scratchDir } from '../../test-utils/src/scratch';
import { writeFileSync, mkdirSync, truncateSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { FILE_TRANSFER_MAX_BYTES, formatBytes, localPlanes } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import {
  describePromptAttachment,
  resolvePromptAttachments,
} from '../src/attachments';

/** Each file kept as an upload is: here, recorded by name under /uploads, as the client's upload answers. */
function uploads() {
  const kept: { filename: string; mediaType: string; bytes: number }[] = [];

  return {
    kept,
    upload: async (file: { readonly filename: string; readonly mediaType: string; readonly bytes: Uint8Array }): Promise<string> => {
      kept.push({ filename: file.filename, mediaType: file.mediaType, bytes: file.bytes.length });

      return `/uploads/${file.filename}`;
    },
  };
}

function makeDir(): string {
  const dir = scratchDir('attach');

  return dir;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('prompt token shapes through resolution', () => {
  test('@mentions, quoted tokens, and ~ paths resolve; bare words stay prose', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);
    const notes = join(dir, 'my notes.txt');
    writeFileSync(notes, 'remember the milk');

    const result = await resolvePromptAttachments(
      `look at @${img} and "${notes}" plus ~/docs/spec.pdf but not src/index.ts`,
      { upload: uploads().upload, cwd: dir },
    );

    expect(result.text).toBe(`look at ${img} and "${notes}" plus ~/docs/spec.pdf but not src/index.ts`);
    expect(result.attached.map((a) => a.path).sort()).toEqual([img, notes].sort());
    expect(result.errors).toEqual([]);
  });

  test('quoted @mentions with spaces resolve and lose the @', async () => {
    const dir = makeDir();
    const img = join(dir, 'two words.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`compare @"${img}" please`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('two words.png');
    expect(result.text).toBe(`compare ${img} please`);
  });

  test('an email-style @ inside a word resolves to nothing', async () => {
    const dir = makeDir();
    const result = await resolvePromptAttachments('mail me@example.com today', { upload: uploads().upload, cwd: dir });
    expect(result.text).toBe('mail me@example.com today');
    expect(result.attached).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('resolvePromptAttachments', () => {
  test('an @mentioned image uploads, the message names its path, and the @ is stripped', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);
    const kept = uploads();

    const result = await resolvePromptAttachments(`describe @${img} please`, { upload: kept.upload, cwd: dir });
    expect(result.text).toBe(`describe ${img} please`);
    expect(result.errors).toEqual([]);
    expect(result.files).toEqual([{ filename: 'shot.png', mediaType: 'image/png', path: '/uploads/shot.png' }]);
    expect(kept.kept).toEqual([{ filename: 'shot.png', mediaType: 'image/png', bytes: PNG_BYTES.length }]);
    expect(result.attached).toEqual([
      { path: img, filename: 'shot.png', mediaType: 'image/png', size: PNG_BYTES.length },
    ]);
  });

  test('a quoted path with spaces resolves (terminal drag-drop)', async () => {
    const dir = makeDir();
    const pdf = join(dir, 'two words.pdf');
    writeFileSync(pdf, '%PDF-1.4');

    const result = await resolvePromptAttachments(`summarize "${pdf}"`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].mediaType).toBe('application/pdf');
    expect(result.text).toBe(`summarize "${pdf}"`);
  });

  test('a path a terminal pasted with its spaces escaped resolves as the file it names', async () => {
    const dir = makeDir();
    const img = join(dir, 'my shot.png');
    writeFileSync(img, PNG_BYTES);

    const mention = await resolvePromptAttachments(`what is in @${img.replaceAll(' ', '\\ ')}`, { upload: uploads().upload, cwd: dir });
    expect(mention.attached.map(({ path }) => path)).toEqual([img]);
  });

  // CODE-8 #14: a terminal's drag-and-drop quotes an apostrophe the shell's way, or escapes spaces with no quotes at all.
  test('a dropped path is read as the whole shell word it is: a quoted apostrophe, or escaped spaces with no quotes', async () => {
    const dir = makeDir();
    const quoted = join(dir, "it's here.png");
    const escaped = join(dir, 'my "best" shot.png');
    writeFileSync(quoted, PNG_BYTES);
    writeFileSync(escaped, PNG_BYTES);

    const shellQuoted = `'${quoted.replaceAll("'", "'\\''")}'`;
    const shellEscaped = escaped.replaceAll(' ', '\\ ').replaceAll('"', '\\"');
    const result = await resolvePromptAttachments(`compare ${shellQuoted} with ${shellEscaped}`, { upload: uploads().upload, cwd: dir });

    expect(result.attached.map(({ path }) => path)).toEqual([quoted, escaped]);
  });

  test('relative @mentions resolve against the provided cwd', async () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'logo.png'), PNG_BYTES);

    const result = await resolvePromptAttachments('use @assets/logo.png here', { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.attached[0].path).toBe(join(dir, 'assets', 'logo.png'));
    expect(result.text).toBe('use assets/logo.png here');
  });

  test('trailing punctuation after a mention does not break resolution', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`what is in @${img}?`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('shot.png');
  });

  test('non-multimodal files become path references with a chip, not parts', async () => {
    const dir = makeDir();
    const notes = join(dir, 'notes.txt');
    writeFileSync(notes, 'remember the milk');

    const result = await resolvePromptAttachments(`read @${notes}`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toEqual([]);
    expect(result.attached).toEqual([
      { path: notes, filename: 'notes.txt', mediaType: null, size: 17 },
    ]);
    expect(result.text).toBe(`read ${notes}`);
    expect(describePromptAttachment(result.attached[0])).toContain('notes.txt');
  });

  // core-rest review P1-28: the CLI kept its own byte formatter, which had no gigabytes and read 1 GiB as "1024.0 MB".
  test('a referenced file\'s size reads as the app reads it, gigabytes included', async () => {
    const dir = makeDir();
    const disk = join(dir, 'disk.img');
    // Sparse: a gigabyte long, no gigabyte written.
    writeFileSync(disk, '');
    truncateSync(disk, 1024 ** 3);

    const result = await resolvePromptAttachments(`inspect @${disk}`, { upload: uploads().upload, cwd: dir });
    expect(describePromptAttachment(present(result.attached[0], 'the referenced disk'))).toBe(`disk.img (${formatBytes(1024 ** 3)}, referenced)`);
  });

  test('an image past what one upload carries is left as a reference with a visible error', async () => {
    const dir = makeDir();
    const big = join(dir, 'huge.png');
    writeFileSync(big, Buffer.alloc(FILE_TRANSFER_MAX_BYTES + 1));

    const result = await resolvePromptAttachments(`look at @${big}`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('huge.png');
    expect(result.attached[0].mediaType).toBeNull();
  });

  test('a file whose upload fails is left as a reference, its failure said', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`look at @${img}`, { upload: async () => { throw new Error('the workspace is full'); }, cwd: dir });
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('the workspace is full')]);
  });

  // 2026-10-04: `@vfs://…` and `@local://…` named nothing, since the CLI resolved every token against its own cwd.
  test('a reference to the workspace\'s own space or folder attaches the file it names; another plane stays prose', async () => {
    const space = makeDir();
    const folder = makeDir();
    mkdirSync(join(space, 'slates', 'board'), { recursive: true });
    writeFileSync(join(space, 'slates', 'board', 'shot.png'), PNG_BYTES);
    writeFileSync(join(folder, 'notes.txt'), 'in the folder');
    const planes = localPlanes({ space, folder, home: folder, views: [] });

    const result = await resolvePromptAttachments('see @vfs://slates/board/shot.png and @local://notes.txt not @computer://x', { upload: uploads().upload, cwd: folder, planes });

    expect(result.attached.map((a) => a.path)).toEqual([join(space, 'slates', 'board', 'shot.png'), join(folder, 'notes.txt')]);
    expect(result.files).toHaveLength(1);
    expect(result.text).toBe('see vfs://slates/board/shot.png and local://notes.txt not @computer://x');
    expect(result.errors).toEqual([]);
  });

  test('nonexistent paths and directories are ignored', async () => {
    const dir = makeDir();
    const result = await resolvePromptAttachments(`see @${join(dir, 'missing.png')} and @${dir}`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toEqual([]);
    expect(result.attached).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('a repeated mention attaches once', async () => {
    const dir = makeDir();
    const img = join(dir, 'shot.png');
    writeFileSync(img, PNG_BYTES);

    const result = await resolvePromptAttachments(`diff @${img} with @${img}`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.attached).toHaveLength(1);
    expect(result.text).toBe(`diff ${img} with ${img}`);
  });
});

describe('a quoted sentence is prose, not a path', () => {
  // stat() answers ENAMETOOLONG (not ENOENT) for a long quoted string; it must pass through, not throw.
  const SENTENCE = 'I am the big blind with J7 offsuit facing a limp from the opponent. '
    + 'This is a weak, poorly-connected hand, so raising would be a risky bluff with little equity. '
    + 'Since the opponent only limped, I can see the flop for free, which is the safest and most '
    + 'profitable default against an unknown opponent.';

  test('a quoted token longer than a filename resolves to nothing and throws nothing', async () => {
    const dir = makeDir();
    expect(SENTENCE.length).toBeGreaterThan(255);
    const result = await resolvePromptAttachments(`Answer: "${SENTENCE}"`, { upload: uploads().upload, cwd: dir });
    expect(result.attached).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.text).toBe(`Answer: "${SENTENCE}"`);
  });

  test('a quoted filename shorter than the bound still attaches', async () => {
    const dir = makeDir();
    const name = `${'a'.repeat(160)}.png`;
    writeFileSync(join(dir, name), PNG_BYTES);

    const result = await resolvePromptAttachments(`look at "${name}"`, { upload: uploads().upload, cwd: dir });
    expect(result.files).toHaveLength(1);
    expect(result.attached[0]?.filename).toBe(name);
  });

  test('an absolute path over the resolvable limit is refused before stat', async () => {
    const dir = makeDir();
    const deep = Array.from({ length: 40 }, () => 'd'.repeat(120)).join('/');
    const result = await resolvePromptAttachments(`look at "${deep}"`, { upload: uploads().upload, cwd: dir });
    expect(result.attached).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
