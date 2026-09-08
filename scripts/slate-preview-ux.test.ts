import { describe, expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';
import type { Page } from 'puppeteer';

async function serveSlate(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (!url.hostname.endsWith('.preview.example.test')) { await request.continue(); return; }
    if (url.pathname === '/ping') {
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'served by the slate' }) });
      return;
    }
    await request.respond({ status: 200, contentType: 'text/html', body: [
      '<!doctype html><p data-slate-preview>pending</p><script>',
      'fetch("/ping").then(r => r.json()).then(value => { document.querySelector("p").textContent = value.message; })',
      '.catch(cause => { document.querySelector("p").textContent = "blocked: " + cause.message; });',
      '</script>',
    ].join('') });
  });
}

describe('the Slate preview frame', () => {
  test('a Slate calls its own preview origin without reaching the host document', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await serveSlate(page);
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=slate`, { waitUntil: 'networkidle0' });
        const frameElement = await page.waitForSelector('iframe');
        if (frameElement === null) throw new Error('Slate preview iframe did not mount');
        const frame = await frameElement.contentFrame();
        if (!frame) throw new Error('the Slate preview did not create an iframe context');
        await frame.waitForSelector('[data-slate-preview]', { timeout: 30_000 });
        expect(await frame.$eval('[data-slate-preview]', (element) => element.textContent))
          .toBe('served by the slate');
        expect(await frame.evaluate(() => {
          try { return window.parent.document.title; }
          catch (cause) { if (!(cause instanceof DOMException)) throw cause; return cause.name; }
        })).toBe('SecurityError');
      } finally {
        await page.close();
      }
    });
  }, 120_000);

  test('removing the selected Slate returns the work surface to Work', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await serveSlate(page);
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=workslatefallback`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button[title="Fallback Probe"][aria-current="true"]');
        await page.evaluate(() => { window.dispatchEvent(new Event('gallery:slate-unpublish')); });
        await page.waitForSelector('button[aria-label="Work"][aria-current="true"]');
        expect(await page.$('button[title="Fallback Probe"]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  }, 120_000);
});


test('preview tabs deduplicate live slates, fill the surface and keep plans in Work', async () => {
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    try {
      await serveSlate(page);
      for (const width of [1100, 390]) {
        await page.setViewport({ width, height: 850 });
        await page.goto(`${origin}/gallery.html?frame=previewtabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[aria-label="Dashboard"]');
        expect(await page.$('[aria-label="Output"]')).toBeNull();
        expect(await page.$('[aria-label="Duplicate dashboard port"]')).toBeNull();
        expect(await page.$('[data-work-plans]')).toBeNull();
        expect(await page.$('[aria-label="Diffs"]')).toBeNull();
        for (const title of ['Dashboard', 'Sandbox app', 'Device app']) {
          await page.click(`[aria-label="${title}"]`);
          const iframe = await page.waitForSelector('iframe');
          if (!iframe) throw new Error('Preview missing');
          const frame = await iframe.contentFrame();
          if (!frame) throw new Error('Preview frame missing');
          await frame.waitForSelector('[data-slate-preview]');
          expect(await frame.$eval('[data-slate-preview]', el => el.textContent)).toBe('served by the slate');
          expect(await iframe.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(600);
        }
        await page.click('[data-new-plan]');
        await page.waitForSelector('[data-plan-review-root]');
        expect(await page.$eval('[aria-label="Work"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find(el => el.textContent?.includes('Approve & implement'));
          if (!button) throw new Error('Approval missing');
          button.click();
        });
        await page.waitForFunction(() => document.querySelector('[data-plan-status]')?.textContent === 'Approved');
        await page.select('[aria-label="Plan history"]', 'plan-dashboard:1');
        await page.waitForFunction(() => document.querySelector('[data-plan-title]')?.textContent?.includes('Earlier'));
        await page.click('[data-new-preview]');
        await page.waitForSelector('[aria-label="Report"][aria-current="true"]');
        await page.click('[aria-label="Work"]');
        await page.click('[data-refresh-preview]');
        expect(await page.$eval('[aria-label="Work"]', el => el.getAttribute('aria-current'))).toBe('true');
        await page.click('[data-add-diff]');
        await page.waitForSelector('[aria-label="Diffs"]');
      }
    } finally { await page.close(); }
  });
}, 120_000);
