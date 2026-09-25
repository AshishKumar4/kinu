/**
 * How the live-app and gallery harnesses, and the browser tests and scripts beside them, start Chrome.
 *
 * Puppeteer starts Chrome detached, in a process group of its own, so a runner's end does not reach it, and a
 * SIGKILLed runner runs no teardown at all. On 2026-09-25 the owner found six headless Chrome re-parented to PID 1,
 * up to 10 h old, holding about 1.2 GB, with their profiles still on the scratch disk. A browser here is tied to its
 * launcher by the DevTools pipe instead of a port: Chrome ends when the pipe's far end closes, which a launcher's death
 * does however it dies. Measured: 5 s after `kill -9` of the launcher, all 9 processes of a port-driven Chrome were
 * running and none of a pipe-driven one.
 *
 * Its profile is in RAM ({@link BROWSER_PROFILE_PARENT}) and goes when the browser has ended; one a killed launcher
 * left behind is removed by the next launch, or by `scripts/preflight.ts --reclaim`, judged by the owner recorded here.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';
import { BROWSER_PROFILE_PARENT, holdForRelease, releaseScratch, scratchDir } from '../packages/test-utils/src/scratch';
import { groupRuns, reapAbandonedRoots, recordOwner } from './process-owner';
import { signalGroup } from './process-group';

// A caller that is a script rather than a `bun test` row has no preload `afterAll`: a browser it left open, and the
// profile under it, go when it exits.
process.once('exit', releaseScratch);

export interface TestChromeOptions {
  /** Flags after `--no-sandbox` and `--disable-dev-shm-usage`, which every test browser takes. */
  readonly args?: readonly string[];
  /** Runs first when the process is ended with this browser open: the caller's account of what it was waiting on. */
  readonly onAbandon?: () => void;
}

export interface TestChrome {
  readonly browser: Browser;
  /** Ends the browser's process group and removes its profile now, awaiting nothing: for a process being ended. */
  abandon(): void;
  /** Closes the browser, ends whatever of its group the close left, and removes its profile. */
  close(): Promise<void>;
}

/** The box's own Chrome when one is installed; otherwise puppeteer's. */
function chromePath(): string | undefined {
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((candidate) => existsSync(candidate));
}

/** Sleeps this thread, which a process being ended has no event loop left to await with. */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * SIGKILL has no handler, so the group ends as soon as the kernel runs it: every member was a zombie right after
 * the signal in 6 of 6 abandons measured on 2026-09-25. The bound is for a member stuck in the kernel (state D).
 */
const GROUP_END_POLLS = 500;

/**
 * Ends the browser's group, then removes its profile once no member runs, so no dying process writes into a removed
 * profile. A group still running after {@link GROUP_END_POLLS} polls keeps its profile for the next launch to reap.
 */
function endAndRemove(group: number | undefined, root: string): void {
  signalGroup(group, 'SIGKILL');

  for (let poll = 0; group !== undefined && groupRuns(group); poll++) {
    if (poll === GROUP_END_POLLS) return;
    Atomics.wait(PAUSE, 0, 0, 10);
  }

  rmSync(root, { recursive: true, force: true });
}

export async function launchTestChrome(options: TestChromeOptions = {}): Promise<TestChrome> {
  const root = scratchDir('chrome', BROWSER_PROFILE_PARENT);

  recordOwner(root);
  // A launcher killed outright left its profile in RAM; its recorded owner says it is gone.
  reapAbandonedRoots(BROWSER_PROFILE_PARENT, root);
  let group: number | undefined;

  const abandon = (): void => {
    options.onAbandon?.();
    signalGroup(group, 'SIGTERM');
    endAndRemove(group, root);
  };

  // Under `bun test` this is the one teardown a killed row runs: the preload's signal listener releases and then ends
  // the process inside its own re-raise, so no `finally` opens.
  const dropHold = holdForRelease('a test browser', abandon);

  const launchOptions: LaunchOptions = {
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(options.args ?? [])],
    pipe: true,
    userDataDir: join(root, 'profile'),
    // No clock on the launch or a protocol round trip (puppeteer 25.10 guards every timer with `if (timeout)`): a
    // launch ran past 30 s at load 109 on 2026-09-22. A browser that dies fails the launch on its exit.
    timeout: 0,
    protocolTimeout: 0,
  };

  const executablePath = chromePath();

  if (executablePath !== undefined) launchOptions.executablePath = executablePath;
  let browser: Browser;

  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (error) {
    dropHold();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  group = browser.process()?.pid;

  return {
    browser,
    abandon,
    async close() {
      dropHold();
      // The group, not the browser alone: puppeteer's close reaches the process it spawned, and the SIGKILL collects
      // whatever of the group that close left, a wedged renderer or a zygote holding a pipe.
      signalGroup(group, 'SIGTERM');
      await browser.close();
      endAndRemove(group, root);
    },
  };
}

/** Launch a test browser, run `body` with it, and close it whatever `body` did. */
export async function withTestChrome<T>(body: (browser: Browser) => Promise<T>, options: TestChromeOptions = {}): Promise<T> {
  const chrome = await launchTestChrome(options);

  try {
    return await body(chrome.browser);
  } finally {
    await chrome.close();
  }
}
