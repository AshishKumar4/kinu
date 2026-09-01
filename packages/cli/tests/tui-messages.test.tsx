/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { MessageList } from '../src/tui/messages';
import { BUILTIN_TUI_THEMES } from '../src/tui/theme';

const TEST_TUI_BACKGROUND = BUILTIN_TUI_THEMES[0]!.colors.background.overlay;

describe('TUI transcript rendering', () => {
  test('the user turn is a bubble with no speaker label; assistant markdown stays unprefixed', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            messages={[
              { id: 'u1', role: 'user', content: 'Review this module' },
              { id: 'a1', role: 'assistant', content: '### Plan\n\n- **Inspect** sources\n- Ship fix' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      // The web chat marks the speaker by the bubble alone; no gutter label.
      expect(frame).not.toContain('YOU');
      expect(frame).toContain('Review this module');
      expect(frame).not.toContain('KINU');
      // The bubble's rounded edge sits on the user row.
      expect(frame).toContain('╭');
      expect(frame).toContain('Plan');
      expect(frame).toContain('Inspect');
      expect(frame).not.toContain('**Inspect**');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('status snapshots stay in transcript chronology', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 96,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            messages={[
              { id: 'before', role: 'system', content: 'before status' },
              {
                id: 'status',
                role: 'system',
                content: '',
                status: {
                  name: 'checkout',
                  purpose: 'Audit checkout',
                  model: 'openai/gpt-5.5',
                  reasoningEffort: 'high',
                },
              },
              { id: 'after', role: 'system', content: 'after status' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(lineContaining(frame, 'before status')).toBeLessThan(lineContaining(frame, 'Workspace Status'));
      expect(lineContaining(frame, 'Workspace Status')).toBeLessThan(lineContaining(frame, 'after status'));
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('text and tool calls render chronologically interleaved', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      // The transcript order IS the chronological order: text, tool, text, tool.
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            messages={[
              { id: 'a1', role: 'assistant', content: 'FIRST text before the tool' },
              { id: 't1', role: 'tool_call', content: '', toolName: 'read_file' },
              {
                id: 'r1',
                role: 'tool_result',
                content: `command exited 1 ${'detail '.repeat(30)}HIDDEN-TAIL`,
                success: false,
              },
              { id: 'a2', role: 'assistant', content: 'SECOND text after the tool' },
              { id: 't2', role: 'tool_call', content: '', toolName: 'write_file' },
              { id: 'a3', role: 'assistant', content: 'THIRD text after the second tool' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      const at = (needle: string) => frame.indexOf(needle);
      // Each surface lands strictly after the one that preceded it in the stream.
      expect(at('FIRST')).toBeGreaterThanOrEqual(0);
      expect(at('read_file')).toBeGreaterThan(at('FIRST'));
      expect(at('✗ command exited 1')).toBeGreaterThan(at('read_file'));
      expect(at('SECOND')).toBeGreaterThan(at('✗ command exited 1'));
      expect(at('write_file')).toBeGreaterThan(at('SECOND'));
      expect(at('THIRD')).toBeGreaterThan(at('write_file'));
      expect(frame).not.toContain('HIDDEN-TAIL');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('a live assistant segment renders its streaming text in place', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            messages={[
              { id: 't1', role: 'tool_call', content: '', toolName: 'read_file' },
              { id: 'a1', role: 'assistant', content: 'streaming reply in progress', live: true },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      // The live segment sits AFTER the tool it followed, with its text visible.
      expect(frame.indexOf('streaming reply')).toBeGreaterThan(frame.indexOf('read_file'));
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
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
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
      expect(frame).toContain('↪ steered mid-turn');
      // The marker belongs to the steered bubble only.
      expect(frame.split('↪ steered mid-turn')).toHaveLength(2);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });
});

async function renderSettled(renderOnce: () => Promise<void>) {
  for (let index = 0; index < 10; index += 1) {
    await renderOnce();
    await Bun.sleep(30);
  }
}

function lineContaining(frame: string, text: string): number {
  const line = frame.split('\n').findIndex((candidate) => candidate.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
}
