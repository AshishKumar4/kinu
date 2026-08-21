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
import {
  COPY_SCRIPT, GITHUB_ICON, HERO_FACTS, REPO_URL, heroFigure, mark, publicFooter, publicPage,
} from './public-shell';

/* ── Front page ──────────────────────────────────────────────────────── */

/** Counts the repo can answer for, each one a link in the same argument: the
 *  search is configurable, and the configuration is closed. */
const STATS: ReadonlyArray<readonly [figure: string, label: string]> = [
  ['6', 'named searches'],
  ['6', 'composable axes'],
  ['7', 'delegation actions'],
  ['2', 'backends, one core'],
];

/** Cells of the capability grid. Every claim is one the repo can answer for. */
const CAPABILITIES: ReadonlyArray<readonly [title: string, body: string]> = [
  [
    'You declare the measurement',
    'An objective names the metric, its unit, the direction and the target, and it names the verifier that measures a candidate. A verifier nobody registered refuses the run instead of inventing a score.',
  ],
  [
    'A node is a whole agent',
    'Every branch runs the same turn loop the workspace agent runs. Inside the one workspace filesystem it holds its own directory, its own credential and its own /tmp.',
  ],
  [
    'Workspaces that keep working',
    'A workspace holds its filesystem, sessions and history between turns. Work still running at 30 seconds detaches into a background job, and the agent wakes when the job settles.',
  ],
  [
    'The same agent on your machine',
    'The CLI runs the same core on bun:sqlite and real processes. Cloud and local drive one orchestrator, so the two cannot drift into two products.',
  ],
  [
    'One real filesystem',
    'A durable POSIX filesystem, a real shell, about 95 coreutils, and language runtimes installed when the agent asks for them. The same component runs on Workers and on your laptop.',
  ],
  [
    'It keeps the tools it writes',
    'The agent learns reusable tools from its own conversations and scores them as they earn their place. Its agentic loop is code it can rewrite, checked by four structural gates.',
  ],
];

/** The page as text. `install` is the command for THIS origin, so a preview
 *  deployment shows its own. */
export function landingDocument(install: string): string {
  return publicPage({
    title: 'Kinu.run — the self-evolving agent platform',
    description: 'An agent of your own that gets better every time it works. When a task is hard it searches a tree of agents, measures every candidate the way you said, and keeps every skill it earns.',
    styles: LANDING_CSS,
    nav: [
      `<a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a>`,
      '<a class="quiet" href="#install" data-install-toggle aria-expanded="false">Install CLI</a>',
      '<a class="btn solid" href="/login">Sign in</a>',
    ].join(''),
    body: `<main>
  <section class="hero">
    <div class="say">
      <p class="eyebrow">The self-evolving agent platform</p>
      <h1>An agent of your own that <em>gets better every time it works</em>.</h1>
      <p class="lede">Give it a task and a way to measure the answer. When the task is hard it runs a tree of agents, measures every candidate the way you said, and keeps the branch that measured best.</p>
      <p class="lede">Agents live in durable workspaces. Run them in the cloud, or entirely on your own machine.</p>
      <div class="actions">
        <a class="btn solid" href="/login">Sign in</a>
        <a class="btn" href="#install" data-install-toggle aria-expanded="false">Install CLI</a>
      </div>
      <div id="install" class="panel" hidden>
        <div class="cmd">
          <code id="landing-install-command">${escapeHtml(install)}</code>
          <button class="copy" type="button" data-copy="landing-install-command">Copy</button>
        </div>
        <p class="dim">Run it in a terminal on macOS or Linux. The installer adds the <code>kinu</code> command, then starts browser sign-in.</p>
      </div>
      <ul class="stats">
        ${STATS.map(([figure, label]) => `<li class="stat"><strong>${figure}</strong><span>${label}</span></li>`).join('\n        ')}
      </ul>
    </div>
    <figure class="show">
      <div class="anno ruled"><span>Search · UCT</span><span>${HERO_FACTS.rollouts} rollouts · depth ${HERO_FACTS.depth}</span></div>
      ${heroFigure()}
      <div class="anno ruled"><span>Fill · measured score</span><span>${HERO_FACTS.abandoned} branches abandoned</span></div>
      <figcaption class="dim">Every node is an agent that ran the task its own way. Fill is the score it measured, from worst to best. The bright line is the branch the search kept spending on.</figcaption>
    </figure>
  </section>

  <section class="section">
    <p class="label"><b>§ 01</b>Quickstart</p>
    <div class="grid three">
      <div class="cell">
        <span class="num">Step one</span>
        <h2>Install the CLI</h2>
        <p>One command on macOS or Linux.</p>
        <div class="cmd"><code id="step-install">${escapeHtml(install)}</code><button class="copy" type="button" data-copy="step-install">Copy</button></div>
      </div>
      <div class="cell">
        <span class="num">Step two</span>
        <h2>Create a workspace</h2>
        <p>Cloud by default. Add <code>--mode local</code> to keep it on this machine.</p>
        <div class="cmd"><code id="step-create">kinu create triage</code><button class="copy" type="button" data-copy="step-create">Copy</button></div>
      </div>
      <div class="cell">
        <span class="num">Step three</span>
        <h2>Give it work</h2>
        <p>Run one task, or open a conversation with <code>kinu chat triage</code>.</p>
        <div class="cmd"><code id="step-run">kinu run triage "find the slowest query"</code><button class="copy" type="button" data-copy="step-run">Copy</button></div>
      </div>
    </div>
    <p class="dim foot">The web app opens the same workspace, with its files, its sessions and every search it has run.</p>
  </section>

  <section class="section">
    <p class="label"><b>§ 02</b>What you get</p>
    <div class="grid three">
      ${CAPABILITIES.map(([title, body]) => `<div class="cell"><h2>${title}</h2><p>${body}</p></div>`).join('\n      ')}
    </div>
  </section>
</main>
`,
    footer: publicFooter(),
    script: `${COPY_SCRIPT}\n${INSTALL_PANEL_SCRIPT}\n${GROW_SCRIPT}`,
  });
}

const LANDING_CSS = `
main{display:flex;flex-direction:column}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.04fr);
gap:calc(var(--gutter) * 1.05);align-items:center;
padding:calc(var(--gutter) * 1.5) var(--gutter);border-bottom:var(--rule)}
h1 em{font-style:italic}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
/* Four across, or two, never three with an orphan under them. */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;
margin-top:40px;padding-top:26px;border-top:var(--rule)}
.stat span{font-size:10.5px;letter-spacing:0.06em;line-height:1.45}
.show{margin:0}
.ruled{display:flex;justify-content:space-between;gap:16px;padding:8px 0;
border-bottom:var(--rule)}
.ruled:first-child{border-top:var(--rule)}
figcaption{margin-top:16px;max-width:46ch}
.foot{margin:18px 0 0;max-width:72ch}
.cell .cmd{margin-top:16px}
/* A command in a third of the column is narrow, so it wraps rather than
   clipping: the reader has to be able to see what they are about to run. */
.cell .cmd code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}

/* The tree. Every rule is the app's own reading of a search: weight and radius
   track rollouts, fill tracks the measured score, the kept line is the one
   thing drawn in the accent, and an abandoned branch is dashed. */
.tree{display:block;width:100%;height:auto;padding:22px 0;overflow:visible}
.tree .e{fill:none;stroke:var(--c-border-strong);stroke-linecap:round}
.tree .e[data-status="kept"]{stroke:var(--c-accent)}
.tree .e[data-status="pruned"]{stroke-opacity:0.4;stroke-dasharray:3 4}
.tree .n{stroke:var(--c-bg);stroke-width:1}
.tree .n[data-status="pruned"]{fill-opacity:0.45}
.tree .n[data-status="kept"]{stroke:var(--c-accent);stroke-width:1.5}
.tree[data-growing] .e,.tree[data-growing] .n{opacity:0}
.tree[data-growing] [data-shown]{opacity:1;transition:opacity 300ms var(--ease)}

@media (max-width:880px){
.hero{grid-template-columns:1fr;gap:32px;padding:32px var(--gutter) 36px}
.actions{margin-top:24px}
.actions .btn{flex:1 1 auto}
.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:30px;padding-top:22px}
.tree{padding:16px 0}
}
`;

/** Opening the panel is the only state on the page, and both toggles share it. */
const INSTALL_PANEL_SCRIPT = `
const panel = document.getElementById('install');
const toggles = document.querySelectorAll('[data-install-toggle]');
for (const toggle of toggles) {
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    panel.hidden = false;
    for (const other of toggles) other.setAttribute('aria-expanded', 'true');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}`;

/**
 * Grow the tree in the order the search built it.
 *
 * The server already sent the finished tree, so this hides it and puts it back
 * one beat at a time. That way round on purpose: with no script, or a broken
 * one, the page still shows the whole search, and a reader who asked for less
 * motion gets the finished picture at once.
 *
 * Three conditions, and each one leaves the finished tree on screen rather
 * than a blank frame: reduced motion, a hidden tab (a browser stops serving
 * animation frames there, so a reveal started in the background would sit at
 * beat zero until the tab is looked at), and no script at all.
 *
 * `data-growing` is present only while a reveal runs, which is what the
 * screenshot pass and the browser gate wait on.
 */
const GROW_SCRIPT = `
const tree = document.getElementById('hero-tree');
if (tree && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const parts = Array.from(tree.querySelectorAll('[data-beat]'))
    .sort((a, b) => Number(a.dataset.beat) - Number(b.dataset.beat));
  tree.setAttribute('data-growing', '');
  let at = 0;
  let last = 0;
  const step = (now) => {
    if (now - last >= 46) {
      last = now;
      const beat = parts[at].dataset.beat;
      while (at < parts.length && parts[at].dataset.beat === beat) parts[at++].setAttribute('data-shown', '');
    }
    if (at < parts.length) requestAnimationFrame(step);
    else tree.removeAttribute('data-growing');
  };
  requestAnimationFrame(step);
}`;

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
