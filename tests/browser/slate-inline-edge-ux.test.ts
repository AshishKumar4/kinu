import { describe, expect, test } from 'bun:test';
import type { Frame, Page } from 'puppeteer';
import { DRAWN_SANDBOX } from '@kinu.run/core';
import { THEME_TOKENS } from '../../packages/core/src/web/theme';
import { contrast, rgba, withGallery } from '../../scripts/gallery-harness';
import { captureUiScene, openUiScene } from '../../scripts/ui-shell-scenes';

async function drawnFrame(page: Page, phase: 'streaming' | 'page'): Promise<Frame> {
  const selector = `iframe[data-slate-drawn="${phase}"]`;

  await page.waitForFunction((at) => (document.querySelector(at)?.getBoundingClientRect().height ?? 0) > 0, {}, selector);
  const element = await page.$(selector);
  const frame = await element?.contentFrame();

  if (frame === undefined || frame === null) throw new Error(`No ${phase} slate frame`);
  await frame.waitForSelector('#edge');
  await frame.evaluate(async () => { await document.fonts.ready; });

  return frame;
}

async function settledGeometry(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function edgeGeometry(frame: Frame) {
  await frame.focus('#secondary');
  await frame.page().keyboard.press('Tab');
  await frame.waitForFunction(() => document.activeElement?.id === 'edge');

  return frame.$eval('#edge', (button) => {
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const secondary = document.getElementById('secondary');
    const disabled = document.getElementById('disabled');

    if (!(disabled instanceof HTMLButtonElement) || secondary === null) throw new Error('Missing native controls');
    const outset = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);

    return {
      right: box.right + outset, bottom: box.bottom + outset,
      width: innerWidth, height: document.documentElement.getBoundingClientRect().height,
      focus: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
      radius: Number.parseFloat(style.borderRadius), foreground: style.color, primary: style.backgroundColor,
      secondary: getComputedStyle(secondary).backgroundColor,
      disabled: disabled.disabled && Number.parseFloat(getComputedStyle(disabled).opacity) < 1,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

describe('drawn inline slate edge controls', () => {
  for (const theme of ['graphite', 'warm'] as const) for (const mode of ['light', 'dark'] as const) for (const width of [1280, 390, 320]) {
    test(`keeps native primary/focus corners in its content height while streaming then final (${theme}, ${mode}, ${width})`, async () => {
      await withGallery(async (gallery) => {
        const page = await openUiScene(gallery, 'slateedges', mode, width);

        await page.evaluate((next) => window.dispatchEvent(new CustomEvent('gallery:theme', { detail: next })), { name: theme, mode });
        await page.waitForFunction((name) => document.documentElement.dataset.theme === name, {}, theme);

        for (const phase of ['streaming', 'page'] as const) {
          const frame = await drawnFrame(page, phase);

          await frame.waitForFunction((accent) => getComputedStyle(document.documentElement).getPropertyValue('--c-accent-fill').trim() === accent, {}, THEME_TOKENS[theme][mode]['--c-accent-fill']);
          await settledGeometry(page);
          const measured = await edgeGeometry(frame);

          await captureUiScene(page, `slate-edge-${phase}-${theme}-${mode}-${width}`);
          expect(measured.focus).toBe(true);
          expect(measured.radius).toBeGreaterThan(0);
          expect(measured.right).toBeLessThanOrEqual(measured.width);
          expect(measured.bottom).toBeLessThanOrEqual(Math.ceil(measured.height));
          expect(measured.horizontalOverflow).toBe(false);
          expect(measured.disabled).toBe(true);
          expect(measured.primary).not.toBe(measured.secondary);
          expect(contrast(rgba(measured.foreground), rgba(measured.primary))).toBeGreaterThanOrEqual(4.5);

          const host = await page.$eval(`iframe[data-slate-drawn="${phase}"]`, (iframe) => {
            const after = document.querySelector('[data-after-edge]');

            if (after === null) throw new Error('No prose after the page');

            return { radius: getComputedStyle(iframe).borderRadius, height: iframe.getBoundingClientRect().height, bottom: iframe.getBoundingClientRect().bottom, after: after.getBoundingClientRect().top, sandbox: iframe.getAttribute('sandbox') };
          });

          expect(Number.parseFloat(host.radius)).toBe(0);
          expect(host.height).toBe(Math.ceil(measured.height));
          expect(host.after).toBeGreaterThanOrEqual(host.bottom);
          expect(host.sandbox).toBe(DRAWN_SANDBOX);
          await settledGeometry(page);
          expect(await page.$eval(`iframe[data-slate-drawn="${phase}"]`, (iframe) => iframe.getBoundingClientRect().height)).toBe(host.height);

          if (phase === 'streaming') await page.click('[data-finish-slate]');
        }
      });
    });
  }
});
