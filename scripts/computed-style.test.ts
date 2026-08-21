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
  /** Silk's light face, reached the way a person reaches it. */
  readonly lightMode: ThemeAudit;
  /** Umber's dark face, reached through its own control. */
  readonly umberDark: ThemeAudit;
  /** Umber's light face — both controls, the theme furthest from the default. */
  readonly umberLight: ThemeAudit;
}

/**
 * One pass, and the theme it actually measured.
 *
 * The theme is carried by EVERY scenario rather than only the switched ones,
 * because a pin that is set but never read is indistinguishable from no pin at
 * all: the pre-paint script in `gallery.html:7-22` writes `data-mode` and
 * `data-palette` once at load and installs no listener, so a feature emulated
 * at the wrong moment leaves the page on whichever theme Chromium and
 * localStorage happened to produce while the test reads as pinned. Asserting
 * both axes is what makes the pin a measurement.
 */
interface ThemeAudit {
  readonly mode: string | undefined;
  readonly palette: string | undefined;
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
 * One server and one browser for the file — booting vite costs ~5s and all
 * seven scenarios want the same page.
 */
async function run(): Promise<Scenarios> {
  return withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
    /**
     * PINS `prefers-color-scheme` before navigating, and that is not a detail:
     * `gallery.html:7-22` resolves the initial `data-mode` from exactly this
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
      // Every page in this file shares one browser context, so one page's
      // toggle is the next page's stored preference — and a stored preference
      // beats the emulated media query by design. Uncleared, the scenario that
      // clicks "light" silently moved every scenario after it off the theme it
      // claims, and the palette scenario found the control already switched and
      // timed out looking for its own label. Cleared before the pre-paint script
      // runs, each scenario starts from "the user has never chosen".
      await page.evaluateOnNewDocument(() => { localStorage.clear(); });
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
      // A plain object, not `dataset`: a DOMStringMap crosses the CDP boundary
      // as `{}` and every attribute read comes back undefined.
      const { mode, palette } = await page.evaluate(() => ({
        mode: document.documentElement.dataset.mode,
        palette: document.documentElement.dataset.palette,
      }));
      await page.close();
      return { mode, palette, audit };
    };

    /**
     * A theme entered through the controls a person actually clicks rather than
     * by setting the attribute — so a regression in `use-theme.ts` or in the
     * Sidebar wiring shows up here too, not just a missing token.
     *
     * Each palette block is structurally distinct, not a filter over another
     * one. `index.css:300-388` (umber light) carries its own record of "three
     * passes of complaint, all the same one"; the silk blocks after it are a
     * second full palette whose light face is the theme furthest from `:root`,
     * four blocks deep in the cascade. Any token left unmapped in any of them
     * renders as Kumo's uncustomised brand colour rather than throwing, which is
     * why this has to be measured per theme and not inferred from one. Silk is
     * the shipped default, so the controls here reach umber, not silk.
     */
    const throughTheControls = async (want: { mode: 'dark' | 'light'; palette: 'umber' | 'silk' }): Promise<ThemeAudit> => {
      const page = await openShell('dark');
      // Ordered mode-then-palette only because the mode control's label depends
      // on the mode; both are idempotent and neither reads the other.
      const clicks = [
        ...(want.mode === 'light' ? ['[aria-label="Switch to light mode"]'] : []),
        ...(want.palette === 'umber' ? ['[aria-label="Switch to the umber palette"]'] : []),
      ];
      for (const control of clicks) {
        await page.waitForSelector(control);
        await page.click(control);
      }
      // Polled rather than awaited on a selector so a control that fails to
      // switch reports the theme it stayed in, instead of failing every scenario
      // in this file from `beforeAll` with a timeout.
      const read = () => page.evaluate(() => ({
        mode: document.documentElement.dataset.mode,
        palette: document.documentElement.dataset.palette,
      }));
      let applied = await read();
      for (let attempt = 0; attempt < 40 && (applied.mode !== want.mode || applied.palette !== want.palette); attempt += 1) {
        await Bun.sleep(25);
        applied = await read();
      }
      const audit = await page.evaluate(auditPage);
      await page.close();
      return { mode: applied.mode, palette: applied.palette, audit };
    };

    return {
      clean: await on(null),
      // Verbatim shape of the shipped bug: Tailwind's radius scale mapped onto
      // `calc(var(--radius) …)` with `--radius` declared nowhere at this scope.
      // Valid CSS; the page renders; only the cascade knows.
      seededRadius: await on('.p-card { border-radius: calc(var(--radius) - 2px); }'),
      cutRoleToken: await on(null, '--r-card'),
      withFallback: await on('.p-card { outline-width: var(--never-declared-anywhere, 1px); }'),
      lightMode: await throughTheControls({ mode: 'light', palette: 'silk' }),
      umberDark: await throughTheControls({ mode: 'dark', palette: 'umber' }),
      umberLight: await throughTheControls({ mode: 'light', palette: 'umber' }),
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

  test('the four passes above measured the default theme, as pinned', () => {
    // Without this the pin is decoration: `emulateMediaFeatures` could stop
    // applying, or move after `goto`, and every assertion above would quietly
    // change which theme it was making a claim about.
    expect({ mode: scenarios.clean.mode, palette: scenarios.clean.palette })
      .toEqual({ mode: 'dark', palette: 'silk' });
  });

  test('the controls switch the document to each of the other three themes', () => {
    // User-visible controls, and the denominator for the test below: a control
    // that silently failed would leave these passes re-measuring the theme the
    // four scenarios above already covered.
    expect([
      { mode: scenarios.lightMode.mode, palette: scenarios.lightMode.palette },
      { mode: scenarios.umberDark.mode, palette: scenarios.umberDark.palette },
      { mode: scenarios.umberLight.mode, palette: scenarios.umberLight.palette },
    ]).toEqual([
      { mode: 'light', palette: 'silk' },
      { mode: 'dark', palette: 'umber' },
      { mode: 'light', palette: 'umber' },
    ]);
  });

  test('every other theme resolves every token it references', () => {
    // Same instrument as the shipped-stylesheet test, pointed at each remaining
    // theme. An unmapped role token renders as Kumo's uncustomised brand colour
    // rather than throwing, which is why three rounds of it reached a human
    // before a gate ever could — and why silk's two blocks are audited here
    // rather than assumed complete because their sibling is.
    const audited = [
      ['silk light', scenarios.lightMode],
      ['umber dark', scenarios.umberDark],
      ['umber light', scenarios.umberLight],
    ] as const;
    expect(audited.map(([theme, s]) => ({ theme, findings: s.audit.findings, measured: s.audit.checked > 100 })))
      .toEqual(audited.map(([theme]) => ({ theme, findings: [], measured: true })));
  });
});
