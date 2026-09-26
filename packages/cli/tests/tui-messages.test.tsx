/** @jsxImportSource @opentui/react */
import { TextAttributes, type CapturedSpan, type RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { MessageList } from '../src/tui/messages';
import { BUILTIN_TUI_THEMES, TuiThemeProvider } from '../src/tui/theme';
import { present } from '@kinu.run/test-utils';

const TEST_TUI_BACKGROUND = BUILTIN_TUI_THEMES[0].colors.background.overlay;

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
      expect(frame).toContain('YOU');
      expect(frame).toContain('Review this module');
      const row = frame.split('\n')[lineContaining(frame, 'Review this module')];
      expect(row.indexOf('YOU')).toBeLessThan(row.indexOf('Review this module'));
      expect(row.search(/\S/)).toBeLessThanOrEqual(8);
      expect(frame).not.toContain('KINU');
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
      const frame = await renderSettled(renderOnce, captureCharFrame, ['before status', 'Workspace status', 'after status']);
      expect(lineContaining(frame, 'before status')).toBeLessThan(lineContaining(frame, 'Workspace status'));
      expect(lineContaining(frame, 'Workspace status')).toBeLessThan(lineContaining(frame, 'after status'));
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('text and tool calls render chronologically interleaved', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
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
      expect(frame.split('↪ steered mid-turn')).toHaveLength(2);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  // Code blocks and tool calls carry the dark well under every theme; opentui builds fenced blocks with the
  // markdown renderable's ink and fill, so the well arrives via `useCodeWellRenderer` (src/tui/messages.tsx).
  test('a fenced code block sits on the dark well; the prose around it does not', async () => {
    for (const themeId of ['kinu-light', 'kinu-dark']) {
      const theme = present(BUILTIN_TUI_THEMES.find((candidate) => candidate.id === themeId), 'the theme theme');
      const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 20, useThread: false, maxFps: Number.POSITIVE_INFINITY });
      const root = createRoot(renderer);

      try {
        root.render(
          <TuiThemeProvider selection={{ mode: 'theme', themeId }} colorCapability="truecolor">
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

        const fenced = present(spans.find((span) => span.text.includes('const FENCED')), 'the fenced span');
        const prose = present(spans.find((span) => span.text.includes('PROSELINE')), 'the prose span');
        const rail = present(spans.find((span) => span.text.includes('│')), 'the rail span');
        expect(hex(fenced.bg)).toBe(theme.colors.well.fill);
        expect(hex(fenced.fg)).toBe(theme.colors.well.code);
        expect(hex(rail.bg)).toBe(theme.colors.well.fill);
        expect(hex(rail.fg)).toBe(theme.colors.well.border);
        expect(hex(prose.bg)).not.toBe(theme.colors.well.fill);
        expect(hex(prose.fg)).toBe(theme.colors.text.strong);
      } finally {
        flushSync(() => { root.unmount(); });
        renderer.destroy();
      }
    }
  });

  test('assistant markdown renders: bold is bold, a bullet is a glyph, the markers are gone', async () => {
    // Syntax styles must be keyed by opentui's tree-sitter capture names, not marked's token names.
    const theme = present(BUILTIN_TUI_THEMES.find((candidate) => candidate.id === 'kinu-dark'), 'the kinu-dark theme');
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 20, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <TuiThemeProvider selection={{ mode: 'theme', themeId: 'kinu-dark' }} colorCapability="truecolor">
          <box style={{ width: '100%', height: '100%' }}>
            <MessageList
              messages={[{ id: 'a1', role: 'assistant', content: 'Here is **what works** now:\n\n- Full bash and `git`\n- **GPU** work\n\n1. first\n2. second' }]}
            />
          </box>
        </TuiThemeProvider>,
      );

      const spans = await renderUntil(renderOnce, captureSpans, (frame) => (
        ['what works', 'Full bash', 'second'].every((text) => frame.some((span) => span.text.includes(text)))
      ));

      const text = spans.map((span) => span.text).join('');

      expect(text).not.toContain('**');
      expect(text).toContain('• Full bash');
      expect(text).toContain('• ');
      expect(text).toContain('1. first');
      expect(text).toContain('2. second');
      expect(text).not.toMatch(/^- /m);

      const strong = present(spans.find((span) => span.text.includes('what works')), 'the strong span');
      const plain = present(spans.find((span) => span.text.includes('Here is')), 'the plain span');
      expect(strong.attributes & TextAttributes.BOLD).not.toBe(0);
      expect(plain.attributes & TextAttributes.BOLD).toBe(0);

      const gpu = present(spans.find((span) => span.text.includes('GPU')), 'the gpu span');
      expect(gpu.attributes & TextAttributes.BOLD).not.toBe(0);

      const codespan = present(spans.find((span) => span.text.includes('git')), 'the codespan span');
      expect(hex(codespan.fg)).toBe(theme.colors.intent.accentStrong);

      const bullet = present(spans.find((span) => span.text.startsWith('•')), 'the bullet span');
      expect(hex(bullet.fg)).toBe(theme.colors.intent.accent);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  // The markdown renderable reads its block hook once at construction and React updates it in place, so
  // the theme switch goes through state; re-rendering the root would rebuild it and prove nothing.
  test('a tool result and a reply draw what an escape sequence says, never the sequence', async () => {
    // Text a program or a model wrote reached the terminal raw: its colour codes, a title change or a screen clear
    // acted on the TUI.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            toolDetailsExpanded
            messages={[
              { id: 't1', role: 'tool_call', content: '', toolName: 'bash', args: 'make \u001b[2J' },
              { id: 'r1', role: 'tool_result', content: '\u001b[31mbuild red\u001b[0m\u001b]0;pwned\u0007\n50%\r100% done\u0007', success: true },
              { id: 'a1', role: 'assistant', content: 'reply \u001b[1mbold\u001b[0m\u001b[H' },
            ]}
          />
        </box>,
      );
      const frame = await renderSettled(renderOnce, captureCharFrame, ['build red', '100% done', 'reply bold']);

      expect(frame).toContain('build red');
      expect(frame).toContain('100% done\u2407');
      expect(frame).not.toContain('50%');
      expect(frame).not.toContain('pwned');
      expect(frame).toContain('reply bold');
      expect(frame.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('a collapsed tool result stays on one row whatever its characters\' width', async () => {
    // One cell per character (ASCII), two (CJK, emoji), and an emoji that is two UTF-16 units: the preview is cut
    // to the row's columns, never past them, and never through a character.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    const results = { narrow: 'n'.repeat(200), wide: '表'.repeat(200), emoji: '😀'.repeat(200) };

    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
          <MessageList
            messages={Object.entries(results).flatMap(([name, content]) => [
              { id: `c-${name}`, role: 'tool_call' as const, content: '', toolName: name, args: name },
              { id: `r-${name}`, role: 'tool_result' as const, content, success: true },
            ])}
          />
        </box>,
      );
      const frame = await renderSettled(renderOnce, captureCharFrame, ['nnn', '表表', '😀']);
      const rows = frame.split('\n');

      for (const glyph of ['n', '表', '😀']) {
        const holding = rows.filter((row) => row.includes(glyph.repeat(2)));
        expect(holding).toHaveLength(1);
        expect(holding[0]).toContain('…');
      }

      expect(frame).not.toContain('\ufffd');
      expect(frame).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('the code well follows a live theme switch', async () => {
    const contrast = present(BUILTIN_TUI_THEMES.find((candidate) => candidate.id === 'high-contrast'), 'the high-contrast theme');
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 16, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    let pick: (themeId: string) => void = () => undefined;

    function Transcript() {
      const [themeId, setThemeId] = useState('kinu-light');
      pick = setThemeId;

      return (
        <TuiThemeProvider selection={{ mode: 'theme', themeId }} colorCapability="truecolor">
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

      const fenced = present(spans.find((span) => span.text.includes('const FENCED')), 'the fenced span');
      expect(hex(fenced.bg)).toBe(contrast.colors.well.fill);
      expect(hex(fenced.fg)).toBe(contrast.colors.well.code);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
});

/**
 * opentui paints markdown prose only after its grammar loads asynchronously, so wait for the asserted
 * text rather than a frame count.
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
