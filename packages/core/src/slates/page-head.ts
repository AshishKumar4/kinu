/**
 * What every slate page's head carries before its own markup, after the app's palette (`THEME_CSS`), served by the
 * runner for an HTML page and a React client alike: zero-specificity defaults for the elements a page draws, and the
 * scheme its host asked for, set before the first paint. A page's own styles override any of it.
 */
import { SLATE_QUERY_PARAM } from './host-context';

/**
 * The chat's own type and controls, as the app draws them: prose 16/26, controls 14/20, code in the mono face. In the
 * chat (`data-display="inline"`) the document is as tall as what it holds: a body sized to the viewport would size the
 * card to itself.
 */
export const SLATE_PAGE_STYLE = [
  ':where(html){background:transparent;color:var(--c-text,CanvasText);font:16px/1.625 var(--font-ui,system-ui,sans-serif);'
    + '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',
  ':where(body){margin:0}',
  ':where(h1,h2,h3,h4){font-family:var(--font-display,inherit);font-weight:600;line-height:1.3;letter-spacing:-0.01em}',
  ':where(a){color:var(--c-accent-fg,LinkText)}',
  ':where(code,kbd,pre,samp){font-family:var(--font-mono,ui-monospace,monospace);font-size:0.875em}',
  ':where(button,input,select,textarea){font:inherit;font-size:0.875rem;line-height:1.4286;color:inherit}',
  ':where(button){padding:6px 12px;border:1px solid var(--c-border-strong,ButtonBorder);border-radius:var(--r-control,6px);'
    + 'background:var(--c-elevated,ButtonFace);font-weight:500;cursor:pointer}',
  ':where(button:hover){border-color:var(--c-accent,ButtonBorder)}',
  ':where(button:disabled){opacity:0.5;cursor:default}',
  ':where(input,select,textarea){padding:6px 10px;border:1px solid var(--c-input-border,ButtonBorder);border-radius:var(--r-control,6px);'
    + 'background:var(--c-recessed,Field)}',
  ':where(input,select,textarea,button):focus-visible{outline:2px solid var(--c-accent,Highlight);outline-offset:1px}',
  ':where(table){border-collapse:collapse}',
  ':where(th,td){padding:6px 10px;border-bottom:1px solid var(--c-border,GrayText);text-align:left}',
  ':where(hr){border:0;border-top:1px solid var(--c-border,GrayText)}',
  ':root[data-display="inline"],:root[data-display="inline"] body{height:auto!important;min-height:0!important;overflow:hidden}',
].join('');

/** Run as the head is parsed, so the first paint is already in the host's scheme: the module that follows applies the
 *  rest of the context. A page opened on its own takes the reader's scheme. */
export const SLATE_SCHEME_SCRIPT = `(()=>{const r=document.documentElement;let t;try{t=JSON.parse(new URLSearchParams(location.search).get(${JSON.stringify(SLATE_QUERY_PARAM)})).theme}catch{}`
  + 'if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";r.dataset.mode=t;r.style.colorScheme=t;})()';
