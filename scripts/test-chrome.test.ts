/**
 * A test browser lives exactly as long as its launcher. Closed, it leaves no process and no profile. Killed with
 * SIGKILL, which runs no teardown at all, its launcher still takes the browser with it, and the abandoned-root reap
 * that `preflight --reclaim` runs removes the profile left behind. Before the DevTools pipe, that kill left all nine
 * Chrome processes running under PID 1 (measured 2026-09-25), and this file's second case waited on them until the
 * ladder's deadline.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { BROWSER_PROFILE_PARENT, scratchDir } from '../packages/test-utils/src/scratch';
import { argsOf, testBrowserProfile } from './preflight';
import { currentOwner, OWNER_RECORD, procFile, reapAbandonedRoots } from './process-owner';
import { isParseable, readMatching } from './sources';
import { memberCalleeName, parse, walk, type Parsed } from './syntax';
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

  // Any launch or suite on the box may reap the root first: every one sweeps the RAM parent for dead owners, and a
  // concurrent sweep took it between the kill and this pass in 5 of 5 runs (2026-09-27). What must hold is that after a
  // pass, this one or another's, nothing of the abandoned profile is left.
  expect(reapAbandonedRoots(BROWSER_PROFILE_PARENT, '').unremovable).not.toContain(dirname(profile));
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

test('a dead launcher\'s profile stays while a process still runs from it, and goes once none does', async () => {
  const owner = currentOwner();

  if (owner === null) throw new Error('/proc cannot name this process, so no owner can be recorded');
  const root = scratchDir('chrome', BROWSER_PROFILE_PARENT);
  mkdirSync(join(root, 'profile'));
  writeFileSync(join(root, OWNER_RECORD), JSON.stringify({ ...owner, startTicks: owner.startTicks - 1 }));

  // A browser a SIGKILLed launcher left: its launcher is gone, and its profile is still in its command line.
  const survivor = Bun.spawn(['bash', '-c', 'exec -a "$0" sleep 30', `browser --user-data-dir=${join(root, 'profile')}`]);

  expect(reapAbandonedRoots(BROWSER_PROFILE_PARENT, '').reaped).not.toContain(root);
  expect(existsSync(root)).toBe(true);

  survivor.kill('SIGKILL');
  await survivor.exited;

  expect(reapAbandonedRoots(BROWSER_PROFILE_PARENT, '').reaped).toContain(root);
});

/**
 * The bindings a file's value imports of puppeteer bring in (default, namespace or a named `launch`), read from its
 * syntax tree: a type-only import launches nothing, and text that spells an import (a fixture string, a comment) is
 * none.
 */
function puppeteerBindings(parsed: Parsed): Set<string> {
  const bindings = new Set<string>();

  for (const statement of parsed.root.children) {
    const { raw } = statement;

    if (raw.type !== 'ImportDeclaration' || raw.importKind === 'type' || raw.source.value !== 'puppeteer') continue;

    for (const specifier of raw.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
      bindings.add(specifier.local.name);
    }
  }

  return bindings;
}

/** Whether the file calls `launch` on a binding its puppeteer import made, or calls an imported `launch` itself. */
function launchesChrome(file: string, text: string): boolean {
  const parsed = parse(file, text);
  const bindings = puppeteerBindings(parsed);
  let launches = false;

  if (bindings.size === 0) return false;
  walk(parsed.root, (node) => {
    const { raw } = node;

    if (raw.type !== 'CallExpression') return;
    const { callee } = raw;

    const onImport = callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
      && bindings.has(callee.object.name) && memberCalleeName(node) === 'launch';

    const imported = callee.type === 'Identifier' && callee.name === 'launch' && bindings.has('launch');

    if (onImport || imported) launches = true;
  });

  return launches;
}

test('the launch check reads syntax: a real launch counts, a fixture spelling one does not', () => {
  expect(launchesChrome('a.ts', "import puppeteer from 'puppeteer';\nawait puppeteer.launch({});\n")).toBeTrue();
  expect(launchesChrome('b.ts', "import * as p from 'puppeteer';\nawait p.launch();\n")).toBeTrue();
  expect(launchesChrome('c.ts', "import type { Browser } from 'puppeteer';\nconst b = {} as Browser;\nawait b.launch();\n")).toBeFalse();
  expect(launchesChrome('d.ts', "const fixture = \"import driver from 'puppeteer'; driver.launch()\";\n")).toBeFalse();
  expect(launchesChrome('e.ts', "import puppeteer from '@cloudflare/puppeteer';\nawait puppeteer.launch(env.BROWSER);\n")).toBeFalse();
});

test('every Chrome this repository starts on this box starts through the launcher', () => {
  const launchers = [...readMatching(isParseable)].filter(([file, text]) => launchesChrome(file, text)).map(([file]) => file);

  expect(launchers).toEqual(['scripts/test-chrome.ts']);
});
