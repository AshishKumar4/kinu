/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { GuidedOnboarding, type OnboardingReadiness, type TuiOnboardingOperations } from '../src/tui/onboarding';
import { createMemoryTuiPreferenceStore } from './helpers/tui-preferences';
import { TuiProductProvider } from '../src/tui/tui-shell';

describe('guided onboarding renderer', () => {
  test('skip is durable readiness input and re-entry resumes the next scene', async () => {
    let readiness: OnboardingReadiness = {
      location: 'cloud',
      accountConnected: true,
      providerConnected: false,
      defaultModel: 'workers-ai/deepseek',
      tierAliasesResolved: true,
      themeSelected: false,
      keymapSelected: false,
      workspaceCount: 0,
      skippedSteps: [],
    };
    const update = (patch: Partial<OnboardingReadiness>) => {
      readiness = { ...readiness, ...patch };
    };
    const operations: TuiOnboardingOperations = {
      readReadiness: () => readiness,
      chooseLocation: (location) => update({ location }),
      connectAccount: () => update({ accountConnected: true }),
      connectProvider: () => update({ providerConnected: true }),
      configureTiers: () => update({ defaultModel: 'workers-ai/deepseek', tierAliasesResolved: true }),
      selectTheme: () => update({ themeSelected: true }),
      selectKeymap: () => update({ keymapSelected: true }),
      createWorkspace: () => update({ workspaceCount: 1 }),
      skip: (step) => update({ skippedSteps: [...readiness.skippedSteps, step] }),
    };
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    const store = createMemoryTuiPreferenceStore();
    const scene = (
      <TuiProductProvider runtime={{ preferenceStore: store, terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
        <GuidedOnboarding
          operations={operations}
          roles={[{ id: 'general', label: 'General', description: 'General work' }]}
          onReady={() => {}}
          onExit={() => {}}
        />
      </TuiProductProvider>
    );
    try {
      root.render(scene);
      await waitForFrame(renderOnce, captureCharFrame, 'Step 4/6 · theme');
      mockInput.pressKey('s');
      await waitForFrame(renderOnce, captureCharFrame, 'Step 5/6 · keymap');

      root.render(<box />);
      await renderSettled(renderOnce);
      root.render(scene);
      await waitForFrame(renderOnce, captureCharFrame, 'Step 5/6 · keymap');
      expect(readiness.skippedSteps).toEqual(['theme']);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('a wholly fresh install opens on the first scene', async () => {
    const readiness: OnboardingReadiness = {
      accountConnected: false,
      providerConnected: false,
      tierAliasesResolved: false,
      themeSelected: false,
      keymapSelected: false,
      workspaceCount: 0,
      skippedSteps: [],
    };
    const operations: TuiOnboardingOperations = {
      readReadiness: () => readiness,
      chooseLocation: () => {},
      connectAccount: () => {},
      connectProvider: () => {},
      configureTiers: () => {},
      selectTheme: () => {},
      selectKeymap: () => {},
      createWorkspace: () => {},
      skip: () => {},
    };
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    try {
      root.render(
        <TuiProductProvider runtime={{ preferenceStore: createMemoryTuiPreferenceStore(), terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
          <GuidedOnboarding
            operations={operations}
            roles={[{ id: 'general', label: 'General', description: 'General work' }]}
            onReady={() => {}}
            onExit={() => {}}
          />
        </TuiProductProvider>,
      );
      await waitForFrame(renderOnce, captureCharFrame, 'Step 1/6 · location');
      expect(captureCharFrame()).toContain('Where will your workspaces live?');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('a failed readiness read shows the whole cause chain, not a stuck spinner', async () => {
    const operations: TuiOnboardingOperations = {
      readReadiness: () => {
        throw new Error('readiness read failed', { cause: new Error('no such table: onboarding') });
      },
      chooseLocation: () => {},
      connectAccount: () => {},
      connectProvider: () => {},
      configureTiers: () => {},
      selectTheme: () => {},
      selectKeymap: () => {},
      createWorkspace: () => {},
      skip: () => {},
    };
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    try {
      root.render(
        <TuiProductProvider runtime={{ preferenceStore: createMemoryTuiPreferenceStore(), terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
          <GuidedOnboarding
            operations={operations}
            roles={[]}
            onReady={() => {}}
            onExit={() => {}}
          />
        </TuiProductProvider>,
      );
      await waitForFrame(renderOnce, captureCharFrame, 'readiness read failed: no such table: onboarding');
      expect(captureCharFrame()).not.toContain('Checking readiness…');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('a failed step action surfaces the whole cause chain beside the step', async () => {
    const readiness: OnboardingReadiness = {
      accountConnected: false,
      providerConnected: false,
      tierAliasesResolved: false,
      themeSelected: false,
      keymapSelected: false,
      workspaceCount: 0,
      skippedSteps: [],
    };
    const operations: TuiOnboardingOperations = {
      readReadiness: () => readiness,
      chooseLocation: () => {
        throw new Error('the location could not be saved', { cause: new Error('config.json is read-only') });
      },
      connectAccount: () => {},
      connectProvider: () => {},
      configureTiers: () => {},
      selectTheme: () => {},
      selectKeymap: () => {},
      createWorkspace: () => {},
      skip: () => {},
    };
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    try {
      root.render(
        <TuiProductProvider runtime={{ preferenceStore: createMemoryTuiPreferenceStore(), terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
          <GuidedOnboarding
            operations={operations}
            roles={[{ id: 'general', label: 'General', description: 'General work' }]}
            onReady={() => {}}
            onExit={() => {}}
          />
        </TuiProductProvider>,
      );
      await waitForFrame(renderOnce, captureCharFrame, 'Step 1/6 · location');
      mockInput.pressEnter();
      await waitForFrame(renderOnce, captureCharFrame, 'the location could not be saved: config.json is read-only');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });
});

async function renderSettled(renderOnce: () => Promise<void>): Promise<void> {
  await renderOnce();
  await Bun.sleep(0);
  await renderOnce();
}

async function waitForFrame(
  renderOnce: () => Promise<void>,
  capture: () => string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await renderOnce();
    if (capture().includes(expected)) return;
    await Bun.sleep(1);
  }
  expect(capture()).toContain(expected);
}
