import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { recordScriptFailures } from '../../scripts/script-failures';
import { launchTestChrome, type TestChrome } from '../../scripts/test-chrome';
import { SlateView } from './browser';
import { shows, type Sight } from './sight';

// The checks of what a person sees read pages an agent built, whose markup no check may assume. These pages lay the
// same three teams out the ways agents do, and each must read the same: every team's figures in a part of its own,
// with the buttons there.

const TEAMS = ['design', 'growth', 'platform'];

let chrome: TestChrome;

let browser: Browser;

beforeAll(async () => {
  chrome = await launchTestChrome();
  browser = chrome.browser;
});

afterAll(() => chrome.close());

async function pageOf(html: string, width = 800): Promise<Page> {
  const page = await browser.newPage();

  await page.setViewport({ width, height: 600 });
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);

  return page;
}

async function read(html: string, width?: number): Promise<Sight> {
  const page = await pageOf(html, width);

  try {
    return await new SlateView(page.mainFrame()).read(TEAMS);
  } finally {
    await page.close();
  }
}

/** Whether `team` has a part that shows every one of `amounts`. */
function shown(sight: Sight, team: string, amounts: readonly number[]): boolean {
  return (sight.regions[team] ?? []).some((region) => amounts.every((amount) => shows(region.text, amount)));
}

const ROWS = `<table><thead><tr><th>Team</th><th>Budget</th><th>Spent</th><th>Left</th><th></th></tr></thead><tbody>
  <tr><td>design</td><td>$1,500.00</td><td>$1,641.00</td><td>-$141.00</td><td><button>Cover</button><button aria-label="Ask Kinu about design">?</button></td></tr>
  <tr><td>growth</td><td>$3,000.00</td><td>$2,705.00</td><td>$295.00</td><td></td></tr>
  <tr><td>platform</td><td>$2,000.00</td><td>$1,530.50</td><td>$469.50</td><td></td></tr>
</tbody></table>`;

/** The same figures with the teams across the top, as a comparison grid lays them out. */
const COLUMNS = `<table><tr><th></th>${TEAMS.map((team) => `<th><span>${team}</span></th>`).join('')}</tr>
  <tr><td>Budget</td><td>1,500.00</td><td>3,000.00</td><td>2,000.00</td></tr>
  <tr><td>Spent</td><td>1,641.00</td><td>2,705.00</td><td>1,530.50</td></tr>
  <tr><td></td>${TEAMS.map((team) => `<td><button data-is="pick ${team}">Pick</button></td>`).join('')}</tr></table>`;

describe('a page read as a person sees it', () => {
  test('a table row is its team\'s part, with the buttons in it named as a person hears them', async () => {
    const sight = await read(ROWS);

    expect(shown(sight, 'design', [1500, 1641, 141])).toBe(true);
    expect(shown(sight, 'platform', [2000, 1530.5, 469.5])).toBe(true);
    expect(shown(sight, 'growth', [1641])).toBe(false);
    expect(sight.regions.design?.flatMap((region) => region.controls)).toEqual(['Cover', 'Ask Kinu about design']);
    expect(sight.regions.growth?.flatMap((region) => region.controls)).toEqual([]);
  });

  test('a grid is read down its columns, each under its team', async () => {
    const sight = await read(COLUMNS);

    expect(shown(sight, 'growth', [3000, 2705])).toBe(true);
    expect(shown(sight, 'growth', [1641])).toBe(false);
    expect(sight.regions.platform?.flatMap((region) => region.controls)).toEqual(['Pick']);
  });

  test('a repeated name keeps the column values of its own table row, not the last matching table', async () => {
    const sight = await read([141, 777].map((p95) => `<table><thead><tr><th>Team</th><th>p95 (ms)</th></tr></thead><tbody>
      <tr><td>design</td><td>${String(p95)}</td></tr><tr><td>growth</td><td>29</td></tr></tbody></table>`).join(''));

    const rows = sight.regions.design ?? [];

    expect(rows.find((region) => shows(region.text, 141))?.columns?.['p95 (ms)']).toBe('141');
    expect(rows.find((region) => shows(region.text, 777))?.columns?.['p95 (ms)']).toBe('777');
  });

  test('overlapping row and column readings cannot turn one comparison into several treatments', async () => {
    for (const count of [1, 2, 3]) {
      const sight = await read(Array.from({ length: count }, () => `<div style="display:flex">${TEAMS.map((team) =>
        `<section><h2>${team}</h2><p>19 monthly</p><p>205.20 yearly</p></section>`).join('')}</div>`).join(''));

      for (const team of TEAMS) {
        const priced = (sight.regions[team] ?? []).filter((region) => shows(region.text, 19) && shows(region.text, 205.2));

        expect(new Set(priced.flatMap((region) => region.occurrence === undefined ? [] : [region.occurrence])).size).toBe(count);
      }
    }
  });

  test('cards read like rows, and a heading naming every team is no team\'s part', async () => {
    const sight = await read(`<h1>Teams: design, growth and platform</h1><div style="display:flex">
      ${TEAMS.map((team, index) => `<section><h2>${team.toUpperCase()}</h2><p>Budget <b>${String(1000 * (index + 1))}</b></p><p>Spent ${String(900 * (index + 1))}</p></section>`).join('')}
    </div>`);

    expect(shown(sight, 'growth', [2000, 1800])).toBe(true);
    expect(shown(sight, 'growth', [1000])).toBe(false);
    expect(shown(sight, 'design', [2000])).toBe(false);
  });

  test('what a person cannot see is not read: a closed select, a hidden note, a script, text cut off or past the side', async () => {
    const page = `<select>${TEAMS.map((team) => `<option>${team}</option>`).join('')}</select>
      <div><span>design</span> <span style="display:none">9999.99</span> <span style="visibility:hidden">8888</span> 1500</div>
      <div style="height:0;overflow:hidden">6666</div><div style="width:40px;overflow:hidden;white-space:nowrap">platform 5555555555555</div>
      <script>"design 7777"</script>
      <div style="display:flex;width:1200px"><span style="flex:0 0 900px">growth</span><span>3000</span></div>`;

    const narrow = await read(page, 600);

    expect(shown(narrow, 'design', [1500])).toBe(true);
    expect([9999.99, 8888, 7777, 6666, 5555555555555, 3000].some((hidden) => shows(narrow.text, hidden))).toBe(false);
    expect(shown(await read(page, 1400), 'growth', [3000])).toBe(true);
  });

  test('a name split across text nodes is one label, and copy that mentions a name in passing is none', async () => {
    const sight = await read(`<div style="display:flex">${TEAMS.map((team, index) => `<section><h3><b>${team.slice(0, 3)}</b>${team.slice(3)}</h3>
      <p>${String(1000 * (index + 1))}</p><p>${index === 2 ? 'Everything in design and growth, plus more' : 'The basics'}</p></section>`).join('')}</div>`);

    expect(shown(sight, 'design', [1000])).toBe(true);
    expect(shown(sight, 'platform', [3000])).toBe(true);
    expect(shown(sight, 'design', [3000])).toBe(false);
  });

  test('a column ends with its table, and a chart\'s bar is read under and over its label', async () => {
    const stacked = await read(`${COLUMNS}<table><tr>${[...TEAMS].reverse().map((team) => `<th>${team}</th>`).join('')}</tr><tr><td>7</td><td>8</td><td>9</td></tr></table>`);

    const chart = await read(`<svg width="300" height="200">${TEAMS.map((team, index) => `<text x="${String(50 + index * 100)}" y="20" text-anchor="middle">${String(100 * (index + 1))}</text>
      <rect x="${String(35 + index * 100)}" y="30" width="30" height="${String(40 * (index + 1))}"></rect>
      <text x="${String(50 + index * 100)}" y="190" text-anchor="middle">${team}</text>`).join('')}</svg>`);

    expect(shown(stacked, 'growth', [3000, 2705])).toBe(true);
    expect(shown(stacked, 'growth', [7])).toBe(false);
    expect(shown(stacked, 'design', [9])).toBe(true);
    expect(shown(chart, 'growth', [200])).toBe(true);
    expect(shown(chart, 'growth', [100])).toBe(false);
  });

  test('figures read whatever their grouping and sign, to the cent', () => {
    for (const text of ['$1,641.00', '1641', 'spent 1,641']) expect(shows(text, 1641)).toBe(true);

    for (const text of ['-$141.00', '−141.00', '($141.00)', 'over by 141']) expect(shows(text, -141)).toBe(true);

    expect(shows('$164.10', 1641)).toBe(false);
    expect(shows('$205.20 a year', 205.2)).toBe(true);
    expect(shows('$205 a year', 205.2)).toBe(false);
  });
});

describe('a control pressed as a person presses it', () => {
  async function pressed(html: string, press: { name: string; label: string | null }): Promise<string | null> {
    const page = await pageOf(`${html}<output id="pressed"></output>
      <script>document.addEventListener('click', (event) => { document.getElementById('pressed').textContent = event.target.closest('[data-is]')?.dataset.is ?? 'nothing'; });</script>`);

    try {
      const done = await new SlateView(page.mainFrame()).press(TEAMS, press);

      return done ? await page.$eval('#pressed', (output) => output.textContent) : null;
    } finally {
      await page.close();
    }
  }

  test('the button its label names, in the team\'s own row or column', async () => {
    expect(await pressed(ROWS.replace('<button>Cover</button>', '<button data-is="cover design">Cover</button>'), { name: 'design', label: '\\bcover\\b' })).toBe('cover design');
    expect(await pressed(ROWS, { name: 'growth', label: '\\bcover\\b' })).toBeNull();
    expect(await pressed(COLUMNS, { name: 'growth', label: null })).toBe('pick growth');
  });

  test('a card that shows a pointer is a control, and the button inside one is the one pressed', async () => {
    const cards = TEAMS.map((team) => `<div data-is="card ${team}" style="cursor:pointer"><h3>${team}</h3><p>1500</p></div>`).join('');
    const holding = TEAMS.map((team) => `<div style="cursor:pointer"><h3>${team}</h3><button data-is="pick ${team}">Pick</button></div>`).join('');
    const radios = TEAMS.map((team) => `<label data-is="label ${team}"><input type="radio" name="team"> ${team}</label>`).join('');

    expect(await pressed(cards, { name: 'platform', label: null })).toBe('card platform');
    expect(await pressed(holding, { name: 'platform', label: null })).toBe('pick platform');
    expect(await pressed(radios, { name: 'growth', label: null })).toBe('label growth');
  });

  test('two controls that would both do are no one control', async () => {
    expect(await pressed(ROWS, { name: 'design', label: null })).toBeNull();
  });
});

describe('what failed in a page', () => {
  test('an uncaught error, a rejection nothing handled and a script that never loaded, in a frame of the page', async () => {
    const page = await browser.newPage();

    try {
      await recordScriptFailures(page);

      const framed = '<p>drawn</p><script>throw new Error("the page broke")</script><script>Promise.reject(new Error("nobody waited"))</script>'
        + '<script src="http://127.0.0.1:9/missing.js"></script>';

      await page.goto(`data:text/html,${encodeURIComponent(`<iframe srcdoc="${framed.replaceAll('"', '&quot;')}"></iframe>`)}`, { waitUntil: 'load' });
      const frame = page.frames().find((each) => each !== page.mainFrame());

      if (frame === undefined) throw new Error('the page has no frame');
      await frame.waitForFunction('(window.__scriptFailures ?? []).length > 0 && (window.__uncaughtErrors ?? []).length > 1', { timeout: 0 });
      const faults = await new SlateView(frame).faults();

      expect(faults.errors).toEqual(['Uncaught Error: the page broke', 'Uncaught (in promise) nobody waited']);
      expect(faults.scripts).toEqual(['http://127.0.0.1:9/missing.js']);
    } finally {
      await page.close();
    }
  });
});
