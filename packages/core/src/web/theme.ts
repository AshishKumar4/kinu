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
  | '--c-bg' | '--c-sidebar' | '--c-sunken' | '--c-surface' | '--c-field' | '--c-fill' | '--c-overlay'
  | '--c-hover' | '--c-pressed' | '--c-selected'
  | '--c-border' | '--c-border-strong' | '--c-field-border' | '--c-dash'
  | '--c-text' | '--c-text-2' | '--c-text-3'
  | '--c-accent' | '--c-accent-fg' | '--c-accent-on' | '--c-accent-mark' | '--c-focus'
  | '--c-success' | '--c-warning' | '--c-danger' | '--c-info'
  | '--c-success-tint' | '--c-warning-tint' | '--c-danger-tint' | '--c-info-tint' | '--c-danger-on'
  | '--c-button-bg' | '--c-button-bg-hover' | '--c-button-bg-active' | '--c-button-line'
  | '--c-user-bg' | '--c-user-border'
  | '--c-composer-bg' | '--c-composer-line' | '--c-composer-line-focus' | '--c-scrim' | '--c-shadow-drop'
  | '--c-accent-hover' | '--c-accent-active' | '--c-danger-hover'
  | '--shadow-overlay' | '--shadow-card' | '--shadow-menu' | '--shadow-composer' | '--shadow-button'
  | '--shadow-primary' | '--shadow-destructive' | '--shadow-tab';

/** Every block declares the complete set: an omitted token would resolve by source order. */
export type TokenSet = Readonly<Record<ColourToken, string>>;

/*
 * Each palette's grounds step evenly in OKLCH lightness; every text role clears WCAG AA on every ground it can land on,
 * and control edges, brass edges and the open row's icon clear 3:1 (tests/browser/palette-ux.test.ts holds every theme
 * to that). Graphite is near-neutral, so brass is the only colour on screen. Warm is the owner's own palette as it was
 * approved (2026-10-14: "no need to change warm more"): its grounds, papers, text and bubble as they were, with only
 * what the contrast rules need moved in its own hue (the control edge, the brass edge on light paper) and warning
 * turned 20 degrees off brass so the two never read as one. Dark draws no card shadow: a card is a rung of the ladder
 * plus a hairline.
 */
const GRAPHITE_DARK = {
  '--c-sunken': '#0B0A09',
  '--c-bg': '#100F0E',
  '--c-sidebar': '#141413',
  '--c-surface': '#1A1918',
  '--c-fill': '#1F1E1D',
  '--c-overlay': '#252423',
  '--c-border': '#323130',
  '--c-border-strong': '#666664',
  '--c-field-border': '#666664',
  '--c-dash': '#292928',
  '--c-text': '#EDEBE8',
  '--c-text-2': '#D2D1CE',
  '--c-text-3': '#9D9C99',
  '--c-accent': '#E0A458',
  '--c-accent-fg': '#E6D3AC',
  '--c-accent-on': '#1F1306',
  '--c-selected': 'rgba(224, 164, 88, 0.12)',
  '--c-accent-mark': 'var(--c-accent)',
  '--c-success': '#7CCD8E',
  '--c-warning': '#E4CE63',
  '--c-danger': '#EF7F72',
  '--c-info': '#7EBCE8',
  '--c-success-tint': 'rgba(124, 205, 142, 0.14)',
  '--c-warning-tint': 'rgba(228, 206, 99, 0.14)',
  '--c-danger-tint': 'rgba(239, 127, 114, 0.14)',
  '--c-info-tint': 'rgba(126, 188, 232, 0.14)',
  '--c-hover': 'rgba(237, 235, 232, 0.06)',
  '--c-pressed': 'rgba(237, 235, 232, 0.1)',
  '--c-user-bg': '#302416',
  '--c-user-border': '#4C3922',
  '--c-field': '#090807',
  '--c-composer-bg': '#181716',
  '--c-composer-line': 'rgba(237, 235, 232, 0.09)',
  '--c-composer-line-focus': 'rgba(237, 235, 232, 0.18)',
  '--c-scrim': 'rgba(4, 3, 3, 0.6)',
  '--c-shadow-drop': 'rgba(0, 0, 0, 0.35)',
  '--shadow-overlay': '0 18px 44px -12px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 28px -10px rgba(0, 0, 0, 0.5)',
  '--shadow-composer': '0 12px 32px -12px rgba(0, 0, 0, 0.6), 0 2px 6px -2px rgba(0, 0, 0, 0.35)',
  // A button's own fill, edge and lift (design review 2026-10-20, A4): quieter than an input's 3:1 edge.
  '--c-button-bg': '#232221',
  '--c-button-bg-hover': '#2A2928',
  '--c-button-bg-active': '#1E1D1C',
  '--c-button-line': 'rgba(237, 235, 232, 0.09)',
  '--shadow-button': 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
  '--c-danger-on': '#1A0B08',
  // The focus ring: 3:1 on every ground (brass itself is too light on the light grounds).
  '--c-focus': '#E0A458',
  // A filled control pressed or hovered (a step darker on light grounds, lighter on dark), and the lifts a filled
  // button and a raised tab carry.
  '--c-accent-hover': '#E3AD69',
  '--c-accent-active': '#CE9751',
  '--c-danger-hover': '#D77267',
  '--shadow-primary': 'inset 0 1px 0 rgba(255, 255, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
  '--shadow-destructive': 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
  '--shadow-tab': '0 1px 2px rgba(0, 0, 0, 0.18)',
} satisfies TokenSet;

const GRAPHITE_LIGHT = {
  '--c-sunken': '#EAE9E8',
  '--c-bg': '#F9F9F8',
  '--c-sidebar': '#F3F2F1',
  '--c-surface': '#FFFFFF',
  '--c-fill': '#EFEEED',
  '--c-overlay': '#FFFFFF',
  '--c-border': '#DAD9D8',
  '--c-border-strong': '#8B8A89',
  '--c-field-border': '#8B8A89',
  '--c-dash': '#E4E3E1',
  '--c-text': '#191816',
  '--c-text-2': '#3C3A38',
  '--c-text-3': '#615F5D',
  '--c-accent': '#BE7D1D',
  '--c-accent-fg': '#865713',
  '--c-accent-on': '#1F1306',
  '--c-selected': 'rgba(190, 125, 29, 0.12)',
  '--c-accent-mark': 'var(--c-accent-fg)',
  '--c-success': '#29723E',
  '--c-warning': '#796300',
  '--c-danger': '#AB4335',
  '--c-info': '#2A6999',
  '--c-success-tint': 'rgba(41, 114, 62, 0.1)',
  '--c-warning-tint': 'rgba(121, 99, 0, 0.1)',
  '--c-danger-tint': 'rgba(171, 67, 53, 0.1)',
  '--c-info-tint': 'rgba(42, 105, 153, 0.1)',
  '--c-hover': 'rgba(25, 24, 22, 0.06)',
  '--c-pressed': 'rgba(25, 24, 22, 0.1)',
  '--c-user-bg': '#F5E2C4',
  '--c-user-border': '#DDBF91',
  '--c-field': '#FFFFFF',
  '--c-composer-bg': '#FFFFFF',
  '--c-composer-line': 'rgba(25, 24, 22, 0.12)',
  '--c-composer-line-focus': 'rgba(25, 24, 22, 0.24)',
  '--c-scrim': 'rgba(25, 24, 22, 0.28)',
  '--c-shadow-drop': 'rgba(25, 24, 22, 0.12)',
  '--shadow-overlay': '0 16px 40px -14px rgba(25, 24, 22, 0.20), 0 2px 8px rgba(25, 24, 22, 0.07)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 24px -10px rgba(25, 24, 22, 0.18), 0 1px 3px rgba(25, 24, 22, 0.06)',
  '--shadow-composer': '0 12px 32px -14px rgba(25, 24, 22, 0.24), 0 1px 3px rgba(25, 24, 22, 0.07)',
  // A button's own fill, edge and lift (design review 2026-10-20, A4): quieter than an input's 3:1 edge.
  '--c-button-bg': '#FFFFFF',
  '--c-button-bg-hover': '#F4F4F3',
  '--c-button-bg-active': '#ECECEA',
  '--c-button-line': 'rgba(25, 24, 22, 0.13)',
  '--shadow-button': '0 1px 2px rgba(25, 24, 22, 0.06)',
  '--c-danger-on': '#FFFFFF',
  // The focus ring: 3:1 on every ground (brass itself is too light on the light grounds).
  '--c-focus': '#9D691C',
  // A filled control pressed or hovered (a step darker on light grounds, lighter on dark), and the lifts a filled
  // button and a raised tab carry.
  '--c-accent-hover': '#AF731B',
  '--c-accent-active': '#A36B19',
  '--c-danger-hover': '#9A3C30',
  '--shadow-primary': 'inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px rgba(25, 24, 22, 0.06)',
  '--shadow-destructive': 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
  '--shadow-tab': '0 1px 2px rgba(0, 0, 0, 0.18)',
} satisfies TokenSet;

const WARM_DARK = {
  '--c-sunken': '#131110',
  '--c-bg': '#0F0D0B',
  '--c-sidebar': '#141110',
  '--c-surface': '#181512',
  '--c-fill': '#1B1713',
  '--c-overlay': '#221C15',
  '--c-border': '#302920',
  '--c-border-strong': '#696257',
  '--c-field-border': '#696257',
  '--c-dash': '#2A241D',
  '--c-text': '#EDE5D8',
  '--c-text-2': '#D8CFC2',
  '--c-text-3': '#9C9184',
  '--c-accent': '#E0A458',
  '--c-accent-fg': '#E3D2AE',
  '--c-accent-on': '#1A1408',
  '--c-selected': 'rgba(224, 164, 88, 0.12)',
  '--c-accent-mark': 'var(--c-accent)',
  '--c-success': '#8FBC8B',
  '--c-warning': '#DAC077',
  '--c-danger': '#C97B6B',
  '--c-info': '#8FB6D6',
  '--c-success-tint': 'rgba(143, 188, 139, 0.14)',
  '--c-warning-tint': 'rgba(218, 192, 119, 0.14)',
  '--c-danger-tint': 'rgba(201, 123, 107, 0.14)',
  '--c-info-tint': 'rgba(143, 182, 214, 0.14)',
  '--c-hover': 'rgba(237, 229, 216, 0.06)',
  '--c-pressed': 'rgba(237, 229, 216, 0.1)',
  '--c-user-bg': '#241E16',
  '--c-user-border': '#3A3126',
  '--c-field': '#0B0A09',
  '--c-composer-bg': '#1A1714',
  '--c-composer-line': 'rgba(237, 229, 216, 0.08)',
  '--c-composer-line-focus': 'rgba(237, 229, 216, 0.16)',
  '--c-scrim': 'rgba(10, 8, 5, 0.55)',
  '--c-shadow-drop': 'rgba(0, 0, 0, 0.3)',
  '--shadow-overlay': '0 18px 44px -12px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 28px -10px rgba(0, 0, 0, 0.5)',
  '--shadow-composer': '0 12px 32px -12px rgba(0, 0, 0, 0.6), 0 2px 6px -2px rgba(0, 0, 0, 0.35)',
  // A button's own fill, edge and lift (design review 2026-10-20, A4): quieter than an input's 3:1 edge.
  '--c-button-bg': '#201B16',
  '--c-button-bg-hover': '#27211A',
  '--c-button-bg-active': '#1B1713',
  '--c-button-line': 'rgba(237, 229, 216, 0.09)',
  '--shadow-button': 'inset 0 1px 0 rgba(255, 240, 220, 0.04)',
  '--c-danger-on': '#1A0B08',
  // The focus ring: 3:1 on every ground (brass itself is too light on the light grounds).
  '--c-focus': '#E0A458',
  // A filled control pressed or hovered (a step darker on light grounds, lighter on dark), and the lifts a filled
  // button and a raised tab carry.
  '--c-accent-hover': '#E3AD69',
  '--c-accent-active': '#CE9751',
  '--c-danger-hover': '#B56F60',
  '--shadow-primary': 'inset 0 1px 0 rgba(255, 255, 255, 0.16), inset 0 1px 0 rgba(255, 240, 220, 0.04)',
  '--shadow-destructive': 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
  '--shadow-tab': '0 1px 2px rgba(0, 0, 0, 0.18)',
} satisfies TokenSet;

const WARM_LIGHT = {
  '--c-sunken': '#E0D8C5',
  '--c-bg': '#E9E2D3',
  '--c-sidebar': '#F1EBDD',
  '--c-surface': '#F7F3E9',
  '--c-fill': '#E5DCC8',
  '--c-overlay': '#F7F3E9',
  '--c-border': '#D2C6AE',
  '--c-border-strong': '#8F7F62',
  '--c-field-border': '#8F7F62',
  '--c-dash': '#DBD1BE',
  '--c-text': '#1C1710',
  '--c-text-2': '#3D3427',
  '--c-text-3': '#5E5344',
  '--c-accent': '#B17513',
  '--c-accent-fg': '#7A5514',
  '--c-accent-on': '#1F1503',
  '--c-selected': 'rgba(216, 154, 68, 0.16)',
  '--c-accent-mark': 'var(--c-accent-fg)',
  '--c-success': '#316530',
  '--c-warning': '#715A00',
  '--c-danger': '#96412C',
  '--c-info': '#2F6289',
  '--c-success-tint': 'rgba(49, 101, 48, 0.11)',
  '--c-warning-tint': 'rgba(113, 90, 0, 0.1)',
  '--c-danger-tint': 'rgba(150, 65, 44, 0.11)',
  '--c-info-tint': 'rgba(47, 98, 137, 0.08)',
  '--c-hover': 'rgba(43, 36, 25, 0.07)',
  '--c-pressed': 'rgba(43, 36, 25, 0.11)',
  '--c-user-bg': '#F2D9AC',
  '--c-user-border': '#D9B573',
  '--c-field': '#F7F3E9',
  '--c-composer-bg': '#F8F4EB',
  '--c-composer-line': 'rgba(43, 36, 25, 0.10)',
  '--c-composer-line-focus': 'rgba(43, 36, 25, 0.20)',
  '--c-scrim': 'rgba(43, 26, 4, 0.32)',
  '--c-shadow-drop': 'rgba(43, 26, 4, 0.14)',
  '--shadow-overlay': '0 16px 40px -14px rgba(43, 26, 4, 0.20), 0 2px 8px rgba(43, 26, 4, 0.07)',
  '--shadow-card': 'none',
  '--shadow-menu': '0 10px 24px -10px rgba(43, 26, 4, 0.18), 0 1px 3px rgba(43, 26, 4, 0.06)',
  '--shadow-composer': '0 12px 32px -14px rgba(43, 26, 4, 0.24), 0 1px 3px rgba(43, 26, 4, 0.07)',
  // A button's own fill, edge and lift (design review 2026-10-20, A4): quieter than an input's 3:1 edge.
  '--c-button-bg': '#FBF8F1',
  '--c-button-bg-hover': '#F3EEE2',
  '--c-button-bg-active': '#ECE5D5',
  '--c-button-line': 'rgba(43, 36, 25, 0.15)',
  '--shadow-button': '0 1px 2px rgba(43, 26, 4, 0.07)',
  '--c-danger-on': '#FFFFFF',
  // The focus ring: 3:1 on every ground (brass itself is too light on the light grounds).
  '--c-focus': '#936212',
  // A filled control pressed or hovered (a step darker on light grounds, lighter on dark), and the lifts a filled
  // button and a raised tab carry.
  '--c-accent-hover': '#A36C11',
  '--c-accent-active': '#986510',
  '--c-danger-hover': '#873B28',
  '--shadow-primary': 'inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px rgba(43, 26, 4, 0.07)',
  '--shadow-destructive': 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
  '--shadow-tab': '0 1px 2px rgba(0, 0, 0, 0.18)',
} satisfies TokenSet;

/** Each theme's token values by mode, for a reader that needs one colour outside the cascade. */
export const THEME_TOKENS: Readonly<Record<ThemeName, Readonly<Record<Mode, TokenSet>>>> = {
  graphite: { dark: GRAPHITE_DARK, light: GRAPHITE_LIGHT },
  warm: { dark: WARM_DARK, light: WARM_LIGHT },
};

export type RadiusRole = '--r-check' | '--r-inner' | '--r-control' | '--r-row' | '--r-card' | '--r-pill'
  | '--r-composer' | '--r-workspace-tab' | '--r-workspace-tab-outline' | '--r-workspace-tab-flare'
  | '--r-bubble' | '--r-bubble-tail' | '--r-prompt';

/** The only radii (design system §1.5): a checkbox; an inner piece; a control; a row, menu or notice; a card, tile or
 *  dialog; and a pill. Then the named variants of the approved composer and the settled workspace tab: its rename
 *  field, the outline's top corners and its flared feet; the person's chat bubble, round but for the corner that
 *  points at them; and the prompt card that opens a workspace or a chat. */
const RADII = {
  '--r-check': '4px',
  '--r-inner': '6px',
  '--r-control': '8px',
  '--r-row': '12px',
  '--r-card': '14px',
  '--r-pill': '999px',
  '--r-composer': '24px',
  '--r-workspace-tab': '7px',
  '--r-workspace-tab-outline': '10px',
  '--r-workspace-tab-flare': '8px',
  '--r-bubble': '16px',
  '--r-bubble-tail': '4px',
  '--r-prompt': '16px',
} satisfies Readonly<Record<RadiusRole, string>>;

/**
 * The colours the agents' mascots and their accessories are drawn in (components/Marks.tsx): an illustration's own, the
 * same in every look, so a mascot is the same character on a dark page and a light one.
 */
export const ILLUSTRATION = {
  teal: '#1F7A72', tealLight: '#2FA39A', blue: '#3366B5', ink: '#4A4366', sky: '#4C86E0', lilac: '#8C86A3',
  berry: '#C94F88', red: '#E0524F', pink: '#EC6FA8', rose: '#F07FAE', gold: '#F2BE45',
} as const;

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

/** Colours the same in every look: a partner's full-colour mark sits on white, as its guidelines ask, and a mark drawn
 *  in white (GitHub's) on near-black; an avatar's initial is white on its name's hue; the prompt card's long soft drop. */
const FIXED = {
  '--c-brand-tile': '#FFFFFF',
  '--c-brand-tile-ink': '#111318',
  '--c-avatar-ink': '#FFFFFF',
  '--shadow-prompt': '0 18px 55px -42px rgba(0, 0, 0, 0.75)',
} satisfies Readonly<Record<`--c-${string}` | `--shadow-${string}`, string>>;

/** An avatar's ground (ui/Avatar.tsx): its name's hue at a middle lightness, so the white initial reads in every look. */
export function avatarGround(hue: number): string {
  return `hsl(${String(hue)} 45% 45%)`;
}

/**
 * The public pages' type (design system §1.3, the public variants): the landing, /privacy, /terms and the deploy flow
 * are read by someone not yet in the app, at a reading size, not the app chrome's 13. Body 15, lede 17 and the
 * call to action's 14, each with its leading; the public shell's CSS and the app's t-public-* roles read these.
 */
const PUBLIC_TYPE = {
  '--t-public-body': '15px',
  '--t-public-body-leading': '1.7',
  '--t-public-lede': '17px',
  '--t-public-lede-leading': '1.62',
  '--t-public-control': '14px',
} satisfies Readonly<Record<`--t-public-${string}`, string>>;

const declarations = (tokens: Readonly<Record<string, string>>): string => Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');

const ORDERED: readonly ThemeName[] = [DEFAULT_THEME, ...THEME_NAMES.filter((name) => name !== DEFAULT_THEME)];

export const THEME_CSS = [
  `:root{${declarations(RADII)};${declarations(PUBLIC_TYPE)};${declarations(FIXED)}}`,
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
    black: light ? token('--c-text') : token('--c-sunken'),
    white: light ? token('--c-text-2') : token('--c-text'),
    brightBlack: token('--c-text-3'),
    brightWhite: light ? token('--c-text-3') : token('--c-text'),
  };
}
