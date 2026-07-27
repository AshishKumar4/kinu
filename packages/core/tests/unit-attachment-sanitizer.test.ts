/** Model-capability attachment sanitizer — the mechanical fix for the
 *  "attached PDF 400s every Workers AI request forever" production bug.
 *  Behavior contract: parts the model cannot accept become content-addressed
 *  VFS references (byte-stable, write-once), small text attachments inline,
 *  accepted media passes through untouched, and the persisted history is
 *  never mutated (message count preserved, untouched messages by reference). */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ModelMessage } from 'ai';
import {
  acceptedMediaForModel,
  sanitizeAttachmentsForModel,
  type MediaModality,
} from '../src/prompting/attachment-sanitizer.js';
import type { VFS } from '../src/types/primitives.js';
import { createMemoryVFS } from './helpers.js';

function countingVfs(): { vfs: VFS; writes: () => number } {
  const inner = createMemoryVFS(new Database(':memory:'));
  let writes = 0;
  return {
    vfs: {
      ...inner,
      readFile: (p, o) => inner.readFile(p, o),
      writeFile: (p, d) => { writes += 1; return inner.writeFile(p, d); },
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

describe('sanitizeAttachmentsForModel', () => {
  test('replaces a PDF for a text-only model with a VFS reference and writes the exact bytes once', async () => {
    const { vfs, writes } = countingVfs();
    const input: ModelMessage[] = [pdfMessage(), { role: 'assistant', content: 'Got it.' }];
    const before = JSON.stringify(input);

    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts(), vfs });

    // Message count preserved; the persisted history untouched; unchanged
    // messages keep referential identity.
    expect(out).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
    expect(out[1]).toBe(input[1]!);

    const content = out[0]!.content;
    if (typeof content === 'string' || !Array.isArray(content)) throw new Error('expected part array');
    expect(content).toHaveLength(2);
    const [replacement, text] = content as Array<{ type: string; text?: string }>;
    expect(replacement!.type).toBe('text');
    expect(replacement!.text).toContain('resume.pdf');
    expect(replacement!.text).toContain('application/pdf');
    expect(replacement!.text).toContain(`${PDF_BYTES.length} bytes`);
    expect(replacement!.text).toContain('read it with your file tools');
    expect(text!.text).toBe('I have shared the resume.');

    // No file-typed part survives; the payload round-trips through the VFS.
    const path = /saved to (\S+)/.exec(replacement!.text!)?.[1];
    expect(path).toStartWith('/local/attachments/');
    const stored = await vfs.readFile(path!);
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
    expect(await vfs.readdir('/local/attachments')).toHaveLength(1);
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
    const parts = replaced[0]!.content as Array<{ type: string; text?: string }>;
    expect(parts.every((p) => p.type === 'text')).toBe(true);
    expect(parts[0]!.text).toContain('/local/attachments/');
    expect(parts[1]!.text).toContain('/local/attachments/');
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
    const part = (out[0]!.content as Array<{ type: string; text: string }>)[0]!;
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
    const part = (out[0]!.content as Array<{ type: string; text: string }>)[0]!;
    expect(part.text).toContain('/local/attachments/');
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
    const part = (out[0]!.content as Array<{ type: string; text: string }>)[0]!;
    expect(part.type).toBe('text');
    expect(part.text).toContain('https://example.com/a.pdf');
    expect(writes()).toBe(0);
  });

  test('string and tool messages pass through by reference', async () => {
    const { vfs } = countingVfs();
    const input: ModelMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'plain text' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'run', output: { type: 'text', value: 'ok' } }] },
    ];
    const out = await sanitizeAttachmentsForModel(input, { accepts: accepts(), vfs });
    expect(out[0]).toBe(input[0]!);
    expect(out[1]).toBe(input[1]!);
    expect(out[2]).toBe(input[2]!);
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
    // No catalog entry: the provider-class ceiling is the default.
    expect(acceptedMediaForModel({ provider: 'anthropic' }).has('pdf')).toBe(true);
  });

  test('unknown providers/models fall back to the conservative text+image default', () => {
    expect([...acceptedMediaForModel({ provider: 'some-catalog-provider' })]).toEqual(['image']);
    expect([...acceptedMediaForModel({})]).toEqual(['image']);
  });
});
