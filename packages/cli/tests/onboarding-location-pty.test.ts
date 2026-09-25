/**
 * First run with nothing connected: kinu opens on its setup steps, which own the keys while they show.
 * Driven through `bin/cli.ts` on a real pty, the way a person starts it.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonObject } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';

import { runTuiInPty } from './helpers/pty-screen';

const cliBin = resolve(import.meta.dir, '../bin/cli.ts');

const DOWN = '\u001b[B';

test('choosing where workspaces live keeps the answer and moves setup to the provider step', async () => {
  const home = scratchDir('onboarding-location-home');

  const run = await runTuiInPty(cliBin, {
    cwd: scratchDir('onboarding-location-project'),
    cols: 120,
    rows: 32,
    env: { KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    steps: [
      { wait: 'Where will your workspaces live?', timeout: 45 },
      { send: DOWN },
      { wait: '› local', timeout: 10 },
      { send: '\r' },
      { wait: 'Step 2/6', timeout: 20 },
    ],
  });

  expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
  expect(run.screen).not.toContain('Where will your workspaces live?');
  expect(parseJsonObject(readFileSync(join(home, 'tui.json'), 'utf8')).onboardingLocation).toBe('local');
});

test('Esc on a setup question answers it, and kinu keeps running', async () => {
  const home = scratchDir('onboarding-escape-home');

  const run = await runTuiInPty(cliBin, {
    cwd: scratchDir('onboarding-escape-project'),
    cols: 120,
    rows: 40,
    env: { KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    steps: [
      { wait: 'Where will your workspaces live?', timeout: 45 },
      { send: DOWN },
      { wait: '› local', timeout: 10 },
      { send: '\r' },
      { wait: '› ○ Cloudflare', timeout: 20 },
      { send: DOWN },
      { wait: '› ○ Claude subscription', timeout: 10 },
      { send: DOWN },
      { wait: '› ○ Codex', timeout: 10 },
      { send: DOWN },
      { wait: '› ○ OpenAI ·', timeout: 10 },
      { send: '\r' },
      { wait: 'OpenAI API key', timeout: 20 },
      { send: '\u001b' },
      { wait: 'No OpenAI key was given.', timeout: 20 },
      { sleep: 1 },
    ],
  });

  expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
  expect(run.exited, run.screen).toBe(false);
  expect(run.screen).toContain('Connect a provider');
});
