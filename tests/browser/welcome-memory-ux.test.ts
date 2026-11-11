/**
 * Setup's "Wanna dump everything about yourself?" step in a real browser (owner, 2026-11-11): what another AI remembers,
 * a file (a PDF the platform reads to text), or a ChatGPT export read on the device. Of an export only the person's own
 * words are sent, each dated, the oldest conversation first, so the extractor's later statement wins (account-import.ts).
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { withGallery } from '../../scripts/gallery-harness';

const STEP = '[data-welcome-step="memory"]';

/** A zip of one deflated entry, as an export's archive holds `conversations.json`. */
function deflatedZip(name: string, content: string): Buffer {
  const raw = Buffer.from(content);
  const packed = deflateRawSync(raw);
  const path = Buffer.from(name);
  const crc = Bun.hash.crc32(raw);
  const local = Buffer.alloc(30);

  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);

  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(path.length, 28);
  central.writeUInt32LE(0, 42);
  const directoryAt = local.length + path.length + packed.length;
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12);
  end.writeUInt32LE(directoryAt, 16);

  return Buffer.concat([local, path, packed, central, path, end]);
}

const seconds = (iso: string): number => Date.parse(iso) / 1000;

/** A ChatGPT conversation: the person's and the assistant's turns, linked root to end as the export links them. */
function chatGptConversation(title: string, started: string, turns: readonly (readonly ['user' | 'assistant', string, string])[]) {
  const nodes = turns.map(([role, at, text], index) => [`m${String(index)}`, {
    id: `m${String(index)}`, parent: index === 0 ? 'root' : `m${String(index - 1)}`, children: index + 1 < turns.length ? [`m${String(index + 1)}`] : [],
    message: { author: { role }, create_time: seconds(at), content: { content_type: 'text', parts: [text] } },
  }] as const);

  const mapping = Object.fromEntries([['root', { id: 'root', parent: null, message: null, children: ['m0'] }], ...nodes]);

  return { title, create_time: seconds(started), current_node: `m${String(turns.length - 1)}`, mapping };
}

/** The rest of a long conversation, so each sits in a piece of its own. */
const MORE = ' And a long list of other weekend errands, groceries and chores to sort out.'.repeat(30);

/** Listed newest first, as an export may list them; read oldest first. */
const EXPORT = JSON.stringify([
  chatGptConversation('Moving checklist', '2025-05-02T10:00:00Z', [
    ['user', '2025-05-02T10:00:00Z', `I moved to Austin last week, so update everything to Austin, Texas.${MORE}`],
    ['assistant', '2025-05-02T10:00:05Z', 'ASSISTANT-ONLY: noted, you are in Austin now.'],
  ]),
  chatGptConversation('Weekend plans', '2023-08-12T09:00:00Z', [
    ['user', '2023-08-12T09:00:00Z', `I live in Raleigh, North Carolina. What can I do this weekend?${MORE}`],
    ['assistant', '2023-08-12T09:00:04Z', 'ASSISTANT-ONLY: try the art museum.'],
  ]),
]);

function tabOf(page: Page, label: string): Promise<void> {
  return page.$$eval(`${STEP} [role="tablist"] button`, (tabs, want) => {
    tabs.find((tab) => tab.textContent?.trim() === want)?.click();
  }, label);
}

async function importPressed(page: Page): Promise<string[]> {
  await page.$$eval(`${STEP} button`, (buttons) => { buttons.find((button) => button.textContent?.trim() === 'Import')?.click(); });
  await page.waitForFunction(() => (document.documentElement.dataset.galleryMemoryImports ?? '') !== '');

  return page.evaluate(() => (document.documentElement.dataset.galleryMemoryImports ?? '').split('\n').filter((line) => line !== ''));
}

async function openStep(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/gallery.html?frame=welcome&route=${encodeURIComponent('/welcome?step=memory')}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(`${STEP} [data-memory-import]`);
}

describe("setup's memory step", () => {
  test("pastes what another AI remembers and imports it as a document, then goes on", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await openStep(page, origin);
      expect(await page.$eval(`${STEP} [data-memory-import-prompt]`, (prompt) => prompt.textContent?.trim().length ?? 0)).toBeGreaterThan(0);
      await page.type(`${STEP} textarea`, 'I live in Austin, Texas. My partner is Meera.');
      const sent = await importPressed(page);

      expect(sent.map((line) => JSON.parse(line))).toEqual([{ document: 'I live in Austin, Texas. My partner is Meera.' }]);
      await page.waitForFunction(() => document.querySelector('[data-welcome-step="search"]')?.getAttribute('aria-hidden') !== 'true');
    });
  });

  test('reads a PDF to text, shows it, and imports that text', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const pdf = join(scratchDir('welcome-memory'), 'me.pdf');

      writeFileSync(pdf, '%PDF-1.4\n% a PDF the platform reads\n');
      await openStep(page, origin);
      await tabOf(page, 'A file');
      await (await page.waitForSelector(`${STEP} input[type="file"]`))?.uploadFile(pdf);
      await page.waitForSelector(`${STEP} textarea[aria-label="The file's text"]`);
      const sent = await importPressed(page);

      expect(sent.map((line) => JSON.parse(line).document)).toEqual([expect.stringContaining('I live in Austin, Texas.')]);
    });
  });

  test("reads a ChatGPT export on the device: the person's own words, dated, the oldest conversation first", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const archive = join(scratchDir('welcome-memory'), 'chatgpt-export.zip');

      writeFileSync(archive, deflatedZip('conversations.json', EXPORT));
      await openStep(page, origin);
      await tabOf(page, 'An AI export');
      await (await page.waitForSelector(`${STEP} input[type="file"]`))?.uploadFile(archive);
      await page.waitForSelector(`${STEP} [data-memory-import-preview]`);
      const [sent] = (await importPressed(page)).map((line) => v.parse(v.object({ conversations: v.array(v.string()) }), JSON.parse(line)));

      expect(sent?.conversations).toEqual([
        expect.stringContaining('2023-08-12: I live in Raleigh, North Carolina.'),
        expect.stringContaining('2025-05-02: I moved to Austin last week'),
      ]);
      expect(JSON.stringify(sent)).not.toContain('ASSISTANT-ONLY');
    });
  });
});
