/** @jsxImportSource @opentui/react */
import { describe, expect, test } from 'bun:test';

import {
  KEYMAP_PRESET_IDS,
  createKeybindingRegistry,
  keyEventAction,
  type TuiKeyEvent,
} from '../src/tui/actions';
import {
  BUILTIN_TUI_THEMES,
  createThemeRegistry,
  parseCustomTheme,
  resolveThemeSelection,
  themeContrastFailures,
} from '../src/tui/theme';
import { deriveOnboardingState, type OnboardingReadiness } from '../src/tui/onboarding';
import {
  DEFAULT_TUI_PREFERENCES,
  createMemoryTuiPreferenceStore,
  parseTuiPreferences,
} from '../src/tui/preferences';
import { tuiLayoutForWidth } from '../src/tui/tui-shell';

const key = (name: string, modifiers: Partial<TuiKeyEvent> = {}): TuiKeyEvent => ({
  name,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...modifiers,
});

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
    expect(keyEventAction(registry, key('escape'), ['modal', 'conversation', 'global'])).toBe('modal.close');
    expect(keyEventAction(registry, key('escape'), ['conversation', 'global'])).toBe('conversation.cancel');
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
    expect(keyEventAction(registry, key('o', { ctrl: true }), ['editor', 'conversation', 'global'])).toBe('tool.toggle');
    expect(keyEventAction(registry, key('g', { ctrl: true }), ['editor', 'conversation', 'global'])).toBe('editor.external');
    expect(keyEventAction(registry, key('tab', { shift: true }), ['editor', 'conversation', 'global'])).toBe('effort.cycle');
    expect(keyEventAction(registry, key('p', { ctrl: true }), ['editor', 'conversation', 'global'])).toBe('tier.cycle');
    expect(keyEventAction(registry, key('p', { ctrl: true, shift: true }), ['editor', 'conversation', 'global'])).toBe('tier.cycle-reverse');
    expect(keyEventAction(registry, key('p', { alt: true }), ['editor', 'conversation', 'global'])).toBe('tier.quick');
    expect(keyEventAction(registry, key('a', { alt: true }), ['editor', 'conversation', 'global'])).toBe('hub.agents');
    expect(keyEventAction(registry, key('l', { ctrl: true }), ['editor', 'conversation', 'global'])).toBe('model.open');
    expect(keyEventAction(registry, key('w', { alt: true }), ['editor', 'conversation', 'global'])).toBe('workspace.toggle');
    expect(keyEventAction(registry, key('tab'), ['editor', 'conversation', 'global'])).not.toBe('queue.add');
    expect(keyEventAction(registry, key('b', { ctrl: true }), ['editor', 'conversation', 'global'])).not.toBe('conversation.branch');
  });

  test('built-in themes validate contrast and system selection resolves an explicit pair', () => {
    const registry = createThemeRegistry(BUILTIN_TUI_THEMES);
    for (const theme of registry.themes) expect(themeContrastFailures(theme)).toEqual([]);
    expect(resolveThemeSelection(registry, {
      mode: 'system',
      darkThemeId: 'kinu-dark',
      lightThemeId: 'kinu-light',
    }, 'dark').id).toBe('kinu-dark');
    expect(resolveThemeSelection(registry, {
      mode: 'system',
      darkThemeId: 'kinu-dark',
      lightThemeId: 'kinu-light',
    }, 'light').id).toBe('kinu-light');
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


describe('guided onboarding', () => {
  test('readiness derivation resumes at the first incomplete, unskipped scene', () => {
    const fresh: OnboardingReadiness = {
      accountConnected: false,
      providerConnected: false,
      tierAliasesResolved: false,
      themeSelected: false,
      keymapSelected: false,
      workspaceCount: 0,
      skippedSteps: [],
    };
    expect(deriveOnboardingState(fresh).activeStep).toBe('location');
    expect(deriveOnboardingState({
      ...fresh,
      location: 'cloud',
      accountConnected: true,
      defaultModel: 'workers-ai/deepseek',
      tierAliasesResolved: true,
      skippedSteps: ['theme'],
    }).activeStep).toBe('keymap');
  });

});



describe('adaptive TUI shell', () => {
  test('layout thresholds follow the sidebar plus conversation budget', () => {
    expect([40, 80, 120, 160].map(tuiLayoutForWidth)).toEqual(['narrow', 'medium', 'wide', 'wide']);
  });

  test('wide sidebar preference persists through a new provider', () => {
    const store = createMemoryTuiPreferenceStore(DEFAULT_TUI_PREFERENCES);
    const next = { ...store.read(), wideSidebarOpen: false };
    store.write(next);
    expect(store.read().wideSidebarOpen).toBe(false);
    expect(parseTuiPreferences(JSON.stringify(store.read()), 'saved tui').wideSidebarOpen).toBe(false);
  });

});

