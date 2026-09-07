import { expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';

test('code retains syntax colors through streaming and sidebar ages share a right edge', async () => {
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 1000 });
    await page.evaluateOnNewDocument(() => {
      let clipboard = '';
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async (text: string) => { clipboard = text; },
        readText: async () => clipboard,
      } });
    });
    try {
      for (const mode of ['light', 'dark']) {
        await page.evaluateOnNewDocument((theme) => localStorage.setItem('theme', theme), mode);
        await page.goto(`${origin}/gallery.html?frame=coderendering`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-code-sample="js"] code');
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        await page.waitForFunction(() => document.querySelectorAll('[data-code-sample="js"] code span').length > 1);
        const colors = await page.evaluate(() => [...document.querySelectorAll('[data-code-sample]')].map((sample) => {
          const code = sample.querySelector('code');
          const walker = document.createTreeWalker(code ?? sample, NodeFilter.SHOW_TEXT);
          const ink = new Set<string>();
          while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;
            if (parent !== null && walker.currentNode.textContent?.trim()) ink.add(getComputedStyle(parent).color);
          }
          return { language: sample.getAttribute('data-code-sample'), colors: [...ink] };
        }));
        for (const sample of colors.filter((item) => item.language !== 'unknown-language' && item.language !== 'go' && item.language !== 'rust')) {
          expect(sample.colors.length, `${mode} ${sample.language} syntax colors`).toBeGreaterThan(1);
        }
        const ages = await page.$$eval('aside ul > li', (rows) => rows.flatMap((row) => {
          const link = row.querySelector('a[href^="/workspace/"]');
          const age = link?.lastElementChild;
          if (age === null || age === undefined) return [];
          const range = document.createRange();
          range.selectNodeContents(age);
          return [{ text: age.textContent, right: range.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right }];
        }));
        expect(new Set(ages.map((age) => age.text?.length)).size).toBeGreaterThan(1);
        for (const age of ages) expect(age.rowRight - age.right).toBeLessThan(28);
        const firstAge = ages[0];
        if (firstAge === undefined) throw new Error('no sidebar ages');
        for (const age of ages) expect(Math.abs(age.right - firstAge.right)).toBeLessThan(1);
        const updated = 'export const finished = "' + 'stream complete '.repeat(20) + '";\nconsole.log(finished);';
        await page.$eval('textarea', (element) => { element.value = ''; });
        await page.type('textarea', updated);
        await page.waitForFunction((text) => document.querySelector('[data-code-sample="stream"] code')?.textContent === text, {}, updated);
        const streamed = await page.$eval('[data-code-sample="stream"]', (sample) => {
          const colors = new Set([...sample.querySelectorAll('code span')].map((token) => getComputedStyle(token).color));
          let scrollable = false;
          for (const element of sample.querySelectorAll('div, pre')) {
            element.scrollLeft = 50;
            if (element.scrollLeft > 0) scrollable = true;
            element.scrollLeft = 0;
          }
          return { colors: colors.size, scrollable };
        });
        expect(streamed.colors).toBeGreaterThan(1);
        expect(streamed.scrollable).toBeTrue();
        expect(await page.$eval('[data-code-sample="unknown-language"] code', (code) => code.textContent)).toBe('<script>unknown & safe</script>');
        for (const [language, source] of [['go', 'package main'], ['rust', 'fn main() {}']]) {
          expect(await page.$eval(`[data-code-sample="${language}"] code`, (code) => code.textContent)).toBe(source);
        }
        await page.bringToFront();
        await page.$eval('[data-code-sample="stream"] button', (button) => button.click());
        await page.waitForFunction(() => document.querySelector('[data-code-sample="stream"] button')?.textContent?.includes('Copied'));
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(updated);
      }
    } finally {
      await page.close();
    }
  });
}, 120_000);
