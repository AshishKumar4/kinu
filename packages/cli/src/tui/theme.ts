import { SyntaxStyle } from '@opentui/core';

// The Kinu design system, dark theme — packages/cf-backend/src/index.css
// :root is the source of truth (mock-canonical); this file mirrors it for the
// terminal. Warm black ladder for ground and chrome, brass #E0A458 as the one
// accent, hairlines as solid warm browns straight off the mock. Status hues:
// the system defines good and bad; warning and info are its derived tan and
// slate, and info stays a cool tone on purpose — a warm info hue would vanish
// into the ground.
export const tuiColors = {
  bg: '#0F0D0B',           // --c-bg — the canvas, warm black at reading depth
  panel: '#141110',        // --c-sidebar — chrome: rails, panel headers
  panelStrong: '#181512',  // --c-surface — cards
  panelDeep: '#131110',    // --c-recessed — wells, tracks, inset code
  selection: '#1B1713',    // --c-fill — chips, segments, row hover
  selectionDeep: '#221C15',// --c-elevated — the selected, raised state
  bubbleBg: '#241E16',     // --c-user-bg — the user turn's plane
  bubbleBorder: '#3A3126', // --c-user-border — mock --bubbleLine
  border: '#262019',       // --c-border — mock --line
  borderSubtle: '#2A241D', // --c-dash — dashed separators
  borderMuted: '#332C23',  // --c-border-strong — mock --line2
  borderActive: '#E0A458', // focus sits in the system's full-brass ration
  text: '#EDE5D8',         // --c-text — the ink
  textStrong: '#E3D2AE',   // --c-accent-fg — headings, identity
  textBright: '#EDE5D8',
  muted: '#9C9184',        // --c-text-3 — the dim role
  accent: '#E0A458',       // --c-accent — fills, strokes, the winning line
  accentStrong: '#E3D2AE', // --c-accent-fg — bright end, hover
  accentDeep: '#E3D2AE',   // --c-code — one brass tone on a well
  blue: '#8FB6D6',         // --c-info — links; deliberately cool on a warm ground
  green: '#8FBC8B',        // --c-success — mock --good
  amber: '#E8B97A',        // --c-warning — the system's derived tan
  amberDeep: '#AE8B5C',    // warning mixed 25% toward black, for borders
  red: '#C97B6B',          // --c-danger — mock --bad
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
