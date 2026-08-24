import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import { AGENT_HOME } from '../config';
import {
  KEYMAP_PRESET_IDS,
  isTuiActionId,
  type KeymapOverrides,
  type KeymapPresetId,
  type TuiActionId,
} from './actions';
import type { ThemeSelection } from './theme';

export const ONBOARDING_STEP_IDS = [
  'location',
  'connection',
  'tiers',
  'theme',
  'keymap',
  'workspace',
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];
export type WorkspaceLocationChoice = 'cloud' | 'local' | 'both';

export interface TuiPreferences {
  readonly theme: ThemeSelection;
  readonly keymapPreset: KeymapPresetId;
  readonly keyOverrides: KeymapOverrides;
  readonly wideSidebarOpen: boolean;
  readonly onboardingLocation?: WorkspaceLocationChoice;
  readonly skippedOnboardingSteps: readonly OnboardingStepId[];
}

export interface TuiPreferenceStore {
  read(): TuiPreferences;
  write(preferences: TuiPreferences): void;
}

const DEFAULT_TUI_PREFERENCES: TuiPreferences = Object.freeze({
  theme: Object.freeze({ mode: 'system', darkThemeId: 'kinu-dark', lightThemeId: 'kinu-light' }),
  keymapPreset: 'pi-omp',
  keyOverrides: Object.freeze({}),
  wideSidebarOpen: true,
  skippedOnboardingSteps: Object.freeze([]),
});

export function createFileTuiPreferenceStore(path = join(AGENT_HOME, 'tui.json')): TuiPreferenceStore {
  return {
    read() {
      if (!existsSync(path)) return DEFAULT_TUI_PREFERENCES;
      return parseTuiPreferences(readFileSync(path, 'utf8'), path);
    },
    write(preferences) {
      const validated = parseTuiPreferences(JSON.stringify(preferences), path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}


const ThemeSelectionSchema = v.variant('mode', [
  v.strictObject({
    mode: v.literal('theme'),
    themeId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    mode: v.literal('system'),
    darkThemeId: v.pipe(v.string(), v.minLength(1)),
    lightThemeId: v.pipe(v.string(), v.minLength(1)),
  }),
]);
const KeyOverrideSchema = v.record(
  v.string(),
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
);
const TuiPreferencesSchema = v.strictObject({
  theme: ThemeSelectionSchema,
  keymapPreset: v.picklist(KEYMAP_PRESET_IDS),
  keyOverrides: KeyOverrideSchema,
  wideSidebarOpen: v.boolean(),
  onboardingLocation: v.optional(v.picklist(['cloud', 'local', 'both'])),
  skippedOnboardingSteps: v.array(v.picklist(ONBOARDING_STEP_IDS)),
});

function parseTuiPreferences(json: string, source: string): TuiPreferences {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`${source}: invalid JSON`, { cause: error });
  }
  let parsed: v.InferOutput<typeof TuiPreferencesSchema>;
  try {
    parsed = v.parse(TuiPreferencesSchema, raw);
  } catch (error) {
    throw new Error(`${source} is not a valid Kinu TUI preference file.`, { cause: error });
  }
  const overrideEntries: Array<readonly [TuiActionId, readonly string[]]> = [];
  for (const [actionId, bindings] of Object.entries(parsed.keyOverrides)) {
    if (!isTuiActionId(actionId)) {
      throw new Error(`${source}.keyOverrides.${actionId} is not a known TUI action.`);
    }
    overrideEntries.push([actionId, Object.freeze(bindings)]);
  }
  const keyOverrides: KeymapOverrides = Object.fromEntries(overrideEntries);
  const common = {
    theme: Object.freeze(parsed.theme),
    keymapPreset: parsed.keymapPreset,
    keyOverrides: Object.freeze(keyOverrides),
    wideSidebarOpen: parsed.wideSidebarOpen,
    skippedOnboardingSteps: Object.freeze([...new Set(parsed.skippedOnboardingSteps)]),
  };
  return Object.freeze(parsed.onboardingLocation === undefined
    ? common
    : { ...common, onboardingLocation: parsed.onboardingLocation });
}
