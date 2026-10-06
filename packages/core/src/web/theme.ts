/**
 * Kinu's palette and radii, for the app and the signed-out pages alike: the app's stylesheet takes `THEME_CSS`
 * through `virtual:kinu-theme.css` (cf-backend/vite-theme.ts), and every public page inlines it.
 */

export type Mode = 'dark' | 'light';

export type PublicToken =
  | '--c-recessed' | '--c-bg' | '--c-sidebar' | '--c-surface' | '--c-elevated' | '--c-fill'
  | '--c-border' | '--c-border-strong' | '--c-input-border'
  | '--c-text' | '--c-text-2' | '--c-text-3'
  | '--c-accent' | '--c-accent-fg' | '--c-accent-on' | '--c-accent-subtle'
  | '--c-success' | '--c-warning' | '--c-danger'
  | '--c-code'
  | '--shadow-overlay';

export type TokenSet = Readonly<Record<PublicToken, string>>;

/** Dark on `:root`, light on `[data-mode="light"]`. */
const DARK = {
  '--c-recessed': '#131110',
  '--c-bg': '#0F0D0B',
  '--c-sidebar': '#141110',
  '--c-surface': '#181512',
  '--c-elevated': '#221C15',
  '--c-fill': '#1B1713',
  '--c-border': '#262019',
  '--c-border-strong': '#332C23',
  '--c-input-border': '#332C23',
  '--c-text': '#EDE5D8',
  '--c-text-2': '#D8CFC2',
  '--c-text-3': '#9C9184',
  '--c-accent': '#E0A458',
  '--c-accent-fg': '#E3D2AE',
  '--c-accent-on': '#1A1408',
  '--c-accent-subtle': 'rgba(224, 164, 88, 0.12)',
  '--c-success': '#8FBC8B',
  '--c-warning': '#E8B97A',
  '--c-danger': '#C97B6B',
  '--c-code': '#E3D2AE',
  '--shadow-overlay': '0 18px 44px -12px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
} satisfies TokenSet;

const LIGHT = {
  '--c-recessed': '#E0D8C5',
  '--c-bg': '#E9E2D3',
  '--c-sidebar': '#F1EBDD',
  '--c-surface': '#F7F3E9',
  '--c-elevated': '#E8E0CE',
  '--c-fill': '#E5DCC8',
  '--c-border': '#D2C6AE',
  '--c-border-strong': '#BBAB8C',
  '--c-input-border': '#BBAB8C',
  '--c-text': '#1C1710',
  '--c-text-2': '#3D3427',
  '--c-text-3': '#5E5344',
  '--c-accent': '#D89A44',
  '--c-accent-fg': '#7A5514',
  '--c-accent-on': '#1F1503',
  '--c-accent-subtle': 'rgba(216, 154, 68, 0.16)',
  '--c-success': '#316530',
  '--c-warning': '#7E5205',
  '--c-danger': '#96412C',
  '--c-code': '#7A5514',
  '--shadow-overlay': '0 16px 40px -14px rgba(43, 26, 4, 0.20), 0 2px 8px rgba(43, 26, 4, 0.07)',
} satisfies TokenSet;

/** Every block declares the complete set: an omitted token would resolve by source order. */
const THEME_BLOCKS: ReadonlyArray<{
  readonly selector: string;
  readonly mode: Mode;
  readonly tokens: TokenSet;
}> = [
  { selector: ':root', mode: 'dark', tokens: DARK },
  { selector: '[data-mode="light"]', mode: 'light', tokens: LIGHT },
];

/** Each mode's token values, for a reader that needs one colour outside the cascade. */
export const THEME_TOKENS: Readonly<Record<Mode, TokenSet>> = { dark: DARK, light: LIGHT };

export type RadiusRole = '--r-control' | '--r-row' | '--r-card' | '--r-overlay';

const RADII = {
  '--r-control': '6px',
  '--r-row': '8px',
  '--r-card': '14px',
  '--r-overlay': '14px',
} satisfies Readonly<Record<RadiusRole, string>>;

export const THEME_CSS = THEME_BLOCKS.map(({ selector, tokens }) => {
  const body = Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');
  const radii = selector === ':root' ? `;${Object.entries(RADII).map(([n, v]) => `${n}:${v}`).join(';')}` : '';

  return `${selector}{${body}${radii}}`;
}).join('\n');
