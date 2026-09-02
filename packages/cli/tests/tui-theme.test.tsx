/** @jsxImportSource @opentui/react */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { scratchDir } from '@kinu.run/test-utils';

import { MessageList } from '../src/tui/messages';
import { createFileTuiPreferenceStore } from '../src/tui/preferences';
import {
  BUILTIN_TUI_THEMES,
  DEFAULT_TUI_THEME_SELECTION,
  TuiThemeProvider,
  createThemeRegistry,
} from '../src/tui/theme';

const TUI_SOURCES = join(import.meta.dir, '..', 'src', 'tui');

/** Terminal grounds a transparent theme meets in the wild, for the blind-spot print. */
const MID_TONE_TERMINALS = {
  dark: { 'Nord #2E3440': '#2E3440', 'Dracula #282A36': '#282A36', 'Solarized dark #002B36': '#002B36' },
  light: { 'Solarized light #FDF6E3': '#FDF6E3', 'GitHub light #FFFFFF': '#FFFFFF' },
} as const;

/** WCAG 2.x relative luminance and contrast, owned by this test so the palette
 *  is judged against the standard's arithmetic rather than the registry's own. */
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

describe('TUI theme', () => {
  test('a missing preference file follows the terminal; an existing file keeps its choice', () => {
    const path = join(scratchDir('tui-theme-prefs'), 'tui.json');
    const store = createFileTuiPreferenceStore(path);
    expect(store.read().theme).toEqual({ mode: 'system', darkThemeId: 'kinu-dark', lightThemeId: 'kinu-light' });
    expect(DEFAULT_TUI_THEME_SELECTION).toEqual(store.read().theme);

    store.write({ ...store.read(), theme: { mode: 'theme', themeId: 'kinu-dusk' } });
    expect(createFileTuiPreferenceStore(path).read().theme).toEqual({ mode: 'theme', themeId: 'kinu-dusk' });
  });

  test('every preset passes the registry contrast gate, and the numbers are printed', () => {
    // The registry refuses any theme whose ink does not reach the WCAG floor
    // over the grounds it is drawn on — presets included, at module load. So
    // the presets standing here IS the assertion; the ratios are printed on
    // the green path because a floor says nothing about the margin.
    const registry = createThemeRegistry(BUILTIN_TUI_THEMES);
    expect(registry.themes.map((theme) => theme.id)).toEqual([
      'kinu-light', 'kinu-dark', 'kinu-dusk', 'kinu-light-solid', 'kinu-dark-solid', 'kinu-paper', 'high-contrast',
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
        // Blind spot, printed on the green path: the gate measures the web
        // canvas and the extreme, never the mid-tone terminals in between.
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

  test('under Kinu light a user turn sits on the user fill and the assistant turn does not', async () => {
    const light = BUILTIN_TUI_THEMES.find((theme) => theme.id === 'kinu-light')!;
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 80, height: 16, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <TuiThemeProvider selection={{ mode: 'theme', themeId: 'kinu-light' }} terminalAppearance="light" colorCapability="truecolor">
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
      // opentui paints markdown prose only after an async grammar load, so a
      // frame count is not a settled frame: wait for the spans read below.
      let spans = captureSpans().lines.flatMap((line) => line.spans);
      for (let index = 0; index < 60; index += 1) {
        await renderOnce();
        spans = captureSpans().lines.flatMap((line) => line.spans);
        if (['USERTURN', 'ASSISTANTTURN', 'exec'].every((text) => spans.some((span) => span.text.includes(text)))) break;
        await Bun.sleep(20);
      }
      const hex = (color: { toInts(): [number, number, number, number] }) => {
        const [red, green, blue] = color.toInts();
        return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
      };
      const user = spans.find((span) => span.text.includes('USERTURN'))!;
      const assistant = spans.find((span) => span.text.includes('ASSISTANTTURN'))!;
      const tool = spans.find((span) => span.text.includes('exec'))!;
      expect(hex(user.bg)).toBe(light.colors.background.user);
      expect(hex(user.fg)).toBe(light.colors.text.strong);
      expect(hex(assistant.bg)).not.toBe(light.colors.background.user);
      expect(hex(assistant.fg)).toBe(light.colors.text.primary);
      // The tool card is the dark well, even under the light theme.
      expect(hex(tool.bg)).toBe(light.colors.well.fill);
      expect(hex(tool.fg)).toBe(light.colors.well.ink);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('no colour literal lives outside the theme registry', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(TUI_SOURCES)) {
      if (name === 'theme.ts' || !/\.tsx?$/u.test(name)) continue;
      const source = readFileSync(join(TUI_SOURCES, name), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/#[0-9A-Fa-f]{6}\b|\b(?:fg|bg|color|backgroundColor|borderColor)=?["'\s:]+(?:red|green|blue|yellow|cyan|magenta|white|black|gr[ae]y)\b/u.test(line)) {
          offenders.push(`${name}:${String(index + 1)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
