import { SyntaxStyle } from '@opentui/core';
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import * as v from 'valibot';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

export type ThemeAppearance = 'dark' | 'light';

export type TerminalColorCapability = 'truecolor' | 'ansi256' | 'ansi16';

/**
 * TUI colour roles. The canvas model follows oh-my-pi (transparent presets leave the terminal's own fg/bg); every colour
 * comes from the web app's `packages/cf-backend/src/index.css`, alpha composited onto its ground. Code blocks and tool
 * cards sit on a dark well in every theme, light included (a Kinu decision), with the dark inks. opentui paints unset
 * text `#FFFFFF` rather than emitting `39m`, so prose takes the theme's ink.
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
  readonly description: string;
  readonly appearance: ThemeAppearance;
  readonly source: 'kinu' | 'custom';
  readonly colors: TuiThemeColors;
}

export interface ThemeSelection {
  readonly mode: 'theme';
  readonly themeId: string;
}

export interface ThemeRegistry {
  readonly themes: readonly TuiThemeDefinition[];
  get(themeId: string): TuiThemeDefinition;
}

const DEFAULT_DARK_TUI_THEME_ID = 'kinu-dark-solid';

const DEFAULT_LIGHT_TUI_THEME_ID = 'kinu-light-solid';

/** Fresh-install default: the web app's dark theme painted whole. */
export const DEFAULT_TUI_THEME_SELECTION: ThemeSelection = Object.freeze({
  mode: 'theme',
  themeId: DEFAULT_DARK_TUI_THEME_ID,
});

/** A transparent theme is measured on its web canvas and the terminal's extreme. */
export const REFERENCE_TERMINAL_GROUNDS: Readonly<Record<ThemeAppearance, readonly string[]>> = Object.freeze({
  dark: Object.freeze(['#0F0D0B', '#000000']),
  light: Object.freeze(['#E9E2D3', '#FFFFFF']),
});

/** WCAG AA for running text; 3:1 for marks, labels and the focus rule. */
const TEXT_CONTRAST_MINIMUM = 4.5;

const MARK_CONTRAST_MINIMUM = 3;

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

const KINU_LIGHT: TuiThemeDefinition = {
  id: 'kinu-light',
  label: 'Kinu light, transparent',
  description: 'Ink and brass on your terminal\'s own light background.',
  appearance: 'light',
  source: 'kinu',
  colors: KINU_LIGHT_COLORS,
};

const KINU_DARK: TuiThemeDefinition = {
  id: 'kinu-dark',
  label: 'Kinu dark, transparent',
  description: 'Ink and brass on your terminal\'s own dark background.',
  appearance: 'dark',
  source: 'kinu',
  colors: KINU_DARK_COLORS,
};

/** Kinu dark in slate (`--c-info` hue, 207°); brass, silk, and status hues unchanged. */
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

const KINU_LIGHT_SOLID: TuiThemeDefinition = {
  id: DEFAULT_LIGHT_TUI_THEME_ID,
  label: 'Kinu light',
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

const KINU_DARK_SOLID: TuiThemeDefinition = {
  id: DEFAULT_DARK_TUI_THEME_ID,
  label: 'Kinu dark',
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

/** Picker order; a stale selection may fall back to the first entry, so painted defaults lead. */
export const BUILTIN_TUI_THEMES: readonly TuiThemeDefinition[] = Object.freeze([
  KINU_LIGHT_SOLID,
  KINU_DARK_SOLID,
  KINU_LIGHT,
  KINU_DARK,
  KINU_DUSK,
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

/** Unknown ids fall back to the default and are recorded: `tui.json` is hand-edited. */
function resolveThemeSelection(
  registry: ThemeRegistry,
  selection: ThemeSelection,
): TuiThemeDefinition {
  const known = registry.themes.find((candidate) => candidate.id === selection.themeId);

  if (known !== undefined) return known;

  const fallback = registry.themes.find((candidate) => candidate.id === DEFAULT_DARK_TUI_THEME_ID)
    ?? registry.themes[0];

  if (fallback === undefined) throw new Error('the TUI theme registry is empty');
  diagnostics.failure(
    'tui.theme_absent',
    toKinuError({
      doing: `resolving the selected TUI theme ${selection.themeId}`,
      cause: new Error(`no theme with id ${selection.themeId} is registered`),
      otherwise: 'bad_input',
    }),
    { selected: selection.themeId, applied: fallback.id },
  );

  return fallback;
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

interface ThemeContrastPair {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
  readonly ratio: number;
}

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


/** Fenced blocks take colour from `well` via the block hook in `messages.tsx`. */
function markdownSyntaxForTheme(theme: TuiThemeDefinition): SyntaxStyle {
  const { border, text, intent } = theme.colors;
  const prose = { fg: text.strong };
  const heading = { fg: text.strong, bold: true };
  const raw = { fg: intent.accentStrong };
  const link = { fg: intent.accentStrong, underline: true };
  const mark = { fg: intent.accent };
  const punctuation = { fg: text.muted };

  // Keyed by the tree-sitter capture names `MarkdownRenderable.getStyle` looks up (exact, then the prefix before the first
  // dot); heading levels are listed singly because `markup.heading.2` falls back to `markup`. No `default` entry: fenced
  // chunks resolve `default` before the block's own well ink.
  return SyntaxStyle.fromStyles({
    markup: prose,
    'markup.strong': { fg: text.strong, bold: true },
    'markup.italic': { fg: text.strong, italic: true },
    'markup.strikethrough': { fg: text.muted, dim: true },
    'markup.heading': heading,
    'markup.heading.1': heading,
    'markup.heading.2': heading,
    'markup.heading.3': heading,
    'markup.heading.4': heading,
    'markup.heading.5': heading,
    'markup.heading.6': heading,
    'markup.raw': raw,
    'markup.raw.block': raw,
    'markup.link': link,
    'markup.link.url': link,
    'markup.link.label': { fg: intent.accentStrong },
    'markup.quote': { fg: text.muted, italic: true },
    'markup.list': mark,
    'markup.list.checked': mark,
    'markup.list.unchecked': mark,
    punctuation,
    'punctuation.special': punctuation,
    'punctuation.delimiter': punctuation,
    label: prose,
    'string.escape': prose,
    'character.special': punctuation,
    hr: { fg: border.default },
  });
}


interface ActiveTuiTheme {
  readonly definition: TuiThemeDefinition;
  readonly colors: TuiThemeColors;
  readonly markdownSyntax: SyntaxStyle;
  readonly registry: ThemeRegistry;
}

const DEFAULT_ACTIVE_THEME: ActiveTuiTheme = Object.freeze({
  definition: KINU_DARK,
  colors: KINU_DARK.colors,
  markdownSyntax: markdownSyntaxForTheme(KINU_DARK),
  registry: DEFAULT_THEME_REGISTRY,
});

const ThemeContext = createContext<ActiveTuiTheme>(DEFAULT_ACTIVE_THEME);

export function TuiThemeProvider(props: {
  readonly registry?: ThemeRegistry;
  readonly selection?: ThemeSelection;
  readonly colorCapability?: TerminalColorCapability;
  readonly children: ReactNode;
}) {
  const registry = props.registry ?? DEFAULT_THEME_REGISTRY;
  const selection = props.selection ?? DEFAULT_TUI_THEME_SELECTION;
  const capability = props.colorCapability ?? detectTerminalColorCapability();

  const active = useMemo(() => {
    const definition = projectTheme(resolveThemeSelection(registry, selection), capability);

    return Object.freeze({
      definition,
      colors: definition.colors,
      markdownSyntax: markdownSyntaxForTheme(definition),
      registry,
    });
  }, [capability, registry, selection]);

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

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };

  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);

  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

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
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of palette) {
    const candidateRgb = [1, 3, 5].map((offset) => Number.parseInt(candidate.slice(offset, offset + 2), 16));
    const distance = rgb.reduce((sum, channel, index) => sum + (channel - candidateRgb[index]) ** 2, 0);

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
