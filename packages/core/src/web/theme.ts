/**
 * Kinu's palettes and radii: the one table every colour token comes from, for the app, the signed-out pages and slate
 * pages alike. The app's stylesheet takes `THEME_CSS` through `virtual:kinu-theme.css` (cf-backend/vite-theme.ts);
 * public and slate pages inline it. Graphite is the default and what a signed-out page wears; an account may choose
 * Warm, which the server names on `<html data-theme>` before the page paints. The mode is the device's own choice, on
 * `data-mode`.
 */

export type Mode = 'dark' | 'light';

export const THEME_NAMES = ['graphite', 'warm'] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export const DEFAULT_THEME: ThemeName = 'graphite';

/** A stored or sent name the table holds; null for any other. */
export function themeNamed(value: string | null | undefined): ThemeName | null {
  return THEME_NAMES.find((name) => name === value) ?? null;
}

/** The user config row an account's theme is kept in; the server names it on every page it serves the account. */
export const THEME_CONFIG_KEY = 'theme';

/** A stored value the table names; the default for no choice or any other. */
export function accountTheme(stored: string | null): ThemeName {
  return themeNamed(stored) ?? DEFAULT_THEME;
}

export type ColourToken =
  | '--c-recessed' | '--c-bg' | '--c-sidebar' | '--c-surface' | '--c-elevated' | '--c-fill' | '--c-overlay'
  | '--c-border' | '--c-border-strong' | '--c-input-border' | '--c-dash'
  | '--c-text' | '--c-text-2' | '--c-text-3' | '--c-text-4'
  | '--c-accent' | '--c-accent-fg' | '--c-accent-on' | '--c-accent-subtle' | '--c-accent-mark'
  | '--c-success' | '--c-warning' | '--c-danger' | '--c-info'
  | '--c-success-tint' | '--c-warning-tint' | '--c-danger-tint' | '--c-info-tint' | '--c-neutral-tint'
  | '--c-code' | '--c-user-bg' | '--c-user-border' | '--c-input-bg'
  | '--c-composer-bg' | '--c-composer-line' | '--c-composer-line-focus' | '--c-scrim' | '--c-shadow-drop'
  | '--shadow-overlay' | '--shadow-card' | '--shadow-menu' | '--shadow-composer';

/** Every block declares the complete set: an omitted token would resolve by source order. */
export type TokenSet = Readonly<Record<ColourToken, string>>;

/*
 * Each palette's grounds step evenly in OKLCH lightness; every text role clears WCAG AA on every ground it can land on,
 * and control edges, brass edges and the open row's icon clear 3:1 (tests/browser/palette-ux.test.ts holds every theme
 * to that). Graphite is near-neutral, so brass is the only colour on screen; Warm keeps the umber ground at half its
 * old tint. Dark draws no card shadow: a card is a rung of the ladder plus a hairline.
 */
const GRAPHITE_DARK = {
  '--c-recessed': '#0B0A09',
  '--c-bg': '#100F0E',
  '--c-sidebar': '#141413',
  '--c-surface': '#1A1918',
  '--c-elevated': '#252423',
  '--c-fill': '#1F1E1D',
  '--c-overlay': '#252423',
  '--c-border': '#323130',
  '--c-border-strong': '#666664',
  '--c-input-border': '#666664',
  '--c-dash': '#292928',
  '--c-text': '#EDEBE8',
  '--c-text-2': '#D2D1CE',
  '--c-text-3': '#9D9C99',
  '--c-text-4': '#8D8C89',
  '--c-accent': '#E0A458',
  '--c-accent-fg': '#E6D3AC',
  '--c-accent-on': '#1F1306',
  '--c-accent-subtle': 'rgba(224, 164, 88, 0.12)',
  '--c-accent-mark': 'var(--c-accent)',
  '--c-success': '#7CCD8E',
  '--c-warning': '#E4CE63',
  '--c-danger': '#EF7F72',
  '--c-info': '#7EBCE8',
  '--c-success-tint': 'rgba(124, 205, 142, 0.14)',
  '--c-warning-tint': 'rgba(228, 206, 99, 0.14)',
  '--c-danger-tint': 'rgba(239, 127, 114, 0.14)',
  '--c-info-tint': 'rgba(126, 188, 232, 0.14)',
  '--c-neutral-tint': 'rgba(237, 235, 232, 0.06)',
  '--c-code': '#E6D3AC',
  '--c-user-bg': '#302416',
  '--c-user-border': '#4C3922',
  '--c-input-bg': '#090807',
  '--c-composer-bg': '#181716',
  '--c-composer-line': 'rgba(237, 235, 232, 0.09)',
  '--c-composer-line-focus': 'rgba(237, 235, 232, 0.18)',
  '--c-scrim': 'rgba(4, 3, 3, 0.6)',
  '--c-shadow-drop': 'rgba(0, 0, 0, 0.35)',
  '--shadow-overlay': '0 18px 44px -12px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 28px -10px rgba(0, 0, 0, 0.5)',
  '--shadow-composer': '0 12px 32px -12px rgba(0, 0, 0, 0.6), 0 2px 6px -2px rgba(0, 0, 0, 0.35)',
} satisfies TokenSet;

const GRAPHITE_LIGHT = {
  '--c-recessed': '#EAE9E8',
  '--c-bg': '#F9F9F8',
  '--c-sidebar': '#F3F2F1',
  '--c-surface': '#FFFFFF',
  '--c-elevated': '#EDEDEB',
  '--c-fill': '#EFEEED',
  '--c-overlay': '#FFFFFF',
  '--c-border': '#DAD9D8',
  '--c-border-strong': '#8B8A89',
  '--c-input-border': '#8B8A89',
  '--c-dash': '#E4E3E1',
  '--c-text': '#191816',
  '--c-text-2': '#3C3A38',
  '--c-text-3': '#615F5D',
  '--c-text-4': '#696765',
  '--c-accent': '#BE7D1D',
  '--c-accent-fg': '#865713',
  '--c-accent-on': '#1F1306',
  '--c-accent-subtle': 'rgba(190, 125, 29, 0.12)',
  '--c-accent-mark': 'var(--c-accent-fg)',
  '--c-success': '#29723E',
  '--c-warning': '#796300',
  '--c-danger': '#AB4335',
  '--c-info': '#2A6999',
  '--c-success-tint': 'rgba(41, 114, 62, 0.1)',
  '--c-warning-tint': 'rgba(121, 99, 0, 0.1)',
  '--c-danger-tint': 'rgba(171, 67, 53, 0.1)',
  '--c-info-tint': 'rgba(42, 105, 153, 0.1)',
  '--c-neutral-tint': 'rgba(25, 24, 22, 0.06)',
  '--c-code': '#865713',
  '--c-user-bg': '#F5E2C4',
  '--c-user-border': '#DDBF91',
  '--c-input-bg': '#FFFFFF',
  '--c-composer-bg': '#FFFFFF',
  '--c-composer-line': 'rgba(25, 24, 22, 0.12)',
  '--c-composer-line-focus': 'rgba(25, 24, 22, 0.24)',
  '--c-scrim': 'rgba(25, 24, 22, 0.28)',
  '--c-shadow-drop': 'rgba(25, 24, 22, 0.12)',
  '--shadow-overlay': '0 16px 40px -14px rgba(25, 24, 22, 0.20), 0 2px 8px rgba(25, 24, 22, 0.07)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 24px -10px rgba(25, 24, 22, 0.18), 0 1px 3px rgba(25, 24, 22, 0.06)',
  '--shadow-composer': '0 12px 32px -14px rgba(25, 24, 22, 0.24), 0 1px 3px rgba(25, 24, 22, 0.07)',
} satisfies TokenSet;

const WARM_DARK = {
  '--c-recessed': '#0D0905',
  '--c-bg': '#130F0A',
  '--c-sidebar': '#17130E',
  '--c-surface': '#1D1913',
  '--c-elevated': '#27231E',
  '--c-fill': '#211D18',
  '--c-overlay': '#27231E',
  '--c-border': '#35312B',
  '--c-border-strong': '#6B665F',
  '--c-input-border': '#6B665F',
  '--c-dash': '#2C2822',
  '--c-text': '#F1EAE1',
  '--c-text-2': '#D6D0C7',
  '--c-text-3': '#A19A92',
  '--c-text-4': '#918B83',
  '--c-accent': '#E0A458',
  '--c-accent-fg': '#E6D3AC',
  '--c-accent-on': '#1F1306',
  '--c-accent-subtle': 'rgba(224, 164, 88, 0.12)',
  '--c-accent-mark': 'var(--c-accent)',
  '--c-success': '#7CCD8E',
  '--c-warning': '#E4CE63',
  '--c-danger': '#EF7F72',
  '--c-info': '#7EBCE8',
  '--c-success-tint': 'rgba(124, 205, 142, 0.14)',
  '--c-warning-tint': 'rgba(228, 206, 99, 0.14)',
  '--c-danger-tint': 'rgba(239, 127, 114, 0.14)',
  '--c-info-tint': 'rgba(126, 188, 232, 0.14)',
  '--c-neutral-tint': 'rgba(241, 234, 225, 0.06)',
  '--c-code': '#E6D3AC',
  '--c-user-bg': '#302416',
  '--c-user-border': '#4C3922',
  '--c-input-bg': '#0B0804',
  '--c-composer-bg': '#1A1611',
  '--c-composer-line': 'rgba(241, 234, 225, 0.09)',
  '--c-composer-line-focus': 'rgba(241, 234, 225, 0.18)',
  '--c-scrim': 'rgba(5, 3, 1, 0.6)',
  '--c-shadow-drop': 'rgba(0, 0, 0, 0.35)',
  '--shadow-overlay': '0 18px 44px -12px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 28px -10px rgba(0, 0, 0, 0.5)',
  '--shadow-composer': '0 12px 32px -12px rgba(0, 0, 0, 0.6), 0 2px 6px -2px rgba(0, 0, 0, 0.35)',
} satisfies TokenSet;

const WARM_LIGHT = {
  '--c-recessed': '#EAE2D7',
  '--c-bg': '#FAF2E7',
  '--c-sidebar': '#F4EBE1',
  '--c-surface': '#FEFBF8',
  '--c-elevated': '#EDE5DA',
  '--c-fill': '#EFE7DC',
  '--c-overlay': '#FEFBF8',
  '--c-border': '#D9D1C7',
  '--c-border-strong': '#8D867C',
  '--c-input-border': '#8D867C',
  '--c-dash': '#E3DBD0',
  '--c-text': '#1C1711',
  '--c-text-2': '#3F3A33',
  '--c-text-3': '#615B54',
  '--c-text-4': '#69635C',
  '--c-accent': '#BA7917',
  '--c-accent-fg': '#82530D',
  '--c-accent-on': '#1F1306',
  '--c-accent-subtle': 'rgba(186, 121, 23, 0.12)',
  '--c-accent-mark': 'var(--c-accent-fg)',
  '--c-success': '#246E3A',
  '--c-warning': '#755F00',
  '--c-danger': '#A73F32',
  '--c-info': '#266595',
  '--c-success-tint': 'rgba(36, 110, 58, 0.1)',
  '--c-warning-tint': 'rgba(117, 95, 0, 0.1)',
  '--c-danger-tint': 'rgba(167, 63, 50, 0.1)',
  '--c-info-tint': 'rgba(38, 101, 149, 0.1)',
  '--c-neutral-tint': 'rgba(28, 23, 17, 0.06)',
  '--c-code': '#82530D',
  '--c-user-bg': '#F5E2C4',
  '--c-user-border': '#DDBF91',
  '--c-input-bg': '#FEFBF8',
  '--c-composer-bg': '#FEFBF8',
  '--c-composer-line': 'rgba(28, 23, 17, 0.12)',
  '--c-composer-line-focus': 'rgba(28, 23, 17, 0.24)',
  '--c-scrim': 'rgba(28, 23, 17, 0.28)',
  '--c-shadow-drop': 'rgba(28, 23, 17, 0.12)',
  '--shadow-overlay': '0 16px 40px -14px rgba(43, 26, 4, 0.20), 0 2px 8px rgba(43, 26, 4, 0.07)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 24px -10px rgba(43, 26, 4, 0.18), 0 1px 3px rgba(43, 26, 4, 0.06)',
  '--shadow-composer': '0 12px 32px -14px rgba(43, 26, 4, 0.24), 0 1px 3px rgba(43, 26, 4, 0.07)',
} satisfies TokenSet;

/** Each theme's token values by mode, for a reader that needs one colour outside the cascade. */
export const THEME_TOKENS: Readonly<Record<ThemeName, Readonly<Record<Mode, TokenSet>>>> = {
  graphite: { dark: GRAPHITE_DARK, light: GRAPHITE_LIGHT },
  warm: { dark: WARM_DARK, light: WARM_LIGHT },
};

export type RadiusRole = '--r-control' | '--r-row' | '--r-card' | '--r-overlay';

const RADII = {
  '--r-control': '6px',
  '--r-row': '8px',
  '--r-card': '14px',
  '--r-overlay': '14px',
} satisfies Readonly<Record<RadiusRole, string>>;

/**
 * The default theme is unnamed on `:root`; every theme also answers its own `data-theme`, so a swatch can wear one
 * inside a page in another. A theme's light block names both attributes and so outranks any one-attribute block, and
 * the other themes come after the default, so on a tie they win.
 */
function selectors(theme: ThemeName, mode: Mode): string {
  const named = `[data-theme="${theme}"]${mode === 'light' ? '[data-mode="light"]' : ''}`;

  if (theme !== DEFAULT_THEME) return named;

  return `${mode === 'dark' ? ':root' : '[data-mode="light"]'},${named}`;
}

const declarations = (tokens: Readonly<Record<string, string>>): string => Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');

const ORDERED: readonly ThemeName[] = [DEFAULT_THEME, ...THEME_NAMES.filter((name) => name !== DEFAULT_THEME)];

export const THEME_CSS = [
  `:root{${declarations(RADII)}}`,
  ...ORDERED.flatMap((theme) => (['dark', 'light'] as const).map((mode) => `${selectors(theme, mode)}{${declarations(THEME_TOKENS[theme][mode])}}`)),
].join('\n');

/** The ANSI colours a terminal draws in: each of the 16 slots and the ground. */
export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly black: string; readonly red: string; readonly green: string; readonly yellow: string;
  readonly blue: string; readonly magenta: string; readonly cyan: string; readonly white: string;
  readonly brightBlack: string; readonly brightRed: string; readonly brightGreen: string; readonly brightYellow: string;
  readonly brightBlue: string; readonly brightMagenta: string; readonly brightCyan: string; readonly brightWhite: string;
}

/** Magenta and cyan, which no role names, pulled into the warm family. */
const ANSI_UNTOKENED = {
  dark: { magenta: '#c9a0c6', cyan: '#8fbdb8' },
  light: { magenta: '#7a3f74', cyan: '#2f6660' },
} as const satisfies Readonly<Record<Mode, { magenta: string; cyan: string }>>;

/**
 * A terminal's palette from a theme's tokens, every slot a program writes text in readable on its ground. The status
 * slots take their role's token, and a bright slot its plain one, as bold draws in it: xterm's own bright colours
 * (tango's #8ae234 green, 1.5:1 on the light ground) left a bold prompt nearly unreadable there (the owner,
 * 2026-10-15). On a light ground black is the ink and white a grey, as GitHub's and Solarized's light terminals have
 * them; on a dark one, black stays the recess a program paints backgrounds with.
 */
export function terminalPalette(mode: Mode, token: (name: ColourToken) => string): TerminalPalette {
  const { magenta, cyan } = ANSI_UNTOKENED[mode];
  const roles = { red: token('--c-danger'), green: token('--c-success'), yellow: token('--c-warning'), blue: token('--c-info'), magenta, cyan };
  const light = mode === 'light';

  return {
    background: token('--c-bg'),
    foreground: token('--c-text'),
    cursor: token('--c-accent'),
    ...roles,
    brightRed: roles.red, brightGreen: roles.green, brightYellow: roles.yellow, brightBlue: roles.blue,
    brightMagenta: magenta, brightCyan: cyan,
    black: light ? token('--c-text') : token('--c-recessed'),
    white: light ? token('--c-text-2') : token('--c-text'),
    brightBlack: token('--c-text-3'),
    brightWhite: light ? token('--c-text-3') : token('--c-text'),
  };
}
