/**
 * An answer's page the browser draws itself (1023-ac): a `<slate-ui>` block that reaches nothing through `kinu:slate`
 * needs no process, no preview origin and no fetch. Its frame is a `srcdoc` document, sandboxed to an opaque origin, with
 * the head every slate page has (the app's palette and faces, the chat's type, its height told to the host) and a
 * policy that lets it reach nothing outside: its own inline script and style, the app's faces, and pictures it makes.
 * While its answer streams, a frame draws the markup written so far, its scripts inert; once the block is closed, the
 * page itself is opened and runs as written.
 */
import { SLATE_PAGE_STYLE } from '../slates/page-head';
import { SLATE_LEGACY_TOKEN_CSS, SLATE_SIZE_CHANGED_MESSAGE } from '../slates/host-context';
import { APP_FONTS_PATH, fontsCss } from './fonts';
import { THEME_CSS } from './theme';

/** What the host sends a streaming frame: the block's markup written so far. */
export const SLATE_DRAW_MESSAGE = 'draw';

/** A block whose page reaches the workspace through `kinu:slate` is served by its process; any other is drawn here. */
export function drawnInBrowser(html: string): boolean {
  return !html.includes('kinu:slate');
}

/**
 * Nothing outside: no request a script makes, no form sent, no picture or face from another site. Whatever the app's
 * own policy allows, the frame inherits and this narrows.
 */
function drawnPolicy(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    `font-src ${appOrigin}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The page's height, told to its host whenever it changes, measured as `kinu:slate`'s `fit` measures it. */
const SIZE_SCRIPT = `(()=>{const r=document.documentElement;let q=false;new ResizeObserver(()=>{if(q)return;q=true;`
  + `requestAnimationFrame(()=>{q=false;parent.postMessage({kinu:${JSON.stringify(SLATE_SIZE_CHANGED_MESSAGE)},`
  + `height:Math.ceil(r.getBoundingClientRect().height)},"*")})}).observe(r)})()`;

/** A streaming frame takes the markup written so far from its own host only, never from a frame beside it. Set as the
 *  body's markup, its scripts do not run: they run once the block is closed and the page itself is opened. */
const STREAM_SCRIPT = `addEventListener("message",(e)=>{const d=e.data;if(e.source!==parent||d===null||typeof d!=="object"`
  + `||d.kinu!==${JSON.stringify(SLATE_DRAW_MESSAGE)}||typeof d.html!=="string")return;document.body.innerHTML=d.html})`;

export interface DrawnPageLook {
  readonly theme: 'dark' | 'light';
  /** The host's own palette, as computed where the page sits (`SLATE_THEME_TOKENS`). */
  readonly variables: Readonly<Record<string, string>>;
  /** The app's origin, whose faces the page reads. */
  readonly appOrigin: string;
}

function drawnHead(look: DrawnPageLook, script: string): string {
  const tokens = Object.entries(look.variables).map(([name, value]) => `${name}:${value}`).join(';');

  return `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${drawnPolicy(look.appOrigin)}">`
    + `<style>${THEME_CSS}\n${SLATE_LEGACY_TOKEN_CSS}\n${fontsCss(`${look.appOrigin}${APP_FONTS_PATH}`)}\n${SLATE_PAGE_STYLE}`
    + `\n:root{${tokens}}</style><script>${script}</script>`;
}

const root = (look: DrawnPageLook) => `<html data-mode="${look.theme}" data-display="inline" style="color-scheme:${look.theme}">`;

/** The page itself, opened as written once its block is closed. */
export function drawnPageDocument(html: string, look: DrawnPageLook): string {
  return `<!doctype html>${root(look)}<head>${drawnHead(look, SIZE_SCRIPT)}</head><body>${html}</body></html>`;
}

/** The frame a streaming block is drawn in: empty until its host sends the markup written so far. */
export function drawnStreamDocument(look: DrawnPageLook): string {
  return `<!doctype html>${root(look)}<head>${drawnHead(look, `${SIZE_SCRIPT};${STREAM_SCRIPT}`)}</head><body></body></html>`;
}
