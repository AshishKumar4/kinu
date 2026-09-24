/** @jsxImportSource @opentui/react */
/** Onboarding against real stores; the provider flow runs in a child because `config.ts` binds KINU_HOME at import. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { expect, test } from 'bun:test';
import { parseJsonObject } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';

import type { ProviderConnectionState } from '../src/commands/provider-connect';
import { GuidedOnboarding, type OnboardingReadiness, type TuiOnboardingOperations } from '../src/tui/onboarding';
import { createFileTuiPreferenceStore } from '../src/tui/preferences';
import { createMemoryTuiPreferenceStore } from './helpers/tui-preferences';
import { TuiProductProvider } from '../src/tui/tui-shell';

const repoRoot = resolve(import.meta.dir, '../../..');

test('the theme step stands until a theme is stored, and closes once one is', async () => {
  const store = createFileTuiPreferenceStore(join(scratchDir('onboarding-theme'), 'tui.json'));

  const readiness = (): OnboardingReadiness => ({
    location: 'local',
    accountConnected: true,
    providerConnected: true,
    defaultModel: 'openai/gpt-5.5',
    tierAliasesResolved: true,
    themeSelected: store.read().theme !== undefined,
    keymapSelected: false,
    workspaceCount: 1,
    skippedSteps: [],
  });

  const operations: TuiOnboardingOperations = {
    readReadiness: readiness,
    chooseLocation: () => {},
    listProviders: async () => [],
    connectProvider: async () => ({ kind: 'connected', summary: 'connected' }),
    configureTiers: () => {},
    selectTheme: (selection) => store.write({ ...store.read(), theme: selection }),
    selectKeymap: () => {},
    createWorkspace: () => {},
    skip: () => {},
  };

  const { renderer, mockInput, waitForFrame, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 28,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });

  const root = createRoot(renderer);

  try {
    root.render(
      <TuiProductProvider runtime={{ preferenceStore: createMemoryTuiPreferenceStore(), colorCapability: 'truecolor' }}>
        <GuidedOnboarding
          operations={operations}
          roles={[{ id: 'task', label: 'Task', description: 'General work' }]}
          onReady={() => {}}
          onExit={() => {}}
        />
      </TuiProductProvider>,
    );
    // The render loop must run for frame events to fire; the wait returns on the first frame showing the step.
    renderer.start();
    await waitForFrame((frame) => frame.includes('Choose a theme'));
    expect(captureCharFrame()).toContain('Light');
    expect(captureCharFrame()).toContain('Dark');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('Choose a keymap'));
    expect(store.read().theme).toBeDefined();
    expect(captureCharFrame()).not.toContain('Choose a theme');
  } finally {
    flushSync(() => { root.unmount(); });
    renderer.destroy();
  }
});

test('a check that never answers shows until Esc skips it, which aborts it and moves on to the question', async () => {
  const endpoint: ProviderConnectionState = {
    descriptor: { id: 'openai-compatible', label: 'OpenAI-compatible', blurb: 'Any /v1 endpoint.', credential: 'api-key' },
    connected: false,
    detail: 'kinu provider connect openai-compatible',
  };

  let abortedProbe = false;
  let skipped: string | null = 'unsettled';

  const operations: TuiOnboardingOperations = {
    readReadiness: () => ({
      location: 'local',
      accountConnected: false,
      providerConnected: false,
      tierAliasesResolved: false,
      themeSelected: false,
      keymapSelected: false,
      workspaceCount: 0,
      skippedSteps: [],
    }),
    chooseLocation: () => {},
    listProviders: async () => [endpoint],
    connectProvider: async (_id, port) => {
      skipped = await port.skippable('Checking http://unanswering.test/v1/models…', (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortedProbe = true;
          reject(signal.reason);
        });
      }));

      return { kind: 'connected', summary: `Connected with ${await port.ask({ label: 'Default model' })}` };
    },
    configureTiers: () => {},
    selectTheme: () => {},
    selectKeymap: () => {},
    createWorkspace: () => {},
    skip: () => {},
  };

  const { renderer, mockInput, waitForFrame } = await createTestRenderer({
    width: 100,
    height: 32,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });

  const root = createRoot(renderer);

  try {
    root.render(
      <TuiProductProvider runtime={{ preferenceStore: createMemoryTuiPreferenceStore(), colorCapability: 'truecolor' }}>
        <GuidedOnboarding operations={operations} roles={[]} onReady={() => {}} onExit={() => {}} />
      </TuiProductProvider>,
    );
    renderer.start();
    await waitForFrame((frame) => frame.includes('OpenAI-compatible'));
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('Checking http://unanswering.test/v1/models… Esc skips'));
    expect(abortedProbe).toBe(false);
    mockInput.pressEscape();
    await waitForFrame((frame) => frame.includes('Default model'));
    expect(abortedProbe).toBe(true);
    expect(skipped).toBeNull();
  } finally {
    flushSync(() => { root.unmount(); });
    renderer.destroy();
  }
});

test('a provider connected through the port stores the key the connected check reads', () => {
  const home = scratchDir('onboarding-connect-home');

  const runner = `
    const { connectProvider, readProviderConnections } = await import('./packages/cli/src/commands/provider-connect.ts');
    const answers = ['sk-onboarding-key', 'gpt-4o-mini'];
    const port = { report: () => {}, ask: async () => answers.shift() ?? '' };
    const before = (await readProviderConnections()).states.find((state) => state.descriptor.id === 'openai');
    const outcome = await connectProvider('openai', port, { local: true });
    const after = (await readProviderConnections()).states.find((state) => state.descriptor.id === 'openai');
    console.log(JSON.stringify({ before: before.connected, after: after.connected, kind: outcome.kind }));
  `;

  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', runner],
    cwd: repoRoot,
    env: {
      ...process.env,
      KINU_HOME: home,
      NO_COLOR: '1',
      OPENAI_API_KEY: '',
      KINU_TOKEN: '',
      KINU_ORIGIN: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(proc.stderr.toString()).toBe('');
  const result = parseJsonObject(proc.stdout.toString().trim().split('\n').at(-1) ?? '{}');
  expect(result).toEqual({ before: false, after: true, kind: 'connected' });
  const config = parseJsonObject(readFileSync(join(home, 'config.json'), 'utf8'));
  expect(JSON.stringify(config)).toContain('sk-onboarding-key');
});
