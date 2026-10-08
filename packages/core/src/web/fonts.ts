/**
 * The app's faces and the stacks that name them: one list for the app's stylesheet (`virtual:kinu-theme.css`) and every
 * slate page's head, so a slate sets its text as the chat does. The files ship under `/assets/fonts/` with their
 * licence (OFL); a preview host serves the same files at `/__kinu/fonts/`, its own origin, so a slate's page loads
 * them with no cross-origin read.
 *
 * `--font-ui` and `--font-display` are the same Schibsted Grotesk stack: hierarchy is set with weight, not typeface
 * swaps, and they stay two tokens so the roles can diverge without touching call sites. `--font-serif` is Newsreader,
 * read only by the brand mark. `--font-mono` also sets every eyebrow and section label.
 */

/** Where the app's own pages read the faces, and where a preview host serves them to a slate's page. */
export const APP_FONTS_PATH = '/assets/fonts/';

export const SLATE_FONTS_PATH = '/__kinu/fonts/';

/** Latin, with the punctuation and symbols the product's copy uses; every face is cut to it. */
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

/** Variable cuts at one optical size: the opsz axis bought nothing and cost 74 KB. */
const APP_FONT_FACES = [
  { family: 'Schibsted Grotesk', file: 'schibsted-latin-var.woff2', format: 'woff2-variations', weight: '400 900' },
  { family: 'Newsreader', file: 'newsreader-latin-var.woff2', format: 'woff2-variations', weight: '400 700' },
  { family: 'Fragment Mono', file: 'fragmentmono-latin.woff2', format: 'woff2', weight: '400' },
] as const;

/** Fallback stacks stay whole, so an unloaded face degrades to the one this product shipped before it. */
const FONT_STACKS = {
  '--font-display': '"Schibsted Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  '--font-ui': '"Schibsted Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  '--font-serif': '"Newsreader", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  '--font-mono': '"Fragment Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** The faces, read from `base`, and the stacks on `:root`. */
export function fontsCss(base: string): string {
  const faces = APP_FONT_FACES.map((face) => `@font-face{font-family:"${face.family}";src:url("${base}${face.file}") format("${face.format}");`
    + `font-weight:${face.weight};font-style:normal;font-display:swap;unicode-range:${LATIN}}`);

  return [...faces, `:root{${Object.entries(FONT_STACKS).map(([name, value]) => `${name}:${value}`).join(';')}}`].join('\n');
}

/** A face file the app ships, by its name under either path; null for any other name. */
export function appFontFile(name: string): string | null {
  return APP_FONT_FACES.find((face) => face.file === name)?.file ?? null;
}
