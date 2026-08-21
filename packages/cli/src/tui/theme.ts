import { SyntaxStyle } from '@opentui/core';

// The silk palette (絹) — cf-backend index.css, silk dark. Two threads: indigo
// dye as the ground, raw silk fibre as the text; the accent is the thread
// itself, the brightest thing on screen. Borders are the fibre blended over
// the ground at the CSS alphas (0.20 / 0.28 / 0.36), precomputed because
// opentui takes hex only. Status hues are dye colours — 若竹 bamboo, 山吹
// amber, 紅 safflower — and info deliberately leaves the blue family: on an
// indigo ground a blue status tone is the ground.
export const tuiColors = {
  bg: '#111923',           // --c-bg — the canvas, indigo at reading depth
  panel: '#142230',        // --c-sidebar — chrome: rails, panel headers
  panelStrong: '#192B44',  // --c-surface — cards
  panelDeep: '#080F17',    // --c-recessed — wells, tracks, inset code
  selection: '#1F334F',    // --c-fill — chips, segments, hover
  selectionDeep: '#1B3050',// --c-user-bg — the dye plane at full strength
  bubbleBg: '#1B3050',     // the user's turn is the one saturated plane
  bubbleBorder: '#5B646E', // --c-user-border blend over the dye plane
  border: '#3B3E3F',       // --c-border blend
  borderSubtle: '#22282E', // fibre at ~0.08 over bg
  borderMuted: '#5D5C55',  // --c-border-strong blend
  borderActive: '#E3D2AE', // the thread itself
  text: '#F4EFE6',         // raw silk
  textStrong: '#F2DFB4',   // the sheen — headings, identity
  textBright: '#F4EFE6',
  muted: '#B0A795',        // --c-text-3 — dim
  accent: '#E3D2AE',       // --c-accent — fills, strokes, the winning line
  accentStrong: '#F2DFB4', // --c-accent-fg — champagne sheen
  accentDeep: '#D8CBA4',   // --c-code — one thread tone on a well
  blue: '#93BFC8',         // --c-info — muted teal, not blue
  green: '#9BC7A2',        // --c-success — 若竹 bamboo
  amber: '#DFAE72',        // --c-warning — 山吹 amber
  amberDeep: '#C9975F',    // warning deepened for borders on the dye plane
  red: '#EC9393',          // --c-danger — 紅 safflower
};

export const markdownSyntax = SyntaxStyle.fromStyles({
  text: { fg: tuiColors.text },
  paragraph: { fg: tuiColors.text },
  heading: { fg: tuiColors.textStrong, bold: true },
  strong: { fg: tuiColors.textStrong, bold: true },
  emphasis: { fg: tuiColors.text, italic: true },
  code: { fg: tuiColors.accentDeep, bg: tuiColors.panelDeep },
  codespan: { fg: tuiColors.accentDeep, bg: tuiColors.panelDeep },
  link: { fg: tuiColors.blue, underline: true },
  blockquote: { fg: tuiColors.muted, italic: true },
  list: { fg: tuiColors.text },
  list_item: { fg: tuiColors.text },
  table: { fg: tuiColors.text },
  hr: { fg: tuiColors.border },
});
