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

/** Whether `team` has a part that shows every one of `amounts` and is not cut off. */
function shown(sight: Sight, team: string, amounts: readonly number[]): boolean {
  return (sight.regions[team] ?? []).some((region) => !region.clipped && amounts.every((amount) => shows(region.text, amount)));
}

const ROWS = `<table><thead><tr><th>Team</th><th>Budget</th><th>Spent</th><th>Left</th><th></th></tr></thead><tbody>
  <tr><td>design</td><td>$1,500.00</td><td>$1,641.00</td><td>-$141.00</td><td><button>Cover</button><button aria-label="Ask Kinu about design">?</button></td></tr>
  <tr><td>growth</td><td>$3,000.00</td><td>$2,705.00</td><td>$295.00</td><td></td></tr>
  <tr><td>platform</td><td>$2,000.00</td><td>$1,530.50</td><td>$469.50</td><td></td></tr>
</tbody></table>`;

describe('a page read as a person sees it', () => {
  test('a table row is its team\'s part, with the buttons in it named as a person hears them', async () => {
    const sight = await read(ROWS);

    expect(shown(sight, 'design', [1500, 1641, 141])).toBe(true);
    expect(shown(sight, 'platform', [2000, 1530.5, 469.5])).toBe(true);
    expect(sight.regions.design?.[0]?.controls).toEqual(['Cover', 'Ask Kinu about design']);
    expect(sight.regions.growth?.[0]?.controls).toEqual([]);
  });

  test('cards read like rows, and a team named in a heading over all of them is no team\'s part', async () => {
    const sight = await read(`<h1>Teams: design, growth and platform</h1><div style="display:flex">
      ${TEAMS.map((team, index) => `<section><h2>${team.toUpperCase()}</h2><p>Budget <b>${String(1000 * (index + 1))}</b></p><p>Spent ${String(900 * (index + 1))}</p></section>`).join('')}
    </div>`);

    expect(shown(sight, 'growth', [2000, 1800])).toBe(true);
    expect(shown(sight, 'growth', [1000])).toBe(false);
    expect(sight.regions.design).toHaveLength(1);
  });

  test('a transposed table sets no team apart, so its figures are no team\'s', async () => {
    const sight = await read(`<table><tr><th></th>${TEAMS.map((team) => `<th>${team}</th>`).join('')}</tr>
      <tr><td>Budget</td><td>1500</td><td>3000</td><td>2000</td></tr></table>`);

    expect(shown(sight, 'growth', [3000])).toBe(false);
  });

  test('what a person cannot see is not read: a closed select, a hidden note, a script', async () => {
    const sight = await read(`<select>${TEAMS.map((team) => `<option>${team}</option>`).join('')}</select>
      <div><span>design</span> <span style="display:none">9999.99</span> <span style="visibility:hidden">8888</span> 1500</div>
      <script>"design 7777"</script>`);

    expect(shown(sight, 'design', [1500])).toBe(true);
    expect(shows(sight.text, 9999.99) || shows(sight.text, 8888) || shows(sight.text, 7777)).toBe(false);
  });

  test('a part wider than the page is cut off, and a narrow page fits it', async () => {
    const wide = '<div style="width:1200px"><span>design</span> 1500</div><div><span>growth</span> 3000</div>';
    const narrow = await read(wide, 600);

    expect(narrow.regions.design?.[0]?.clipped).toBe(true);
    expect(narrow.regions.growth?.[0]?.clipped).toBe(false);
    expect((await read(wide, 1400)).regions.design?.[0]?.clipped).toBe(false);
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

  test('the button its label names, in the team\'s own part', async () => {
    expect(await pressed(ROWS.replace('<button>Cover</button>', '<button data-is="cover design">Cover</button>'), { name: 'design', label: '\\bcover\\b' })).toBe('cover design');
    expect(await pressed(ROWS, { name: 'growth', label: '\\bcover\\b' })).toBeNull();
  });

  test('a card that shows a pointer is a control, and a label is one with the field it wraps', async () => {
    const cards = TEAMS.map((team) => `<div data-is="card ${team}" style="cursor:pointer"><h3>${team}</h3><p>1500</p></div>`).join('');
    const radios = TEAMS.map((team) => `<label data-is="label ${team}"><input type="radio" name="team"> ${team}</label>`).join('');

    expect(await pressed(cards, { name: 'platform', label: null })).toBe('card platform');
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
