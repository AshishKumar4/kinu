/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { HubOverlay, type TuiHubData, type TuiHubView } from '../src/tui/hubs';
import { DEFAULT_TUI_PREFERENCES, createMemoryTuiPreferenceStore } from '../src/tui/preferences';
import { TuiProductProvider } from '../src/tui/tui-shell';

describe('role, tier, and agent hubs', () => {
  test('typed injected hub data renders each view without inventing mutations', async () => {
    const hubData: TuiHubData = {
      agents: [
        {
          id: 'agent-main',
          label: 'Checkout',
          kind: 'main',
          status: 'idle',
          roleId: 'general',
          tierId: 'default',
          workspace: 'checkout',
        },
        {
          id: 'agent-reviewer',
          label: 'Reviewer',
          kind: 'subordinate',
          status: 'running',
          roleId: 'auditor',
          tierId: 'slow',
          workspace: 'checkout',
          task: 'Review the coupon patch',
        },
        {
          id: 'agent-jarvis',
          label: 'Jarvis',
          kind: 'main',
          status: 'idle',
          roleId: 'general',
          tierId: 'default',
          workspace: 'jarvis',
        },
      ],
      profile: {
        envelope: {
          authority: { kind: 'local' },
          version: 4,
          digest: 'profile-digest',
          catalog: {
            roles: {
              general: {
                description: 'General work',
                instructions: 'Work directly.',
                tier: 'default',
                preset: 'ideate',
              },
              auditor: {
                label: 'Auditor',
                description: 'Review claims and run checks.',
                instructions: 'Audit the evidence.',
                tier: 'slow',
                preset: 'audit',
              },
            },
            tiers: {
              default: { model: 'workers-ai/deepseek', reasoningEffort: 'medium' },
              slow: { model: 'anthropic/claude-opus', reasoningEffort: 'high' },
            },
          },
        },
        activeRoleId: 'general',
        allowedRoleIds: ['general', 'auditor'],
      },
    };
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 30,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    const store = createMemoryTuiPreferenceStore(DEFAULT_TUI_PREFERENCES);
    try {
      for (const [view, expected] of [
        ['agents', 'Reviewer · subordinate · auditor/slow'],
        ['roles', 'Review claims and run checks.'],
        ['tiers', 'fast → default'],
      ] as const satisfies readonly (readonly [TuiHubView, string])[]) {
        root.render(
          <TuiProductProvider runtime={{ preferenceStore: store, terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
            <box style={{ width: '100%', height: '100%' }}>
              <HubOverlay view={view} data={hubData} width={100} height={30} />
            </box>
          </TuiProductProvider>,
        );
        await waitForFrame(renderOnce, captureCharFrame, expected);
        if (view !== 'agents') continue;
        // Entries group under their workspace heading; subordinates indent
        // under the peer they belong to.
        const lines = captureCharFrame().split('\n').map((line) => line.replaceAll('│', ' ').trim());
        const checkout = lines.findIndex((line) => line === 'checkout');
        const main = lines.findIndex((line) => line.includes('Checkout · main'));
        const reviewer = lines.findIndex((line) => line.startsWith('└ ') && line.includes('Reviewer · subordinate'));
        const jarvisHeading = lines.findIndex((line) => line === 'jarvis');
        expect(checkout).toBeGreaterThanOrEqual(0);
        expect(main).toBeGreaterThan(checkout);
        expect(reviewer).toBeGreaterThan(main);
        expect(jarvisHeading).toBeGreaterThan(reviewer);
      }
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });
});

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
