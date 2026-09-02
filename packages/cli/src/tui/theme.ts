import { SyntaxStyle } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as v from 'valibot';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

export type ThemeAppearance = 'dark' | 'light';
export type TerminalColorCapability = 'truecolor' | 'ansi256' | 'ansi16';

/**
 * The TUI's colour roles, and where each one comes from.
 *
 * Two sources, in this order:
 *
 * 1. The canvas model is oh-my-pi's (can1357/oh-my-pi 17.4.2,
 *    `packages/coding-agent/src/modes/theme/`). Its `dark.json` and
 *    `light.json` set `text: ""` and `userMessageText: ""`, and `color.ts`
 *    turns `""` into `\x1b[39m` / `\x1b[49m`: the terminal's own foreground
 *    and background. Nothing paints the canvas. What IS painted: the user
 *    bubble (`userMessageBg`, `components/user-message.ts`), the composer
 *    (`tui-adapters.ts` `surfaceColor: bgFill("userMessageBg")`), tool cards
 *    (`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`,
 *    `components/tool-execution.ts`) and the status line. Thinking is
 *    `thinkingText: gray`, italic (`components/assistant-message.ts`).
 *    Markdown code fences take `mdCodeBlock` ink and no fill
 *    (`tui-adapters.ts` `getMarkdownTheme`). Here the canvas, the chrome and
 *    the cards are transparent by default; the bubble, the composer, the
 *    tool/code well and the dialogs are painted.
 *
 *    One deliberate difference: opentui paints unset text `#FFFFFF` rather
 *    than emitting `39m` (measured on a pty, 2026-09-01), so prose takes the
 *    theme's ink for the detected appearance instead of the terminal's.
 *
 * 2. Every colour is the web app's (`packages/cf-backend/src/index.css`, the
 *    `:root` dark block and the `[data-mode="light"]` block). A terminal has
 *    no alpha, so the one tint the web uses is composited at its ground.
 *
 * | TUI role              | web token                              | dark    | light   |
 * |-----------------------|----------------------------------------|---------|---------|
 * | background.canvas     | --c-bg (solid presets; else terminal)   | #0F0D0B | #E9E2D3 |
 * | background.chrome     | --c-sidebar (solid presets; else none)  | #141110 | #F1EBDD |
 * | background.surface    | --c-surface (solid presets; else none)  | #181512 | #F7F3E9 |
 * | background.overlay    | --c-overlay — dialogs, palettes, hubs   | #221C15 | #F7F3E9 |
 * | background.recessed   | --c-recessed — a well inside a dialog   | #131110 | #E0D8C5 |
 * | background.elevated   | --c-elevated — the open/active row      | #221C15 | #E8E0CE |
 * | background.selection  | --c-neutral-tint over --c-overlay       | #2E2821 | #E9E5DA |
 * | background.accent     | --c-accent — the gold fill              | #E0A458 | #D89A44 |
 * | background.user       | --c-user-bg — user bubble, composer     | #241E16 | #F2D9AC |
 * | border.default        | --c-border — structural rules           | #262019 | #D2C6AE |
 * | border.subtle         | --c-dash — separators inside a card     | #2A241D | #DBD1BE |
 * | border.strong         | --c-border-strong — outlined controls   | #332C23 | #BBAB8C |
 * | border.focus          | --c-accent, text-grade on paper (*)     | #E0A458 | #8F5C10 |
 * | border.user           | --c-user-border — the bubble edge       | #3A3126 | #D9B573 |
 * | text.primary          | --c-text-2 — prose, UI text             | #D8CFC2 | #3D3427 |
 * | text.strong           | --c-text — ink: headings, the bubble    | #EDE5D8 | #1C1710 |
 * | text.muted            | --c-text-3 — dim: hints, thinking       | #9C9184 | #5E5344 |
 * | text.onAccent         | --c-accent-on — ink on the gold fill    | #1A1408 | #1F1503 |
 * | intent.accent         | --c-accent, text-grade on paper (*)     | #E0A458 | #8F5C10 |
 * | intent.accentStrong   | --c-accent-fg — silk: links, inline code| #E3D2AE | #7A5514 |
 * | intent.info           | --c-info                                | #8FB6D6 | #2F6289 |
 * | intent.success        | --c-success                             | #8FBC8B | #316530 |
 * | intent.warning        | --c-warning                             | #E8B97A | #7E5205 |
 * | intent.danger         | --c-danger                              | #C97B6B | #96412C |
 * | well.fill             | --c-recessed, dark block (**)           | #131110 | #131110 |
 * | well.border           | --c-border-strong, dark block           | #332C23 | #332C23 |
 * | well.ink              | --c-text-2, dark block                  | #D8CFC2 | #D8CFC2 |
 * | well.muted            | --c-text-3, dark block                  | #9C9184 | #9C9184 |
 * | well.code             | --c-code, dark block                    | #E3D2AE | #E3D2AE |
 * | well.accent           | --c-accent, dark block                  | #E0A458 | #E0A458 |
 * | well.success          | --c-success, dark block                 | #8FBC8B | #8FBC8B |
 * | well.danger           | --c-danger, dark block                  | #C97B6B | #C97B6B |
 *
 * (*) The web keeps two golds on paper: the fill stays bright (#D89A44) and
 * text-grade gold deepens to #8F5C10, the mock's own figure. In a terminal
 * every gold is text or a one-cell rule, so the light ink set's
 * `intent.accent` and `border.focus` take the text-grade gold (4.4:1 on the
 * web canvas) and only `background.accent` keeps the bright fill, under
 * `text.onAccent`.
 *
 * (**) Code blocks and tool cards sit on a dark well in every theme, light
 * ones included. That is a Kinu decision: omp's own `light.json` tints its
 * tool cards light (`toolSuccessBg: #e8f0e8`). The well is the web's dark
 * code surface (`.p-code`: silk on `--c-recessed`), and because it is dark
 * on a light canvas it carries the dark block's inks and marks itself.
 *
 * Roles the web has and the TUI does not: `--c-text-4` (micro labels;
 * `text.muted` covers the register), `--c-fill` (chip planes; a terminal chip
 * is a bracketed word), the status tints (a notice here is a bordered box in
 * the status hue) and `--c-scrim` (a transparent canvas has nothing to blend
 * a scrim into). `intent.warningMuted` is gone: the web has no such hue, and
 * every mark that used it is gold or dim on the web.
 */
export interface TuiThemeColors {
  readonly background: {
    /** The transcript ground. Absent: the terminal's own background. */
    readonly canvas?: string;
    /** Sidebar and status strip. Absent: the terminal's own background. */
    readonly chrome?: string;
    /** Cards on the canvas. Absent: the terminal's own background. */
    readonly surface?: string;
    readonly overlay: string;
    readonly recessed: string;
    readonly elevated: string;
    readonly selection: string;
    readonly accent: string;
    readonly user: string;
  };
  readonly border: {
    readonly default: string;
    readonly subtle: string;
    readonly strong: string;
    readonly focus: string;
    readonly user: string;
  };
  readonly text: {
    readonly primary: string;
    readonly strong: string;
    readonly muted: string;
    readonly onAccent: string;
  };
  readonly intent: {
    readonly accent: string;
    readonly accentStrong: string;
    readonly info: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
  };
  /** The dark surface code blocks and tool cards sit on, with its own inks. */
  readonly well: {
    readonly fill: string;
    readonly border: string;
    readonly ink: string;
    readonly muted: string;
    readonly code: string;
    readonly accent: string;
    readonly success: string;
    readonly danger: string;
  };
}

export interface TuiThemeDefinition {
  readonly id: string;
  readonly label: string;
  /** One line the picker shows beside the label. */
  readonly description: string;
  readonly appearance: ThemeAppearance;
  readonly source: 'kinu' | 'custom';
  readonly colors: TuiThemeColors;
}

export type ThemeSelection =
  | { readonly mode: 'theme'; readonly themeId: string }
  | {
      readonly mode: 'system';
      readonly darkThemeId: string;
      readonly lightThemeId: string;
    };

export interface ThemeRegistry {
  readonly themes: readonly TuiThemeDefinition[];
  get(themeId: string): TuiThemeDefinition;
}

const DEFAULT_DARK_TUI_THEME_ID = 'kinu-dark';
const DEFAULT_LIGHT_TUI_THEME_ID = 'kinu-light';
/**
 * What a fresh install paints: the ink set the terminal's own background
 * calls for, on that background. The same rule as omp's `getDefaultTheme`.
 */
export const DEFAULT_TUI_THEME_SELECTION: ThemeSelection = Object.freeze({
  mode: 'system',
  darkThemeId: DEFAULT_DARK_TUI_THEME_ID,
  lightThemeId: DEFAULT_LIGHT_TUI_THEME_ID,
});

/**
 * The grounds a transparent theme is measured on: the web canvas of its
 * appearance, which the ink set was designed for, and the extreme the
 * terminal can go to. A theme that paints its canvas is measured on that.
 */
export const REFERENCE_TERMINAL_GROUNDS: Readonly<Record<ThemeAppearance, readonly string[]>> = Object.freeze({
  dark: Object.freeze(['#0F0D0B', '#000000']),
  light: Object.freeze(['#E9E2D3', '#FFFFFF']),
});

/** WCAG AA for running text; 3:1 for marks, labels and the focus rule. */
const TEXT_CONTRAST_MINIMUM = 4.5;
const MARK_CONTRAST_MINIMUM = 3;

/** The web's dark code surface; every theme's well unless it says otherwise. */
const KINU_DARK_WELL: TuiThemeColors['well'] = {
  fill: '#131110',
  border: '#332C23',
  ink: '#D8CFC2',
  muted: '#9C9184',
  code: '#E3D2AE',
  accent: '#E0A458',
  success: '#8FBC8B',
  danger: '#C97B6B',
};

const KINU_LIGHT_COLORS: TuiThemeColors = {
  background: {
    overlay: '#F7F3E9',
    recessed: '#E0D8C5',
    elevated: '#E8E0CE',
    selection: '#E9E5DA',
    accent: '#D89A44',
    user: '#F2D9AC',
  },
  border: {
    default: '#D2C6AE',
    subtle: '#DBD1BE',
    strong: '#BBAB8C',
    focus: '#8F5C10',
    user: '#D9B573',
  },
  text: {
    primary: '#3D3427',
    strong: '#1C1710',
    muted: '#5E5344',
    onAccent: '#1F1503',
  },
  intent: {
    accent: '#8F5C10',
    accentStrong: '#7A5514',
    info: '#2F6289',
    success: '#316530',
    warning: '#7E5205',
    danger: '#96412C',
  },
  well: KINU_DARK_WELL,
};

const KINU_DARK_COLORS: TuiThemeColors = {
  background: {
    overlay: '#221C15',
    recessed: '#131110',
    elevated: '#221C15',
    selection: '#2E2821',
    accent: '#E0A458',
    user: '#241E16',
  },
  border: {
    default: '#262019',
    subtle: '#2A241D',
    strong: '#332C23',
    focus: '#E0A458',
    user: '#3A3126',
  },
  text: {
    primary: '#D8CFC2',
    strong: '#EDE5D8',
    muted: '#9C9184',
    onAccent: '#1A1408',
  },
  intent: {
    accent: '#E0A458',
    accentStrong: '#E3D2AE',
    info: '#8FB6D6',
    success: '#8FBC8B',
    warning: '#E8B97A',
    danger: '#C97B6B',
  },
  well: KINU_DARK_WELL,
};

/** The web's light ink set on the terminal's own background. */
const KINU_LIGHT: TuiThemeDefinition = {
  id: DEFAULT_LIGHT_TUI_THEME_ID,
  label: 'Kinu light',
  description: 'Ink and brass on your terminal\'s light background.',
  appearance: 'light',
  source: 'kinu',
  colors: KINU_LIGHT_COLORS,
};

/** The web's dark ink set on the terminal's own background. */
const KINU_DARK: TuiThemeDefinition = {
  id: DEFAULT_DARK_TUI_THEME_ID,
  label: 'Kinu dark',
  description: 'Ink and brass on your terminal\'s dark background.',
  appearance: 'dark',
  source: 'kinu',
  colors: KINU_DARK_COLORS,
};

/**
 * Kinu dark with every ground, rule and ink turned to the family's slate:
 * the hue of `--c-info` (207°) at Kinu dark's own saturation and lightness
 * per rung. The brass, the silk and the status hues do not move, so the
 * accent stays the one warm note. For terminals that run cool.
 */
const KINU_DUSK: TuiThemeDefinition = {
  id: 'kinu-dusk',
  label: 'Kinu dusk',
  description: 'Kinu dark turned to slate, brass unchanged.',
  appearance: 'dark',
  source: 'kinu',
  colors: {
    background: {
      overlay: '#151C22',
      recessed: '#101213',
      elevated: '#151C22',
      selection: '#21282E',
      accent: '#E0A458',
      user: '#161E24',
    },
    border: {
      default: '#192026',
      subtle: '#1D242A',
      strong: '#232C33',
      focus: '#E0A458',
      user: '#26313A',
    },
    text: {
      primary: '#C2CED8',
      strong: '#D8E4ED',
      muted: '#84919C',
      onAccent: '#1A1408',
    },
    intent: KINU_DARK_COLORS.intent,
    well: {
      fill: '#101213',
      border: '#232C33',
      ink: '#C2CED8',
      muted: '#84919C',
      code: '#E3D2AE',
      accent: '#E0A458',
      success: '#8FBC8B',
      danger: '#C97B6B',
    },
  },
};

/** The web's `[data-mode="light"]` block painted whole: canvas, chrome and cards. */
const KINU_LIGHT_SOLID: TuiThemeDefinition = {
  id: 'kinu-light-solid',
  label: 'Kinu light, painted',
  description: 'The web app\'s light face, canvas included.',
  appearance: 'light',
  source: 'kinu',
  colors: {
    ...KINU_LIGHT_COLORS,
    background: {
      ...KINU_LIGHT_COLORS.background,
      canvas: '#E9E2D3',
      chrome: '#F1EBDD',
      surface: '#F7F3E9',
    },
  },
};

/** The web's `:root` dark block painted whole: canvas, chrome and cards. */
const KINU_DARK_SOLID: TuiThemeDefinition = {
  id: 'kinu-dark-solid',
  label: 'Kinu dark, painted',
  description: 'The web app\'s dark face, canvas included.',
  appearance: 'dark',
  source: 'kinu',
  colors: {
    ...KINU_DARK_COLORS,
    background: {
      ...KINU_DARK_COLORS.background,
      canvas: '#0F0D0B',
      chrome: '#141110',
      surface: '#181512',
    },
  },
};

/**
 * Kinu light painted one rung up: the canvas takes the paper card tone
 * (`--c-surface`), cards step to a near-white warm paper, and the web canvas
 * (`--c-bg`) becomes the well inside dialogs. For a terminal that reads the
 * tinted ground as dim.
 */
const KINU_PAPER: TuiThemeDefinition = {
  id: 'kinu-paper',
  label: 'Kinu paper, painted',
  description: 'Kinu light on brighter paper, same ink and brass.',
  appearance: 'light',
  source: 'kinu',
  colors: {
    ...KINU_LIGHT_COLORS,
    background: {
      ...KINU_LIGHT_COLORS.background,
      canvas: '#F7F3E9',
      chrome: '#FBF8F1',
      surface: '#FFFDF8',
      overlay: '#FFFDF8',
      recessed: '#E9E2D3',
      selection: '#F0EEE8',
    },
  },
};

/** Kinu dark pushed to the ends: near-white ink and bright rules on the terminal's black. */
const HIGH_CONTRAST: TuiThemeDefinition = {
  id: 'high-contrast',
  label: 'High contrast',
  description: 'Bright ink and rules for a near-black terminal.',
  appearance: 'dark',
  source: 'kinu',
  colors: {
    background: {
      overlay: '#1B1813',
      recessed: '#0D0B09',
      elevated: '#2A2419',
      selection: '#3A3020',
      accent: '#FFD37A',
      user: '#34240F',
    },
    border: {
      default: '#B5A88F',
      subtle: '#827762',
      strong: '#D8C8A9',
      focus: '#FFD37A',
      user: '#D8A64B',
    },
    text: {
      primary: '#F7F0E3',
      strong: '#FFF4D1',
      muted: '#CEC3B1',
      onAccent: '#171006',
    },
    intent: {
      accent: '#FFD37A',
      accentStrong: '#FFE7AD',
      info: '#A8D8FF',
      success: '#A7E8A1',
      warning: '#FFD37A',
      danger: '#FF9A87',
    },
    well: {
      fill: '#0D0B09',
      border: '#D8C8A9',
      ink: '#F7F0E3',
      muted: '#CEC3B1',
      code: '#FFE7AD',
      accent: '#FFD37A',
      success: '#A7E8A1',
      danger: '#FF9A87',
    },
  },
};

/**
 * Order matters twice: the picker lists themes in it, and `themeOrDefault`
 * takes the first theme of the terminal's appearance when a selection names
 * a theme that is gone, so Kinu light and Kinu dark lead their appearances.
 */
export const BUILTIN_TUI_THEMES: readonly TuiThemeDefinition[] = Object.freeze([
  KINU_LIGHT,
  KINU_DARK,
  KINU_DUSK,
  KINU_LIGHT_SOLID,
  KINU_DARK_SOLID,
  KINU_PAPER,
  HIGH_CONTRAST,
].map(freezeTheme));

const ThemeColorSchema = v.pipe(
  v.string(),
  v.regex(/^#[0-9A-F]{6}$/iu, 'must be a #RRGGBB color'),
  v.transform((color) => color.toUpperCase()),
);
const TuiThemeColorsSchema = v.strictObject({
  background: v.strictObject({
    canvas: v.optional(ThemeColorSchema),
    chrome: v.optional(ThemeColorSchema),
    surface: v.optional(ThemeColorSchema),
    overlay: ThemeColorSchema,
    recessed: ThemeColorSchema,
    elevated: ThemeColorSchema,
    selection: ThemeColorSchema,
    accent: ThemeColorSchema,
    user: ThemeColorSchema,
  }),
  border: v.strictObject({
    default: ThemeColorSchema,
    subtle: ThemeColorSchema,
    strong: ThemeColorSchema,
    focus: ThemeColorSchema,
    user: ThemeColorSchema,
  }),
  text: v.strictObject({
    primary: ThemeColorSchema,
    strong: ThemeColorSchema,
    muted: ThemeColorSchema,
    onAccent: ThemeColorSchema,
  }),
  intent: v.strictObject({
    accent: ThemeColorSchema,
    accentStrong: ThemeColorSchema,
    info: ThemeColorSchema,
    success: ThemeColorSchema,
    warning: ThemeColorSchema,
    danger: ThemeColorSchema,
  }),
  well: v.strictObject({
    fill: ThemeColorSchema,
    border: ThemeColorSchema,
    ink: ThemeColorSchema,
    muted: ThemeColorSchema,
    code: ThemeColorSchema,
    accent: ThemeColorSchema,
    success: ThemeColorSchema,
    danger: ThemeColorSchema,
  }),
});
const CustomThemeSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)),
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  description: v.optional(v.pipe(v.string(), v.trim()), ''),
  appearance: v.picklist(['dark', 'light']),
  colors: TuiThemeColorsSchema,
});
export function createThemeRegistry(themes: readonly TuiThemeDefinition[]): ThemeRegistry {
  const byId: Record<string, TuiThemeDefinition> = {};
  const validated = themes.map((theme) => {
    validateTheme(theme, theme.id);
    if (byId[theme.id] !== undefined) throw new Error(`Duplicate TUI theme id: ${theme.id}`);
    const frozen = freezeTheme(theme);
    byId[theme.id] = frozen;
    return frozen;
  });
  return Object.freeze({
    themes: Object.freeze(validated),
    get(themeId: string) {
      const theme = byId[themeId];
      if (theme === undefined) throw new Error(`Unknown TUI theme: ${themeId}`);
      return theme;
    },
  });
}

const DEFAULT_THEME_REGISTRY = createThemeRegistry(BUILTIN_TUI_THEMES);

/**
 * The theme a selection names, or the appearance-appropriate default when it
 * names one this registry does not have.
 *
 * `tui.json` is a file a person edits, and its schema can only check that
 * `themeId` is a non-empty string — registry membership is not a fact the
 * preference layer holds. So a custom theme that is deleted or renamed leaves a
 * selection pointing at nothing, and `registry.get` throwing inside the
 * provider's `useMemo` took the whole TUI down at first render with
 * `Unknown TUI theme`. A stale id in a user's config is drift, not a
 * programming error: it degrades to the default and is RECORDED, because
 * falling back silently would leave someone wondering why their theme stopped
 * applying.
 */
function themeOrDefault(
  registry: ThemeRegistry,
  themeId: string,
  terminalAppearance: ThemeAppearance,
): TuiThemeDefinition {
  const known = registry.themes.find((candidate) => candidate.id === themeId);
  if (known !== undefined) return known;
  const fallback = registry.themes.find((candidate) => candidate.appearance === terminalAppearance)
    ?? registry.themes[0];
  if (fallback === undefined) throw new Error('the TUI theme registry is empty');
  diagnostics.failure(
    'tui.theme_absent',
    toKinuError({
      doing: `resolving the selected TUI theme ${themeId}`,
      cause: new Error(`no theme with id ${themeId} is registered`),
      otherwise: 'bad_input',
    }),
    { selected: themeId, applied: fallback.id },
  );
  return fallback;
}

export function resolveThemeSelection(
  registry: ThemeRegistry,
  selection: ThemeSelection,
  terminalAppearance: ThemeAppearance,
): TuiThemeDefinition {
  if (selection.mode === 'theme') {
    return themeOrDefault(registry, selection.themeId, terminalAppearance);
  }
  const wanted = terminalAppearance === 'dark' ? selection.darkThemeId : selection.lightThemeId;
  const theme = themeOrDefault(registry, wanted, terminalAppearance);
  if (theme.appearance !== terminalAppearance) {
    throw new Error(`System ${terminalAppearance} selection resolved ${theme.id}, which is ${theme.appearance}.`);
  }
  return theme;
}


export function parseCustomTheme(json: string, filename: string): TuiThemeDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`${filename}: invalid JSON`, { cause: error });
  }
  let parsed: v.InferOutput<typeof CustomThemeSchema>;
  try {
    parsed = v.parse(CustomThemeSchema, raw);
  } catch (error) {
    const detail = error instanceof v.ValiError
      ? error.issues.slice(0, 3).map((issue) => {
          const path = issue.path
            ?.map((item: { readonly key: PropertyKey }) => String(item.key))
            .join('.') ?? '(root)';
          return `${path}: ${issue.message}`;
        }).join('; ')
      : 'invalid value';
    throw new Error(`${filename}: ${detail}`, { cause: error });
  }
  const theme: TuiThemeDefinition = {
    ...parsed,
    source: 'custom',
  };
  validateTheme(theme, filename);
  return freezeTheme(theme);
}

export interface ThemeContrastPair {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
  readonly ratio: number;
}

/**
 * The pairs every theme is held to: the three inks on every ground they are
 * drawn on, the ink on the gold fill, each status hue on the grounds a mark
 * or label sits on, the focus rule on the canvas, and the well's own inks and
 * marks on the well.
 */
function themeContrastPairs(theme: TuiThemeDefinition): readonly ThemeContrastPair[] {
  const { background, border, text, intent, well } = theme.colors;
  const pairs: ThemeContrastPair[] = [];
  const push = (label: string, foreground: string, ground: string, minimum: number) => {
    pairs.push({ label, foreground, background: ground, minimum, ratio: contrastRatio(foreground, ground) });
  };
  const canvases: ReadonlyArray<readonly [string, string]> = background.canvas === undefined
    ? REFERENCE_TERMINAL_GROUNDS[theme.appearance].map((ground) => [`terminal ${ground}`, ground] as const)
    : [['background.canvas', background.canvas]];
  const painted: Array<readonly [string, string]> = [
    ...canvases,
    ...(background.chrome === undefined ? [] : [['background.chrome', background.chrome] as const]),
    ...(background.surface === undefined ? [] : [['background.surface', background.surface] as const]),
    ['background.overlay', background.overlay],
    ['background.recessed', background.recessed],
    ['background.elevated', background.elevated],
    ['background.selection', background.selection],
    ['background.user', background.user],
  ];
  for (const ink of ['primary', 'strong', 'muted'] as const) {
    for (const [label, ground] of painted) push(`text.${ink}/${label}`, text[ink], ground, TEXT_CONTRAST_MINIMUM);
  }
  push('text.onAccent/background.accent', text.onAccent, background.accent, TEXT_CONTRAST_MINIMUM);
  const markGrounds = [...canvases, ['background.overlay', background.overlay] as const, ['background.recessed', background.recessed] as const];
  for (const hue of ['accent', 'accentStrong', 'info', 'success', 'warning', 'danger'] as const) {
    for (const [label, ground] of markGrounds) push(`intent.${hue}/${label}`, intent[hue], ground, MARK_CONTRAST_MINIMUM);
  }
  for (const [label, ground] of canvases) push(`border.focus/${label}`, border.focus, ground, MARK_CONTRAST_MINIMUM);
  for (const ink of ['ink', 'muted', 'code'] as const) push(`well.${ink}/well.fill`, well[ink], well.fill, TEXT_CONTRAST_MINIMUM);
  for (const hue of ['accent', 'success', 'danger'] as const) push(`well.${hue}/well.fill`, well[hue], well.fill, MARK_CONTRAST_MINIMUM);
  return pairs;
}

function themeContrastFailures(theme: TuiThemeDefinition): string[] {
  return themeContrastPairs(theme).flatMap((pair) => (
    pair.ratio + Number.EPSILON < pair.minimum
      ? [`${pair.label} contrast ${pair.ratio.toFixed(2)} is below ${String(pair.minimum)}.`]
      : []
  ));
}

/**
 * The terminal's appearance when it has not answered the renderer's OSC 11
 * query: `COLORFGBG` (a background index below 8 is dark), else dark. The
 * same tiers, in the same order, as omp's `detectTerminalBackground`
 * (`packages/coding-agent/src/modes/theme/theme.ts`): its tier 1 is the OSC
 * 11 luminance the renderer supplies here, its tier 2 is this env var, and
 * its last answer is dark.
 */
function appearanceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ThemeAppearance {
  const colorFgBg = environment.COLORFGBG?.split(';');
  const background = colorFgBg !== undefined && colorFgBg.length >= 2 ? Number.parseInt(colorFgBg[1]!, 10) : Number.NaN;
  if (!Number.isNaN(background)) return background < 8 ? 'dark' : 'light';
  return 'dark';
}

/**
 * The appearance the terminal reports. The renderer queries OSC 10/11 at
 * start and re-queries on a DEC 2031 notification, classifying the answered
 * background by BT.601 brightness above 128 — the mechanism omp implements
 * itself in `packages/tui/src/terminal.ts` (`#startDirectOsc11Query`,
 * `#handleOsc11Response`). Until an answer arrives, the environment decides.
 */
function useTerminalAppearance(override?: ThemeAppearance): ThemeAppearance {
  const renderer = useRenderer();
  const [reported, setReported] = useState<ThemeAppearance | null>(() => renderer.themeMode);
  useEffect(() => {
    setReported(renderer.themeMode);
    const onThemeMode = (mode: ThemeAppearance) => setReported(mode);
    renderer.on('theme_mode', onThemeMode);
    return () => {
      renderer.off('theme_mode', onThemeMode);
    };
  }, [renderer]);
  return override ?? reported ?? appearanceFromEnvironment();
}

function detectTerminalColorCapability(environment: Readonly<Record<string, string | undefined>> = process.env): TerminalColorCapability {
  const colorTerm = environment.COLORTERM?.toLowerCase() ?? '';
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 'truecolor';
  return environment.TERM?.includes('256color') === true ? 'ansi256' : 'ansi16';
}

function projectTheme(theme: TuiThemeDefinition, capability: TerminalColorCapability): TuiThemeDefinition {
  if (capability === 'truecolor') return theme;
  const palette = capability === 'ansi256' ? ANSI_256 : ANSI_16;
  const project = (color: string): string => closestColor(color, palette);
  const colors = mapColors(theme.colors, project);
  return freezeTheme({ ...theme, colors });
}


/**
 * Assistant markdown in the web's registers: prose in `--c-text-2`, headings
 * and bold in ink, inline code as silk (`.p-code-inline`), code blocks as
 * silk on the well (`.p-code`), links as silk (`--text-color-kumo-link`),
 * quotes in the dim register.
 */
function markdownSyntaxForTheme(theme: TuiThemeDefinition): SyntaxStyle {
  const { border, text, intent, well } = theme.colors;
  return SyntaxStyle.fromStyles({
    text: { fg: text.primary },
    paragraph: { fg: text.primary },
    heading: { fg: text.strong, bold: true },
    strong: { fg: text.strong, bold: true },
    emphasis: { fg: text.primary, italic: true },
    code: { fg: well.code, bg: well.fill },
    codespan: { fg: intent.accentStrong },
    link: { fg: intent.accentStrong, underline: true },
    blockquote: { fg: text.muted, italic: true },
    list: { fg: text.primary },
    list_item: { fg: text.primary },
    table: { fg: text.primary },
    hr: { fg: border.default },
  });
}


export interface ActiveTuiTheme {
  readonly definition: TuiThemeDefinition;
  readonly colors: TuiThemeColors;
  readonly markdownSyntax: SyntaxStyle;
  /** What a `system` selection follows right now. */
  readonly terminalAppearance: ThemeAppearance;
  readonly registry: ThemeRegistry;
}

const DEFAULT_ACTIVE_THEME: ActiveTuiTheme = Object.freeze({
  definition: KINU_DARK,
  colors: KINU_DARK.colors,
  markdownSyntax: markdownSyntaxForTheme(KINU_DARK),
  terminalAppearance: 'dark',
  registry: DEFAULT_THEME_REGISTRY,
});
const ThemeContext = createContext<ActiveTuiTheme>(DEFAULT_ACTIVE_THEME);

export function TuiThemeProvider(props: {
  readonly registry?: ThemeRegistry;
  readonly selection?: ThemeSelection;
  readonly terminalAppearance?: ThemeAppearance;
  readonly colorCapability?: TerminalColorCapability;
  readonly children: ReactNode;
}) {
  const registry = props.registry ?? DEFAULT_THEME_REGISTRY;
  const selection = props.selection ?? DEFAULT_TUI_THEME_SELECTION;
  const appearance = useTerminalAppearance(props.terminalAppearance);
  const capability = props.colorCapability ?? detectTerminalColorCapability();
  const active = useMemo(() => {
    const definition = projectTheme(resolveThemeSelection(registry, selection, appearance), capability);
    return Object.freeze({
      definition,
      colors: definition.colors,
      markdownSyntax: markdownSyntaxForTheme(definition),
      terminalAppearance: appearance,
      registry,
    });
  }, [appearance, capability, registry, selection]);
  return createElement(ThemeContext.Provider, { value: active }, props.children);
}

export function useTuiTheme(): ActiveTuiTheme {
  return useContext(ThemeContext);
}

function validateTheme(theme: TuiThemeDefinition, source: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(theme.id)) throw new Error(`${source}.id must be a lower-case theme id.`);
  if (theme.label.trim() === '') throw new Error(`${source}.label cannot be empty.`);
  v.parse(TuiThemeColorsSchema, theme.colors);
  const failures = themeContrastFailures(theme);
  if (failures.length > 0) throw new Error(`${source}: ${failures.join(' ')}`);
}


function freezeTheme(theme: TuiThemeDefinition): TuiThemeDefinition {
  return Object.freeze({
    id: theme.id,
    label: theme.label,
    description: theme.description,
    appearance: theme.appearance,
    source: theme.source,
    colors: Object.freeze({
      background: Object.freeze({ ...theme.colors.background }),
      border: Object.freeze({ ...theme.colors.border }),
      text: Object.freeze({ ...theme.colors.text }),
      intent: Object.freeze({ ...theme.colors.intent }),
      well: Object.freeze({ ...theme.colors.well }),
    }),
  });
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const [red, green, blue] = channels.map((channel) => (
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/** The grounds of a theme as `mapColors` assembles them, optional ones last. */
type ThemeGrounds = { -readonly [Key in keyof TuiThemeColors['background']]: TuiThemeColors['background'][Key] };

function mapColors(colors: TuiThemeColors, map: (color: string) => string): TuiThemeColors {
  const background: ThemeGrounds = {
    overlay: map(colors.background.overlay),
    recessed: map(colors.background.recessed),
    elevated: map(colors.background.elevated),
    selection: map(colors.background.selection),
    accent: map(colors.background.accent),
    user: map(colors.background.user),
  };
  if (colors.background.canvas !== undefined) background.canvas = map(colors.background.canvas);
  if (colors.background.chrome !== undefined) background.chrome = map(colors.background.chrome);
  if (colors.background.surface !== undefined) background.surface = map(colors.background.surface);
  return {
    background,
    border: {
      default: map(colors.border.default),
      subtle: map(colors.border.subtle),
      strong: map(colors.border.strong),
      focus: map(colors.border.focus),
      user: map(colors.border.user),
    },
    text: {
      primary: map(colors.text.primary),
      strong: map(colors.text.strong),
      muted: map(colors.text.muted),
      onAccent: map(colors.text.onAccent),
    },
    intent: {
      accent: map(colors.intent.accent),
      accentStrong: map(colors.intent.accentStrong),
      info: map(colors.intent.info),
      success: map(colors.intent.success),
      warning: map(colors.intent.warning),
      danger: map(colors.intent.danger),
    },
    well: {
      fill: map(colors.well.fill),
      border: map(colors.well.border),
      ink: map(colors.well.ink),
      muted: map(colors.well.muted),
      code: map(colors.well.code),
      accent: map(colors.well.accent),
      success: map(colors.well.success),
      danger: map(colors.well.danger),
    },
  };
}

function closestColor(color: string, palette: readonly string[]): string {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  let best = palette[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const candidateRgb = [1, 3, 5].map((offset) => Number.parseInt(candidate.slice(offset, offset + 2), 16));
    const distance = rgb.reduce((sum, channel, index) => sum + (channel - candidateRgb[index]!) ** 2, 0);
    if (distance >= bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

const ANSI_16 = Object.freeze([
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#C0C0C0',
  '#808080', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF',
]);

const ANSI_256 = Object.freeze([
  ...ANSI_16,
  ...[0, 95, 135, 175, 215, 255].flatMap((red) => (
    [0, 95, 135, 175, 215, 255].flatMap((green) => (
      [0, 95, 135, 175, 215, 255].map((blue) => `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)
    ))
  )),
  ...Array.from({ length: 24 }, (_, index) => {
    const channel = 8 + index * 10;
    return `#${channel.toString(16).padStart(2, '0').repeat(3)}`;
  }),
]);
