import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

/** What the Agent tab's memory section shows: its retry, the workspace's memory, an empty state, or nothing yet. */
function memoryShows(page: Page): Promise<string> {
  return page.$eval('[data-section="memory"]', (section) => {
    if (section.querySelector('[data-failure]') !== null) return 'failed';

    if (section.querySelector('[data-empty]') !== null) return 'empty';

    return /Memory \w+/u.exec(section.textContent ?? '')?.[0] ?? 'nothing yet';
  });
}

async function openAgentTab(page: Page): Promise<void> {
  await page.waitForSelector('[data-composer-root]');

  // With nothing loaded the inspector starts shut; its tabs take clicks once it has opened.
  if (await page.$('button[aria-label="Show inspector"]') !== null) {
    await page.click('button[aria-label="Show inspector"]');
    await page.waitForSelector('button[aria-label="Hide inspector"]');
  }

  await page.click('button[title="Agent"]');
  await page.waitForSelector('[data-section="memory"]');
}


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


/** The gallery socket's record of what the page did: forced redials, calls failed, snapshot reads. */
function socketRecord(page: Page): Promise<{ redials: number; failedCalls: number; snapshotReads: number }> {
  return page.evaluate(() => {
    const root = document.documentElement.dataset;

    return {
      redials: Number(root.galleryRedials ?? '0'),
      failedCalls: Number(root.galleryFailedCalls ?? '0'),
      snapshotReads: Number(root.gallerySnapshotReads ?? '0'),
    };
  });
}

/** The workspace page on its Files tab, its listing read, with its socket in `socket` from then on. */
async function filesOnSocket(page: Page, origin: string, socket: 'dead' | 'refusing'): Promise<void> {
  await page.setViewport({ width: 1920, height: 1100 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage&workspaceFault=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-composer-root]');
  // The stub's first open belongs to the initial connection, so a later one is the page's reconnect.
  await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
  await page.click('button[title="Files"]');
  await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('before.txt'));
  await page.evaluate((mode) => {
    document.documentElement.dataset.workspaceRevision = 'current';
    document.documentElement.dataset.gallerySocket = mode;
  }, socket);
}

/** Presses Files' Refresh and waits until its reads failed or the page redialled. */
async function refreshFailing(page: Page): Promise<void> {
  const before = await socketRecord(page);

  await page.click('[aria-label="Refresh"]');
  await page.waitForFunction((was) => {
    const root = document.documentElement.dataset;

    return Number(root.galleryFailedCalls ?? '0') > was.failedCalls || Number(root.galleryRedials ?? '0') > was.redials;
  }, {}, before);
}

/**
 * A socket that still claims to be open but answers nothing is only noticed by its calls timing out: a run of
 * timeouts condemns it, the page redials once, and the fresh socket's re-read shows the workspace as it is now.
 */
test('a socket open but answering nothing is redialled once, and the page re-reads', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await filesOnSocket(page, origin, 'dead');

    for (let presses = 0; (await socketRecord(page)).redials === 0; presses += 1) {
      if (presses > 6) throw new Error(`no redial after ${String(presses)} refreshes: ${JSON.stringify(await socketRecord(page))}`);
      await refreshFailing(page);
    }

    await page.waitForFunction(() => document.querySelector('[data-files-surface]')?.textContent?.includes('current.txt'));
    expect((await socketRecord(page)).redials).toBe(1);
    await page.close();
  });
});

/** Calls refused at once prove the origin is there: however many fail, the page keeps its socket. */
test('calls the origin refuses at once never condemn the socket', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await filesOnSocket(page, origin, 'refusing');

    for (let presses = 0; presses < 4; presses += 1) await refreshFailing(page);
    const record = await socketRecord(page);

    expect(record.failedCalls).toBeGreaterThanOrEqual(4);
    expect(record.redials).toBe(0);
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

/** The attention stack's cards, the open one first, then those waiting behind it, nearest first. */
function stacked(page: Page): Promise<(string | null)[]> {
  return page.$$eval('[data-attention-card], [data-attention-behind]', (cards) => {
    const open = cards.filter((card) => card.hasAttribute('data-attention-card')).map((card) => card.getAttribute('data-attention-card'));
    const behind = cards.filter((card) => card.hasAttribute('data-attention-behind')).map((card) => card.getAttribute('data-attention-behind')).reverse();

    return [...open, ...behind];
  });
}

/**
 * Two device commands waiting at once are one stack, the newer open: answering it opens the other, an answer the
 * device hub refuses keeps that card open and says why, a re-read of the waiting list keeps the reason standing, and
 * answering again clears both.
 */
test('two waiting device commands are a stack: answering the top opens the next, and a refused answer keeps its card and its reason', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&consent=two`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-device-bind="c-2"]');
    // The stub's first open belongs to the initial connection, so a later one is the page's reconnect.
    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    expect(await stacked(page)).toEqual(['consent:c-2', 'consent:c-1']);

    await pressButtonIn(page, '[data-device-bind="c-2"]', 'Not now');
    await settleConsent(page, 'c-2');
    await page.waitForSelector('[data-device-bind="c-1"]');
    expect(await stacked(page)).toEqual(['consent:c-1']);

    await pressButtonIn(page, '[data-device-bind="c-1"]', 'Use studio');
    await settleConsent(page, 'c-1', 'device hub unavailable');
    await page.waitForFunction(() => document.body.textContent?.includes('device hub unavailable'));
    expect(await stacked(page)).toEqual(['consent:c-1']);

    // The waiting list is read again: the refused command is still waiting, and still says why.
    const reads = await page.evaluate(() => Number(document.documentElement.dataset.galleryConsentReads ?? '0'));

    await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
    await page.waitForFunction((was) => Number(document.documentElement.dataset.galleryConsentReads ?? '0') > was, {}, reads);
    await page.waitForFunction(() => document.querySelector('[data-device-bind="c-1"]') !== null);
    expect(await stacked(page)).toEqual(['consent:c-1']);
    expect(await page.evaluate(() => document.body.textContent?.includes('device hub unavailable'))).toBe(true);

    await pressButtonIn(page, '[data-device-bind="c-1"]', 'Use studio');
    await settleConsent(page, 'c-1');
    await page.waitForFunction(() => document.querySelector('[data-attention-stack]') === null);
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

/** Loads the workspace page, then makes `revision` what its reads answer from the next reconnect on. */
async function workspaceAt(page: Page, origin: string, revision: string): Promise<void> {
  await page.goto(`${origin}/gallery.html?frame=workspacepage&workspaceFault=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-composer-root]');
  // The stub's first open belongs to the initial connection, so only a later one re-reads.
  await page.evaluate(() => window.dispatchEvent(new Event('gallery-reconnect')));
  await page.evaluate((loaded) => {
    document.documentElement.dataset.workspaceRevision = loaded;
    window.dispatchEvent(new Event('gallery-reconnect'));
  }, revision);
}

/**
 * The Agent tab's memory claims only what a read said: nothing while the snapshot is out, a retry once it failed with
 * nothing loaded (the reason stays the banner's), the empty state for a workspace that loaded holding nothing, and the
 * last memory, or the last emptiness, while a dropped connection leaves the snapshot stale.
 */
test('memory shows what the last read said, through loading, failure, a stale snapshot and an empty one', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1920, height: 1100 });

    await page.goto(`${origin}/gallery.html?frame=workspacepage&snapshot=held`, { waitUntil: 'networkidle0' });
    await openAgentTab(page);
    expect(await memoryShows(page)).toBe('nothing yet');
    await page.evaluate(() => { document.documentElement.dataset.snapshotReleased = '1'; });
    await page.waitForFunction(() => document.querySelector('[data-section="memory"] [data-empty]') !== null);

    await page.goto(`${origin}/gallery.html?frame=workspacepage&snapshot=failed`, { waitUntil: 'networkidle0' });
    await openAgentTab(page);
    await page.waitForFunction(() => document.querySelector('[data-section="memory"] [data-failure]') !== null);
    // The pane offers its retry without repeating the reason the banner gives.
    expect(await page.$eval('[data-section="memory"]', (section) => section.textContent ?? '')).not.toContain('Network connection lost');

    // Loaded, then every read fails: the memory on screen stays, and so does an empty one.
    for (const [revision, loaded] of [['before', 'Memory before'], ['empty', 'empty']] as const) {
      await workspaceAt(page, origin, revision);
      await openAgentTab(page);
      await page.waitForFunction((want) => {
        const section = document.querySelector('[data-section="memory"]');

        return want === 'empty' ? section?.querySelector('[data-empty]') !== null : section?.textContent?.includes(want) === true;
      }, {}, loaded);

      await page.evaluate(() => {
        document.documentElement.dataset.workspaceFault = '1';
        window.dispatchEvent(new Event('gallery-reconnect'));
      });
      await page.waitForFunction(() => document.body.textContent?.includes('Showing last known data'));
      expect(await memoryShows(page)).toBe(loaded);
    }

    await page.close();
  });
});
