import { SyntaxStyle } from '@opentui/core';

export const tuiColors = {
  bg: '#0f0f23',
  panel: '#171725',
  panelStrong: '#1a1a2e',
  border: '#3b3b5c',
  borderActive: '#7c3aed',
  text: '#d1d5db',
  textStrong: '#e5e7eb',
  muted: '#6b7280',
  accent: '#a78bfa',
  accentStrong: '#c4b5fd',
  blue: '#60a5fa',
  green: '#4ade80',
  amber: '#fbbf24',
  red: '#f87171',
};

export const markdownSyntax = SyntaxStyle.fromStyles({
  text: { fg: tuiColors.text },
  paragraph: { fg: tuiColors.text },
  heading: { fg: tuiColors.textStrong, bold: true },
  strong: { fg: tuiColors.textStrong, bold: true },
  emphasis: { fg: tuiColors.text, italic: true },
  code: { fg: '#93c5fd', bg: '#111827' },
  codespan: { fg: '#93c5fd', bg: '#111827' },
  link: { fg: tuiColors.blue, underline: true },
  blockquote: { fg: tuiColors.muted, italic: true },
  list: { fg: tuiColors.text },
  list_item: { fg: tuiColors.text },
  table: { fg: tuiColors.text },
  hr: { fg: tuiColors.border },
});
