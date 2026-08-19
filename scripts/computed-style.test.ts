import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser } from 'puppeteer';

import { type PageAudit, auditPage } from './computed-style';
import { withGallery } from './gallery-harness';

interface Scenarios {
  /** The tree as it ships. */
  readonly clean: ThemeAudit;
  /** The historical `--radius` defect, re-injected into the live cascade. */
  readonly seededRadius: ThemeAudit;
  /** A shipped role token withdrawn at `:root` at runtime — no file touched. */
  readonly cutRoleToken: ThemeAudit;
  /** `var(--x, fallback)` against a token that does not exist. */
  readonly withFallback: ThemeAudit;
  /** The light palette, reached the way a person reaches it. */
  readonly lightMode: ThemeAudit;
}

/**
 * One pass, and the palette it actually measured.
 *
 * The mode is carried by EVERY scenario rather than only the light one, because
 * a pin that is set but never read is indistinguishable from no pin at all: the
 * pre-paint script in `gallery.html:8-15` writes `data-mode` once at load and
 * installs no listener, so a feature emulated at the wrong moment leaves the
 * page on whichever palette Chromium chose while the test reads as pinned.
 * Asserting the mode is what makes the pin a measurement.
 */
interface ThemeAudit {
  readonly mode: string | undefined;
  readonly audit: PageAudit;
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
    /**
     * PINS `prefers-color-scheme` before navigating, and that is not a detail:
     * `gallery.html:8-15` resolves the initial `data-mode` from exactly this
     * media query, and the harness never pinned it — it declares a pointing
     * device for `hover:` utilities (`gallery-harness.ts:96-100`) and stops
     * there. Unpinned, every assertion in this file read "the shipped
     * stylesheet resolves every token" against whichever palette the Chromium
     * build happened to prefer. Measured dark on this build; a build or CI image
     * that answered light would have silently moved the subject of the gate
     * without changing a line here.
     */
    const openShell = async (prefers: 'dark' | 'light') => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: prefers }]);
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      // The signal that React has mounted the surface, not a guessed duration:
      // `.p-card` is the class every scenario below asserts against.
      await page.waitForSelector('.p-card');
      return page;
    };

    const on = async (seed: string | null, withdraw?: string): Promise<ThemeAudit> => {
      const page = await openShell('dark');
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
      const audit = await page.evaluate(auditPage);
      const mode = await page.evaluate(() => document.documentElement.dataset.mode);
      await page.close();
      return { mode, audit };
    };

    /**
     * The light palette, entered through the control a person actually clicks
     * rather than by setting the attribute — so a regression in `use-theme.ts`
     * or in the Sidebar wiring shows up here too, not just a missing token.
     *
     * `index.css:300-388` is a structurally distinct palette, not a filter over
     * the dark one, and its own comment records "three passes of complaint, all
     * the same one" plus the warning that any token left unmapped renders as
     * Kumo's uncustomised brand colour. No browser gate had ever set
     * `data-mode` at all, so that palette had never been audited.
     */
    const throughTheThemeControl = async (): Promise<ThemeAudit> => {
      const page = await openShell('dark');
      const control = '[aria-label="Switch to light mode"]';
      await page.waitForSelector(control);
      await page.click(control);
      // Polled rather than awaited on a selector so a control that fails to
      // switch reports the mode it stayed in, instead of failing every scenario
      // in this file from `beforeAll` with a timeout.
      let mode = await page.evaluate(() => document.documentElement.dataset.mode);
      for (let attempt = 0; attempt < 40 && mode !== 'light'; attempt += 1) {
        await Bun.sleep(25);
        mode = await page.evaluate(() => document.documentElement.dataset.mode);
      }
      const audit = await page.evaluate(auditPage);
      await page.close();
      return { mode, audit };
    };

    return {
      clean: await on(null),
      // Verbatim shape of the shipped bug: Tailwind's radius scale mapped onto
      // `calc(var(--radius) …)` with `--radius` declared nowhere at this scope.
      // Valid CSS; the page renders; only the cascade knows.
      seededRadius: await on('.p-card { border-radius: calc(var(--radius) - 2px); }'),
      cutRoleToken: await on(null, '--r-card'),
      withFallback: await on('.p-card { outline-width: var(--never-declared-anywhere, 1px); }'),
      lightMode: await throughTheThemeControl(),
    };
  });
}

describe('computed-style gate', () => {
  let scenarios: Scenarios;
  beforeAll(async () => { scenarios = await run(); }, 180_000);

  test('it measures something — a clean verdict over an empty denominator is not a pass', () => {
    // `tool-construction` reports `0/0, score null` inside a headline that
    // reads 100%. This is the assertion that stops that happening here.
    expect(scenarios.clean.audit.checked).toBeGreaterThan(100);
  });

  test('the shipped stylesheet resolves every token it references', () => {
    expect(scenarios.clean.audit.findings).toEqual([]);
  });

  test('the historical --radius defect is reported when seeded back in', () => {
    const hit = scenarios.seededRadius.audit.findings.find((f) => f.token === '--radius');
    expect(hit).toBeDefined();
    expect(hit!.property).toBe('border-radius');
    expect(hit!.selector).toBe('.p-card');
  });

  test('a role token withdrawn at :root is reported at the class that reads it', () => {
    // Cut-the-wire: the gate must be reading the live cascade, not stylesheet
    // text. Nothing on disk changed, so every source-reading instrument in the
    // repo still passes and only this one fails.
    const hit = scenarios.cutRoleToken.audit.findings.find((f) => f.token === '--r-card');
    expect(hit).toBeDefined();
    expect(hit!.property).toBe('border-radius');
  });

  test('a var() with a fallback is not a defect', () => {
    expect(scenarios.withFallback.audit.findings).toEqual([]);
  });

  test('the four passes above measured the DARK palette, as pinned', () => {
    // Without this the pin is decoration: `emulateMediaFeatures` could stop
    // applying, or move after `goto`, and every assertion above would quietly
    // change which palette it was making a claim about.
    expect(scenarios.clean.mode).toBe('dark');
  });

  test('the theme control switches the document to the light palette', () => {
    // A user-visible control, and the denominator for the test below: if this is
    // `dark`, the light audit silently re-measured the palette already covered
    // by the four scenarios above.
    expect(scenarios.lightMode.mode).toBe('light');
  });

  test('the light palette resolves every token it references', () => {
    // Same instrument as the shipped-stylesheet test, pointed at the other
    // palette for the first time. An unmapped role token here renders as Kumo's
    // uncustomised brand colour rather than throwing, which is why three rounds
    // of it reached a human before a gate ever could.
    expect(scenarios.lightMode.audit.checked).toBeGreaterThan(100);
    expect(scenarios.lightMode.audit.findings).toEqual([]);
  });
});
