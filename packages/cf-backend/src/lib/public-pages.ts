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
   Measured, not assumed: his mock runtime ships its own
   box-sizing:border-box reset, so his max-width-1280 padded column is
   1280 OUTER with an 1184 content measure — exactly what this shell's
   border-box .page already produces. No compensation; rails, gutters and
   inner grids line up verbatim. */
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
.film .anno.ruled{border:0;padding:0 0 14px;flex-wrap:wrap;gap:8px;
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

/* Interactive previews: the beats the driver reveals. All ships visible;
   the driver hides future beats only when motion is allowed and the figure
   is on screen. */
[data-preview] .term{margin:14px 0}
.prev-duo{margin-top:clamp(36px,4vw,56px);align-items:start}
.tui-preview .line[data-kind="tool"]{color:var(--c-text-2);font-family:var(--font-mono)}
.tui-preview .line[data-kind="say"]{color:var(--c-text);font-family:var(--font-ui);font-size:13.5px;line-height:1.7}
.tui-preview .line[data-kind="status"]{color:var(--c-success)}
.ws{display:grid;grid-template-columns:150px minmax(0,1fr);gap:1px;
background:var(--c-border);border:1px solid var(--c-border);
font-family:var(--font-ui)}
.ws-rail{background:var(--c-recessed);padding:14px;display:flex;flex-direction:column;gap:6px}
.ws-item{font-size:12.5px;color:var(--c-text-2);padding:6px 10px;border-left:2px solid transparent}
.ws-item.active{color:var(--c-text);border-left-color:var(--c-accent);background:var(--c-fill)}
.ws-main{position:relative;background:var(--c-surface);padding:18px;min-height:230px}
.ws-bubble{background:var(--c-user-bg);border:1px solid var(--c-user-border);
padding:9px 12px;font-size:13.5px;color:var(--c-text);max-width:85%;
margin-left:auto;margin-bottom:12px}
.ws-tool,.ws-say,.ws-job,.ws-inspector{margin-bottom:11px}
.ws-tool{font-family:var(--font-mono);font-size:12.5px;color:var(--c-text-2)}
.ws-tool .metric{margin-left:8px}
.ws-say{font-size:14px;line-height:1.65;color:var(--c-text-2);max-width:60ch}
.ws-job{display:flex;gap:10px;align-items:center;padding:8px 10px;
border:1px dashed var(--c-border-strong);font-size:12.5px;color:var(--c-text-2)}
.ws-inspector{border-top:1px dashed var(--c-border-strong);padding-top:10px;
display:flex;flex-direction:column;gap:6px}
.ws-inspector>div:not(.fig){font-family:var(--font-mono);font-size:12px;
display:flex;justify-content:space-between;gap:16px;color:var(--c-text-2)}
[data-preview] [data-beat]{opacity:1}

@media (max-width:1020px){
@media (prefers-reduced-motion:no-preference){
[data-preview] [data-beat-shown]{opacity:1}
[data-preview] [data-beat]:not([data-beat-shown]){opacity:0}
}}
@media (max-width:1020px){
.hero-grid{grid-template-columns:1fr;gap:44px}
.hero-grid>*{min-width:0}
.g.two,.g.three,.grid.four{grid-template-columns:repeat(2,minmax(0,1fr))!important}
.duo,.cta-grid,#deploy .duo{grid-template-columns:1fr;gap:40px}
.section{padding:80px 0 72px}
.cta-band{padding:80px 0}
.hero-panel{padding:40px 32px 36px}
}
@media (max-width:680px){
.g.two,.g.three,.grid.four{grid-template-columns:1fr!important}
.ws{grid-template-columns:1fr}
.ws-rail{flex-direction:row;flex-wrap:wrap}
.ws-main{min-height:0}
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
