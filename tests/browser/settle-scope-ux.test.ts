/**
 * A press settles on what can move the number it measures, in real Chrome. Motion elsewhere on the page is not that
 * number's: a decoration restarted beside the inspector held the settle forever with the inspector already open
 * (2026-10-14; staging's live-memory row went silent there). A transition that can move it is waited for, pending or
 * running: equal frames alone read the rail as settled at its open 240 px while its collapse waited pending
 * (2026-09-24, 10 of 40 collapses short of the end state at 6x CPU throttling).
 */
import { expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import * as v from 'valibot';
import { withBrowser } from '../../scripts/live-app-harness';
import { INSPECTOR_PANEL, INSPECTOR_WIDTH, settled } from '../../scripts/browser-page';

/** The shell's shape: the rail beside `main`, which holds the chat column and the inspector. */
const SHELL = `<style>
  @keyframes pulse { from { opacity: 0.2 } to { opacity: 1 } }
  @keyframes grow { from { width: 10px } to { width: 60px } }
  @keyframes enter { from { opacity: 0 } to { opacity: 1 } }
  body { margin: 0 }
  .shell { display: flex; height: 600px }
  aside { width: 240px; flex-shrink: 0; overflow: hidden; transition: width 180ms ease-out }
  main { flex: 1; min-width: 0; display: flex }
  .chat { flex: 1; min-width: 0 }
  #inspector { width: 340px; flex-shrink: 0 }
  #scroller { height: 200px; overflow-y: auto }
  .pulse { animation: pulse 200ms 1 }
  .grow { display: inline-block; height: 8px; animation: grow 200ms 1 }
  .lane { animation: enter 150ms 1 }
  .slide { display: inline-block; transition: margin-left 200ms }
  .row { height: 40px }
  .opening { height: 0; overflow: hidden; transition: height 300ms ease-out }
</style>
<div class="shell">
  <aside><div class="lane"></div></aside>
  <main>
    <div class="chat">
      <span id="pulse" class="pulse">*</span><span id="grow" class="grow"></span><span id="slide" class="slide">-</span>
      <div id="scroller"><div class="row"></div><div class="row"></div><div class="row"></div><div class="row"></div><div class="row"></div><div class="row"></div></div>
    </div>
    <div id="inspector"></div>
  </main>
</div>`;

const RAIL_LANE = `Math.round(document.querySelector('main').getBoundingClientRect().left)`;

const SCROLLER = `document.querySelector('#scroller')`;

const SCROLL_HEIGHT = `${SCROLLER}.scrollHeight`;

/** Each decoration started again whenever it ends, as an app's decorations are, counting its restarts. */
const RESTART_DECORATIONS = `(() => {
  window.__restarts = 0;
  for (const id of ['pulse', 'grow']) {
    const el = document.getElementById(id);
    el.addEventListener('animationend', () => {
      window.__restarts += 1;
      const name = el.className;
      el.className = '';
      void el.offsetWidth;
      el.className = name;
    });
  }
  const slide = document.getElementById('slide');
  slide.addEventListener('transitionend', () => {
    window.__restarts += 1;
    slide.style.marginLeft = slide.style.marginLeft === '20px' ? '0px' : '20px';
  });
  slide.style.marginLeft = '20px';
})()`;

async function shell(browser: Browser): Promise<Page> {
  const page = await browser.newPage();

  page.setDefaultTimeout(0);
  await page.setContent(SHELL);

  return page;
}

test('motion that cannot move the measured box, restarted keyframes and a restarted transition, does not hold its settle', async () => {
  await withBrowser(async (browser) => {
    const page = await shell(browser);

    await page.evaluate(RESTART_DECORATIONS);
    await page.waitForFunction('window.__restarts >= 3', { polling: 'raf' });
    await settled(page, INSPECTOR_WIDTH, { box: INSPECTOR_PANEL });
    const restartsAtSettle = v.parse(v.number(), await page.evaluate('window.__restarts'));

    // Still restarting after the settle returned: the wait ended beside them, not after them.
    await page.waitForFunction(`window.__restarts > ${String(restartsAtSettle)}`, { polling: 'raf' });
    expect(v.parse(v.number(), await page.evaluate(INSPECTOR_WIDTH))).toBe(340);
  });
});

test('the rail\'s collapse, a sibling of the measured box, is waited for to its end state at 6x CPU throttling', async () => {
  await withBrowser(async (browser) => {
    const page = await shell(browser);
    const cdp = await page.createCDPSession();

    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.evaluate(RESTART_DECORATIONS);
    const lanes: number[] = [];

    for (let press = 0; press < 20; press += 1) {
      const width = press % 2 === 0 ? 56 : 240;

      // One evaluate presses and the next settles, as `pressUntil` does: the transition is pending at the first read.
      await page.evaluate(`document.querySelector('aside').style.width = '${String(width)}px'`);
      await settled(page, RAIL_LANE, { box: `document.querySelector('main')` });
      lanes.push(v.parse(v.number(), await page.evaluate(RAIL_LANE)));
    }

    expect(lanes).toEqual(Array.from({ length: 20 }, (_, press) => (press % 2 === 0 ? 56 : 240)));
  });
});

test('a scroller settles once a row opening inside it has its full height, whatever paints beside it', async () => {
  await withBrowser(async (browser) => {
    const page = await shell(browser);

    await page.evaluate(`(() => {
      const scroller = ${SCROLLER};
      const row = document.createElement('div');
      row.className = 'opening';
      const pulse = document.createElement('div');
      pulse.style.height = '10px';
      pulse.className = 'pulse';
      pulse.addEventListener('animationend', () => { pulse.className = ''; void pulse.offsetWidth; pulse.className = 'pulse'; });
      scroller.append(pulse, row);
      void row.offsetHeight;
      row.style.height = '200px';
    })()`);
    await settled(page, SCROLL_HEIGHT, { scroller: SCROLLER });

    // Six rows of 40 px, the pulse's 10 px and the opened row's 200 px.
    expect(v.parse(v.number(), await page.evaluate(SCROLL_HEIGHT))).toBe(6 * 40 + 10 + 200);
  });
});
