/** @jsxImportSource @opentui/react */
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { present, scratchDir } from '@kinu.run/test-utils';

import { MessageList } from '../src/tui/messages';
import { PhaseLine, ThemePickerOverlay } from '../src/tui/overlays';
import { createFileTuiPreferenceStore } from '../src/tui/preferences';
import {
  BUILTIN_TUI_THEMES,
  useTuiTheme,
  TuiThemeProvider,
  createThemeRegistry, DEFAULT_TUI_THEME_SELECTION, type ThemeSelection,
} from '../src/tui/theme';

const MID_TONE_TERMINALS = {
  dark: { 'Nord #2E3440': '#2E3440', 'Dracula #282A36': '#282A36', 'Solarized dark #002B36': '#002B36' },
  light: { 'Solarized light #FDF6E3': '#FDF6E3', 'GitHub light #FFFFFF': '#FFFFFF' },
} as const;

/** WCAG 2.x arithmetic owned by this test, so the palette is not judged by the registry's own math. */
function luminance(hex: string): number {
  const channel = (index: number): number => {
    const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;

    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);

  return (light + 0.05) / (dark + 0.05);
}

function hexOf(color: { toInts(): [number, number, number, number] }): string {
  const [red, green, blue] = color.toInts();

  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

describe('TUI theme', () => {
  test('the theme picker renders and commits the selected shared default', async () => {
    const { renderer, mockInput, waitForFrame, captureCharFrame } = await createTestRenderer({ width: 100, height: 32, useThread: false });
    const root = createRoot(renderer);
    const selected = Promise.withResolvers<ThemeSelection>();
    const theme = createThemeRegistry(BUILTIN_TUI_THEMES).get(DEFAULT_TUI_THEME_SELECTION.themeId);

    try {
      flushSync(() => root.render(
        <TuiThemeProvider>
          <ThemePickerOverlay terminal={{ width: 100, height: 32 }} selection={DEFAULT_TUI_THEME_SELECTION} onSelect={selected.resolve} />
        </TuiThemeProvider>,
      ));
      renderer.start();
      await waitForFrame(() => captureCharFrame().includes(theme.label));
      mockInput.pressEnter();
      expect(await selected.promise).toEqual(DEFAULT_TUI_THEME_SELECTION);
    } finally {
      flushSync(() => root.unmount());
      renderer.destroy();
    }
  });

  test('a missing preference file holds no theme; an existing file keeps its choice', async () => {
    const path = join(scratchDir('tui-theme-prefs'), 'tui.json');
    const store = createFileTuiPreferenceStore(path);
    expect(store.read().theme).toBeUndefined();
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 4, useThread: false });
    const root = createRoot(renderer);

    function DefaultThemeProbe() {
      const { definition } = useTuiTheme();

      return <text>{definition.id}</text>;
    }

    try {
      flushSync(() => root.render(<TuiThemeProvider><DefaultThemeProbe /></TuiThemeProvider>));
      await renderOnce();
      expect(captureCharFrame().trim()).toBe('kinu-dark-solid');
    } finally {
      flushSync(() => root.unmount());
      renderer.destroy();
    }

    for (const id of ['kinu-dark-solid', 'kinu-light-solid']) {
      const theme = BUILTIN_TUI_THEMES.find((candidate) => candidate.id === id);

      if (theme === undefined) throw new Error(`missing preset ${id}`);
      // An undefined or transparent ground leaves the panel edgeless.
      const { background } = theme.colors;
      expect(background.canvas, `${id} canvas`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(background.chrome, `${id} chrome`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(background.surface, `${id} surface`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }

    store.write({ ...store.read(), theme: { mode: 'theme', themeId: 'kinu-dusk' } });
    expect(createFileTuiPreferenceStore(path).read().theme).toEqual({ mode: 'theme', themeId: 'kinu-dusk' });
  });

  test('every preset passes the registry contrast gate, and the numbers are printed', () => {
    // The registry refuses sub-WCAG presets at module load, so their presence is the assertion;
    // ratios print because a floor says nothing about the margin.
    const registry = createThemeRegistry(BUILTIN_TUI_THEMES);
    expect(registry.themes.map((theme) => theme.id)).toEqual([
      'kinu-light-solid', 'kinu-dark-solid', 'kinu-light', 'kinu-dark', 'kinu-dusk', 'kinu-paper', 'high-contrast',
    ]);
    const lines: string[] = [];

    for (const theme of registry.themes) {
      const { text, background } = theme.colors;
      const bubble = contrast(text.strong, background.user);
      const onAccent = contrast(text.onAccent, background.accent);
      expect(bubble, `${theme.id} bubble ink`).toBeGreaterThanOrEqual(4.5);
      expect(onAccent, `${theme.id} ink on accent`).toBeGreaterThanOrEqual(4.5);
      lines.push(`${theme.id}: bubble ink ${bubble.toFixed(2)} · ink on accent ${onAccent.toFixed(2)}`);

      if (background.canvas === undefined) {
        // Blind spot: the gate measures the web canvas and the extreme, never mid-tone terminals.
        const grounds = MID_TONE_TERMINALS[theme.appearance];
        const dim = Object.entries(grounds).map(([name, ground]) => `${name} ${contrast(text.muted, ground).toFixed(2)}`);
        lines.push(`  not gated — text.muted on ${dim.join(', ')}`);
      }
    }

    console.log(lines.join('\n'));
  });

  test('the registry refuses a theme whose ink vanishes into its own ground, naming the pair', () => {
    const [light] = BUILTIN_TUI_THEMES;

    const invisible = {
      ...light,
      id: 'invisible-ink',
      colors: { ...light.colors, text: { ...light.colors.text, strong: light.colors.background.user } },
    };

    expect(() => createThemeRegistry([invisible])).toThrow(/text\.strong\/background\.user contrast/);
  });

  test('under Kinu light the user turn carries the accent gutter on the canvas and the assistant turn avoids the user fill', async () => {
    const light = present(BUILTIN_TUI_THEMES.find((theme) => theme.id === 'kinu-light'), 'the kinu-light theme');
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 16, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <TuiThemeProvider selection={{ mode: 'theme', themeId: 'kinu-light' }} colorCapability="truecolor">
          <box style={{ width: '100%', height: '100%' }}>
            <MessageList
              messages={[
                { id: 'u1', role: 'user', content: 'USERTURN' },
                { id: 'a1', role: 'assistant', content: 'ASSISTANTTURN' },
                { id: 't1', role: 'tool_call', content: '', toolName: 'exec', args: '{"cmd":"bun test"}' },
              ]}
            />
          </box>
        </TuiThemeProvider>,
      );
      // opentui paints markdown prose only after an async grammar load: wait for the spans read below.
      let spans = captureSpans().lines.flatMap((line) => line.spans);

      for (let index = 0; index < 60; index += 1) {
        await renderOnce();
        spans = captureSpans().lines.flatMap((line) => line.spans);

        if (['USERTURN', 'ASSISTANTTURN', 'exec'].every((text) => spans.some((span) => span.text.includes(text)))) break;
        await Bun.sleep(20);
      }

      const gutter = present(spans.find((span) => span.text.includes('YOU')), 'the gutter span');
      const user = present(spans.find((span) => span.text.includes('USERTURN')), 'the user span');
      const assistant = present(spans.find((span) => span.text.includes('ASSISTANTTURN')), 'the assistant span');
      const tool = present(spans.find((span) => span.text.includes('exec')), 'the tool span');
      expect(hexOf(gutter.fg)).toBe(light.colors.intent.accent);
      expect(hexOf(user.fg)).toBe(light.colors.text.strong);
      expect(hexOf(user.bg)).not.toBe(light.colors.background.user);
      expect(hexOf(assistant.bg)).not.toBe(light.colors.background.user);
      expect(hexOf(assistant.fg)).toBe(light.colors.text.strong);
      expect(hexOf(tool.bg)).toBe(light.colors.well.fill);
      expect(hexOf(tool.fg)).toBe(light.colors.well.ink);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('each transcript role resolves its own ink: prose in ink, thinking muted and italic, notes muted', async () => {
    const dark = present(BUILTIN_TUI_THEMES.find((theme) => theme.id === 'kinu-dark-solid'), 'the kinu-dark-solid theme');
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 20, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <TuiThemeProvider selection={{ mode: 'theme', themeId: 'kinu-dark-solid' }} colorCapability="truecolor">
          <box style={{ width: '100%', height: '100%' }}>
            <MessageList
              messages={[
                { id: 'u1', role: 'user', content: 'USERTURN' },
                { id: 'a1', role: 'assistant', content: 'PROSETURN' },
                { id: 's1', role: 'system', content: 'SYSTEMNOTE' },
              ]}
            />
            <PhaseLine label="THINKINGLABEL" />
          </box>
        </TuiThemeProvider>,
      );
      const wanted = ['USERTURN', 'PROSETURN', 'SYSTEMNOTE', 'THINKINGLABEL'];
      let spans = captureSpans().lines.flatMap((line) => line.spans);

      for (let index = 0; index < 60; index += 1) {
        await renderOnce();
        spans = captureSpans().lines.flatMap((line) => line.spans);

        if (wanted.every((text) => spans.some((span) => span.text.includes(text)))) break;
        await Bun.sleep(20);
      }

      const span = (text: string) => present(spans.find((candidate) => candidate.text.includes(text)), `the ${text} span`);
      const { text } = dark.colors;
      expect(hexOf(span('USERTURN').fg)).toBe(text.strong);
      expect(hexOf(span('PROSETURN').fg)).toBe(text.strong);
      expect(hexOf(span('SYSTEMNOTE').fg)).toBe(text.muted);
      const thinking = span('THINKINGLABEL');
      expect(hexOf(thinking.fg)).toBe(text.muted);
      expect(thinking.attributes & TextAttributes.ITALIC).not.toBe(0);
      expect(text.strong).not.toBe(text.muted);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
});
