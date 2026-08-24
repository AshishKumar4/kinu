import { SyntaxStyle } from '@opentui/core';
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import * as v from 'valibot';

export type ThemeAppearance = 'dark' | 'light';
export type TerminalColorCapability = 'truecolor' | 'ansi256' | 'ansi16';

export interface TuiThemeColors {
  readonly background: {
    readonly canvas: string;
    readonly chrome: string;
    readonly surface: string;
    readonly recessed: string;
    readonly selection: string;
    readonly selectionStrong: string;
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
    readonly warningMuted: string;
    readonly danger: string;
  };
}

export interface TuiThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly source: 'kinu' | 'compatibility' | 'custom';
  readonly license?: {
    readonly spdx: string;
    readonly sourceUrl: string;
  };
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

const KINU_DARK: TuiThemeDefinition = {
  id: 'kinu-dark',
  label: 'Kinu dark',
  appearance: 'dark',
  source: 'kinu',
  colors: {
    background: {
      canvas: '#0F0D0B',
      chrome: '#141110',
      surface: '#181512',
      recessed: '#131110',
      selection: '#1B1713',
      selectionStrong: '#2C241A',
      user: '#241E16',
    },
    border: {
      default: '#3A3126',
      subtle: '#4A3D2E',
      strong: '#5A4935',
      focus: '#E0A458',
      user: '#6A533A',
    },
    text: {
      primary: '#EDE5D8',
      strong: '#F1D9A9',
      muted: '#A99D8E',
      onAccent: '#21170D',
    },
    intent: {
      accent: '#E0A458',
      accentStrong: '#F1C27D',
      info: '#8FB6D6',
      success: '#8FBC8B',
      warning: '#E8B97A',
      warningMuted: '#B39166',
      danger: '#D88776',
    },
  },
};

const KINU_LIGHT: TuiThemeDefinition = {
  id: 'kinu-light',
  label: 'Kinu light',
  appearance: 'light',
  source: 'kinu',
  colors: {
    background: {
      canvas: '#F1EADF',
      chrome: '#E7DDCF',
      surface: '#DED2C1',
      recessed: '#EAE1D5',
      selection: '#D5C6B2',
      selectionStrong: '#CBB99F',
      user: '#E2C99F',
    },
    border: {
      default: '#8A7762',
      subtle: '#9E8B74',
      strong: '#6F5E4D',
      focus: '#80500E',
      user: '#8B642F',
    },
    text: {
      primary: '#2C241D',
      strong: '#3C2B16',
      muted: '#62584D',
      onAccent: '#F8F0E4',
    },
    intent: {
      accent: '#80500E',
      accentStrong: '#633B08',
      info: '#245C78',
      success: '#32643A',
      warning: '#72480D',
      warningMuted: '#765B36',
      danger: '#8D352B',
    },
  },
};

const HIGH_CONTRAST: TuiThemeDefinition = {
  id: 'high-contrast',
  label: 'High contrast',
  appearance: 'dark',
  source: 'kinu',
  colors: {
    background: {
      canvas: '#090807',
      chrome: '#12100D',
      surface: '#1B1813',
      recessed: '#0D0B09',
      selection: '#322818',
      selectionStrong: '#4B381B',
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
      warningMuted: '#D7B775',
      danger: '#FF9A87',
    },
  },
};

const OMP_DARK: TuiThemeDefinition = {
  id: 'omp-dark',
  label: 'Oh My Pi dark',
  appearance: 'dark',
  source: 'compatibility',
  license: {
    spdx: 'MIT',
    sourceUrl: 'https://github.com/can1357/oh-my-pi/blob/160ed439ac0df594347e7d7018b813a7ffdb5e81/packages/coding-agent/src/modes/theme/dark.json',
  },
  colors: {
    background: {
      canvas: '#121212',
      chrome: '#161A1F',
      surface: '#1D2129',
      recessed: '#14171C',
      selection: '#31363F',
      selectionStrong: '#3D424A',
      user: '#221D1A',
    },
    border: {
      default: '#5F6673',
      subtle: '#4E545E',
      strong: '#777D88',
      focus: '#FEBB38',
      user: '#785F3E',
    },
    text: {
      primary: '#E8E8E8',
      strong: '#F2D69A',
      muted: '#9DA2AB',
      onAccent: '#211706',
    },
    intent: {
      accent: '#FEBB38',
      accentStrong: '#FFD47D',
      info: '#3EA7E8',
      success: '#89D281',
      warning: '#E4C00F',
      warningMuted: '#B99F36',
      danger: '#FC5C69',
    },
  },
};

const OPENCODE_DARK: TuiThemeDefinition = {
  id: 'opencode-dark',
  label: 'OpenCode dark',
  appearance: 'dark',
  source: 'compatibility',
  license: {
    spdx: 'MIT',
    sourceUrl: 'https://github.com/anomalyco/opencode/blob/dc13c6bb3d08762ab186b7922208e0155b8d8928/packages/tui/src/theme/assets/opencode.json',
  },
  colors: {
    background: {
      canvas: '#0A0A0A',
      chrome: '#141414',
      surface: '#1E1E1E',
      recessed: '#101010',
      selection: '#282828',
      selectionStrong: '#323232',
      user: '#2A211C',
    },
    border: {
      default: '#606060',
      subtle: '#484848',
      strong: '#777777',
      focus: '#FAB283',
      user: '#A16F50',
    },
    text: {
      primary: '#EEEEEE',
      strong: '#FFD0B2',
      muted: '#9A9A9A',
      onAccent: '#261307',
    },
    intent: {
      accent: '#FAB283',
      accentStrong: '#FFC09F',
      info: '#67C8D2',
      success: '#7FD88F',
      warning: '#F5A742',
      warningMuted: '#C38C4A',
      danger: '#E97C84',
    },
  },
};

export const BUILTIN_TUI_THEMES: readonly TuiThemeDefinition[] = Object.freeze([
  KINU_DARK,
  KINU_LIGHT,
  HIGH_CONTRAST,
  OMP_DARK,
  OPENCODE_DARK,
].map(freezeTheme));

const ThemeColorSchema = v.pipe(
  v.string(),
  v.regex(/^#[0-9A-F]{6}$/iu, 'must be a #RRGGBB color'),
  v.transform((color) => color.toUpperCase()),
);
const TuiThemeColorsSchema = v.strictObject({
  background: v.strictObject({
    canvas: ThemeColorSchema,
    chrome: ThemeColorSchema,
    surface: ThemeColorSchema,
    recessed: ThemeColorSchema,
    selection: ThemeColorSchema,
    selectionStrong: ThemeColorSchema,
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
    warningMuted: ThemeColorSchema,
    danger: ThemeColorSchema,
  }),
});
const CustomThemeSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)),
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
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

function resolveThemeSelection(
  registry: ThemeRegistry,
  selection: ThemeSelection,
  terminalAppearance: ThemeAppearance,
): TuiThemeDefinition {
  if (selection.mode === 'theme') return registry.get(selection.themeId);
  const theme = registry.get(terminalAppearance === 'dark' ? selection.darkThemeId : selection.lightThemeId);
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

function themeContrastFailures(theme: TuiThemeDefinition): string[] {
  const { background, border, text, intent } = theme.colors;
  const pairs = [
    ['text.primary/background.canvas', text.primary, background.canvas, 4.5],
    ['text.strong/background.canvas', text.strong, background.canvas, 4.5],
    ['text.muted/background.canvas', text.muted, background.canvas, 3],
    ['text.primary/background.surface', text.primary, background.surface, 4.5],
    ['intent.accent/background.canvas', intent.accent, background.canvas, 3],
    ['intent.success/background.canvas', intent.success, background.canvas, 3],
    ['intent.warning/background.canvas', intent.warning, background.canvas, 3],
    ['intent.danger/background.canvas', intent.danger, background.canvas, 3],
    ['border.focus/background.canvas', border.focus, background.canvas, 3],
  ] as const;
  return pairs.flatMap(([label, foreground, backgroundColor, minimum]) => {
    const ratio = contrastRatio(foreground, backgroundColor);
    return ratio + Number.EPSILON < minimum ? [`${label} contrast ${ratio.toFixed(2)} is below ${String(minimum)}.`] : [];
  });
}

function detectTerminalAppearance(environment: Readonly<Record<string, string | undefined>> = process.env): ThemeAppearance {
  const colorFgBg = environment.COLORFGBG?.split(';').at(-1);
  if (colorFgBg !== undefined && /^\d+$/u.test(colorFgBg)) {
    const background = Number(colorFgBg);
    return background === 0 || (background >= 8 && background <= 15) ? 'dark' : 'light';
  }
  return environment.TERM_PROGRAM?.toLowerCase().includes('apple_terminal') === true ? 'light' : 'dark';
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


function markdownSyntaxForTheme(theme: TuiThemeDefinition): SyntaxStyle {
  const { background, border, text, intent } = theme.colors;
  return SyntaxStyle.fromStyles({
    text: { fg: text.primary },
    paragraph: { fg: text.primary },
    heading: { fg: text.strong, bold: true },
    strong: { fg: text.strong, bold: true },
    emphasis: { fg: text.primary, italic: true },
    code: { fg: intent.accentStrong, bg: background.recessed },
    codespan: { fg: intent.accentStrong, bg: background.recessed },
    link: { fg: intent.info, underline: true },
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
}

const DEFAULT_ACTIVE_THEME: ActiveTuiTheme = Object.freeze({
  definition: KINU_DARK,
  colors: KINU_DARK.colors,
  markdownSyntax: markdownSyntaxForTheme(KINU_DARK),
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
  const selection = props.selection ?? { mode: 'theme', themeId: 'kinu-dark' };
  const appearance = props.terminalAppearance ?? detectTerminalAppearance();
  const capability = props.colorCapability ?? detectTerminalColorCapability();
  const active = useMemo(() => {
    const definition = projectTheme(resolveThemeSelection(registry, selection, appearance), capability);
    return Object.freeze({
      definition,
      colors: definition.colors,
      markdownSyntax: markdownSyntaxForTheme(definition),
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
  if (theme.source === 'compatibility' && (theme.license?.spdx.trim() === '' || theme.license?.sourceUrl.trim() === '')) {
    throw new Error(`${source}: compatibility themes require license and source metadata.`);
  }
  const failures = themeContrastFailures(theme);
  if (failures.length > 0) throw new Error(`${source}: ${failures.join(' ')}`);
}


function freezeTheme(theme: TuiThemeDefinition): TuiThemeDefinition {
  const common = {
    id: theme.id,
    label: theme.label,
    appearance: theme.appearance,
    source: theme.source,
    colors: Object.freeze({
      background: Object.freeze({ ...theme.colors.background }),
      border: Object.freeze({ ...theme.colors.border }),
      text: Object.freeze({ ...theme.colors.text }),
      intent: Object.freeze({ ...theme.colors.intent }),
    }),
  };
  return Object.freeze(theme.license === undefined
    ? common
    : { ...common, license: Object.freeze({ ...theme.license }) });
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

function mapColors(colors: TuiThemeColors, map: (color: string) => string): TuiThemeColors {
  return {
    background: {
      canvas: map(colors.background.canvas),
      chrome: map(colors.background.chrome),
      surface: map(colors.background.surface),
      recessed: map(colors.background.recessed),
      selection: map(colors.background.selection),
      selectionStrong: map(colors.background.selectionStrong),
      user: map(colors.background.user),
    },
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
      warningMuted: map(colors.intent.warningMuted),
      danger: map(colors.intent.danger),
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
