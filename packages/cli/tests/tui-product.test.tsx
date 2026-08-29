/** @jsxImportSource @opentui/react */
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { scratchDir } from '@kinu.run/test-utils';
import { TUI_ADVERTISED_HINTS, TUI_MARKS } from '@kinu.run/core';

import {
  KEYMAP_PRESET_IDS,
  createKeybindingRegistry,
  createKeyDispatcher,
  type KeybindingRegistry,
  type TuiKeyEvent,
  type KeyScope,
  type TuiActionId,
} from '../src/tui/actions';
import {
  BUILTIN_TUI_THEMES,
  TuiThemeProvider,
  createThemeRegistry,
  parseCustomTheme,
  useTuiTheme,
  type ThemeAppearance,
  type ThemeSelection,
  type TuiThemeDefinition,
} from '../src/tui/theme';
import { createFileTuiPreferenceStore } from '../src/tui/preferences';
import {
  TuiProductProvider,
  TuiShell,
  agentSourceFromList,
  tuiLayoutForWidth,
  useAgentRoster,
} from '../src/tui/tui-shell';

const key = (name: string, modifiers: Partial<TuiKeyEvent> = {}): TuiKeyEvent => ({
  name,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...modifiers,
});

/** What the app's own dispatcher resolves a stroke to. Every TUI surface feeds
 *  keys through `createKeyDispatcher`, so the keymap is asserted at the seam the
 *  product actually uses rather than at a resolver behind it. */
const resolve = (
  registry: KeybindingRegistry,
  event: TuiKeyEvent,
  scopes: readonly KeyScope[],
): TuiActionId | null => createKeyDispatcher(registry).feed(event, scopes).actionId;

const EDITING: readonly KeyScope[] = ['editor', 'conversation', 'global'];

describe('TUI product registries', () => {
  test('every keymap preset binds the same semantic actions and pi-omp is the default', () => {
    expect(KEYMAP_PRESET_IDS).toEqual(['pi-omp', 'kinu', 'opencode']);
    const registries = KEYMAP_PRESET_IDS.map((presetId) => createKeybindingRegistry({ presetId }));
    expect(registries[0]!.presetId).toBe('pi-omp');
    expect(registries.map((registry) => [...registry.actionIds].sort())).toEqual([
      [...registries[0]!.actionIds].sort(),
      [...registries[0]!.actionIds].sort(),
      [...registries[0]!.actionIds].sort(),
    ]);
  });

  test('scope priority chooses the focused action and disjoint duplicate chords remain legal', () => {
    const registry = createKeybindingRegistry({
      presetId: 'pi-omp',
      overrides: {
        'modal.close': ['escape'],
        'conversation.cancel': ['escape'],
      },
    });
    expect(resolve(registry, key('escape'), ['modal', 'conversation', 'global'])).toBe('modal.close');
    expect(resolve(registry, key('escape'), ['conversation', 'global'])).toBe('conversation.cancel');
  });

  test('overlapping key conflicts are rejected with both action ids', () => {
    expect(() => createKeybindingRegistry({
      presetId: 'pi-omp',
      overrides: {
        'conversation.cancel': ['ctrl+x'],
        'conversation.branch': ['ctrl+x'],
      },
    })).toThrow(/conversation\.cancel.*conversation\.branch|conversation\.branch.*conversation\.cancel/);
  });

  test('pi-omp keeps editor conventions and the approved hub shortcuts', () => {
    const registry = createKeybindingRegistry({ presetId: 'pi-omp' });
    expect(resolve(registry, key('o', { ctrl: true }), EDITING)).toBe('tool.toggle');
    expect(resolve(registry, key('g', { ctrl: true }), EDITING)).toBe('editor.external');
    expect(resolve(registry, key('tab', { shift: true }), EDITING)).toBe('effort.cycle');
    expect(resolve(registry, key('p', { ctrl: true }), EDITING)).toBe('tier.cycle');
    expect(resolve(registry, key('p', { ctrl: true, shift: true }), EDITING)).toBe('tier.cycle-reverse');
    expect(resolve(registry, key('p', { alt: true }), EDITING)).toBe('tier.quick');
    expect(resolve(registry, key('a', { alt: true }), EDITING)).toBe('hub.agents');
    expect(resolve(registry, key('l', { ctrl: true }), EDITING)).toBe('model.open');
    expect(resolve(registry, key('w', { alt: true }), EDITING)).toBe('workspace.toggle');
    expect(resolve(registry, key('tab'), EDITING)).not.toBe('queue.add');
    expect(resolve(registry, key('b', { ctrl: true }), EDITING)).not.toBe('conversation.branch');
  });

  test('the advertised hints resolve on the default keymap exactly as stated', () => {
    // TUI_ADVERTISED_HINTS is what marketing surfaces (the landing page's
    // terminal demo) print as the product's keybindings. The default preset
    // must actually bind them, or the demo advertises keys that do nothing.
    const registry = createKeybindingRegistry({ presetId: 'pi-omp' });
    for (const { action, keys } of TUI_ADVERTISED_HINTS) {
      expect(registry.hint(action)).toBe(keys);
    }
  });

  test('navigator rows draw activity through the shared contract', async () => {
    // TUI_MARKS.activity is the one activity vocabulary: the real navigator
    // consumes it here, and the landing page's terminal demo imports the same
    // constant, so the two surfaces cannot disagree about what running looks
    // like. Connection marks stay the StatusBar's separate contract.
    const source = agentSourceFromList(() => [
      { name: 'worker', label: 'worker', mode: 'local', status: 'running', cwd: '/tmp/kinu-activity-probe' },
      { name: 'resting', label: 'resting', mode: 'local', status: 'idle', cwd: '/tmp/kinu-activity-probe' },
    ]);
    function Probe() {
      const roster = useAgentRoster(source);
      return (
        <TuiShell scene="chat" roster={roster} navigationOverlayOpen={false} onNavigationOverlayChange={() => {}}>
          <text>scene</text>
        </TuiShell>
      );
    }
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 20,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    try {
      root.render(<TuiProductProvider><Probe /></TuiProductProvider>);
      for (let pass = 0; pass < 200; pass += 1) {
        await renderOnce();
        if (captureCharFrame().includes('resting')) break;
        await Bun.sleep(10);
      }
      const frame = captureCharFrame();
      expect(frame).toContain(`${TUI_MARKS.activity.running} worker`);
      expect(frame).toContain(`${TUI_MARKS.activity.idle} resting`);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('every built-in theme meets contrast, and one that does not is refused', () => {
    expect(() => createThemeRegistry(BUILTIN_TUI_THEMES)).not.toThrow();

    const dark = BUILTIN_TUI_THEMES.find((theme) => theme.id === 'kinu-dark')!;
    const invisible: TuiThemeDefinition = {
      ...dark,
      id: 'invisible',
      colors: {
        ...dark.colors,
        text: { ...dark.colors.text, primary: dark.colors.background.canvas },
      },
    };
    expect(() => createThemeRegistry([invisible])).toThrow(/text\.primary\/background\.canvas contrast/);
  });

  test('a system theme selection follows the terminal appearance', async () => {
    for (const [appearance, expected] of [['dark', 'kinu-dark'], ['light', 'kinu-light']] as const) {
      const themeId = await renderedThemeId(appearance);
      expect(themeId).toBe(expected);
    }
  });

  test('a selection naming a theme that is gone paints the default instead of crashing', async () => {
    // `tui.json` is hand-editable and its schema can only check that `themeId`
    // is a non-empty string, so a deleted or renamed custom theme leaves a live
    // selection pointing at nothing. That threw inside the provider's useMemo
    // and took the whole TUI down at first render.
    expect(await renderedThemeId('dark', { mode: 'theme', themeId: 'deleted-custom-theme' }))
      .toBe('kinu-dark');
    expect(await renderedThemeId('light', { mode: 'theme', themeId: 'deleted-custom-theme' }))
      .toBe('kinu-light');
  });

  test('custom themes reject malformed colors and unknown fields', () => {
    const valid = JSON.stringify({
      id: 'paper-custom',
      label: 'Paper custom',
      appearance: 'light',
      colors: BUILTIN_TUI_THEMES.find((theme) => theme.id === 'kinu-light')!.colors,
    });
    expect(parseCustomTheme(valid, 'paper-custom.json').id).toBe('paper-custom');
    expect(() => parseCustomTheme(valid.replace('"canvas":"#', '"canvas":"nope#'), 'broken.json')).toThrow(/canvas/);
    expect(() => parseCustomTheme(valid.replace('"appearance":"light"', '"appearance":"light","surprise":true'), 'unknown.json')).toThrow(/surprise/);
  });
});


describe('adaptive TUI shell', () => {
  test('layout thresholds follow the sidebar plus conversation budget', () => {
    expect([40, 80, 120, 160].map(tuiLayoutForWidth)).toEqual(['narrow', 'medium', 'wide', 'wide']);
  });

  test('wide sidebar preference persists through a new provider', () => {
    const path = join(scratchDir('tui-prefs'), 'tui.json');
    const store = createFileTuiPreferenceStore(path);
    expect(store.read().wideSidebarOpen).toBe(true);
    store.write({ ...store.read(), wideSidebarOpen: false });
    // A second store on the same file is what a restarted TUI holds: the saved
    // shape has to survive the parse the reader puts it through.
    expect(createFileTuiPreferenceStore(path).read().wideSidebarOpen).toBe(false);
  });
});


/** The theme the provider hands its children for a system selection, read the
 *  way every TUI surface reads it — through `useTuiTheme` under a mounted
 *  provider, so the terminal-appearance resolution really runs. */
async function renderedThemeId(
  appearance: ThemeAppearance,
  selection: ThemeSelection = { mode: 'system', darkThemeId: 'kinu-dark', lightThemeId: 'kinu-light' },
): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 40,
    height: 4,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });
  const root = createRoot(renderer);
  try {
    root.render(
      <TuiThemeProvider
        registry={createThemeRegistry(BUILTIN_TUI_THEMES)}
        selection={selection}
        terminalAppearance={appearance}
        colorCapability="truecolor"
      >
        <ActiveThemeProbe />
      </TuiThemeProvider>,
    );
    for (let pass = 0; pass < 40; pass += 1) {
      await renderOnce();
      const marked = captureCharFrame().split('theme=')[1];
      if (marked !== undefined && marked.trim() !== '') return marked.trimEnd();
      await Bun.sleep(5);
    }
    throw new Error(`the theme probe never painted for a ${appearance} terminal`);
  } finally {
    root.render(<box />);
    renderer.destroy();
  }
}

function ActiveThemeProbe() {
  const { definition } = useTuiTheme();
  return <text>theme={definition.id}</text>;
}
