import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser } from 'puppeteer';

import { type PageAudit, auditPage } from './computed-style';
import { withGallery } from './gallery-harness';

interface Scenarios {
  /** The tree as it ships. */
  readonly clean: PageAudit;
  /** The historical `--radius` defect, re-injected into the live cascade. */
  readonly seededRadius: PageAudit;
  /** A shipped role token withdrawn at `:root` at runtime — no file touched. */
  readonly cutRoleToken: PageAudit;
  /** `var(--x, fallback)` against a token that does not exist. */
  readonly withFallback: PageAudit;
}

/**
 * The gate is a browser, so its test is a browser.
 *
 * Every scenario renders the same real gallery frame and differs only in what
 * is done to the LIVE cascade before the audit runs. None of them edits a file,
 * which is the point: each seeded defect leaves `tsc`, `oxlint`, the bundle and
 * every source-reading test in the repo green, and the browser still sees it.
 *
 * One server and one browser for the file — booting vite costs ~5s and all four
 * scenarios want the same page.
 */
async function run(): Promise<Scenarios> {
  return withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
    const on = async (seed: string | null, withdraw?: string): Promise<PageAudit> => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      // The signal that React has mounted the surface, not a guessed duration:
      // `.p-card` is the class every scenario below asserts against.
      await page.waitForSelector('.p-card');
      if (seed !== null) {
        await page.evaluate((css: string) => {
          const style = document.createElement('style');
          style.textContent = css;
          document.head.append(style);
        }, seed);
      }
      if (withdraw !== undefined) {
        await page.evaluate((token: string) => {
          document.documentElement.style.setProperty(token, 'initial');
        }, withdraw);
      }
      const found = await page.evaluate(auditPage);
      await page.close();
      return found;
    };

    return {
      clean: await on(null),
      // Verbatim shape of the shipped bug: Tailwind's radius scale mapped onto
      // `calc(var(--radius) …)` with `--radius` declared nowhere at this scope.
      // Valid CSS; the page renders; only the cascade knows.
      seededRadius: await on('.p-card { border-radius: calc(var(--radius) - 2px); }'),
      cutRoleToken: await on(null, '--r-card'),
      withFallback: await on('.p-card { outline-width: var(--never-declared-anywhere, 1px); }'),
    };
  });
}

describe('computed-style gate', () => {
  let scenarios: Scenarios;
  beforeAll(async () => { scenarios = await run(); }, 180_000);

  test('it measures something — a clean verdict over an empty denominator is not a pass', () => {
    // `tool-construction` reports `0/0, score null` inside a headline that
    // reads 100%. This is the assertion that stops that happening here.
    expect(scenarios.clean.checked).toBeGreaterThan(100);
  });

  test('the shipped stylesheet resolves every token it references', () => {
    expect(scenarios.clean.findings).toEqual([]);
  });

  test('the historical --radius defect is reported when seeded back in', () => {
    const hit = scenarios.seededRadius.findings.find((f) => f.token === '--radius');
    expect(hit).toBeDefined();
    expect(hit!.property).toBe('border-radius');
    expect(hit!.selector).toBe('.p-card');
  });

  test('a role token withdrawn at :root is reported at the class that reads it', () => {
    // Cut-the-wire: the gate must be reading the live cascade, not stylesheet
    // text. Nothing on disk changed, so every source-reading instrument in the
    // repo still passes and only this one fails.
    const hit = scenarios.cutRoleToken.findings.find((f) => f.token === '--r-card');
    expect(hit).toBeDefined();
    expect(hit!.property).toBe('border-radius');
  });

  test('a var() with a fallback is not a defect', () => {
    expect(scenarios.withFallback.findings).toEqual([]);
  });
});
