/** Attachment sanitizer: unacceptable parts become content-addressed VFS references,
 *  small text inlines, accepted media passes through, persisted history is never mutated. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import {
  acceptedMediaForModel,
  sanitizeAttachmentsForModel,
  type MediaModality,
} from '../src/prompting/attachment-sanitizer';
import type { VFS } from '../src/types/primitives';
import { TurnContextBudget } from '../src/context-budget';
import { createMemoryVFS } from './helpers';
import { KinuError, renderCauseChain } from '../src/obs/index';

interface CountingVfs {
  vfs: VFS;
  writes: () => number;
}

function countingVfs(): CountingVfs {
  const inner = createMemoryVFS(new Database(':memory:'));
  let writes = 0;

  return {
    vfs: {
      ...inner,
      readFile: (p, o) => inner.readFile(p, o),
      writeFile: (p, d) => {
        writes += 1;

        return inner.writeFile(p, d);
      },
      readdir: (p) => inner.readdir(p),
      stat: (p) => inner.stat(p),
      unlink: (p) => inner.unlink(p),
      mkdir: (p, o) => inner.mkdir(p, o),
      exists: (p) => inner.exists(p),
    },
    writes: () => writes,
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3, 250]);

const PDF_DATA_URL = `data:application/pdf;base64,${btoa(String.fromCharCode(...PDF_BYTES))}`;

const PNG_DATA_URL = `data:image/png;base64,${btoa('fake-png-bytes')}`;

function pdfMessage(): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'file', data: PDF_DATA_URL, mediaType: 'application/pdf', filename: 'resume.pdf' },
      { type: 'text', text: 'I have shared the resume.' },
    ],
  };
}

const accepts = (...media: MediaModality[]) => new Set<MediaModality>(media);

const TextPartsSchema = v.array(v.object({
  type: v.literal('text'),
  text: v.string(),
}));

function textParts(message: ModelMessage): v.InferOutput<typeof TextPartsSchema> {
  return v.parse(TextPartsSchema, message.content);
}

function messageString(message: ModelMessage): string {
  return v.parse(v.string(), message.content);
}

function savedPath(text: string): string {
  const path = /saved to (\S+)/.exec(text)?.[1];

  if (!path) throw new Error('Expected replacement text to contain a saved attachment path');

  return path;
}

describe('sanitizeAttachmentsForModel', () => {
  test('replaces a PDF for a text-only model with a VFS reference and writes the exact bytes once', async () => {
    const { vfs, writes } = countingVfs();
    const input: ModelMessage[] = [pdfMessage(), { role: 'assistant', content: 'Got it.' }];
    const before = JSON.stringify(input);

    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts(), vfs });

    expect(out).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
    expect(out[1]).toBe(input[1]);

    const content = textParts(out[0]);
    expect(content).toHaveLength(2);
    const [replacement, text] = content;
    expect(replacement.type).toBe('text');
    expect(replacement.text).toContain('resume.pdf');
    expect(replacement.text).toContain('application/pdf');
    expect(replacement.text).toContain(`${PDF_BYTES.length} bytes`);
    expect(replacement.text).toContain('read it with your file tools');
    expect(text.text).toBe('I have shared the resume.');

    const path = savedPath(replacement.text);
    expect(path).toStartWith('attachments/');
    const stored = await vfs.readFile(path);
    expect(stored instanceof Uint8Array ? Array.from(stored) : stored).toEqual(Array.from(PDF_BYTES));
    expect(writes()).toBe(1);
  });

  test('is byte-stable across runs: same content → same path → same replacement text, VFS write skipped', async () => {
    const { vfs, writes } = countingVfs();
    const policy = { accepts: accepts(), vfs };
    const first = await sanitizeAttachmentsForModel([pdfMessage()], policy);
    const second = await sanitizeAttachmentsForModel([pdfMessage()], policy);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(writes()).toBe(1);
    expect(await vfs.readdir('attachments')).toHaveLength(1);
  });

  test('a spill path that does not hold the attachment bytes is not reused', async () => {
    // KINU-016: the address is a cryptographic digest and reuse verifies the bytes behind it.
    const { vfs, writes } = countingVfs();
    const policy = { accepts: accepts(), vfs };
    const first = await sanitizeAttachmentsForModel([pdfMessage()], policy);
    const path = savedPath(textParts(first[0])[0].text);
    expect(writes()).toBe(1);

    await vfs.writeFile(path, new Uint8Array([9, 9, 9]));

    const again = await sanitizeAttachmentsForModel([pdfMessage()], policy);
    // Still byte-stable for the prompt-cache prefix...
    expect(savedPath(textParts(again[0])[0].text)).toBe(path);
    // ...and resolves to the attachment, not the impostor.
    const stored = await vfs.readFile(path);
    expect(stored instanceof Uint8Array ? Array.from(stored) : stored).toEqual(Array.from(PDF_BYTES));
  });

  test('passes images through for image-capable models and replaces them for text-only ones', async () => {
    const { vfs } = countingVfs();

    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'file', data: PNG_DATA_URL, mediaType: 'image/png', filename: 'chart.png' },
        { type: 'image', image: PNG_DATA_URL, mediaType: 'image/png' },
      ],
    };

    const kept = await sanitizeAttachmentsForModel([message], { accepts: accepts('image'), vfs });
    expect(kept[0]).toBe(message);

    const replaced = await sanitizeAttachmentsForModel([message], { accepts: accepts(), vfs });
    const parts = textParts(replaced[0]);
    expect(parts.every((p) => p.type === 'text')).toBe(true);
    expect(parts[0].text).toContain('attachments/');
    expect(parts[1].text).toContain('attachments/');
  });

  test('an SVG never goes out as an image: the image modality carries raster pictures, and the model reads the markup', async () => {
    const { vfs } = countingVfs();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
    const url = `data:image/svg+xml;base64,${btoa(svg)}`;

    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'file', data: url, mediaType: 'image/svg+xml', filename: 'logo.svg' },
        { type: 'image', image: url, mediaType: 'image/svg+xml' },
      ],
    };

    const out = await sanitizeAttachmentsForModel([message], { accepts: accepts('image', 'pdf'), vfs });
    const parts = textParts(out[0]);

    expect(parts.map((part) => part.text.includes(svg))).toEqual([true, true]);
  });

  test('passes PDFs through untouched for pdf-capable models', async () => {
    const { vfs, writes } = countingVfs();
    const message = pdfMessage();
    const out = await sanitizeAttachmentsForModel([message], { accepts: accepts('image', 'pdf'), vfs });
    expect(out[0]).toBe(message);
    expect(writes()).toBe(0);
  });

  test('inlines small text/* attachments verbatim instead of a VFS round-trip', async () => {
    const { vfs, writes } = countingVfs();
    const body = '# Notes\nplain markdown under 8KB';

    const message: ModelMessage = {
      role: 'user',
      content: [{
        type: 'file',
        data: `data:text/markdown;base64,${btoa(body)}`,
        mediaType: 'text/markdown',
        filename: 'notes.md',
      }],
    };

    const out = await sanitizeAttachmentsForModel([message], { accepts: accepts('image'), vfs });
    const part = textParts(out[0])[0];
    expect(part.type).toBe('text');
    expect(part.text).toContain('notes.md');
    expect(part.text).toContain(body);
    expect(writes()).toBe(0);
  });

  test('large text/* attachments get the VFS treatment', async () => {
    const { vfs, writes } = countingVfs();
    const body = 'x'.repeat(9 * 1024);

    const message: ModelMessage = {
      role: 'user',
      content: [{
        type: 'file',
        data: `data:text/plain;base64,${btoa(body)}`,
        mediaType: 'text/plain',
        filename: 'dump.txt',
      }],
    };

    const out = await sanitizeAttachmentsForModel([message], { accepts: accepts('image'), vfs });
    const part = textParts(out[0])[0];
    expect(part.text).toContain('attachments/');
    expect(part.text).not.toContain(body);
    expect(writes()).toBe(1);
  });

  test('remote-URL parts are referenced, never fetched or stored', async () => {
    const { vfs, writes } = countingVfs();

    const message: ModelMessage = {
      role: 'user',
      content: [{ type: 'file', data: new URL('https://example.com/a.pdf'), mediaType: 'application/pdf' }],
    };

    const out = await sanitizeAttachmentsForModel([message], { accepts: accepts(), vfs });
    const part = textParts(out[0])[0];
    expect(part.type).toBe('text');
    expect(part.text).toContain('https://example.com/a.pdf');
    expect(writes()).toBe(0);
  });

  test('string and tool messages pass through by reference', async () => {
    const { vfs } = countingVfs();

    const input: ModelMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'plain text' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'shell', output: { type: 'text', value: 'ok' } }] },
    ];

    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts(), vfs });
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toBe(input[2]);
  });
});

// Oversize accepted content is spilled the same way: content-addressed, bounded head, resolvable address.
describe('message-borne bulk (pasted text and oversize accepted documents)', () => {
  const HUGE_PASTE = `PASTE-HEAD ${'p'.repeat(20_000)} PASTE-TAIL`;

  test('a giant pasted user message keeps a bounded head plus the address of the whole', async () => {
    const { vfs, writes } = countingVfs();
    const budget = new TurnContextBudget();
    const input: ModelMessage[] = [{ role: 'user', content: HUGE_PASTE }];

    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts('image'), vfs, budget });
    const text = messageString(out[0]);

    expect(text.length).toBeLessThan(3_000);
    expect(text).toContain('PASTE-HEAD');
    expect(text).toContain(`${HUGE_PASTE.length} bytes`);
    expect(text).toContain('agents hire so that agent reads it instead of you');
    const path = savedPath(text);
    expect(path).toStartWith('attachments/');
    expect(new TextDecoder().decode(v.parse(v.instance(Uint8Array), await vfs.readFile(path)))).toBe(HUGE_PASTE);
    expect(writes()).toBe(1);
    expect(budget.snapshot().trips).toEqual({ pasted_text: 1 });
    expect(budget.snapshot().referenced).toBe(1);
  });

  test('the same treatment reaches a text PART of a multi-part user message', async () => {
    const { vfs } = countingVfs();

    const input: ModelMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'here is the log:' }, { type: 'text', text: HUGE_PASTE }],
    }];

    const output = await sanitizeAttachmentsForModel(input, { accepts: accepts('image'), vfs });
    const parts = textParts(output[0]);
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe('here is the log:');
    expect(parts[1].text).toContain('attachments/');
  });

  test('ordinary messages inline untouched — the root must not starve on normal material', async () => {
    const { vfs, writes } = countingVfs();
    const budget = new TurnContextBudget();
    const stackTrace = 'Error: boom\n' + '    at frame\n'.repeat(200);

    const input: ModelMessage[] = [
      { role: 'user', content: 'fix the auth bug' },
      { role: 'user', content: [{ type: 'text', text: stackTrace }] },
    ];

    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts('image'), vfs, budget });
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(writes()).toBe(0);
    expect(budget.active).toBe(false);
  });

  test('a spilled paste is byte-stable across turns — same bytes, same path, same text', async () => {
    const { vfs, writes } = countingVfs();
    const policy = { accepts: accepts('image'), vfs };
    const input: ModelMessage[] = [{ role: 'user', content: HUGE_PASTE }];
    const first = await sanitizeAttachmentsForModel(input, policy);
    const second = await sanitizeAttachmentsForModel(input, policy);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(writes()).toBe(1);
  });

  test('the replacement is itself under budget, so a re-sanitized history is a fixed point', async () => {
    const { vfs, writes } = countingVfs();
    const policy = { accepts: accepts('image'), vfs };
    const once = await sanitizeAttachmentsForModel([{ role: 'user', content: HUGE_PASTE }], policy);
    const twice = await sanitizeAttachmentsForModel(once, policy);
    expect(twice[0]).toBe(once[0]);
    expect(writes()).toBe(1);
  });

  test('an accepted PDF past the inline ceiling is spilled; a small one still rides inline', async () => {
    const { vfs } = countingVfs();
    const budget = new TurnContextBudget();

    const bigPdf: ModelMessage = {
      role: 'user',
      content: [{
        type: 'file',
        data: new Uint8Array(2 * 1024 * 1024),
        mediaType: 'application/pdf',
        filename: 'thesis.pdf',
      }],
    };

    const policy = { accepts: accepts('image', 'pdf'), vfs, budget };

    const spilled = await sanitizeAttachmentsForModel([bigPdf], policy);
    const part = textParts(spilled[0])[0];
    expect(part.type).toBe('text');
    expect(part.text).toContain('thesis.pdf');
    expect(part.text).toContain('attachments/');
    expect(budget.snapshot().trips).toEqual({ attachment: 1 });

    const small = pdfMessage();
    expect((await sanitizeAttachmentsForModel([small], policy))[0]).toBe(small);
  });

  test('an oversize accepted IMAGE stays inline — a file it cannot see is not a reference', async () => {
    const { vfs, writes } = countingVfs();

    const bigImage: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', image: new Uint8Array(4 * 1024 * 1024), mediaType: 'image/png' }],
    };

    const out = await sanitizeAttachmentsForModel([bigImage], { accepts: accepts('image', 'pdf'), vfs });
    expect(out[0]).toBe(bigImage);
    expect(writes()).toBe(0);
  });
});

describe('the spill-directory mkdir failure is classified, not substring-matched', () => {
  function vfsWhoseMkdirThrows(failure: Error): VFS {
    const inner = createMemoryVFS(new Database(':memory:'));

    return {
      ...inner,
      readFile: (p, o) => inner.readFile(p, o),
      writeFile: (p, d) => inner.writeFile(p, d),
      mkdir: async () => { throw failure; },
      exists: (p) => inner.exists(p),
    };
  }

  test('an EEXIST-shaped mkdir failure is tolerated and the sanitize flow proceeds', async () => {
    const vfs = vfsWhoseMkdirThrows(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }));
    const out = await sanitizeAttachmentsForModel([pdfMessage()], { accepts: accepts(), vfs });
    const stored = await vfs.readFile(savedPath(textParts(out[0])[0].text));
    expect(stored instanceof Uint8Array ? Array.from(stored) : stored).toEqual(Array.from(PDF_BYTES));
  });

  test('a parent-directory mkdir failure propagates with its cause, not as a later writeFile error', async () => {
    const cause = Object.assign(new Error('parent directory does not exist'), { code: 'ENOENT' });
    const vfs = vfsWhoseMkdirThrows(cause);

    try {
      await sanitizeAttachmentsForModel([pdfMessage()], { accepts: accepts(), vfs });
    } catch (err) {
      if (!(err instanceof KinuError)) throw err;
      expect(err.message).toBe('creating the attachments spill directory');
      expect(err.cause).toBe(cause);
      expect(renderCauseChain(err)).toContain('parent directory does not exist');

      return;
    }

    throw new Error('expected a classified KinuError');
  });
});

describe('acceptedMediaForModel', () => {
  test('workers-ai (openai-compatible wire) is capped to image even if the catalog claims pdf', () => {
    expect([...acceptedMediaForModel({ provider: 'workers-ai', catalogInputModalities: ['text', 'image', 'pdf'] })])
      .toEqual(['image']);
  });

  test('a text-only catalog model accepts no media at all (the glm-5.2 case)', () => {
    expect(acceptedMediaForModel({ provider: 'workers-ai', catalogInputModalities: ['text'] }).size).toBe(0);
  });

  test('anthropic/openai models that genuinely accept PDFs pass them', () => {
    const anthropic = acceptedMediaForModel({ provider: 'anthropic', catalogInputModalities: ['text', 'image', 'pdf'] });
    expect(anthropic.has('pdf')).toBe(true);
    expect(anthropic.has('image')).toBe(true);
    expect(acceptedMediaForModel({ provider: 'anthropic' }).has('pdf')).toBe(true);
  });

  test('unknown providers/models fall back to the conservative text+image default', () => {
    expect([...acceptedMediaForModel({ provider: 'some-catalog-provider' })]).toEqual(['image']);
    expect([...acceptedMediaForModel({})]).toEqual(['image']);
  });
});
