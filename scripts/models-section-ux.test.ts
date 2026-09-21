/**
 * The model controls, through the names assistive technology reads and the
 * look the composer's row is measured by.
 *
 * The settings section was redesigned from one tall card into tiers +
 * master/detail roles, and a redesign is exactly when a control silently drops
 * out: the DOM still "has a picker" but the tier row no longer names it. Every
 * assertion in the first test is by ACCESSIBLE NAME — `getByRole`-equivalent
 * lookups over the rendered document — so a refactor that keeps the controls
 * and loses their names fails here, and one that drops a control outright
 * fails here too.
 *
 * The composer's own pair (the model name and the thinking level) is measured
 * rather than named: the owner's report was that the thinking control carried
 * a heavier edge than the model name above it, and that the two stacked in a
 * column wide enough for one line. Kumo draws that edge as a RING, not a
 * border, so the rest state is read as the painted box-shadow and the
 * background — a `border-width` assertion alone is green on the heavy pill
 * this replaces. Screenshots land in ~/kinu-logs/composer-model-row/.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'composer-model-row');

mkdirSync(SHOTS, { recursive: true });

/** The computed `box-shadow` segments that actually draw: a colour with alpha
 *  over a non-zero offset, blur or spread. Tailwind leaves the property set
 *  whatever the utilities say, so `ring` removed reads as a zero-size segment
 *  rather than `none` — and a zero-size segment paints nothing. Kumo draws the
 *  control's edge here, which is why this, and not `border-width`, is what
 *  tells a pill from plain text. */
const paintedEdges = (boxShadow: string): string[] =>
  boxShadow.split(/,(?![^()]*\))/).map((segment) => segment.trim()).filter((segment) => {
    const color = segment.match(/rgba?\(([^)]*)\)/);
    const channels = color ? color[1].split(/[,/]/).map((channel) => Number.parseFloat(channel.trim())) : [];
    const visible = channels.length > 3 ? channels[3] > 0 : color !== null;

    return visible && [...segment.matchAll(/(-?[\d.]+)px/g)].some((length) => Number.parseFloat(length[1]) !== 0);
  });

/** Chrome's computed value for a background that is not there. */
const NO_BACKGROUND = 'rgba(0, 0, 0, 0)';

interface RowGeometry {
  /** The thinking trigger at rest, as the browser computes it. */
  readonly borderWidth: string;
  readonly boxShadow: string;
  readonly background: string;
  /** True when the two triggers overlap vertically — one row. */
  readonly oneRow: boolean;
  /** The thinking trigger follows the model name, with a gap between them. */
  readonly gapAfterModel: number;
}

async function rowGeometry(page: Page): Promise<RowGeometry> {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-composer-root]');

    if (!composer) throw new Error('the composer frame rendered no composer');
    const model = composer.querySelector('input[aria-label="Model"]');
    const thinking = composer.querySelector('[aria-label="Thinking level"]');

    if (!model || !thinking) throw new Error('the composer is missing the model or the thinking control');
    const style = getComputedStyle(thinking);
    const m = model.getBoundingClientRect();
    const t = thinking.getBoundingClientRect();

    return {
      borderWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      background: style.backgroundColor,
      oneRow: t.top < m.bottom && m.top < t.bottom,
      gapAfterModel: t.left - m.right,
    };
  });
}

const THINKING = '[aria-label="Thinking level"]';

/** The trigger's background once the pointer is on it and the colour
 *  transition has landed: the wait ends on the raise leaving the rest value
 *  and its transition reaching `finished`, never on a duration — a read taken
 *  while the colour is still moving catches an interpolated tint. The raise is
 *  the whole affordance after the pill goes, so a rest state with no hover
 *  state is a control that answers nothing. */
async function hoverBackground(page: Page): Promise<string> {
  await page.hover(THINKING);
  await page.waitForFunction(
    (selector: string, rest: string) => {
      const element = document.querySelector(selector);

      if (element === null || getComputedStyle(element).backgroundColor === rest) return false;

      return element.getAnimations().every((animation) => animation.playState === 'finished');
    },
    {}, THINKING, NO_BACKGROUND,
  );

  return page.$eval(THINKING, (element) => getComputedStyle(element).backgroundColor);
}

/** A theme's own `--c-elevated`, as the browser resolves it — the token every
 *  quiet control in the app raises to on hover. */
async function elevatedColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--c-elevated)';
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();

    return resolved;
  });
}

/**
 * The composer sheet at one width, in one theme.
 *
 * The width is the page's from before the load and never changes after: a
 * `setViewport` on a loaded page turns `(hover: hover)` false for the rest of
 * that page's life — measured 2026-09-21 on this harness's Chrome, where the
 * launch flags declare the pointer — and every `hover:` utility Tailwind emits
 * behind that query is then dead. One page per width keeps the hover read
 * honest.
 */
async function composerPage(gallery: Gallery, theme: 'dark' | 'light', width: number): Promise<Page> {
  const page = await gallery.newPage();
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.setViewport({ width, height: 1100 });
  await page.goto(`${gallery.origin}/gallery.html?frame=composer`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(THINKING);

  return page;
}

describe('the models section keeps every control reachable by name', () => {
  test('tier rows and the role editor expose their controls by accessible name', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="New tier id"]');

      const named = async (name: string): Promise<boolean> =>
        page.$$eval(`[aria-label="${name}"]`, (els) => els.length > 0);

      // Every built-in tier row carries its two controls, named for the tier:
      // the model combobox and the reasoning-effort select.
      for (const tier of ['fast', 'default', 'deep']) {
        expect(await named(`${tier} model`)).toBe(true);
        expect(await named(`${tier} reasoning effort`)).toBe(true);
      }

      // The role navigation and the selected role's editor fields.
      expect(await page.$('nav[aria-label="Agent roles"] [aria-current="true"]')).not.toBeNull();

      for (const field of ['Label', 'Description', 'Instructions', 'Default tier', 'Default swarm preset']) {
        expect(await named(field)).toBe(true);
      }

      // The tool and skill membership lists, as named checkboxes.
      expect(await named('Tools: file')).toBe(true);
      expect(await named('Skills: audit-implementation')).toBe(true);
      await page.close();
    });
  });
});

describe('the composer states the model and the thinking level as one quiet row', () => {
  test('both triggers are plain text at rest, on one line, in dark and light', async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        const page = await composerPage(gallery, theme, 1280);
        const rest = await rowGeometry(page);

        // Nothing is drawn around the thinking level until it is used.
        expect(rest.borderWidth).toBe('0px');
        expect(paintedEdges(rest.boxShadow)).toEqual([]);
        expect(rest.background).toBe(NO_BACKGROUND);

        // One line, the thinking level after the model name.
        expect(rest.oneRow).toBe(true);
        expect(rest.gapAfterModel).toBeGreaterThan(6);
        await page.screenshot({ path: join(SHOTS, `row-${theme}.png`), fullPage: true });

        // The raise the app gives every quiet control, and only on hover. It
        // runs after the sheet is photographed, so the sheet shows the rest
        // state this test is about.
        expect(await hoverBackground(page)).toBe(await elevatedColor(page));
        await page.close();

        // A chat column too narrow for the pair stacks it, which is the only
        // state that may.
        const narrow = await composerPage(gallery, theme, 420);
        expect((await rowGeometry(narrow)).oneRow).toBe(false);
        await narrow.screenshot({ path: join(SHOTS, `stacked-${theme}.png`), fullPage: true });
        await narrow.close();
      }
    });
  });

  test('the thinking menu keeps its levels and opens from the keyboard', async () => {
    await withGallery(async (gallery) => {
      const page = await composerPage(gallery, 'dark', 1280);

      // The label the trigger carries is the level's own name, not its id.
      expect(await page.$eval(THINKING, (element) => element.textContent?.trim())).toBe('Default');

      await page.focus(THINKING);
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="option"]');

      // The stub model declares low, medium and high, so the menu offers
      // exactly those plus the tier's default — `offeredReasoningEfforts`.
      expect(await page.$$eval('[role="option"]', (options) => options.map((o) => o.textContent?.trim())))
        .toEqual(['Default', 'Low', 'Medium', 'High']);

      await page.keyboard.press('Escape');
      await page.close();
    });
  });
});
