/**
 * The workspace's files and environments, as a browser lays them out. The gate is a browser, so its test is a browser.
 *
 * Two defects the owner hit are invisible to `tsc`, `oxlint` and every
 * source-reading test in this repo:
 *
 *   - "Go to the parent directory" landed on the filesystem root instead of the
 *     directory above, because every environment reported its working directory
 *     as the literal `'.'` and the pane did string arithmetic on it.
 *   - The capability row was raw snake_case ids with no reading and no
 *     absences, so it could not answer the question it existed for.
 *
 * Every assertion below is a measurement of the real components in a real
 * cascade. Cut either wire and its test fails while the rest of the repo stays
 * green — which is precisely what did not happen before.
 *
 * One server, one browser, one pass: booting vite costs several seconds and
 * every assertion here reads from the same frames.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';
import { NEW_SESSION, OPEN_MENU, pressInDialog, pressRowMenu, ROW_MENU } from '../../scripts/browser-page';
import { executorLabel, FILES_PAGE_ENTRIES } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

interface ObservedFiles {
  /** The drive at its root: crumb text, row names, and the origin badges the
   *  mounted folders wear. */
  readonly filesRoot: { crumbs: string; entries: string[]; badges: string[] };
  /** The drive after crossing into the /pc mount, which must land inside the
   *  device's consented directory rather than on the device root. */
  readonly filesRoster: { crumbs: string; entries: string[] };
  readonly filesInMount: { crumbs: string; entries: string[] };
  readonly filesAfterUp: string;
  /** File names the TREE pane carries, not only its folders. */
  readonly treeFileNames: string[];
  /** Markdown opens rendered, through the app's one markdown renderer. */
  readonly filesMarkdownRendered: { heading: string; showsSource: boolean };
  /** The source the Source toggle shows for a workspace file. */
  readonly filesPreviewText: string;
  /** The edit buffer a whole file opens with. */
  readonly filesEditorSeedsFromTheFile: string;
  /** /home/main rows after renaming SOUL.md → CREDO.md, then after deleting
   *  AGENTS.md — both against the frame's stateful fixture. */
  readonly filesAfterRename: string[];
  readonly filesAfterDelete: string[];
  /** Rows visible while the filter says "credo". */
  readonly filesFiltered: string[];
  /** The stated-absence row a disconnected device leaves on the drive. */
  readonly filesOfflineRow: { text: string; reason: string; connects: boolean };
  /** Each environment's name as its chip says it, and its files' root as its head says it once chosen. */
  readonly envNames: Record<string, string>;
  readonly envMounts: Record<string, string>;
  readonly envFilesJumpLandsOnDrive: boolean;
  /** Every `input` frame the pane sent the workspace shell, in order. */
  readonly terminalInput: string[];
}

/**
 * Paste into the terminal the way a browser does: a `paste` event on xterm's
 * own textarea. xterm turns the newlines into CR before the pane ever sees
 * them, so typing the text key by key would exercise a different path from the
 * one that dropped every line after the first.
 */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  await page.evaluate((pasted) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');

    if (textarea === null) throw new Error('the terminal has no input to paste into');
    textarea.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', pasted);
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

/**
 * Wait for the terminal to have painted `text`: the fixture shell's echo of
 * the line it received, which is the one signal that the pane delivered the
 * input. A pane that drops a pasted line never paints its echo, and there is
 * no other event that says so — that wait ends with the browser at the
 * gallery's teardown, or with the gate at the ladder's deadline, and either
 * names this suite rather than a duration.
 */
async function terminalSettled(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (painted: string) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(painted),
    {},
    text,
  );
}

async function runFiles(): Promise<ObservedFiles> {
  return withGallery(async ({ newPage, origin }) => {
    const files = await newPage();
    await files.setViewport({ width: 1280, height: 1100 });
    await files.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
    // A first load can trip vite's dependency optimizer, which answers with a
    // full page reload and destroys the execution context of anything waiting.
    // The second load has the deps already, so every wait below is on a page
    // that will not vanish under it.
    await files.reload({ waitUntil: 'networkidle0' });

    const crumbs = () => files.$$eval(
      '[data-files-crumb]',
      (bs) => bs.map((b) => b.textContent ?? '').join('/'),
    );

    const rowNames = () => files.$$eval(
      '[data-files-entry]',
      (rows) => rows.map((r) => r.getAttribute('title') ?? ''),
    );

    const rowSelector = (name: string) => `[data-files-entry][title="${name}"]`;
    const waitForRow = (name: string) => files.waitForSelector(rowSelector(name));

    const waitForRowGone = (name: string) => files.waitForFunction(
      (sel: string) => document.querySelector(sel) === null,
      {}, rowSelector(name),
    );

    // The drive opens at the plane's root: the workspace tree beside the
    // mounted folders, each mount wearing its origin badge.
    await waitForRow('computer');

    const filesRoot = {
      crumbs: await crumbs(),
      entries: await rowNames(),
      badges: await files.$$eval('[data-files-entry] [data-mount-badge]', (els) => els.map((el) => el.textContent ?? '')),
    };

    // Crossing into `/pc` is ordinary navigation onto the roster: one row per
    // live machine. Crossing into a machine lands INSIDE its consented
    // directory. Landing on the machine root itself was the reported failure:
    // it strips to the device's `/`, which its consent boundary refuses, so
    // the first click answered EACCES.
    await files.click(rowSelector('pc'));
    await waitForRow("Ashish's MacBook");
    const filesRoster = { crumbs: await crumbs(), entries: await rowNames() };
    await files.click(rowSelector("Ashish's MacBook"));
    await waitForRow('quarterly-report.txt');
    await files.waitForFunction(
      () => document.querySelectorAll('[data-files-crumb]').length === 5,
    );
    const filesInMount = { crumbs: await crumbs(), entries: await rowNames() };

    // Back to the drive root through the crumb bar, then into the workspace's
    // own tree for the parent row, preview, rename and delete.
    await files.click('[data-files-crumb]');
    await waitForRow('computer');
    await files.click(rowSelector('home'));
    await waitForRow('main');
    await files.click(rowSelector('main'));
    await waitForRow('notes.md');

    // The parent row goes UP ONE LEVEL — to /home, never straight to the root.
    await files.waitForSelector('[data-files-up-row]');
    await files.click('[data-files-up-row]');
    await waitForRow('main');
    const filesAfterUp = await crumbs();

    // The tree carries FILES, not only folders — a recursion that drops file
    // entries leaves the sidebar unable to reach one. Each level is expanded
    // through its own caret.
    await files.click(rowSelector('main'));
    await waitForRow('notes.md');
    await files.click('[data-files-tree-node="/home"] button');
    await files.waitForSelector('[data-files-tree-node="/home/main"]');
    await files.click('[data-files-tree-node="/home/main"] button');
    await files.waitForSelector('[data-files-tree-file]');

    const treeFileNames = await files.$$eval(
      '[data-files-tree-file]', (els) => els.map((el) => el.getAttribute('title') ?? ''),
    );

    // Markdown opens RENDERED through the app's one markdown renderer, and the
    // Source toggle shows the bytes it was rendered from.
    await files.click(rowSelector('notes.md'));
    await files.waitForSelector('[data-files-preview-body] h1');

    const filesMarkdownRendered = await files.$eval('[data-files-preview-body]', (el) => ({
      heading: el.querySelector('h1')?.textContent ?? '',
      showsSource: el.querySelector('pre') !== null,
    }));

    await files.click('[data-files-render-toggle]');
    await files.waitForSelector('[data-files-preview-body] pre');
    const filesPreviewText = await files.$eval('[data-files-preview-body] pre', (el) => el.textContent ?? '');

    // A whole file can be edited in place; a truncated read cannot, because
    // writing that prefix back would delete the rest of the file.
    await files.waitForSelector('[data-files-edit]');
    await files.click('[data-files-edit]');
    await files.waitForSelector('[data-files-editor]');

    const filesEditorSeedsFromTheFile = await files.$eval(
      '[data-files-editor]', (el) => el instanceof HTMLTextAreaElement ? el.value : '',
    );

    await files.click('[aria-label="Close preview"]');
    await files.waitForFunction(
      () => document.querySelector('[data-files-preview]') === null,
    );

    // Rename rides the real RPC against the frame's stateful fixture, from the row's menu.
    await pressRowMenu(files, rowSelector('SOUL.md'), '[data-files-rename]');
    await files.waitForSelector('[data-files-rename-input]');
    const renameInput = present(await files.$('[data-files-rename-input]'), 'the rename input');

    await renameInput.evaluate((el) => { if (el instanceof HTMLInputElement) el.value = ''; });
    await renameInput.type('CREDO.md');
    await renameInput.press('Enter');
    await waitForRow('CREDO.md');
    const filesAfterRename = await rowNames();

    // Delete asks inline, then the row is gone.
    await pressRowMenu(files, rowSelector('AGENTS.md'), '[data-files-delete]');
    await files.click(`${rowSelector('AGENTS.md')} [data-files-delete-confirm]`);
    await waitForRowGone('AGENTS.md');
    const filesAfterDelete = await rowNames();

    // The search box is a filter over the folder in view.
    await files.type('[data-files-filter]', 'credo');
    await waitForRowGone('notes.md');
    const filesFiltered = await rowNames();
    await files.close();

    // A disconnected device is a stated absence, not a missing row.
    const offline = await newPage();
    await offline.setViewport({ width: 1280, height: 1100 });
    await offline.goto(`${origin}/gallery.html?frame=files&offline=device`, { waitUntil: 'networkidle0' });
    await offline.reload({ waitUntil: 'networkidle0' });
    await offline.waitForSelector('[data-files-offline-mount]');

    const filesOfflineRow = await offline.$eval('[data-files-offline-mount]', (el) => ({
      text: el.textContent ?? '', reason: el.getAttribute('title') ?? '', connects: el.querySelector('[data-files-connect]') !== null,
    }));

    await offline.close();

    // The Environment tab: each environment by its name, no capability
    // doctrine, and a Files action that lands the drive.
    const env = await newPage();
    await env.setViewport({ width: 1280, height: 1100 });
    await env.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
    await env.reload({ waitUntil: 'networkidle0' });
    await env.waitForSelector('[data-env-card]');

    const envNames = Object.fromEntries(await env.$$eval('[data-env-card]', (cards) => cards.map((card) => [
      card.getAttribute('data-env-card') ?? '', (card.querySelector('button')?.textContent ?? '').trim(),
    ])));

    // The workspace shell: the pane sends what is typed as `input` frames over
    // the terminal socket. Two commands: one typed, one pasted with a newline in
    // it. What is read back is the frames the pane sent, because a paste that
    // reaches the shell as one frame cannot lose its second line; what the shell
    // prints is the fixture's own echo and proves nothing about the pane.
    await env.waitForSelector('.xterm-rows');
    await terminalSettled(env, '$ ');
    await env.click('.xterm-screen');
    await env.keyboard.type('one');
    await env.keyboard.press('Enter');
    await terminalSettled(env, 'ran: one');
    await pasteIntoTerminal(env, 'two\nthree\n');
    await terminalSettled(env, 'ran: three');

    const terminalInput = await env.evaluate(() => window.__kinuTerminalInput ?? []);

    // Each environment, chosen, names its files' root.
    const envMounts: Record<string, string> = {};

    for (const name of Object.keys(envNames)) {
      await env.click(`[data-env-card="${name}"] button`);
      await env.waitForSelector(`[data-env-card="${name}"] [aria-pressed="true"]`);
      envMounts[name] = await env.$eval('[data-env-mount]', (mount) => mount.textContent ?? '');
    }

    // The jump switches the surface at once (`openFiles` navigates focus); the
    // Files surface's chunk loads with its first view, so the drive is awaited.
    await env.click('[data-env-card="workspace"] button');
    await env.click('[data-env-files]');
    const envFilesJumpLandsOnDrive = await env.waitForSelector('[data-files-surface]') !== null;

    await env.close();

    return {
      filesRoot, filesRoster, filesInMount, filesAfterUp, treeFileNames,
      filesMarkdownRendered, filesPreviewText, filesEditorSeedsFromTheFile,
      filesAfterRename, filesAfterDelete, filesFiltered, filesOfflineRow,
      envNames, envMounts, envFilesJumpLandsOnDrive,
      terminalInput,
    };
  });
}

let observed: ObservedFiles;

beforeAll(async () => { observed = await runFiles(); });

describe('the drive, browsing the one composite plane', () => {
  test('the root is the workspace tree beside the mounts, badges on the mounted folders', () => {
    expect(observed.filesRoot.crumbs).toBe('/');
    expect(observed.filesRoot.entries).toEqual(expect.arrayContaining(['home', 'pc', 'computer']));
    // The origin badge names the machine, not the executor id: the device wears the user's own device name, per the
    // consent naming contract. The agent's computer has none, as its product label only repeats the folder's name.
    expect(executorLabel('computer').toLowerCase()).toBe('computer');
    expect(observed.filesRoot.badges).toEqual(["Ashish's MacBook"]);
  });

  test('crossing into /pc lists the machines; a machine lands inside its consented directory', () => {
    // `/pc` is the roster. A machine root strips to the DEVICE's `/`, which its
    // consent boundary refuses with EACCES, so the machine lands on the
    // directory the owner consented to instead.
    expect(observed.filesRoster.crumbs).toBe('//pc');
    expect(observed.filesRoster.entries).toEqual(["Ashish's MacBook"]);
    expect(observed.filesInMount.crumbs).toBe("//pc/Ashish's MacBook/home/dev");
    expect(observed.filesInMount.entries).toEqual(
      expect.arrayContaining(['quarterly-report.txt', 'shot.png']),
    );
  });

  test('the parent row goes UP ONE LEVEL, not straight to the root', () => {
    expect(observed.filesAfterUp).toBe('//home');
  });

  test('the tree carries files, not only folders', () => {
    expect(observed.treeFileNames).toEqual(expect.arrayContaining(['notes.md', 'AGENTS.md']));
  });

  test('Markdown opens rendered, and the Source toggle shows what it rendered', () => {
    expect(observed.filesMarkdownRendered.heading).toBe('Sessions binding regression');
    expect(observed.filesMarkdownRendered.showsSource).toBe(false);
    expect(observed.filesPreviewText).toContain('Sessions binding regression');
  });

  test('a whole file opens in an editor seeded from its own bytes', () => {
    expect(observed.filesEditorSeedsFromTheFile).toContain('Sessions binding regression');
  });

  test('rename and delete land on the plane and the listing says so', () => {
    expect(observed.filesAfterRename).toContain('CREDO.md');
    expect(observed.filesAfterRename).not.toContain('SOUL.md');
    expect(observed.filesAfterDelete).not.toContain('AGENTS.md');
  });

  test('the search box filters the folder in view', () => {
    expect(observed.filesFiltered).toEqual(['CREDO.md']);
  });

  test('a disconnected device is a stated absence with its reason, not a missing row', () => {
    expect(observed.filesOfflineRow.text).toContain('pc');
    expect(observed.filesOfflineRow.reason).toBe('no device connected');
    expect(observed.filesOfflineRow.connects).toBe(true);
  });
});

describe('the Environment tab, as a user reads it', () => {
  test('each environment is listed by its name, the device by its own, and names its files root once chosen', () => {
    expect(observed.envNames).toEqual({ workspace: 'Workspace', device: "Ashish's MacBook", computer: executorLabel('computer') });
    expect(observed.envMounts).toEqual({ workspace: '/', device: '/pc', computer: '/computer' });
  });

  test("an environment's Files action lands the drive", () => {
    expect(observed.envFilesJumpLandsOnDrive).toBe(true);
  });

  // A pasted `echo first-line\necho second-line\n` once ran the first line and dropped the second.
  test('a pasted two-line command reaches the shell as one frame', () => {
    // One frame carries the whole paste, its newlines as the CR the shell
    // runs at; the pane never re-submits the second line as its own keys.
    expect(observed.terminalInput).toContain('two\rthree\r');
  });
});

/**
 * KINU-060. The real FilesSurface opens a preview whose FIRST RPC is held by
 * the fixture transport. A fixture mutation changes the listing's revision;
 * actual Refresh causes FileViewer/useAsyncResource to start its new request,
 * then the old request resolves. The current preview must stay current.
 */
describe('file preview request generation at the actual FilesSurface boundary', () => {
  test('a stale preview response cannot reclaim a refreshed file', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=files&wide=1&deferpreview=1`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      const row = (name: string) => `[data-files-entry][title="${name}"]`;
      await page.waitForSelector(row('home'));
      await page.click(row('home'));
      await page.waitForSelector(row('main'));
      await page.click(row('main'));
      await page.waitForSelector(row('notes.md'));
      await page.click(row('notes.md'));
      await page.waitForSelector('[data-files-preview-body] [class*="Loader"], [data-files-preview-body]');
      await page.click('[data-files-fixture-mutate]');
      await page.click('[aria-label="Refresh"]');
      await page.waitForFunction(
        () => document.querySelector('[data-files-preview-body]')?.textContent?.includes('Fresh after refresh') === true,
      );
      await page.click('[data-files-fixture-release]');
      // The held first reply was the old content. Once it settles it must
      // not overwrite the fresh resource identity selected by the listing.
      const preview = await page.$eval('[data-files-preview-body]', (body) => body.textContent ?? '');
      expect(preview).toContain('Fresh after refresh');
      expect(preview).not.toContain('Sessions binding regression');
      await page.close();
    });
  });
});

/**
 * N021. This drives the real DevicesCard revoke response, durable-list refresh
 * and acknowledgement endpoint. Reload is the non-vacuity arm: the immediate
 * count is process-local, while the warning itself must return from listDevices
 * until the explicit DELETE succeeds.
 *
 * `&section=devices` is the deep link every work surface has always carried,
 * `/user/settings#devices`, and the reload arm re-enters through it — so this
 * also proves the deep link keeps working now that the hash picks a section
 * rather than scrolling to one.
 */
describe('a revoked device whose command may still run', () => {
  test('shows the count immediately, survives reload without reconnect controls, and disappears only after acknowledgement', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=devices`, { waitUntil: 'networkidle0' });
      // The rail renders once the account reads settle, which lands after the
      // network goes quiet — the reads resolve through the page fixture, not
      // the wire — so the deep-link section is waited for, never read on arrival.
      await page.waitForSelector('[data-settings-section="devices"]');
      expect(await page.$eval(
        '[data-settings-section="devices"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      // Revoke is in the row's menu, beside Rename.
      await page.waitForSelector(`[data-device="dev-1"] ${ROW_MENU}`);
      // The menu is a popup that opens on the press, so its item is there once it has.
      await pressRowMenu(page, '[data-device="dev-1"]', '[role="menuitem"][title="Revoke device"]');
      await page.waitForSelector('[role="dialog"]');
      await pressInDialog(page, 'Revoke');
      await page.waitForSelector('[data-device-incident="dev-1"]');

      const immediate = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 3d50a51a3: the warning reads "Kinu could not confirm that every
      // command stopped after revocation."
      expect(immediate).toContain('Kinu could not confirm that every command stopped after revocation.');
      expect(immediate).toContain('2 commands have no confirmed termination and may still run.');
      expect(await page.$('[data-device-incident="dev-1"] [title="Rename this device"]')).toBeNull();
      expect(await page.$('[data-device-incident="dev-1"] [title="Revoke device"]')).toBeNull();

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-device-incident="dev-1"]');
      const persisted = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 3d50a51a3: same rewrite as the immediate arm.
      expect(persisted).toContain('Kinu could not confirm that every command stopped after revocation.');
      expect(persisted).toContain('Commands may still run.');

      await page.click('[data-device-incident="dev-1"] button');
      await page.waitForFunction(
        () => document.querySelector('[data-device-incident="dev-1"]') === null,
      );
      await page.close();
    });
  });
});

/**
 * Connecting a machine from the surface that asked for it.
 *
 * The report: "when I want to connect my desktop from my Workspace → Env →
 * connect, it takes me to the settings page instead of a modal or something."
 * Both affordances were `<Link to="/user/settings#devices">`, and a link is
 * invisible to every source-reading test in this repo — the component compiled,
 * type-checked and navigated away.
 *
 * So the assertion is where the panel LANDS: the workspace surface is still
 * behind it, the dialog is over it, and the surface is still there when the
 * dialog closes itself. The command is read back off the page and compared to
 * the string the server fixture handed over, because a client that rebuilt it
 * from `location.origin` would render something that looks right.
 */
// A folder of any size is sent a page at a time: the owner's 56,762-entry /tmp, sent whole, reset the workspace.
describe('a large folder in Files', () => {
  test('lists its first page, and Load more the rest', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });

      for (const folder of ['home', 'main', 'logs']) {
        await page.waitForSelector(`[data-files-entry][title="${folder}"]`);
        await page.click(`[data-files-entry][title="${folder}"]`);
      }

      await page.waitForSelector('[data-files-entry][title="run-0000.log"]');
      const rows = () => page.$$eval('[data-files-entry]', (shown) => shown.length);

      expect(await rows()).toBe(FILES_PAGE_ENTRIES);

      while (await page.$('[data-files-more]') !== null) {
        const before = await rows();

        await page.click('[data-files-more]');
        await page.waitForFunction((had: number) => document.querySelectorAll('[data-files-entry]').length > had, {}, before);
      }

      // The fixture's whole folder, once each.
      expect(await rows()).toBe(1_234);
      await page.close();
    });
  });
});

describe('linking a machine happens on the surface that asked for it', () => {
  test('the Environment card opens the panel in place, and the arriving machine closes it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-connect]');

      await page.click('[data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // In place: the Environment surface is still mounted behind the dialog,
      // and the URL never moved.
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      expect(new URL(page.url()).pathname).toBe('/gallery.html');
      // The disclosure is on screen before anything is installed: no command yet.
      expect(await page.$('[data-connect-command]')).toBeNull();
      // L111 #6: and it names the workspace the machine is granted to as it connects, before the command exists.
      expect(await page.$eval('[role="dialog"] [data-connect-grant]', (line) => line.textContent ?? ''))
        .toMatch(/its agents use this machine\s+without asking/u);

      // Named, and pressed twice before the first answer: one registration, carrying the name.
      await page.type('[role="dialog"] input[aria-label="Device name"]', 'Build box');
      await page.$eval('[role="dialog"] [data-connect-start]', (button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error('the start control is not a button');
        button.click();
        button.click();
      });
      await page.waitForSelector('[data-connect-command]');
      expect(await page.$eval('[data-connect-command]', (code) => code.textContent ?? '')).toBe(
        "curl -fsSL 'https://kinu.run/install.sh' | KINU_PARENT_ACTIVATES=1 bash -s -- --no-setup --connect"
        + ' && export PATH="${KINU_HOME:-$HOME/.kinu}/bin:$PATH"',
      );
      expect(await page.$('[data-connect-waiting]')).not.toBeNull();

      // The roster poll finds the machine and the panel closes itself, leaving
      // the surface the owner was working on.
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]') === null,
      );
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      // One registration got us here, though the button was pressed twice: a second would be a device row nobody notices.
      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryRegistrations ?? '[]'))).toEqual(['Build box']);
      await page.close();
    });
  });

  // The non-vacuity arms for the close above: same flow, same clicks, and a roster where the device the connect issued
  // stays `connected: false`, alone or beside another machine of the account that connects. A panel that closed on any
  // roster tick, or on any machine that arrived (26244c765), would pass the first test and fail these.
  for (const [what, mode] of [['a machine that never dials in', 'stall'], ['another machine connecting', 'other']]) {
    test(`${what} leaves the panel open and waiting`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        const page = await newPage();
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=${mode}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-connect]');
        await page.click('[data-env-connect]');
        await page.waitForSelector('[role="dialog"] [data-connect-start]');
        await page.click('[role="dialog"] [data-connect-start]');
        await page.waitForSelector('[data-connect-waiting]');

        // Wait for polls to have HAPPENED rather than for a clock: three roster
        // reads after the registration is three chances to close wrongly.
        const readsAtHandover = await page.evaluate(
          () => Number(document.documentElement.dataset.galleryRosterReads ?? '0'),
        );

        await page.waitForFunction(
          (base: number) => Number(document.documentElement.dataset.galleryRosterReads ?? '0') >= base + 3,
          {},
          readsAtHandover,
        );
        expect(await page.$('[role="dialog"] [data-connect-waiting]')).not.toBeNull();
        expect(await page.$('[data-connect-command]')).not.toBeNull();
        await page.close();
      });
    });
  }

  test('a refused registration is named, and the next press registers', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=fail-first`, { waitUntil: 'networkidle0' });
      await page.click('[data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-start]');

      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[role="dialog"] [data-connect-error]');
      expect(await page.$eval('[data-connect-error]', (line) => line.textContent ?? '')).toContain('the hub is busy');

      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[data-connect-command]');
      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryRegistrations ?? '[]'))).toHaveLength(2);
      await page.close();
    });
  });

  test('the drive opens the same panel from its offline row', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&offline=device&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-connect]');
      await page.click('[data-files-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // Still the drive underneath: the row it was opened from is right there.
      expect(await page.$('[data-files-offline-mount]')).not.toBeNull();
      await page.close();
    });
  });
});

describe('Files at every width it is drawn', () => {
  /** Each entry's left edge and top, in the order drawn. */
  const rowEdges = (page: Page) => page.$$eval('[data-files-entry], [data-files-offline-mount]', (rows) => rows.map((row) => {
    const box = row.getBoundingClientRect();

    return { left: Math.round(box.left), top: Math.round(box.top) };
  }));

  test('as a list, a folder is one entry under another, in the inspector and beside the tree', async () => {
    await withGallery(async ({ newPage, origin }) => {
      for (const width of ['inspector=340', 'inspector=480', 'wide=1']) {
        const page = await newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=files&offline=device&layout=list&${width}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-files-offline-mount]');

        // The owner's report was a grid of tiles in a narrow column; the machine that is away is a row of the same list.
        const edges = await rowEdges(page);

        expect(new Set(edges.map((edge) => edge.left)).size).toBe(1);
        expect(edges.every((edge, index) => index === 0 || edge.top > (edges[index - 1]?.top ?? 0))).toBe(true);
        await page.close();
      }
    });
  });

  test('a machine that is away reads the same in the tree as in the list, and connects from either', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&offline=device&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-offline-mount]');
      // The tree has drawn the root's listing, and the machines that are away with it.
      await page.waitForSelector('[data-files-tree-node="/home"]');

      // No way in: a folder there would only answer with the machine's refusal.
      expect(await page.$('[data-files-tree-node="/pc"]')).toBeNull();
      expect(await page.$('[data-files-tree-offline="pc"]')).not.toBeNull();
      await page.hover('[data-files-tree-offline="pc"]');
      await page.click('[data-files-tree-offline="pc"] [data-files-tree-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      await page.close();
    });
  });

  test("an account that has not chosen sees tiles; the view menu shows hidden items and a list, and the choice holds", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const listed = () => page.$$eval('[data-files-entry]', (rows) => rows.map((row) => row.getAttribute('title') ?? ''));

      const pick = async (item: string) => {
        await page.click('[aria-label="View options"]');
        await page.waitForSelector(`${OPEN_MENU} [${item}]`);
        await page.click(`${OPEN_MENU} [${item}]`);
        await page.waitForFunction(() => document.querySelector('[role="menu"][data-open]') === null);
      };

      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&inspector=480`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-entry][title="home"]');

      const tops = () => page.$$eval('[data-files-entry]', (rows) => rows.slice(0, 2).map((row) => Math.round(row.getBoundingClientRect().top)));

      // Tiles, unchosen: they stand side by side, the first two on one line.
      await page.waitForSelector('[data-files-layout="tiles"]');
      expect(new Set(await tops()).size).toBe(1);
      // A machine's own directories sit beside the workspace's places at its root, out of sight until asked for.
      expect(await listed()).not.toContain('usr');
      await pick('data-files-view-hidden');
      await page.waitForSelector('[data-files-entry][title="usr"]');
      await pick('data-files-view-list');
      await page.waitForSelector('[data-files-layout="list"]');
      expect(new Set(await tops()).size).toBe(2);

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-layout="list"] [data-files-entry][title="usr"]');
      await page.click('[aria-label="View options"]');
      await page.waitForSelector(`${OPEN_MENU} [role="menuitemradio"]`);
      const checked = await page.$$eval(`${OPEN_MENU} [aria-checked="true"]`, (items) => items.map((item) => (item.textContent ?? '').trim()));

      expect(checked.sort()).toEqual(['List', 'Show hidden items']);
      await page.close();
    });
  });

  test('arrows move among tiles as the grid stands: beside in reading order, and up or down a row in the same column', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const chosen = () => page.$eval('[data-files-entry][aria-current="true"]', (tile) => tile.getAttribute('title'));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&inspector=480`, { waitUntil: 'networkidle0' });

      for (const folder of ['home', 'main']) {
        await page.waitForSelector(`[data-files-entry][title="${folder}"]`);
        await page.click(`[data-files-entry][title="${folder}"]`);
      }

      await page.waitForSelector('[data-files-layout="tiles"] [data-files-entry][title="notes.md"]');
      await page.focus('[data-files-list]');
      // The grid as it stands: four to a row, so what is under the second tile is the sixth.
      const tiles = await page.$$eval('[data-files-entry]', (drawn) => drawn.map((tile) => tile.getAttribute('title') ?? ''));
      const perRow = await page.$$eval('[data-files-entry]', (drawn) => drawn.filter((tile) => tile.getBoundingClientRect().top === drawn[0]?.getBoundingClientRect().top).length);
      const walked: (string | null)[] = [];

      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const) {
        await page.keyboard.press(key);
        walked.push(await chosen());
      }

      expect(walked).toEqual([tiles[1], tiles[1 + perRow], tiles[perRow], tiles[0]]);
      await page.close();
    });
  });

  test("a row's menu waits for the pointer, and a touch screen shows it on every row", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const menuShown = (page: Page, name: string) => page.$eval(
        `[data-files-entry][title="${name}"] ${ROW_MENU}`, (button) => button.checkVisibility({ opacityProperty: true }),
      );

      const pointer = await newPage();
      await pointer.setViewport({ width: 1280, height: 900 });
      await pointer.goto(`${origin}/gallery.html?frame=files&inspector=340`, { waitUntil: 'networkidle0' });
      await pointer.waitForSelector('[data-files-entry][title="home"]');
      expect(await menuShown(pointer, 'home')).toBe(false);
      await pointer.hover('[data-files-entry][title="home"]');
      expect(await menuShown(pointer, 'home')).toBe(true);
      await pointer.close();

      const touch = await newPage();
      await touch.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
      await touch.goto(`${origin}/gallery.html?frame=files&narrow=1`, { waitUntil: 'networkidle0' });
      await touch.waitForSelector('[data-files-entry][title="home"]');
      expect(await menuShown(touch, 'home')).toBe(true);
      await touch.close();
    });
  });
});

test('file navigation does not pair a new breadcrumb with the old directory', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-files-entry][title="computer"]');

    const mismatches = await page.evaluate(async () => {
      const titles = (): string[] => [...document.querySelectorAll('[data-files-entry]')]
        .map((row) => row.getAttribute('title') ?? '');

      const trail = (): string => [...document.querySelectorAll('[data-files-crumb]')]
        .map((node) => node.textContent ?? '').join('/');

      const seen: string[] = [];

      /**
       * Cross one level and settle when `arrived` is drawn, recording every
       * frame where the trail already names the destination while `stale` — a
       * row that belongs only to the listing being left — is still on screen.
       */
      const cross = (row: string, crumb: string, stale: string, arrived: string): Promise<void> => {
        const { promise, resolve } = Promise.withResolvers<void>();

        const observe = (): void => {
          if (trail().includes(crumb) && titles().includes(stale)) seen.push(trail());

          if (titles().includes(arrived)) {
            changes.disconnect();
            resolve();
          }
        };

        const changes = new MutationObserver(observe);
        changes.observe(document.body, { childList: true, subtree: true, characterData: true });

        const target = document.querySelector<HTMLElement>(`[data-files-entry][title="${row}"]`);

        if (target === null) throw new Error(`the ${row} row is absent`);
        target.click();

        return promise;
      };

      // `/pc` is the roster and `/pc/<name>` the machine's consented directory,
      // so reaching a file on the device is TWO crossings and each one swaps a
      // trail and a listing together. Watching only the first and settling on a
      // file two levels down is a condition that cannot arrive: it hung this
      // suite, and with it the row, from 89f3b895d until this line.
      await cross('pc', 'pc', 'computer', "Ashish's MacBook");
      await cross("Ashish's MacBook", "Ashish's MacBook", "Ashish's MacBook", 'quarterly-report.txt');

      return seen;
    });

    expect(mismatches).toEqual([]);
  });
});

// A bare mount lands on the directory its listing answered for. That listing is the landed directory's: adopting its
// path lists nothing again (staging, 2026-10-13: a /sandbox click listed /sandbox, then /sandbox/workspace).
test('a click on a bare mount lists once, though it lands below it', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-files-entry][title="pc"]');
    await page.click('[data-files-entry][title="pc"]');
    await page.waitForSelector(`[data-files-entry][title="Ashish's MacBook"]`);
    const before = await page.evaluate(() => window.__kinuListings?.length ?? 0);

    // The machine's own directory is a mount that lands on its consented directory.
    await page.click(`[data-files-entry][title="Ashish's MacBook"]`);
    // The landed directory's tiles draw only once the load its adopted path keyed has answered, so a second listing
    // would already be asked by then.
    await page.waitForSelector('[data-files-entry][title="quarterly-report.txt"]');

    const asked = await page.evaluate((from) => window.__kinuListings?.slice(from) ?? [], before);

    expect(asked).toHaveLength(1);
  });
});

declare global {
  interface Window {
    /** Every `input` frame the pane sent the gallery's workspace shell (`gallery-terminal.ts`). */
    __kinuTerminalInput?: string[];
    /** Every directory the Files frame was asked to list, in order. */
    __kinuListings?: string[];
  }
}

describe('the Environment tab', () => {
  // At the inspector's width the computer's tabs outrun the column: one opened past its edge must come into view.
  test('a session opened past the column edge is brought into view', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&inspector=340`, { waitUntil: 'networkidle0' });
      await page.click('[data-env-card="computer"] button');
      await page.waitForSelector('[data-session]');
      const before = await page.$$eval('[data-session]', (tabs) => tabs.length);

      await page.click(NEW_SESSION);
      await page.waitForFunction((had: number) => document.querySelectorAll('[data-session]').length > had
        && document.querySelector('[data-session][aria-selected="true"]') === [...document.querySelectorAll('[data-session]')].at(-1), {}, before);

      const placed = await page.$eval('[data-session][aria-selected="true"]', (tab) => {
        const strip = tab.closest('[role="tablist"]')?.getBoundingClientRect();
        const box = tab.getBoundingClientRect();

        return { overflows: (tab.closest('[role="tablist"]')?.scrollWidth ?? 0) > (strip?.width ?? 0), inView: strip !== undefined && box.left >= strip.left - 1 && box.right <= strip.right + 1 };
      });

      expect(placed).toEqual({ overflows: true, inView: true });
      await page.close();
    });
  });

  // Staging, 2026-10-08: at the inspector's default width every card ran past the panel's right edge.
  test('fits a panel as narrow as the inspector', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 340, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
      await page.click('[data-env-card="computer"] button');
      await page.waitForSelector('[data-env-size]');

      // Every environment's chip, and everything the chosen computer's head draws, its size choice too, inside the page.
      const past = await page.$$eval('[data-env-card], [data-env-card] *, section header, section header *', (drawn) => drawn
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => [element.getAttribute('data-env-card') ?? element.tagName, Math.round(element.getBoundingClientRect().right - document.documentElement.clientWidth)])
        .filter(([, beyond]) => Number(beyond) > 0));

      expect(past).toEqual([]);
    });
  });
});
