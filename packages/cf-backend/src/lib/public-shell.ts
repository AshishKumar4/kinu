/**
 * The one HTML shell every signed-out page is built from.
 *
 * Four public surfaces render outside React and outside the bundle: the front
 * page, sign-in, the OAuth result pages, and the CLI install and approval
 * pages. Each used to carry its own `<style>` block with its own copy of the
 * umber hexes, `color-scheme: dark` pinned, and its own header. Four copies is
 * four designs: they drifted on hairline alpha, on control height, on whether
 * light mode existed at all, and a token edit in `index.css` reached none of
 * them.
 *
 * So this module owns the public face: tokens, chrome, the type scale, the
 * controls and the responsive rules. A page supplies a title and a body.
 *
 * ## Tokens
 *
 * `THEME_BLOCKS` is a projection of `index.css`, not a second palette. Every
 * value is what that stylesheet declares for the same token in the same theme,
 * and `unit-public-shell.test.ts` replays the cascade in `index.css` and fails
 * when one drifts. That is why the projection is data rather than a string of
 * CSS.
 *
 * The public face and the app share ONE palette — the owner's app mock,
 * warm blacks and gold. A returning user's stored mode is honoured, because
 * the app writes it on this same origin.
 *
 * ## Type
 *
 * Three faces, no web fonts, no bytes over the wire. A Palatino-family serif
 * for display, the system sans for reading, the system mono for labels and
 * commands. Every landing page worth studying uses a display face that is not
 * the UI font (omp.sh sets Fraunces over "Iowan Old Style"; pi.dev sets Plantin
 * over Georgia), and a page that leaves its headline in `-apple-system` reads
 * as a dashboard with marketing copy in it.
 */

import { escapeHtml } from './http';

/* ── Tokens ──────────────────────────────────────────────────────────── */

export type Mode = 'dark' | 'light';

/** The tokens the public pages use, and nothing else. A token added here must
 *  exist in `index.css` for both modes or the parity test fails. */
export type PublicToken =
  | '--c-recessed' | '--c-bg' | '--c-sidebar' | '--c-surface' | '--c-elevated' | '--c-fill'
  | '--c-border' | '--c-border-strong' | '--c-input-border'
  | '--c-text' | '--c-text-2' | '--c-text-3'
  | '--c-accent' | '--c-accent-fg' | '--c-accent-on' | '--c-accent-subtle'
  | '--c-success' | '--c-warning' | '--c-danger'
  | '--c-code';

export type TokenSet = Readonly<Record<PublicToken, string>>;

/** The projection of `index.css`'s two blocks — dark on `:root`, light on
 *  `[data-mode="light"]`. Values are the owner's app mock, verbatim; the
 *  parity test replays the app cascade and fails when one drifts. */
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
} satisfies TokenSet;

/**
 * Selector → tokens, in the source order the cascade needs.
 *
 * Every block declares the COMPLETE set: a token one block omitted would
 * resolve by source order instead of by intent.
 */
export const THEME_BLOCKS: ReadonlyArray<{
  readonly selector: string;
  readonly mode: Mode;
  readonly tokens: TokenSet;
}> = [
  { selector: ':root', mode: 'dark', tokens: DARK },
  { selector: '[data-mode="light"]', mode: 'light', tokens: LIGHT },
];


export type RadiusRole = '--r-control' | '--r-row' | '--r-card' | '--r-overlay';

/** Radii, as the roles `index.css` states them. The mock's two 14px measures
 *  (outer card, composer) are literals there now, not Tailwind rungs, so the
 *  parity test compares these strings to the role declarations directly. */
export const RADII = {
  '--r-control': '6px',
  '--r-row': '8px',
  '--r-card': '14px',
  '--r-overlay': '14px',
} satisfies Readonly<Record<RadiusRole, string>>;

/**
 * Pre-paint theme resolution, as the text that ships.
 *
 * It runs before the first paint, so it cannot be a module. One copy lives
 * here, and `unit-public-shell.test.ts` evaluates this exact text against
 * stubbed storage to prove the resolutions.
 *
 * The app's own bootstrap in `index.html` resolves the same way.
 */
export const THEME_BOOT = `(() => {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var mode = stored === 'light' || stored === 'dark'
    ? stored
    : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.setAttribute('data-mode', mode);
  root.style.colorScheme = mode;
})();`;

/* ── The mark ────────────────────────────────────────────────────────── */

/**
 * Kinu is 絹, silk. The mark is the hiragana く, one stroke, which is also the
 * turn a search makes: a line arrives, changes direction, and leaves. Each
 * candidate below is that stroke and nothing else. No container, no gradient,
 * no second colour. They are hand-authored paths on a 24-unit grid, drawn to
 * hold at 16px.
 *
 * `KINU_MARK` selects the one that ships, so the pick is this line.
 */
export type MarkId = 'kana' | 'node' | 'loom' | 'brush';

export const KINU_MARK: MarkId = 'brush';

/** The stroke, as the kana is written.
 *
 * A symmetric chevron is a mathematical `>`, not a く. Four things make the
 * difference and all four are geometry: the turn sits above the middle, the
 * entry is the SHORT stroke, the exit is long and bows right before it leaves,
 * and the corner is a point rather than a curve. Getting them wrong is what
 * makes a "japanese-looking" mark come out as a caret.
 */
const KU = 'M 10.2 3.6 Q 14.4 6.2 17 9.6 Q 15.2 15 4.8 21';

/** The corner is mitred and the ends are round: a brush leaves a point where it
 *  changes direction and a soft edge where it lifts. */
const STROKE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="miter"';

const MARK_BODIES = {
  kana: `<path d="${KU}" ${STROKE} stroke-width="2"/>`,
  // The stroke with its turn marked. A node with two edges IS the smallest
  // search tree, and it is also where the kana changes direction, so one dot
  // carries the product and the name at the same time. It is the only mark
  // here that still reads as something at 16px.
  node: `<path d="${KU}" ${STROKE} stroke-width="1.9"/><circle cx="17" cy="9.6" r="2.5" fill="currentColor"/>`,
  // Warp and weft. One vertical filament at low weight, crossed by the stroke,
  // which is what a loom is, and what silk is made on.
  loom: `<path d="M 4.6 3.4 L 4.6 20.6" ${STROKE} stroke-width="1.2" stroke-opacity="0.38"/><path d="M 10.6 3.6 Q 14.8 6.2 17.4 9.6 Q 15.6 15 5.4 21" ${STROKE} stroke-width="2"/>`,
  // The stroke as a brush lays it: pressed on entry, held through the turn,
  // lifted on the way out. One filled outline offset from the same centre line,
  // so there is no stroke weight left to thin out at 16px — the taper stops at
  // 0.55 units for that reason, which is a third of a pixel on a favicon and
  // still a visible tail.
  brush: `<path d="M 11.52 2.1 Q 15.72 4.7 18.65 9.58 Q 16.33 16.2 5.18 21.4 L 4.42 20.6 Q 14.07 13.8 15.35 9.62 Q 13.08 7.7 8.88 5.1 Z" fill="currentColor"/>`,
} satisfies Readonly<Record<MarkId, string>>;

/** The mark at `size` px, coloured by `currentColor`. */
export function mark(size: number, id: MarkId = KINU_MARK): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${MARK_BODIES[id]}</svg>`;
}

export const MARK_IDS: readonly MarkId[] = ['kana', 'node', 'loom', 'brush'];

/** Mark plus name, as one link home. */
export function wordmark(size = 21): string {
  return `<a class="brand" href="/" aria-label="Kinu.run home">${mark(size)}<span>Kinu.run</span></a>`;
}

/** The favicon, as its own document. Same paths, one declared colour, because a
 *  favicon has no cascade to inherit from. */
export function markDocument(id: MarkId = KINU_MARK): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" color="${DARK['--c-accent']}">${MARK_BODIES[id]}</svg>\n`;
}

/* ── Stylesheet ──────────────────────────────────────────────────────── */

const THEME_CSS = THEME_BLOCKS.map(({ selector, tokens }) => {
  const body = Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');
  const radii = selector === ':root' ? `;${Object.entries(RADII).map(([n, v]) => `${n}:${v}`).join(';')}` : '';
  return `${selector}{${body}${radii}}`;
}).join('\n');

/** The webfonts the public pages ship: Schibsted Grotesk, variable
 *  [wght 400-900], for display and UI, and Fragment Mono for labels and
 *  commands — the app's own three-face system minus Newsreader, which is
 *  app-only. Latin subsets, self-hosted (no font CDN at runtime), beside
 *  their OFL licence in `public/assets/fonts/`. `unit-public-shell` holds
 *  their byte budgets so an unsubset swap cannot land silently. */
const UI_FONT_PATH = '/assets/fonts/schibsted-latin-var.woff2';
const MONO_FONT_PATH = '/assets/fonts/fragmentmono-latin.woff2';
const FONT_FACES = [
  `@font-face{font-family:"Schibsted Grotesk";src:url("${UI_FONT_PATH}") format("woff2-variations");font-weight:400 900;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`,
  `@font-face{font-family:"Fragment Mono";src:url("${MONO_FONT_PATH}") format("woff2");font-weight:400;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`,
].join('\n');

/**
 * One stylesheet for every public page.
 *
 * Structure comes from surface steps and hairlines, never from shadows or blur,
 * which is the rule the app's dark mode states. Light mode gets the same
 * structure from surface steps on the undyed ground.
 */
const SHELL_CSS = `
${FONT_FACES}
*,::before,::after{box-sizing:border-box}
:root{color-scheme:light dark;
--font-display:"Schibsted Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
--font-ui:"Schibsted Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
--font-mono:"Fragment Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--gutter:clamp(20px,4.6vw,54px);--rule:1px solid var(--c-border);
--ease:cubic-bezier(.23,1,.32,1)}
html{-webkit-text-size-adjust:100%;font-optical-sizing:auto}
body{margin:0;min-height:100vh;background:var(--c-bg);color:var(--c-text);
font-family:var(--font-ui);font-size:16px;line-height:1.55;
display:flex;flex-direction:column;align-items:center}
a{color:inherit;text-decoration:none}
::selection{background:var(--c-accent-subtle)}
:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px;border-radius:var(--r-control)}

/* One measured column with hairline edges. Every surface on the page is a cell
   of that grid rather than a card floating on it, so nothing nests. */
.page{width:min(1200px,100%);flex:1;display:flex;flex-direction:column;
border-inline:var(--rule);background:var(--c-bg)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;
min-height:58px;padding:0 var(--gutter);border-bottom:var(--rule);background:var(--c-sidebar)}
.brand{display:inline-flex;align-items:center;gap:9px;font-family:var(--font-display);
font-size:17px;font-weight:500;letter-spacing:-0.015em}
.brand .mark{color:var(--c-accent);flex:none}
.nav{display:flex;align-items:center;gap:4px}
.nav .quiet{padding:6px 10px;color:var(--c-text-2);border-radius:var(--r-control);
font-family:var(--font-mono);font-size:11.5px;letter-spacing:0.07em;text-transform:uppercase}
.nav .quiet b{color:var(--c-accent-fg);font-weight:inherit;margin-right:7px}
.nav .quiet:hover{color:var(--c-text);background:var(--c-fill)}
.icon{display:inline-flex;padding:7px;color:var(--c-text-3);border-radius:var(--r-control)}
.icon:hover{color:var(--c-text);background:var(--c-fill)}

/* ── Sticky nav ────────────────────────────────────────────────────────
   Blurred ground at 92% so the page reads through it while scrolled. */
.bar{position:sticky;top:0;z-index:10;margin:0 calc(-1 * var(--gutter));
padding:0 var(--gutter);height:64px;display:flex;align-items:center;
justify-content:space-between;gap:24px;border-bottom:1px solid var(--c-border);
background:color-mix(in srgb,var(--c-bg) 92%,transparent);
backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.brand{display:inline-flex;align-items:baseline;gap:12px;font-weight:700;
font-size:24px;letter-spacing:-.02em;color:var(--c-text)}
.brand:hover{color:var(--c-text)}
.brand .mark{color:var(--c-accent);align-self:center}
.brand .kana,.kana{font-family:var(--font-mono);font-size:10px;letter-spacing:.2em;
color:var(--c-text-3)}
.nav-cta{padding:9px 18px;min-height:0;font-size:11px}
.nav{display:flex;align-items:center;gap:26px;font-family:var(--font-mono);
font-size:11px;letter-spacing:.14em}
.nav .quiet{color:var(--c-text-2)}
.nav .quiet:hover{color:var(--c-accent)}
.nav .quiet b{color:inherit;font-weight:inherit}
.icon{display:inline-flex;padding:6px;color:var(--c-text-3)}
.icon:hover{color:var(--c-accent)}

/* ── Type ──────────────────────────────────────────────────────────────
   Two voices per the design system: the grotesque at 600 for display and
   400 for reading; Fragment Mono names everything the machine touches.
   Gold is the emphasis of last resort - one phrase per screen. */
h1,h2,h3{margin:0;font-weight:600}
h1{font-size:clamp(34px,4.5vw,58px);line-height:1.04;letter-spacing:-.03em;text-wrap:pretty}
h2{font-size:clamp(30px,3.5vw,46px);line-height:1.05;letter-spacing:-.03em;text-wrap:pretty}
h3{font-size:22px;letter-spacing:-.02em;line-height:1.25}
.subhead{font-weight:500;font-size:clamp(20px,2vw,28px);line-height:1.25;
letter-spacing:-.02em;color:var(--c-accent-fg)}
p{margin:0}
.gold{color:var(--c-accent)}
.lede{font-size:17px;line-height:1.65;color:var(--c-text-2);text-wrap:pretty}
.body{font-size:15px;line-height:1.7;color:var(--c-text-2);text-wrap:pretty}
.dim{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.04em;
line-height:1.8;color:var(--c-text-3)}

/* The mono voices. Section numerals are gold; figure captions and cell
   kickers are faint; data-row keys are gold at reading size. */
.eyebrow,.label,.fig,.num,.key{font-family:var(--font-mono);text-transform:uppercase}
.eyebrow,.label{font-size:12px;letter-spacing:.22em;color:var(--c-accent)}
.label b{color:inherit;font-weight:inherit;margin-right:1.5em}
.fig{font-size:10px;letter-spacing:.16em;color:var(--c-text-3)}
.num{font-size:10px;letter-spacing:.18em;color:var(--c-text-3)}
.key{font-size:12px;letter-spacing:.02em;color:var(--c-accent)}
.stat-k{font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;
text-transform:uppercase;color:var(--c-accent)}

/* ── Controls: sharp corners, mono labels ──────────────────────────────
   No radius anywhere on this surface; depth comes from the two background
   steps, never from shadows. */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
min-height:38px;padding:0 15px;border:1px solid var(--c-input-border);border-radius:var(--r-row);
background:transparent;color:var(--c-text);font:inherit;font-size:14px;font-weight:600;
white-space:nowrap;cursor:pointer;transition:background 150ms var(--ease),border-color 150ms var(--ease)}
.btn:hover{background:var(--c-fill)}
.btn.solid{border-color:transparent;background:var(--c-accent);color:var(--c-accent-on)}
.btn.solid:hover{background:color-mix(in oklab,var(--c-accent) 90%,var(--c-text))}

/* Mono, letterspaced, small: labels name the thing beside them and never
   compete with it. The one typographic device carried through every section. */
.eyebrow,.label,.anno,.num,.stat span,.spec dt{font-family:var(--font-mono);
font-size:11.5px;letter-spacing:0.09em;text-transform:uppercase}
.eyebrow{margin:0;color:var(--c-accent-fg)}
.label{margin:0 0 20px;color:var(--c-text-3)}
.label b{color:var(--c-accent-fg);font-weight:inherit;margin-right:10px}
.anno{color:var(--c-text-3);opacity:0.85}

/* Sized for Fraunces' wider advance: at the old 62px peak the longest
   tagline ran four lines in the hero column and buried the panel. The
   page column caps at 1200px, so the fix is size: measured in the
   506px column, 46px is the largest size that holds every tagline to
   three lines; 45px ships one notch inside that edge. */
h1{margin:16px 0 0;font-family:var(--font-display);font-size:clamp(32px,4vw,45px);
line-height:1.05;font-weight:500;letter-spacing:-0.03em;max-width:30ch}
h2{margin:0;font-family:var(--font-display);font-size:19px;font-weight:500;letter-spacing:-0.012em}
/* The one gradient in the design: sheen along the thread, rationed to a single
   hero phrase (never body text, never a panel). It runs accent → accent-ink →
   ink, so each theme draws its own — champagne light on the dyed face, deep
   dye on the undyed one — and engines without background-clip keep the plain
   accent ink declared first. */
/* The trailing padding keeps the italic overshoot inside the painted box:
   background-clip:text stops painting at the border box, so a swash past it
   rendered sheared at the edge. The negative margin gives the space back. */
.hero-ink{color:var(--c-accent-fg);background:linear-gradient(93deg,var(--c-accent) 4%,var(--c-accent-fg) 52%,var(--c-text) 98%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;padding-right:.14em;margin-right:-.14em}
.hero-ink+.ink-dot{color:var(--c-accent)}
.lede{margin:22px 0 0;max-width:52ch;color:var(--c-text-2);font-size:17px;line-height:1.62}
.dim{color:var(--c-text-3);font-size:13px;line-height:1.55}
.section{padding:var(--gutter);border-bottom:var(--rule)}
.section:last-child{border-bottom:0}

/* Hairline grids: one background, one-pixel gaps, cells on the page ground. */
.grid{display:grid;gap:1px;background:var(--c-border);border:var(--rule)}
.grid>*{padding:20px;background:var(--c-bg)}
.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.cell p{margin:9px 0 0;color:var(--c-text-2);font-size:13.5px;line-height:1.6}
.cell .num{display:block;margin-bottom:11px;color:var(--c-accent-fg)}

/* A row of counts the repo can answer for. Display face on the number, mono on
   the label, which is the one place the two faces sit together. */
.stats{margin:0;padding:0;list-style:none}
.stat strong{display:block;font-family:var(--font-display);font-size:40px;
font-weight:500;line-height:1.05;letter-spacing:-0.022em}
.stat span{display:block;margin-top:5px;color:var(--c-text-3)}

code{font-family:var(--font-mono);font-size:13px;color:var(--c-code)}
.cmd{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;
padding:10px 11px;border:1px solid var(--c-input-border);border-radius:var(--r-row);
background:var(--c-recessed)}
.cmd::before{content:"$";color:var(--c-text-3);font-family:var(--font-mono);font-size:13px;line-height:1.7}
.cmd code{display:block;overflow-x:auto;white-space:nowrap;line-height:1.7}
.copy{min-height:30px;padding:0 11px;border:1px solid var(--c-input-border);
border-radius:var(--r-control);background:transparent;color:var(--c-text-3);
font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;
cursor:pointer;transition:color 150ms var(--ease),background 150ms var(--ease)}
.copy:hover{color:var(--c-text);background:var(--c-fill)}
.panel[hidden]{display:none}
.panel{margin-top:18px;max-width:620px}
.panel .dim{margin:11px 0 0}

footer{display:flex;align-items:center;justify-content:space-between;gap:16px;
padding:20px var(--gutter);border-top:var(--rule);background:var(--c-sidebar);
color:var(--c-text-3);font-size:13px}
footer nav{display:flex;gap:18px}
footer a:hover{color:var(--c-text)}
.lockup{display:inline-flex;align-items:center;gap:8px;color:var(--c-text-2)}
.lockup .mark{color:var(--c-accent)}

@media (max-width:880px){
.page{border-inline:0}
.grid.three,.grid.two{grid-template-columns:1fr}
.nav .quiet{display:none}
.cmd{grid-template-columns:auto 1fr;row-gap:10px}
.cmd code{white-space:pre-wrap;overflow-wrap:anywhere}
.copy{grid-column:1/-1;min-height:34px}
.stats{gap:22px 32px}
footer{flex-direction:column;align-items:flex-start;gap:14px}
}
`;

/* ── Document ────────────────────────────────────────────────────────── */

export interface PublicPageOptions {
  /** `<title>`. */
  readonly title: string;
  readonly description?: string;
  /** Extra CSS for one page. Kept short: anything two pages need belongs in
   *  `SHELL_CSS`. */
  readonly styles?: string;
  /** Left-hand side of the header bar, as markup. Absent means the standard
   *  mark-plus-wordmark link home. */
  readonly brand?: string;
  /** Right-hand side of the header bar. Absent means no bar at all, which is
   *  what the CLI approval pages want. */
  readonly nav?: string;
  readonly body: string;
  readonly footer?: string;
  /** Inline script text, appended after the body. */
  readonly script?: string;
}

/** Copy-to-clipboard for every `[data-copy]` button, addressed by the element
 *  id in its attribute. One implementation for every command on every page. */
export const COPY_SCRIPT = `
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.getAttribute('data-copy'));
    if (!source) return;
    await navigator.clipboard.writeText((source.textContent || '').trim());
    const was = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = was; }, 1400);
  });
}`;

export function publicPage(options: PublicPageOptions): string {
  const description = options.description ?? '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}" />\n` : ''}<link rel="icon" type="image/svg+xml" href="/assets/kinu-icon.svg" />
<link rel="preload" href="${UI_FONT_PATH}" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="${MONO_FONT_PATH}" as="font" type="font/woff2" crossorigin />
<script>${THEME_BOOT}</script>
<style>${THEME_CSS}${SHELL_CSS}${options.styles ?? ''}</style>
</head>
<body>
<div class="page">
${options.nav === undefined ? '' : `<header class="bar">${options.brand ?? wordmark()}<nav class="nav">${options.nav}</nav></header>\n`}${options.body}
${options.footer ?? ''}</div>
${options.script ? `<script>${options.script}</script>\n` : ''}</body>
</html>`;
}

/** The one external link the public pages carry, in the one place that has to
 *  change when the repository is renamed. */
export const REPO_URL = 'https://github.com/AshishKumar4/kinu';

export const GITHUB_ICON = '<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/** The footer every page shares. */
export function publicFooter(): string {
  return `<footer>
  <span class="lockup">${mark(18)} Kinu.run</span>
  <nav>
    <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="/install">Install</a>
    <a href="/#deploy">Deploy your own</a>
    <a href="/login">Sign in</a>
  </nav>
  <span>MIT licensed.</span>
</footer>
`;
}
