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
  contrastRatio,
  createThemeRegistry,
  themeContrastPairs,
} from '../src/tui/theme';

const TUI_SOURCES = join(import.meta.dir, '..', 'src', 'tui');

/** Terminal grounds a transparent theme meets in the wild, for the blind-spot print. */
const MID_TONE_TERMINALS = {
  dark: { 'Nord #2E3440': '#2E3440', 'Dracula #282A36': '#282A36', 'Solarized dark #002B36': '#002B36' },
  light: { 'Solarized light #FDF6E3': '#FDF6E3', 'GitHub light #FFFFFF': '#FFFFFF' },
} as const;

describe('TUI theme', () => {
  test('a missing preference file follows the terminal; an existing file keeps its choice', () => {
    const path = join(scratchDir('tui-theme-prefs'), 'tui.json');
    const store = createFileTuiPreferenceStore(path);
    expect(store.read().theme).toEqual({ mode: 'system', darkThemeId: 'kinu-dark', lightThemeId: 'kinu-light' });
    expect(DEFAULT_TUI_THEME_SELECTION).toEqual(store.read().theme);

    store.write({ ...store.read(), theme: { mode: 'theme', themeId: 'kinu-dusk' } });
    expect(createFileTuiPreferenceStore(path).read().theme).toEqual({ mode: 'theme', themeId: 'kinu-dusk' });
  });

  test('every preset passes the contrast gate, and the numbers are printed', () => {
    const registry = createThemeRegistry(BUILTIN_TUI_THEMES);
    expect(registry.themes.map((theme) => theme.id)).toEqual([
      'kinu-light', 'kinu-dark', 'kinu-dusk', 'kinu-light-solid', 'kinu-dark-solid', 'kinu-paper', 'high-contrast',
    ]);
    const lines: string[] = [];
    for (const theme of registry.themes) {
      const pairs = themeContrastPairs(theme);
      expect(pairs.length).toBeGreaterThan(40);
      for (const pair of pairs) {
        expect(pair.ratio, `${theme.id} ${pair.label}`).toBeGreaterThanOrEqual(pair.minimum);
      }
      const primaryOnUser = pairs.find((pair) => pair.label === 'text.strong/background.user')!;
      const onAccent = pairs.find((pair) => pair.label === 'text.onAccent/background.accent')!;
      const worst = [...pairs].sort((left, right) => left.ratio / left.minimum - right.ratio / right.minimum)[0]!;
      lines.push(`${theme.id}: ${String(pairs.length)} pairs · bubble ink ${primaryOnUser.ratio.toFixed(2)} · ink on gold ${onAccent.ratio.toFixed(2)} · tightest ${worst.label} ${worst.ratio.toFixed(2)}≥${String(worst.minimum)}`);
      if (theme.colors.background.canvas === undefined) {
        // Blind spot, printed on the green path: the gate measures the web
        // canvas and the extreme, never the mid-tone terminals in between.
        const grounds = MID_TONE_TERMINALS[theme.appearance];
        const dim = Object.entries(grounds).map(([name, ground]) => `${name} ${contrastRatio(theme.colors.text.muted, ground).toFixed(2)}`);
        lines.push(`  not gated — text.muted on ${dim.join(', ')}`);
      }
    }
    console.log(lines.join('\n'));
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
      for (let index = 0; index < 10; index += 1) {
        await renderOnce();
        await Bun.sleep(20);
      }
      const spans = captureSpans().lines.flatMap((line) => line.spans);
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
