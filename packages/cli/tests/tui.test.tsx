/** @jsxImportSource @opentui/react */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { SLASH_COMMANDS } from '../src/slash-commands.js';
import { CommandHintOverlay, DeviceConnectOverlay, ModelPickerOverlay, WalkbackOverlay } from '../src/tui/overlays.js';
import type { AgentModelEntry } from '../src/model-catalog.js';
import { MessageList } from '../src/tui/messages.js';

const repoRoot = resolve(__dirname, '../../..');

describe('CLI TUI layout', () => {
  test('model picker is an absolute overlay and does not move the input area', async () => {
    const withoutOverlay = await renderOverlayFrame(false);
    const withOverlay = await renderOverlayFrame(true);

    expect(lineContaining(withoutOverlay, 'INPUT-SENTINEL')).toBe(lineContaining(withOverlay, 'INPUT-SENTINEL'));
    expect(withOverlay).toContain('Select model');
    expect(withOverlay).toContain('Kimi K2.6');
  });

  test('slash command hints render as a palette without numeric hotkeys', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay commands={SLASH_COMMANDS} terminal={{ width: 80, height: 24 }} />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Commands');
      expect(frame).toContain('/help');
      expect(frame).toContain('/status');
      expect(frame).toContain('more commands');
      expect(frame).not.toContain('/sessions');
      expect(frame).not.toContain('/statusShShow');
      expect(frame).not.toContain('/helptoShow');
      expect(frame).not.toContain('1 /help');
      expect(frame).not.toContain('2 /status');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('command palette clips rows inside the overlay frame', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 58, height: 18, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay
            commands={[{
              name: '/very-long-command-name',
              description: 'This command description is intentionally too long to fit in a narrow overlay without clipping.',
            }]}
            terminal={{ width: 58, height: 18 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      for (const line of frame.split('\n')) {
        expect([...line].length).toBeLessThanOrEqual(58);
      }
      expect(frame).toContain('/very-long');
      expect(frame).not.toContain('without clipping');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('chat messages render user bubbles and assistant markdown', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: '#0f0f23' }}>
          <MessageList
            streamingText={null}
            messages={[
              { id: 'u1', role: 'user', content: 'Review this module' },
              { id: 'a1', role: 'assistant', content: '### Plan\n\n- **Inspect** sources\n- Ship fix' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('You');
      expect(frame).toContain('Review this module');
      expect(frame).toContain('Agent');
      expect(frame).toContain('Plan');
      expect(frame).toContain('Inspect');
      expect(frame).not.toContain('**Inspect**');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('steered user messages carry the steering marker', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: '#0f0f23' }}>
          <MessageList
            streamingText={null}
            messages={[
              { id: 'u1', role: 'user', content: 'start the deploy' },
              { id: 'u2', role: 'user', content: 'use staging instead', steered: true },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('use staging instead');
      expect(frame).toContain('↪ steering');
      // The marker belongs to the steered bubble only.
      expect(frame.split('↪ steering')).toHaveLength(2);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('walk-back overlay lists recent user messages newest first', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <WalkbackOverlay
            candidates={[
              { text: 'now run step two', occurrenceFromEnd: 1 },
              { text: 'plan the migration', occurrenceFromEnd: 1 },
            ]}
            terminal={{ width: 96, height: 24 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Walk back');
      expect(frame).toContain('Enter forks before that message');
      expect(frame).toContain('latest · now run step two');
      expect(frame).toContain('-1 · plan the migration');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('device-connect overlay offers connect, session, not-now, and dismiss choices', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'ask', statusLine: 'No PC is connected to your account yet.' }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Let this agent use this PC?');
      expect(frame).toContain('No PC is connected to your account yet.');
      expect(frame).toContain('C connect & keep connected · S this session only');
      expect(frame).toContain("N not now · D don't ask again");
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('device-connect overlay shows connect progress and the result', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'connecting', session: true, ticks: 1 }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Waiting for the daemon to connect..');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'result', ok: true, message: 'Connected for this session.' }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('✓ Connected for this session.');
      expect(frame).toContain('Press any key to continue');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('home screen has no global numeric agent selection path', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/cli/src/tui/home-app.tsx'), 'utf8');

    expect(source).not.toContain('Number(key.name)');
    expect(source).not.toContain('1-9');
    expect(source).toContain("focusArea === 'mission'");
    expect(source).toContain('nextFocus');
    expect(source).toContain('onMouseDown');
  });
});

async function renderOverlayFrame(showOverlay: boolean) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
  const root = createRoot(renderer);
  try {
    root.render(
        <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
          <box style={{ height: 3 }}>
          <text><span>HEADER</span></text>
        </box>
        <box style={{ flexGrow: 1 }}>
          <text><span>BODY</span></text>
        </box>
        <box style={{ height: 3 }} title="Input">
          <text><span>INPUT-SENTINEL</span></text>
        </box>
        {showOverlay && (
          <ModelPickerOverlay
            models={MODELS}
            currentSpec={MODELS[0]!.spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={() => {}}
          />
        )}
      </box>,
    );
    await renderSettled(renderOnce);
    return captureCharFrame();
  } finally {
    root.render(<box />);
    renderer.destroy();
  }
}

async function renderSettled(renderOnce: () => Promise<void>) {
  for (let i = 0; i < 10; i++) {
    await renderOnce();
    await Bun.sleep(30);
  }
}

function lineContaining(frame: string, text: string) {
  const line = frame.split('\n').findIndex((candidate) => candidate.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
}

const MODELS: AgentModelEntry[] = [
  {
    provider: 'workers-ai',
    id: '@cf/moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    spec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
    capabilities: ['tools', 'streaming'],
  },
  {
    provider: 'workers-ai',
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B',
    spec: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    capabilities: ['streaming'],
  },
];
