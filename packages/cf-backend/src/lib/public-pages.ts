/**
 * Every page a signed-out visitor can see, as text.
 *
 * The pages live together and away from their routes for two reasons. All the
 * public copy is in one file, which is the only way a writing standard is
 * enforceable by reading. And a page is a pure function of its inputs, so the
 * gallery mounts the real document in a real browser, and the unit tests read
 * the real copy, instead of either of them photographing a second landing page
 * written for them.
 *
 * Chrome, tokens and type come from `public-shell.ts`.
 */

import { escapeHtml } from './http';
import { HERO_TREE_SCRIPT, MODE_TOGGLE_SCRIPT, PREVIEW_SCRIPT, TYPEWRITER_SCRIPT } from './landing-scripts';
import { LANDING_BODY } from './landing-body.generated';
import {
  COPY_SCRIPT, GITHUB_ICON, REPO_URL, mark, publicFooter, publicPage,
} from './public-shell';

/* ── Front page ──────────────────────────────────────────────────────── */

/**
 * The owner's landing, served.
 *
 * The BODY is <Landing/> prerendered at build time into
 * `landing-body.generated.ts` (see scripts/prerender-landing.tsx for the
 * why); this function wraps it in the signed-out shell, swaps the per-origin
 * install command, adds the page's own layout layer, and ships behaviour as
 * CSP-safe inline scripts. Nothing here re-authors the component: the parity
 * gate re-renders <Landing/> and fails when the committed body drifts.
 */
export function landingDocument(
  install: string,
): string {
  const command = escapeHtml(install);
  // <main> is the document's landmark; the component renders sections only,
  // so the wrapper lives here rather than in every section.
  const body = `<main>${LANDING_BODY.split('@@INSTALL_COMMAND@@').join(command)}</main>`;
  return publicPage({
    title: 'Kinu.run — the self-evolving agent platform',
    description: 'Kinu is an open-source agent platform. Agents run in durable workspaces, improve with use, and search a tree of agents on hard tasks. Run it on kinu.run, or deploy your own.',
    styles: LANDING_CSS,
    chrome: 'bleed',
    brand: `<a href="#top" style="font-weight:700; font-size:24px; color:var(--c-text); letter-spacing:-.02em">kinu</a>
        <span class="kana">絹</span>`,
    nav: [
      '<a class="quiet" href="#platform">PLATFORM</a>',
      '<a class="quiet" href="#quickstart">QUICKSTART</a>',
      '<a class="quiet" href="#clients">CLIENTS</a>',
      '<a class="quiet" href="#evolution">EVOLUTION</a>',
      '<a class="quiet" href="#swarm">SWARM</a>',
      '<a class="quiet" href="#deploy">SELF-HOST</a>',
      `<a class="quiet" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GITHUB ↗</a>`,
      '<button class="mode-toggle" type="button" data-mode-toggle aria-label="Switch to light mode">'
        + '<svg data-icon="sun" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M120 40V16a8 8 0 0 1 16 0v24a8 8 0 0 1-16 0Zm72 88a64 64 0 1 1-64-64 64.07 64.07 0 0 1 64 64Zm-128 0a8 8 0 0 0-8-8H24a8 8 0 0 0 0 16h24a8 8 0 0 0 8-8Zm80 72v24a8 8 0 0 1-16 0v-24a8 8 0 0 1 16 0Zm88-88h-24a8 8 0 0 0 0 16h24a8 8 0 0 0 0-16ZM74.34 85.66a8 8 0 0 0 11.32 0l16-16a8 8 0 0 0-11.32-11.32l-16 16a8 8 0 0 0 0 11.32Zm96.04 3.95a8 8 0 0 0 5.65-2.34l16-16a8 8 0 1 0-11.31-11.32l-16 16a8 8 0 0 0 5.66 13.66Zm-84.77 79.19-16 16a8 8 0 0 0 11.32 11.32l16-16a8 8 0 0 0-11.32-11.32Zm101.26-.69a8 8 0 0 0-11.32 0 8 8 0 0 0 0 11.32l16 16a8 8 0 0 0 11.32-11.32Z"/></svg>'
        + '<svg data-icon="moon" width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M233.54 142.23a8 8 0 0 0-8-2 88.08 88.08 0 0 1-109.8-109.8 8 8 0 0 0-10-10 104.09 104.09 0 1 0 127.82 127.82 8 8 0 0 0 .02-6.02Z"/></svg>'
        + '</button>',
      '<a class="btn solid nav-cta" href="/login">TRY CLOUD AGENTS</a>',
    ].join(''),
    body,
    footer: `
<footer class="bleed"><div class="page"><div class="footer-in">
  <div style="display:flex; align-items:baseline; gap:12px">
    <span style="font-weight:700; font-size:18px; letter-spacing:-.02em">kinu</span>
    <span class="kana">絹 · THE SELF-EVOLVING AGENT PLATFORM</span>
  </div>
  <nav>
    <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GITHUB</a>
    <a href="${REPO_URL}/blob/main/QUICKSTART.md" target="_blank" rel="noopener noreferrer">QUICKSTART</a>
    <a href="${REPO_URL}/blob/main/docs/USER-GUIDE.md" target="_blank" rel="noopener noreferrer">USER GUIDE</a>
    <a href="/login">KINU.RUN</a>
  </nav>
  <span class="dim">MIT © 2026</span>
</div></div></footer>
`,
    script: [COPY_SCRIPT, MODE_TOGGLE_SCRIPT, TYPEWRITER_SCRIPT, HERO_TREE_SCRIPT, PREVIEW_SCRIPT].join('\n'),
  });
}

/**
 * The landing's own layout layer: the geometry the artifact carries as
 * inline styles that must move for hover and responsiveness, plus the
 * caret blink. Colours stay on tokens throughout.
 */
const LANDING_CSS = `
/* ── Width model ────────────────────────────────────────────────────────
   The app shell uses a 1200px signed-out measure. This page alone follows
   the artifact's max-width-1280 border box: 48px gutters leave its 1184px
   content measure without widening any other public page. */
.page{width:min(1280px,100%)}
.dots{position:absolute;background-image:radial-gradient(
color-mix(in srgb,var(--c-text) 9%,transparent) 1.2px,transparent 1.2px);
background-size:22px 22px;pointer-events:none}
.bar>.page,footer.bleed>.page{flex:0 1 1280px;width:min(1280px,100%)}
@keyframes kinu-blink { 0%, 49% { opacity:1; } 50%, 100% { opacity:0; } }
.caret{display:inline-block;width:.09em;height:.82em;background:var(--c-accent);
margin-left:.06em;vertical-align:baseline;transform:translateY(.12em);
animation:kinu-blink 1.1s step-end infinite}
@media (prefers-reduced-motion:reduce){.caret{animation:none}}

.hero-wrap{position:relative;padding:36px 0 72px}
.hero-dots-left{top:140px;left:-172px;width:150px;height:440px}
.hero-dots-right{top:720px;right:-172px;width:150px;height:520px}
@media (max-width:1380px){.hero-dots-left,.hero-dots-right{display:none}}
.hero-panel{position:relative;overflow:hidden;border:1px solid var(--c-border);
background:linear-gradient(180deg,color-mix(in srgb,var(--c-accent) 13%,transparent) 0%,color-mix(in srgb,var(--c-accent) 5%,transparent) 45%,transparent 100%),var(--c-sidebar);
padding:64px 56px 56px}
.hero-grid{position:relative;display:grid;
grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);gap:56px;align-items:center;z-index:1}

.claims{border-top:1px solid var(--c-border);border-bottom:1px solid var(--c-border)}
/* His cell voice: 14px over 1.65, muted — the grids speak in it, so it is
   declared once here for every cell paragraph the page renders. */
.grid p,.claims p{font-size:14px;line-height:1.65;color:var(--c-text-2)}
.claims>*{background:var(--c-bg)}
.claims>:first-child{padding:26px 28px 26px 0}
.claims>:last-child{padding:26px 0 26px 28px}

.section{padding:110px 0 100px}
.ruled-top{border-top:1px solid var(--c-border)}
.g{display:grid;gap:24px}
.g.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.g.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}
.pad-32{padding:32px}
.panel h3{margin-top:12px}
.core-bar{border:1px solid var(--c-border);border-top:none;background:var(--c-recessed);
padding:18px 32px;font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;
color:var(--c-text-3);margin-bottom:48px}

.qs-card{padding:30px;display:flex;flex-direction:column;gap:14px}
.qs-body{font-size:14px;line-height:1.65;color:var(--c-text-2);flex:1;margin:0}
.mini-cmd{font-family:var(--font-mono);font-size:12px;background:var(--c-recessed);
border:1px solid var(--c-border);padding:10px 14px;color:var(--c-code)}
.mini-cmd .dollar,.cmd .dollar{color:var(--c-accent)}

.duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:64px;align-items:start}
#deploy .duo{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)}
.lede.left{margin-left:0;text-align:left}

.cta-band{border-top:1px solid var(--c-border);
background:linear-gradient(180deg,var(--c-surface) 0%,var(--c-bg) 100%);
padding:110px 0}
.cta-grid{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:center}
.spec-well{padding:8px 28px}
.spec-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:16px;
padding:16px 0;border-bottom:1px dashed var(--c-border-strong);align-items:baseline}
.spec-row.last{border-bottom:0}

/* The recorded film, dressed in the artifact's well chrome: provenance rail
   above, transcript below, one panel. */
.film{margin:0;border:1px solid var(--c-border);border-top:none;
background:var(--c-recessed);padding:24px 28px}
.film .anno.ruled{border:0;padding:0 0 14px;flex-wrap:wrap;
justify-content:space-between;column-gap:20px;row-gap:8px;
font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;
text-transform:uppercase;color:var(--c-text-3)}
.term{border:0;border-radius:0;background:transparent;margin:14px 0;padding:0;max-height:none;
font-size:12px;line-height:2;color:var(--c-text-2);
white-space:pre-wrap;overflow-wrap:anywhere}
.term .line{display:block}
.webfilm{border-radius:0;border-color:var(--c-border)}
.glimpse:empty{display:none}
.glimpse{min-height:120px}

/* Theme toggle — the app top-bar control's landing twin. */
.mode-toggle{display:inline-flex;align-items:center;justify-content:center;
width:34px;height:34px;border:1px solid var(--c-border-strong);border-radius:0;
background:transparent;color:var(--c-text-2);cursor:pointer;
transition:color 150ms var(--ease),border-color 150ms var(--ease)}
.mode-toggle:hover{color:var(--c-accent);border-color:var(--c-accent)}

/* The hero figure floats on the panel's own texture — no box of its own. */
.hero-fig{min-width:0}
.ht-bar{display:flex;justify-content:space-between;align-items:center;
margin-bottom:6px;gap:12px;flex-wrap:wrap}
.ht-tabs{display:flex;align-items:baseline;gap:14px}
.ht-tab{font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;
text-transform:uppercase;color:var(--c-text-3);background:none;border:0;
border-bottom:1px solid transparent;padding:0 0 2px;cursor:pointer}
.ht-tab:hover,.ht-tab[data-lit]{color:var(--c-accent)}
.ht-tab[data-lit]{border-bottom-color:color-mix(in srgb,var(--c-accent) 50%,transparent)}
.ht-status{font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;color:var(--c-accent)}
.ht-svg{display:block;width:100%;height:auto;overflow:visible}
.ht-graph{display:none}
.ht-graph[data-live]{display:initial}
.ht-objective,.ht-winline,.ht-s{text-shadow:0 1px 2px color-mix(in srgb,var(--c-bg) 72%,transparent)}
.ht-objective,.ht-winline{font-family:var(--font-mono);font-size:11px;letter-spacing:.04em}
.ht-objective{fill:var(--c-text-3)}
.ht-winline{fill:var(--c-accent)}
.ht-e{fill:none;stroke:var(--c-border-strong);stroke-width:1.4;stroke-linecap:round}
.ht-v circle{fill:color-mix(in srgb,var(--c-bg) 55%,transparent);
stroke:var(--c-text-3);stroke-width:1.5}
.ht-v.ht-root circle{stroke:var(--c-accent-fg);stroke-width:2}
.ht-s{font-family:var(--font-mono);font-size:12px;fill:var(--c-text-3)}
.ht-s[data-good]{fill:var(--c-success)}
[data-hero-search][data-playing] [data-arrive]:not([data-shown]){opacity:0}
[data-hero-search][data-playing] .ht-s,
[data-hero-search][data-playing] .ht-winline{opacity:0}
[data-hero-search][data-playing] .ht-graph[data-measured] .ht-s{opacity:1;
transition:opacity 300ms var(--ease)}
.ht-graph[data-lit] .ht-e.ht-p{stroke:var(--c-accent);stroke-width:2.4}
.ht-graph[data-lit] .ht-v.ht-p circle{stroke:var(--c-accent);stroke-width:2}
@keyframes ht-pulse{50%{stroke-opacity:.35}}
.ht-graph[data-lit] .ht-v[data-won] circle{animation:ht-pulse 1.6s var(--ease) infinite}
@media (prefers-reduced-motion:reduce){
[data-hero-search] *{transition:none!important;animation:none!important}
}

/* Interactive DOM previews. Every state ships in the prerender; the controller
   hides later beats only while it runs. Chapter controls expose state directly. */
.prev-duo{margin-top:clamp(36px,4vw,56px);align-items:start}
.preview-window{overflow:hidden;border:1px solid var(--c-border-strong);
border-radius:12px;background:var(--c-bg)}
.preview-window-bar{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;
border-bottom:1px solid var(--c-border);background:var(--c-recessed)}
.preview-window-bar i{width:7px;height:7px;border-radius:50%;background:var(--c-border-strong)}
.preview-window-bar i:first-child{background:var(--c-danger)}
.preview-window-bar i:nth-child(2){background:var(--c-accent)}
.preview-window-bar i:nth-child(3){background:var(--c-success)}
.preview-window-bar b{margin-left:auto;font-family:var(--font-mono);font-size:9px;
letter-spacing:.14em;color:var(--c-text-3)}
.preview-controls{display:flex;justify-content:space-between;gap:12px;align-items:center;
margin-top:12px;font-family:var(--font-mono);font-size:10px;letter-spacing:.08em}
.preview-chapters,.preview-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.preview-controls button{border:0;border-bottom:1px solid transparent;background:none;
padding:4px 2px;color:var(--c-text-3);font:inherit;cursor:pointer}
.preview-controls button:hover,.preview-controls button[data-lit]{color:var(--c-accent);
border-bottom-color:var(--c-accent)}
.preview-controls button:disabled{cursor:default;color:var(--c-text-4);border-bottom-color:transparent}
.tui-shell{display:grid;grid-template-columns:118px minmax(0,1fr);min-height:310px;
font-family:var(--font-mono);font-size:11px;background:var(--c-recessed)}
.tui-rail{display:flex;flex-direction:column;gap:9px;padding:14px 11px;
border-right:1px solid var(--c-border);color:var(--c-text-3)}
.tui-rail>b{font-family:var(--font-ui);font-size:15px;color:var(--c-text)}
.tui-rail .active{padding:6px 8px;color:var(--c-text);background:var(--c-fill);
border-left:2px solid var(--c-accent)}
.tui-main{display:flex;flex-direction:column;gap:11px;padding:13px;min-width:0}
.tui-bar,.tui-status{display:flex;justify-content:space-between;gap:12px;color:var(--c-text-3)}
.tui-bar{padding-bottom:9px;border-bottom:1px solid var(--c-border)}
.tui-bar b{color:var(--c-text)}
.tui-turn{align-self:flex-end;max-width:85%;padding:8px 10px;border:1px solid var(--c-user-border);
background:var(--c-user-bg);color:var(--c-text)}
.tui-think{padding-left:10px;border-left:2px solid var(--c-border-strong);color:var(--c-text-2)}
.tui-tool{display:flex;justify-content:space-between;gap:10px;padding:7px 9px;
border:1px solid var(--c-border);color:var(--c-text-2)}
.tui-tool em{font-style:normal;color:var(--c-accent);text-align:right}
.tui-answer{font-family:var(--font-ui);font-size:12.5px;line-height:1.55;color:var(--c-text)}
.tui-status{margin-top:auto;padding-top:8px;border-top:1px solid var(--c-border);font-size:9px}
.tui-status span:last-child{color:var(--c-success)}
.wd-shell{display:grid;grid-template-columns:112px minmax(0,1fr);min-height:330px;
font-family:var(--font-ui);background:var(--c-recessed)}
.wd-rail{display:flex;flex-direction:column;gap:8px;padding:13px 10px;
border-right:1px solid var(--c-border);color:var(--c-text-3);font-size:10px}
.wd-rail>b{font-family:var(--font-display);font-size:16px;color:var(--c-text)}
.wd-rail .active{padding:6px 7px;background:var(--c-fill);color:var(--c-text);
border-left:2px solid var(--c-accent)}
.wd-child{padding-left:9px}
.wd-main{display:flex;flex-direction:column;min-width:0}
.wd-bar{display:flex;align-items:center;gap:9px;height:34px;padding:0 11px;
border-bottom:1px solid var(--c-border);font-size:10px;color:var(--c-text-2)}
.wd-bar>b{font-size:12px;color:var(--c-text)}
.wd-bar>span{color:var(--c-success)}
.wd-bar>em{margin-left:auto;padding:3px 9px;border-radius:999px;background:var(--c-accent);
color:var(--c-accent-ink);font-style:normal}
.wd-panes{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(120px,.8fr);flex:1;min-height:0}
.wd-chat{display:flex;flex-direction:column;gap:9px;padding:12px;border-right:1px solid var(--c-border)}
.wd-bubble{align-self:flex-end;max-width:86%;padding:8px 10px;border:1px solid var(--c-user-border);
border-radius:12px 12px 3px 12px;background:var(--c-user-bg);font-size:11px;color:var(--c-text)}
.wd-think{padding-left:9px;border-left:2px solid var(--c-border-strong);
font-size:10px;line-height:1.5;color:var(--c-text-2)}
.wd-tools{overflow:hidden;border:1px solid var(--c-border);border-radius:8px}
.wd-tools span{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;
font-family:var(--font-mono);font-size:9px;color:var(--c-text-2)}
.wd-tools span+span{border-top:1px dashed var(--c-border-strong)}
.wd-tools b{font-weight:400;color:var(--c-text)}
.wd-tools em{font-style:normal;color:var(--c-accent);text-align:right}
.wd-system{padding:6px 8px;border:1px solid color-mix(in srgb,var(--c-accent) 30%,transparent);
background:color-mix(in srgb,var(--c-accent) 6%,transparent);font-size:9px;color:var(--c-text-2)}
.wd-system b{margin-right:7px;color:var(--c-accent)}
.wd-answer{font-size:10.5px;line-height:1.55;color:var(--c-text)}
.wd-composer{display:grid;grid-template-columns:1fr auto auto;gap:7px;align-items:center;
margin-top:auto;padding:7px 8px;border:1px solid var(--c-input-border);border-radius:9px;
background:var(--c-input-bg);font-size:9px;color:var(--c-text-3)}
.wd-composer b{padding:3px 7px;border:1px solid color-mix(in srgb,var(--c-accent) 30%,transparent);
border-radius:999px;color:var(--c-accent)}
.wd-composer em{padding:4px 8px;border-radius:999px;background:var(--c-accent);
color:var(--c-accent-ink);font-style:normal}
.wd-inspector{display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--c-surface)}
.wd-tabs{display:flex;gap:7px;padding-bottom:7px;border-bottom:1px solid var(--c-border);
font-size:8px;color:var(--c-text-3)}
.wd-tabs b{color:var(--c-accent)}
.wd-inspector>div:not(.wd-tabs){padding:7px;border:1px solid var(--c-border);
border-radius:7px;background:var(--c-recessed)}
.wd-inspector p{margin-top:4px;font-size:9px;line-height:1.4;color:var(--c-text-2)}
[data-preview] [data-beat]{opacity:1;transition:opacity 220ms var(--ease),transform 220ms var(--ease)}
@media (prefers-reduced-motion:no-preference){
[data-preview][data-preview-running] [data-beat-shown]{opacity:1;transform:none}
[data-preview][data-preview-running] [data-beat]:not([data-beat-shown]){opacity:0;transform:translateY(3px)}
}
@media (max-width:1020px){
.hero-grid{grid-template-columns:1fr;gap:44px}
.hero-grid>*{min-width:0}
.g.two,.g.three,.grid.four{grid-template-columns:repeat(2,minmax(0,1fr))!important}
.duo,.cta-grid,#deploy .duo{grid-template-columns:1fr;gap:40px}
.section{padding:80px 0 72px}
.duo>*{min-width:0}
.cta-band{padding:80px 0}
.hero-panel{padding:40px 32px 36px}
}
@media (max-width:680px){
.g.two,.g.three,.grid.four{grid-template-columns:1fr!important}
.tui-shell,.wd-shell,.wd-panes{grid-template-columns:1fr}
.tui-rail,.wd-rail{display:none}
.wd-chat{border-right:0}
.wd-inspector{border-top:1px solid var(--c-border)}
.rows>.row{grid-template-columns:1fr;gap:8px;padding:14px 16px}
.actions.start{align-items:stretch;flex-direction:column}
.actions.start .btn{text-align:center}
/* Below his design's floor the no-wrap claim would clip mid-word; wrapping
   it is the smaller deviation. */
[data-typewriter]{white-space:normal !important;height:auto !important}
.section{padding:64px 0 60px}
.claims>:first-child,.claims>:last-child{padding:22px 20px}
.nav-cta{padding:9px 14px !important;min-height:34px !important}
}
`;

/* ── Sign-in, and the pages the OAuth flow can fail to ───────────────── */

export interface LoginProvider {
  /** Where "Continue with …" goes, already escaped for an attribute. */
  readonly href: string;
  readonly label: string;
}

/** Sign-in. `extra` is the one line the Cloudflare provider earns, because
 *  signing in with it also connects Workers AI. */
export function loginDocument(providers: readonly LoginProvider[], extra: string): string {
  const body = providers.length === 0
    ? '<p class="lede">No sign-in provider is configured on this deployment yet.</p>'
    : `
  <p class="lede">Your verified email is your account. Either provider signs you into the same one.</p>
  <div class="providers">${providers.map((provider) => (
    `<a class="provider" href="${provider.href}">Continue with ${escapeHtml(provider.label)}</a>`
  )).join('')}</div>
  <p class="dim">Kinu reads one thing from the provider, your email address, and an address the provider has not verified cannot sign in.${extra}</p>`;
  return authDocument('Sign in to Kinu.run', body);
}

/** Sign-in, and its two failures, on one card. */
export function authDocument(title: string, body: string): string {
  return publicPage({
    title: title.includes('Kinu') ? title : `${title} — Kinu.run`,
    styles: CARD_CSS,
    nav: `<a class="quiet" href="/install">Install CLI</a><a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a>`,
    body: `<main class="gate"><div class="card">
  <div class="anno ruled"><span>Sign in</span><span>OAuth</span></div>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</div></main>\n`,
    footer: publicFooter(),
  });
}

/**
 * The device-approval pages: the consent screen, its result, and its failures.
 *
 * No header bar and no footer. A terminal opens these, they are read once, and
 * they are closed, so anything that invites the reader elsewhere is in the way.
 */
export function approvalDocument(title: string, body: string): string {
  return publicPage({
    title: `${title} — Kinu.run`,
    styles: CARD_CSS,
    body: `<main class="gate"><div class="card">
  <span class="lockup">${mark(18)} Kinu.run</span>
  <h1 class="small">${escapeHtml(title)}</h1>
  ${body}
</div></main>\n`,
  });
}

const CARD_CSS = `
.gate{flex:1;display:grid;place-items:center;padding:calc(var(--gutter) * 1.1) var(--gutter)}
.card{width:min(440px,100%);padding:26px;border:var(--rule);border-radius:var(--r-card);
background:var(--c-surface)}
.card h1{margin:18px 0 0;font-size:30px;letter-spacing:-0.02em;max-width:none}
.card h1.small{font-size:23px;letter-spacing:-0.015em}
.card .lede{margin:14px 0 0;font-size:15px;max-width:none}
.card p{margin:14px 0 0;color:var(--c-text-2);font-size:15px}
.card .ruled{display:flex;justify-content:space-between;gap:16px;padding-bottom:9px;
border-bottom:var(--rule)}
.card .muted{color:var(--c-text-3);font-size:13px}
.card code{overflow-wrap:anywhere}
.providers{display:grid;gap:10px;margin-top:22px}
.provider{display:flex;align-items:center;justify-content:space-between;gap:12px;
min-height:44px;padding:0 15px;border:1px solid var(--c-input-border);border-radius:var(--r-row);
background:var(--c-fill);color:var(--c-text);font-size:14.5px;font-weight:600;
transition:background 150ms var(--ease),border-color 150ms var(--ease)}
.provider:hover{border-color:var(--c-accent);background:var(--c-accent-subtle)}
.provider::after{content:"→";color:var(--c-text-3)}
.provider:hover::after{color:var(--c-accent-fg)}
dl{display:grid;margin:22px 0 0;border-top:var(--rule)}
dl>div{display:flex;justify-content:space-between;gap:18px;padding:9px 0;
border-bottom:var(--rule);font-size:14px}
dt{color:var(--c-text-3)}
dd{margin:0;text-align:right}
form{margin-top:20px}
button[type="submit"]{display:inline-flex;align-items:center;justify-content:center;
width:100%;min-height:40px;padding:0 15px;border:1px solid transparent;border-radius:var(--r-row);
background:var(--c-accent);color:var(--c-accent-on);font:inherit;font-size:14px;
font-weight:620;cursor:pointer}
button[type="submit"]:hover{background:color-mix(in oklab,var(--c-accent) 90%,var(--c-text))}
`;

/* ── Install ─────────────────────────────────────────────────────────── */

const INSTALLER_SETS_UP: ReadonlyArray<readonly [title: string, body: string]> = [
  [
    'Your account',
    'Setup opens browser approval and stores the CLI session under your Kinu home directory.',
  ],
  [
    'Cloud or local workspaces',
    'Create durable cloud workspaces or fully local ones from the same command, then alias the ones you use daily.',
  ],
  [
    'This machine as an executor',
    'Connect the machine so agents can run commands, read files and serve previews on it, with your approval.',
  ],
];

export function installDocument(command: string): string {
  return publicPage({
    title: 'Install the Kinu.run CLI',
    description: 'One command installs the Kinu CLI on macOS or Linux, then signs it into your account.',
    styles: INSTALL_CSS,
    nav: `<a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a><a class="btn solid" href="/login">Sign in</a>`,
    body: `<main>
  <section class="section top">
    <p class="eyebrow">Terminal setup</p>
    <h1>One command, then your terminal has agents in it.</h1>
    <p class="lede">Kinu installs into <code>~/.kinu</code>, adds the <code>kinu</code> command to your PATH, then starts browser sign-in and local setup when a terminal is available.</p>
    <div class="cmd wide">
      <code id="install-command">${escapeHtml(command)}</code>
      <button class="copy" type="button" data-copy="install-command">Copy</button>
    </div>
    <p class="dim">Script only, with no sign-in and no local setup: add <code>--no-setup</code>.</p>
  </section>
  <section class="section">
    <p class="label"><b>§ 01</b>What the installer sets up</p>
    <div class="grid three">
      ${INSTALLER_SETS_UP.map(([title, body]) => `<div class="cell"><h2>${title}</h2><p>${body}</p></div>`).join('\n      ')}
    </div>
  </section>
</main>
`,
    footer: publicFooter(),
    script: COPY_SCRIPT,
  });
}

const INSTALL_CSS = `
main{display:flex;flex-direction:column}
.top{padding-top:calc(var(--gutter) * 1.4)}
.top h1{font-size:clamp(31px,4.6vw,50px)}
.cmd.wide{margin-top:30px;max-width:720px}
.top .dim{margin:14px 0 0}
`;
