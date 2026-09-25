/**
 * A test browser lives exactly as long as its launcher. Closed, it leaves no process and no profile. Killed with
 * SIGKILL, which runs no teardown at all, its launcher still takes the browser with it, and the abandoned-root reap
 * that `preflight --reclaim` runs removes the profile left behind. Before the DevTools pipe, that kill left all nine
 * Chrome processes running under PID 1 (measured 2026-09-25), and this file's second case waited on them until the
 * ladder's deadline.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { BROWSER_PROFILE_PARENT, scratchDir } from '../packages/test-utils/src/scratch';
import { argsOf, testBrowserProfile } from './preflight';
import { currentOwner, OWNER_RECORD, procFile, reapAbandonedRoots } from './process-owner';
import { trackedFiles } from './sources';
import { launchTestChrome } from './test-chrome';

const HELD = join(import.meta.dir, 'fixtures', 'test-chrome', 'held.ts');

/** The processes running from `profile` now. */
function runningFrom(profile: string): number[] {
  return readdirSync('/proc').filter((name) => /^\d+$/u.test(name))
    .filter((pid) => argsOf(procFile(pid, 'cmdline') ?? '').includes(`--user-data-dir=${profile}`))
    .map(Number);
}

/** The scratch profile the browser process `pid` runs from. */
function profileOf(pid: number | undefined): string {
  const profile = testBrowserProfile(argsOf(procFile(pid ?? 0, 'cmdline') ?? ''));

  if (profile === undefined) throw new Error(`process ${String(pid)} is not a test browser on a scratch profile`);

  return profile;
}

/** Settles when every process in `pids` has ended: `tail --pid` waits on a process this one did not start. */
async function ended(pids: readonly number[]): Promise<void> {
  await Promise.all(pids.map((pid) => Bun.spawn(['tail', `--pid=${String(pid)}`, '-f', '/dev/null']).exited));
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf('\n');

    if (end >= 0) return text.slice(0, end);
  }

  throw new Error(`the launcher ended before it named its browser: ${text}`);
}

test('a closed test browser leaves no process and no profile, and its profile was in RAM', async () => {
  const chrome = await launchTestChrome();
  const profile = profileOf(chrome.browser.process()?.pid);
  const processes = runningFrom(profile);

  expect(dirname(dirname(profile))).toBe(BROWSER_PROFILE_PARENT);
  await chrome.close();
  await ended(processes);

  expect(runningFrom(profile)).toEqual([]);
  expect(existsSync(dirname(profile))).toBe(false);
});

test('a launcher killed outright takes its browser with it, and the profile it left is reaped as abandoned', async () => {
  const launcher = Bun.spawn(['bun', HELD], { stdout: 'pipe', stderr: 'inherit' });
  const named = v.parse(v.object({ browser: v.number() }), JSON.parse(await firstLine(launcher.stdout)));
  const profile = profileOf(named.browser);
  const processes = runningFrom(profile);

  launcher.kill('SIGKILL');
  await launcher.exited;
  await ended(processes);

  expect(runningFrom(profile)).toEqual([]);
  expect(existsSync(dirname(profile))).toBe(true);
  expect(reapAbandonedRoots(BROWSER_PROFILE_PARENT, '').reaped).toContain(dirname(profile));
  expect(existsSync(dirname(profile))).toBe(false);
});

test('a launcher abandoning its browser removes the profile only after the browser has ended', async () => {
  const chrome = await launchTestChrome();
  const profile = profileOf(chrome.browser.process()?.pid);
  await (await chrome.browser.newPage()).goto('data:text/html,<p>open</p>');

  chrome.abandon();

  expect(runningFrom(profile)).toEqual([]);
  expect(existsSync(dirname(profile))).toBe(false);
});

test('a launch reaps the profile a dead launcher left in RAM, and keeps a live one\'s', async () => {
  const owner = currentOwner();

  if (owner === null) throw new Error('/proc cannot name this process, so no owner can be recorded');
  const dead = scratchDir('chrome', BROWSER_PROFILE_PARENT);
  const live = scratchDir('chrome', BROWSER_PROFILE_PARENT);
  mkdirSync(join(dead, 'profile'));
  writeFileSync(join(dead, OWNER_RECORD), JSON.stringify({ ...owner, startTicks: owner.startTicks - 1 }));
  writeFileSync(join(live, OWNER_RECORD), JSON.stringify(owner));

  const chrome = await launchTestChrome();
  await chrome.close();

  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
});

test('every Chrome this repository starts on this box starts through the launcher', () => {
  const launchers = trackedFiles()
    .filter((file) => /\.[cm]?tsx?$/u.test(file) && existsSync(file))
    .filter((file) => {
      const text = readFileSync(file, 'utf8');

      return /from\s+['"]puppeteer['"]/u.test(text) && /\.launch\(/u.test(text);
    });

  expect(launchers).toEqual(['scripts/test-chrome.ts']);
});

