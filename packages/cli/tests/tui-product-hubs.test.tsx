/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { HubOverlay, type TuiHubData, type TuiHubView } from '../src/tui/hubs';
import { createMemoryTuiPreferenceStore } from './helpers/tui-preferences';
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
          roleId: 'task',
          tierId: 'default',
          workspace: 'checkout',
        },
        {
          id: 'agent-reviewer',
          label: 'Reviewer',
          kind: 'subordinate',
          status: 'running',
          roleId: 'auditor',
          tierId: 'deep',
          workspace: 'checkout',
          task: 'Review the coupon patch',
        },
        {
          id: 'agent-jarvis',
          label: 'Jarvis',
          kind: 'main',
          status: 'idle',
          roleId: 'task',
          tierId: 'default',
          workspace: 'jarvis',
        },
      ],
      subordinates: [],
      work: [],
      helpers: [],
      profile: {
        envelope: {
          authority: { kind: 'local' },
          version: 4,
          digest: 'profile-digest',
          catalog: {
            roles: {
              task: {
                description: 'General work',
                instructions: 'Work directly.',
                tier: 'default',
                preset: 'ideate',
              },
              auditor: {
                label: 'Auditor',
                description: 'Review claims and run checks.',
                instructions: 'Audit the evidence.',
                tier: 'deep',
                preset: 'audit',
              },
            },
            tiers: {
              default: { model: 'workers-ai/deepseek', reasoningEffort: 'medium' },
              deep: { model: 'anthropic/claude-opus', reasoningEffort: 'high' },
            },
          },
        },
        activeRoleId: 'task',
        allowedRoleIds: ['task', 'auditor'],
      },
    };

    const { renderer, waitForFrame, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 30,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);
    renderer.start();
    const store = createMemoryTuiPreferenceStore();

    try {
      for (const [view, expected] of [
        ['agents', 'Reviewer · agent · auditor/deep'],
        ['roles', 'Review claims and run checks.'],
        ['tiers', 'fast → default'],
      ] as const satisfies readonly (readonly [TuiHubView, string])[]) {
        root.render(
          <TuiProductProvider runtime={{ preferenceStore: store, colorCapability: 'truecolor' }}>
            <box style={{ width: '100%', height: '100%' }}>
              <HubOverlay view={view} data={hubData} width={100} height={30} />
            </box>
          </TuiProductProvider>,
        );
        await waitForFrame((frame) => frame.includes(expected));

        if (view !== 'agents') continue;
        const lines = captureCharFrame().split('\n').map((line) => line.replaceAll('│', ' ').trim());
        const checkout = lines.findIndex((line) => line === 'checkout');
        const main = lines.findIndex((line) => line.includes('Checkout · main'));
        const reviewer = lines.findIndex((line) => line.includes('Reviewer') && line.includes('auditor/deep'));
        const jarvisHeading = lines.findIndex((line) => line === 'jarvis');
        expect(checkout).toBeGreaterThanOrEqual(0);
        expect(main).toBeGreaterThan(checkout);
        expect(reviewer).toBeGreaterThan(main);
        expect(jarvisHeading).toBeGreaterThan(reviewer);
      }
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
});

