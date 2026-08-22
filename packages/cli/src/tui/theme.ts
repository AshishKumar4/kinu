import { SyntaxStyle } from '@opentui/core';

// The Kinu design system, dark theme — packages/cf-backend/src/index.css
// :root is the source of truth; this file mirrors it for the terminal. Warm
// black ladder for ground and chrome, brass #E0A458 as the one accent. The
// css draws hairlines as gold at alpha over the canvas; opentui takes hex
// only, so those blends are precomputed here (border 0.14, input 0.18/0.22,
// strong 0.28) — same recipe as the css, nothing invented. Status hues are
// the system's sage/tan/terracotta lifted for AA, and info stays a cool
// tone on purpose: a warm info hue would vanish into the ground.
export const tuiColors = {
  bg: '#1A1613',           // --c-bg — the canvas, warm black at reading depth
  panel: '#201A15',        // --c-sidebar — chrome: rails, panel headers
  panelStrong: '#241E18',  // --c-surface — cards
  panelDeep: '#120F0C',    // --c-recessed — wells, tracks, inset code
  selection: '#2C251E',    // --c-fill / --c-elevated — chips, segments, hover
  selectionDeep: '#2A211A',// --c-user-bg — the user turn's raised plane
  bubbleBg: '#2A211A',     // --c-user-bg
  bubbleBorder: '#3E301F', // --c-user-border (0.18) over bg
  border: '#362A1D',       // --c-border (0.14) over bg
  borderSubtle: '#292522', // --c-neutral-tint (0.07) over bg
  borderMuted: '#513E26',  // --c-border-strong (0.28) over bg
  borderActive: '#E0A458', // focus sits in the system's full-brass ration
  text: '#F5EFE6',         // --c-text — the ink
  textStrong: '#F0CF9B',   // --c-accent-fg — headings, identity
  textBright: '#F5EFE6',
  muted: '#A19682',        // --c-text-3 — dim
  accent: '#E0A458',       // --c-accent — fills, strokes, the winning line
  accentStrong: '#F0CF9B', // --c-accent-fg — bright end, hover
  accentDeep: '#E8B97A',   // --c-code — one brass tone on a well
  blue: '#8FB6D6',         // --c-info — links; deliberately cool on a warm ground
  green: '#9EBE7E',        // --c-success — sage
  amber: '#E8B97A',        // --c-warning — tan; the system has no separate warning hue
  amberDeep: '#AE8B5C',    // warning mixed 25% toward black, for borders
  red: '#E8907A',          // --c-danger — terracotta
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
