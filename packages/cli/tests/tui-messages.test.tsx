/** @jsxImportSource @opentui/react */
import type { CapturedSpan, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { MessageList } from '../src/tui/messages';
import { BUILTIN_TUI_THEMES, TuiThemeProvider } from '../src/tui/theme';

const TEST_TUI_BACKGROUND = BUILTIN_TUI_THEMES[0]!.colors.background.overlay;

describe('TUI transcript rendering', () => {
  test('the user turn carries the YOU gutter, left-aligned; assistant markdown stays unprefixed', async () => {
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['Review this module', 'Plan', 'Inspect']);
      // The TUI marks the speaker the way the landing preview does: a YOU
      // gutter on a left turn, never a right bubble and never an agent label.
      expect(frame).toContain('YOU');
      expect(frame).toContain('Review this module');
      const row = frame.split('\n')[lineContaining(frame, 'Review this module')]!;
      expect(row.indexOf('YOU')).toBeLessThan(row.indexOf('Review this module'));
      expect(row.search(/\S/)).toBeLessThanOrEqual(8);
      expect(frame).not.toContain('KINU');
      // No bubble edge anywhere on this transcript: the user row is plain.
      expect(frame).not.toContain('╭');
      expect(frame).toContain('Plan');
      expect(frame).toContain('Inspect');
      expect(frame).not.toContain('**Inspect**');
    } finally {
      flushSync(() => { root.unmount(); });
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['before status', 'Workspace Status', 'after status']);
      expect(lineContaining(frame, 'before status')).toBeLessThan(lineContaining(frame, 'Workspace Status'));
      expect(lineContaining(frame, 'Workspace Status')).toBeLessThan(lineContaining(frame, 'after status'));
    } finally {
      flushSync(() => { root.unmount(); });
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['FIRST', 'read_file', '✗ command exited 1', 'SECOND', 'write_file', 'THIRD']);
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
      flushSync(() => { root.unmount(); });
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['read_file', 'streaming reply']);
      // The live segment sits AFTER the tool it followed, with its text visible.
      expect(frame.indexOf('streaming reply')).toBeGreaterThan(frame.indexOf('read_file'));
    } finally {
      flushSync(() => { root.unmount(); });
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['use staging instead', '↪ steered mid-turn']);
      expect(frame).toContain('use staging instead');
      expect(frame).toContain('↪ steered mid-turn');
      // The marker belongs to the steered bubble only.
      expect(frame.split('↪ steered mid-turn')).toHaveLength(2);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  // The owner's rule: code blocks and tool calls carry the dark well, under every
  // theme. opentui builds a fenced block's CodeRenderable with the markdown
  // renderable's own ink and fill, so the well arrives through the block hook
  // (`useCodeWellRenderer` in src/tui/messages.tsx).
  test('a fenced code block sits on the dark well; the prose around it does not', async () => {
    for (const themeId of ['kinu-light', 'kinu-dark']) {
      const theme = BUILTIN_TUI_THEMES.find((candidate) => candidate.id === themeId)!;
      const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 20, useThread: false, maxFps: Number.POSITIVE_INFINITY });
      const root = createRoot(renderer);
      try {
        root.render(
          <TuiThemeProvider selection={{ mode: 'theme', themeId }} terminalAppearance={theme.appearance} colorCapability="truecolor">
            <box style={{ width: '100%', height: '100%' }}>
              <MessageList
                messages={[{ id: 'a1', role: 'assistant', content: 'PROSELINE around the block\n\n```ts\nconst FENCED = 1;\n```' }]}
              />
            </box>
          </TuiThemeProvider>,
        );
        const spans = await renderUntil(renderOnce, captureSpans, (frame) => (
          ['PROSELINE', 'const FENCED'].every((text) => frame.some((span) => span.text.includes(text)))
        ));
        const fenced = spans.find((span) => span.text.includes('const FENCED'))!;
        const prose = spans.find((span) => span.text.includes('PROSELINE'))!;
        const rail = spans.find((span) => span.text.includes('│'))!;
        expect(hex(fenced.bg)).toBe(theme.colors.well.fill);
        expect(hex(fenced.fg)).toBe(theme.colors.well.code);
        // A single rail keeps the well's grouping without framing prose in chrome.
        expect(hex(rail.bg)).toBe(theme.colors.well.fill);
        expect(hex(rail.fg)).toBe(theme.colors.well.border);
        // Prose keeps the canvas and the ink register.
        expect(hex(prose.bg)).not.toBe(theme.colors.well.fill);
        expect(hex(prose.fg)).toBe(theme.colors.text.strong);
      } finally {
        flushSync(() => { root.unmount(); });
        renderer.destroy();
      }
    }
  });

  // The picker switches themes while the transcript stands, and it switches
  // through state: React updates the markdown renderable in place rather than
  // building a new one, and that renderable read its block hook once, at
  // construction. The well still has to follow the theme in force. (Re-rendering
  // the root instead would rebuild the renderable and prove nothing.)
  test('the code well follows a live theme switch', async () => {
    const contrast = BUILTIN_TUI_THEMES.find((candidate) => candidate.id === 'high-contrast')!;
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 16, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    let pick: (themeId: string) => void = () => undefined;
    function Transcript() {
      const [themeId, setThemeId] = useState('kinu-light');
      pick = setThemeId;
      return (
        <TuiThemeProvider selection={{ mode: 'theme', themeId }} terminalAppearance={themeId === 'kinu-light' ? 'light' : 'dark'} colorCapability="truecolor">
          <box style={{ width: '100%', height: '100%' }}>
            <MessageList messages={[{ id: 'a1', role: 'assistant', content: 'PROSELINE\n\n```ts\nconst FENCED = 1;\n```' }]} />
          </box>
        </TuiThemeProvider>
      );
    }
    try {
      root.render(<Transcript />);
      await renderUntil(renderOnce, captureSpans, (frame) => frame.some((span) => span.text.includes('const FENCED')));
      pick('high-contrast');
      const spans = await renderUntil(renderOnce, captureSpans, (frame) => (
        frame.some((span) => span.text.includes('const FENCED') && hex(span.bg) === contrast.colors.well.fill)
      ));
      const fenced = spans.find((span) => span.text.includes('const FENCED'))!;
      expect(hex(fenced.bg)).toBe(contrast.colors.well.fill);
      expect(hex(fenced.fg)).toBe(contrast.colors.well.code);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
});

/**
 * A frame count is not a settled frame: opentui paints markdown prose only once
 * its grammar has loaded and highlighted, which is asynchronous, and a React
 * update lands a frame or two after that. Render until every text the
 * assertions read is on screen, then hand the frame over and let them speak —
 * a frame that never arrives fails the same assertion it always did.
 */
async function renderSettled(
  renderOnce: () => Promise<void>,
  captureCharFrame: () => string,
  texts: readonly string[],
): Promise<string> {
  let frame = '';
  for (let index = 0; index < 60; index += 1) {
    await renderOnce();
    frame = captureCharFrame();
    if (texts.every((text) => frame.includes(text))) break;
    await Bun.sleep(30);
  }
  return frame;
}

/** The same wait, read over captured spans rather than characters. */
async function renderUntil(
  renderOnce: () => Promise<void>,
  captureSpans: () => { lines: { spans: CapturedSpan[] }[] },
  ready: (spans: CapturedSpan[]) => boolean,
): Promise<CapturedSpan[]> {
  let spans: CapturedSpan[] = [];
  for (let index = 0; index < 60; index += 1) {
    await renderOnce();
    spans = captureSpans().lines.flatMap((line) => line.spans);
    if (ready(spans)) break;
    await Bun.sleep(30);
  }
  return spans;
}

function hex(color: RGBA): string {
  const [red, green, blue] = color.toInts();
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function lineContaining(frame: string, text: string): number {
  const line = frame.split('\n').findIndex((candidate) => candidate.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
}
