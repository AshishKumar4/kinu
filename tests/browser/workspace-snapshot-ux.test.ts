import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';


test('Files recovers current workspace data after a failed read and reconnect', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1920, height: 1100 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&workspaceFault=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-composer-root]');
    // The first open belongs to the initial connection.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.click('button[title="Agent"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Memory before'));
    await page.click('button[title="Files"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('before.txt'));
    await page.evaluate(() => { document.documentElement.dataset.workspaceFault = '1'; });
    await page.click('[aria-label="Refresh"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('Network connection lost'));
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.waitForFunction(() => document.body.textContent?.includes('Showing last known data'));
    expect(await page.$eval('[data-files-surface]', (el) => el.textContent)).toContain('before.txt');
    await page.evaluate(() => {
      document.documentElement.dataset.workspaceFault = '0';
      document.documentElement.dataset.workspaceRevision = 'current';
      window.dispatchEvent(new Event('gallery-reconnect'));
    });
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'));
    const recovered = await page.$eval('[data-files-surface]', (el) => el.textContent);
    expect(recovered).not.toContain('before.txt');
    expect(recovered).not.toContain('Network connection lost');
    await page.click('button[title="Agent"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Memory current'));
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Memory before');
    await page.close();
  });
});

// Review job 183: with the 5 s poll gone, a page opened onto a device command already waiting on its owner (after the
// away email) showed no ask card, and the command stayed blocked.
test('a page opened onto a waiting device consent shows its card with no frame', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=waiting`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-1"]');
    expect(await page.$eval('[data-device-bind="c-1"]', (card) => card.textContent)).toContain('git push origin main');
    await page.close();
  });
});

// A device command is shown as it would run: bidi and zero-width characters that could disguise it appear as marks,
// and the card offers one binding, to the machine, beside Not now.
test('a waiting device command shows its hidden characters as marks and offers one binding', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=spoofed`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-1"]');

    const card = await page.$eval('[data-device-bind="c-1"]', (element) => ({
      text: element.textContent ?? '',
      buttons: [...element.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
    }));

    expect(card.text).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
    expect(card.text).toContain('\uFFFD');
    // Two choices, and the one that binds names the device: no one-off grant.
    expect(card.buttons).toHaveLength(2);
    expect(card.buttons.filter((label) => label.includes('studio'))).toHaveLength(1);
    await page.close();
  });
});

// Review job 183: a `reads_changed` frame sent while the socket was down is never replayed, so a reconnect re-reads
// every live read once, the Work tab's own included.
test('a task written while the socket was down shows on the Work tab after the reconnect', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[aria-label="Work"]');
    // The stub's first open belongs to the initial connection.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.click('[aria-label="Work"]');
    // The fixture's plan opens in review; the task list is behind it.
    await page.waitForSelector('[data-back-to-work]');
    await page.click('[data-back-to-work]');
    await page.waitForFunction(() => document.querySelector('[data-back-to-work]') === null);
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Written during the outage');

    await page.evaluate(() => {
      document.documentElement.dataset.workMoved = '1';
      window.dispatchEvent(new Event('gallery-reconnect'));
    });

    await page.waitForFunction(() => document.body.textContent?.includes('Written during the outage') === true);
    await page.close();
  });
});

test('a delayed snapshot cannot overwrite any surface refreshed after it was admitted', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(origin + '/gallery.html?frame=snapshotrace', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('[data-snapshot-race-state]')?.textContent?.includes('initial snapshot'));
    await page.evaluate(() => { document.documentElement.dataset.snapshotRaceHold = '1'; });
    await page.click('[data-snapshot-race-retry]');
    await page.waitForFunction(() => document.documentElement.dataset.snapshotRaceWaiting === '1');
    await page.evaluate(() => { document.documentElement.dataset.snapshotRaceRevision = 'current'; });
    await page.click('[data-snapshot-race-refresh]');
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-snapshot-race-state]')?.textContent ?? '';

      return ['current memory', 'current-executor', 'current-plan', 'current-slate'].every((value) => text.includes(value));
    });
    await page.evaluate(() => {
      document.documentElement.dataset.snapshotRaceHold = '0';
      window.dispatchEvent(new Event('gallery:release-snapshot'));
    });
    // The identity field proves the old snapshot actually landed, not merely that the new
    // surface reads won before the held response came back.
    await page.waitForFunction(() => document.querySelector('[data-snapshot-race-state]')?.textContent?.includes('held snapshot'));
    const observed = await page.$eval('[data-snapshot-race-state]', (element) => JSON.parse(element.textContent ?? 'null'));
    expect(observed).toEqual({
      snapshot: 'held snapshot', memory: 'current memory', executors: ['current-executor'],
      plan: 'current-plan', presence: { work: true, explorations: false }, slates: ['current-slate'],
    });
    await page.close();
  });
});


/** The gallery socket's record of what the page did: forced redials, failures still scripted when it redialled, snapshot reads. */
function socketRecord(page: Page): Promise<{ redials: number; redialAt: number | null; snapshotReads: number; scripted: number }> {
  return page.evaluate(() => {
    const root = document.documentElement.dataset;

    return {
      redials: Number(root.galleryRedials ?? '0'),
      redialAt: root.galleryRedialAt === undefined ? null : Number(root.galleryRedialAt),
      snapshotReads: Number(root.gallerySnapshotReads ?? '0'),
      scripted: (root.galleryRpcFailures ?? '').split(',').filter(Boolean).length,
    };
  });
}

/**
 * A socket that still claims to be open but answers nothing is only noticed by its calls timing out. Three timeouts in
 * a row condemn it and the page redials once, then re-reads what it shows; a fast refusal in between is proof the
 * origin is alive and starts the count again.
 */
test('a socket open but answering nothing is redialled after three timeouts in a row, and the page re-reads', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1920, height: 1100 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&workspaceFault=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-composer-root]');
    await page.click('button[title="Files"]');
    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('before.txt'));

    // Two timeouts, a refusal, then three timeouts: only the last three are in a row.
    await page.evaluate(() => {
      document.documentElement.dataset.workspaceRevision = 'current';
      document.documentElement.dataset.galleryRpcFailures = 'timeout,timeout,fast,timeout,timeout,timeout';
    });

    for (let presses = 0; (await socketRecord(page)).scripted > 0; presses += 1) {
      if (presses > 12) throw new Error(`Refresh drained no scripted failure: ${JSON.stringify(await socketRecord(page))}`);
      const before = (await socketRecord(page)).scripted;

      await page.click('[aria-label="Refresh"]');
      await page.waitForFunction((was) => (document.documentElement.dataset.galleryRpcFailures ?? '').split(',').filter(Boolean).length < was, {}, before);
    }

    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'));
    const record = await socketRecord(page);

    // One redial, made on the last timeout and not before.
    expect({ redials: record.redials, redialAt: record.redialAt }).toEqual({ redials: 1, redialAt: 0 });
    await page.close();
  });
});

/** Presses the button showing `words` inside `within`. */
async function pressButtonIn(page: Page, within: string, words: string): Promise<void> {
  await page.$$eval(`${within} button`, (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.trim() === label);

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} on the page`);
    button.click();
  }, words);
}

const pressButton = (page: Page, words: string): Promise<void> => pressButtonIn(page, 'body', words);

/** Retry re-reads; on a socket the SDK has given up on, it redials first. */
test('Retry re-reads the workspace, and redials first only when the socket was closed for good', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.goto(`${origin}/gallery.html?frame=workspacepage&snapshot=failed`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.textContent?.includes('Could not open this workspace'));
    const failed = await socketRecord(page);

    await pressButton(page, 'Retry');
    await page.waitForFunction((was) => Number(document.documentElement.dataset.gallerySnapshotReads ?? '0') > was, {}, failed.snapshotReads);
    expect((await socketRecord(page)).redials).toBe(0);

    await page.goto(`${origin}/gallery.html?frame=workspacepage&terminal=denied`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.textContent?.includes('Access to this workspace was denied'));
    const denied = await socketRecord(page);

    await pressButton(page, 'Try again');
    await page.waitForFunction((was) => Number(document.documentElement.dataset.gallerySnapshotReads ?? '0') > was, {}, denied.snapshotReads);
    expect((await socketRecord(page)).redials).toBe(1);
    await page.close();
  });
});

/** Settles the held resolution of consent `id`, failing it with `failed` when given. */
async function settleConsent(page: Page, id: string, failed?: string): Promise<void> {
  await page.evaluate((detail) => { window.dispatchEvent(new CustomEvent('gallery:consent-settle', { detail })); }, { id, ...(failed !== undefined && { failed }) });
}

/** The consent cards on the page, by id. */
function consentCards(page: Page): Promise<(string | null)[]> {
  return page.$$eval('[data-device-bind]', (cards) => cards.map((card) => card.getAttribute('data-device-bind')));
}

/**
 * Two device commands waiting at once are decided apart: one refused by the device hub keeps its card and says why,
 * the other's card goes, a re-read of the waiting list keeps the reason standing, and deciding the first again clears it.
 */
test('two waiting device commands are decided independently, and a refused decision keeps its card and its reason', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=two`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-2"]');
    expect(await consentCards(page)).toEqual(['c-1', 'c-2']);

    await pressButtonIn(page, '[data-device-bind="c-1"]', 'Use studio');
    await pressButtonIn(page, '[data-device-bind="c-2"]', 'Not now');
    await settleConsent(page, 'c-1', 'device hub unavailable');
    await page.waitForFunction(() => document.body.textContent?.includes('device hub unavailable'));
    await settleConsent(page, 'c-2');
    await page.waitForFunction(() => document.querySelector('[data-device-bind="c-2"]') === null);
    expect(await consentCards(page)).toEqual(['c-1']);

    // The waiting list is read again: the refused command is still waiting, and still says why.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.waitForFunction(() => document.querySelector('[data-device-bind="c-1"]') !== null);
    expect(await consentCards(page)).toEqual(['c-1']);
    expect(await page.evaluate(() => document.body.textContent?.includes('device hub unavailable'))).toBe(true);

    await pressButtonIn(page, '[data-device-bind="c-1"]', 'Use studio');
    await settleConsent(page, 'c-1');
    await page.waitForFunction(() => document.querySelector('[data-device-bind]') === null);
    expect(await page.evaluate(() => document.body.textContent?.includes('device hub unavailable'))).toBe(false);
    await page.close();
  });
});

/** Three frames drawn: long enough for an answered read's promise chain to reach the screen. */
async function framesDrawn(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((drawn) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => { drawn(); })));
  }));
}

const jobReads = (page: Page): Promise<number> => page.evaluate(() => Number(document.documentElement.dataset.galleryJobReads ?? '0'));

/** Answers the jobs read numbered `at` with one running job, or fails it. */
async function answerJobs(page: Page, at: number, answer: { label?: string; failed?: string }): Promise<void> {
  await page.evaluate((detail) => { window.dispatchEvent(new CustomEvent('gallery:jobs-answer', { detail })); }, { at, ...answer });
}

/** Has the server say the jobs moved, and returns the number of the read that starts. */
async function jobsMoved(page: Page): Promise<number> {
  const at = await jobReads(page);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: { type: 'reads_changed', reads: ['listBackgroundJobs'] } })));
  await page.waitForFunction((was) => Number(document.documentElement.dataset.galleryJobReads ?? '0') > was, {}, at);

  return at;
}

const pageSays = (page: Page, words: string): Promise<boolean> => page.evaluate((said) => document.body.textContent?.includes(said) === true, words);

/** Two reads of the same list in flight: whichever was asked later decides what shows, whatever order they answer in. */
test('a late answer to an older read never replaces a newer one, nor reports its failure over it', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&jobs=held`, { waitUntil: 'networkidle0' });
    await openWorkList(page);
    await page.waitForFunction(() => document.body.textContent?.includes('first build'));
    await page.evaluate(() => { document.documentElement.dataset.galleryJobsHold = '1'; });

    const older = await jobsMoved(page);
    const newer = await jobsMoved(page);

    await answerJobs(page, newer, { label: 'newer build' });
    await page.waitForFunction(() => document.body.textContent?.includes('newer build'));
    await answerJobs(page, older, { label: 'older build' });
    await framesDrawn(page);
    expect([await pageSays(page, 'newer build'), await pageSays(page, 'older build')]).toEqual([true, false]);

    const olderAgain = await jobsMoved(page);
    const latest = await jobsMoved(page);

    await answerJobs(page, latest, { label: 'latest build' });
    await page.waitForFunction(() => document.body.textContent?.includes('latest build'));
    await answerJobs(page, olderAgain, { failed: 'older request failed' });
    await framesDrawn(page);
    expect([await pageSays(page, 'latest build'), await pageSays(page, 'older request failed')]).toEqual([true, false]);
    await page.close();
  });
});

/** Opens the Work tab's own list, past the plan the gallery workspace has waiting for review. */
async function openWorkList(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Work"]');
  await page.click('[aria-label="Work"]');
  await page.waitForFunction(() => document.querySelector('[data-back-to-work]') !== null || document.querySelector('[data-work-plans]') !== null);

  if (await page.$('[data-back-to-work]') !== null) await page.click('[data-back-to-work]');
}

/** A read the workspace left behind answers after the reader moved on: the next workspace never shows it. */
test('a read answered after its workspace was left never shows in the next one', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&jobs=held`, { waitUntil: 'networkidle0' });
    await openWorkList(page);
    await page.waitForFunction(() => document.body.textContent?.includes('first build'));
    await page.evaluate(() => { document.documentElement.dataset.galleryJobsHold = '1'; });

    const left = await jobsMoved(page);
    const reads = await jobReads(page);

    await page.evaluate(async () => { await window.galleryNavigate?.('/workspace/billing-cleanup'); });
    await page.waitForFunction((was) => Number(document.documentElement.dataset.galleryJobReads ?? '0') > was, {}, reads);
    const arrived = reads;

    await answerJobs(page, arrived, { label: 'next workspace build' });
    await openWorkList(page);
    await page.waitForFunction(() => document.body.textContent?.includes('next workspace build'));

    await answerJobs(page, left, { label: 'left workspace build' });
    await framesDrawn(page);
    expect([await pageSays(page, 'next workspace build'), await pageSays(page, 'left workspace build')]).toEqual([true, false]);
    await page.close();
  });
});
