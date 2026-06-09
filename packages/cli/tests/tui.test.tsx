/** @jsxImportSource @opentui/react */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { LOCAL_COMMANDS } from '../src/tui/commands.js';
import { CommandHintOverlay, ModelPickerOverlay } from '../src/tui/overlays.js';
import type { TuiModelEntry } from '../src/tui/model-types.js';
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
          <CommandHintOverlay commands={LOCAL_COMMANDS} terminal={{ width: 80, height: 24 }} />
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

const MODELS: TuiModelEntry[] = [
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
