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
import { CLI_FILM_SCRIPT, cliFilmFigure } from './cli-film';
import { WEAVE_SCRIPT, weaveLayer } from './hero-weave';
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

/**
 * The lines the headline rotates through. Each completes "An agent of your own
 * that ___." — one product, four angles of the same claim. The first is the
 * one a reader with no script gets, so it stays the strongest.
 */
const TAGLINES = [
  'gets better every time it works',
  'searches a tree of agents when the task is hard',
  'remembers what worked',
  'runs in your cloud, or on your machine',
] as const;

/** § 02. One workspace, reached four ways. The claim the whole section makes
 *  is that no client is the product, the CLI included. */
const CLIENTS: ReadonlyArray<readonly [title: string, body: string]> = [
  [
    'The browser',
    'kinu.run shows your workspaces: files, sessions, and every search they have run.',
  ],
  [
    'The terminal',
    '<code>kinu chat</code> opens a conversation. <code>kinu run</code> executes one task and exits, for scripts and CI.',
  ],
  [
    'Your editor',
    '<code>kinu acp</code> speaks the Agent Client Protocol, so editors like Zed can drive a workspace from a panel.',
  ],
  [
    'Email',
    'Each workspace has an email address. Mail to it starts a turn, and the reply arrives on the same thread. Not yet enabled on kinu.run.',
  ],
];

/** § 04. The four timescales, each cell one clock. The kicker states the
 *  clock's trigger, and the body states what may move on it and what guards
 *  the move. */
const CLOCKS: ReadonlyArray<readonly [kicker: string, title: string, body: string]> = [
  [
    'Per step · every settled tool call',
    'Tool fitness',
    'Crafted tools are scored every time they run. Tools that keep failing drop out of the callable set mid-run.',
  ],
  [
    'Per turn · the next message',
    'Turn review',
    'Each turn is graded against your next message. A lesson persists only when later turns corroborate it.',
  ],
  [
    'Per session · every five turns',
    'Consolidation',
    'Recurring patterns become reusable tools, and the agent can propose changes to its own loop. Proposals pass four structural gates and a shadow eval before they land.',
  ],
  [
    'Per lifetime · every five windows',
    'Retirement and search',
    'Tool scores decay with time, and low scores retire the tool. <code>kinu evolve</code> searches over the loop itself, scored on graded turns.',
  ],
];

/** Cells of the capability grid. Every claim is one the repo can answer for,
 *  and none repeats a section above. */
const CAPABILITIES: ReadonlyArray<readonly [title: string, body: string]> = [
  [
    'Workspaces that keep working',
    'Files, sessions, and history persist between turns. Work that outlives 30 seconds detaches into a background job, and the agent wakes when it settles.',
  ],
  [
    'Local mode',
    'The CLI runs the same core on bun:sqlite and real processes. Cloud and local share one orchestrator.',
  ],
  [
    'One real filesystem',
    'POSIX semantics, a real shell, about 95 coreutils, and language runtimes installed on demand. The same component runs on Workers and on your laptop.',
  ],
  [
    'Four executors',
    'Work runs in the workspace, in a Linux container, on your own machine behind consent, or in the workspace a fork came from. Each executor\u2019s capabilities are rendered into the agent\u2019s prompt.',
  ],
  [
    'Built-in web search',
    'The web tool searches and fetches with no API key. Add a Tavily key for ranked, answer-augmented search.',
  ],
  [
    'Headless and CI',
    '<code>kinu run</code> never prompts, exits nonzero on failure, and streams line-delimited JSON. Scoped tokens limit CI to running tasks and reading state.',
  ],
];

/** § 06. The three-step self-host story, honest about what each step needs. */
const DEPLOY_STEPS: ReadonlyArray<readonly [num: string, title: string, body: string, id: string, cmd: string]> = [
  [
    'Step one',
    'Bring the account',
    'A Cloudflare account on the Workers Paid plan, a zone, and a wrangler login. Provisioning prints everything it cannot create for you, with the command that re-checks each item.',
    'deploy-provision',
    'bun run infra:provision',
  ],
  [
    'Step two',
    'Deploy, then provision again',
    'The deploy ships the Worker, its Durable Objects and its container. Secrets install on a Worker that exists, which is why provisioning runs twice.',
    'deploy-deploy',
    'bun run deploy',
  ],
  [
    'Step three',
    'Prove the account',
    'The infra gate checks that every declared resource exists and that the deployed Worker is bound to it. It exits non-zero when one is not.',
    'deploy-verify',
    'bun run gate:infra',
  ],
];

/** Mono term → value rows, the annotation device the hero already uses. */
function specRows(rows: ReadonlyArray<readonly [term: string, value: string]>): string {
  return `<dl class="spec">
        ${rows.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('\n        ')}
      </dl>`;
}

/** The page as text. `install` is the command for THIS origin, so a preview
 *  deployment shows its own. */
export function landingDocument(install: string): string {
  const deployUrl = `https://deploy.workers.cloudflare.com/?url=${REPO_URL}`;
  const guideUrl = `${REPO_URL}/blob/main/docs/SELF-HOSTING.md`;
  return publicPage({
    title: 'Kinu.run — the self-evolving agent platform',
    description: 'Kinu is an open-source agent platform. Agents run in durable workspaces, improve with use, and search a tree of agents on hard tasks. Run it on kinu.run, or deploy your own.',
    styles: LANDING_CSS,
    nav: [
      `<a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a>`,
      '<a class="quiet" href="#deploy"><b>06</b>Deploy your own</a>',
      '<a class="quiet" href="#install" data-install-toggle aria-expanded="false"><b>01</b>Install CLI</a>',
      '<a class="btn solid" href="/login">Sign in</a>',
    ].join(''),
    body: `<main>
  <section class="hero">
    ${weaveLayer()}
    <div class="say">
      <p class="eyebrow">The self-evolving agent platform</p>
      <h1 class="taglines" data-taglines>
        ${TAGLINES.map((line, at) => `<span${at === 0 ? ' data-shown' : ''}>An agent of your own that <em>${line}</em>.</span>`).join('\n        ')}
      </h1>
      <p class="lede">Give it a task in chat. When the task is hard, Kinu runs many attempts, measures each one, and keeps the best.</p>
      <p class="lede">Workspaces are durable: files, sessions, and memory persist between turns. Run them on Cloudflare or entirely on your own machine.</p>
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
      <figcaption class="dim">A recorded search. Each node is one agent’s attempt, shaded by its measured score; the bright path is the winning branch.</figcaption>
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
    <p class="label"><b>§ 02</b>One workspace, every client</p>
    <h2 class="title">Work from the browser, the terminal, your editor, or email.</h2>
    <p class="lede">Every client opens the same workspace, with the same files and history.</p>
    <div class="grid two">
      ${CLIENTS.map(([title, body]) => `<div class="cell"><h2>${title}</h2><p>${body}</p></div>`).join('\n      ')}
    </div>
    ${cliFilmFigure()}
    <p class="dim foot">Schedules, webhooks, and finished background jobs start turns the same way.</p>
  </section>

  <section class="section">
    <p class="label"><b>§ 03</b>The tree of agents</p>
    <h2 class="title">Run one task as a tree of agents.</h2>
    <div class="duo">
      <div>
        <p class="lede">One tool call builds the tree. Each node is a whole agent that attempts the task its own way, in its own directory, with its own credential.</p>
        <p class="body">The agent turns your ask into an objective: a metric, a target, and a verifier. A verifier is code that runs in the workspace, and its number picks the winner. Unregistered verifier names fail the run.</p>
        <p class="body">Results persist per objective, so the next search starts from the record instead of from zero.</p>
        <p class="dim">The tree in the header is a recorded search.</p>
      </div>
      ${specRows([
        ['One action', "<code>agents({action:'swarm'})</code>"],
        ['Axes', 'unit · context · expand · score · advance · carry'],
        ['Presets', 'ideate · optimise · prove · custom'],
        ['Depth', 'ideate 1 · optimise 5 · prove 7'],
        ['Score', 'a code verifier, or a judge ensemble'],
        ['Records', '<code>exploration_records</code>, per objective'],
      ])}
    </div>
    <figure class="film">
      <div class="anno ruled"><span>Web · swarm run · design gallery, fixture transport</span><span>home · agent · search · work</span></div>
      <img class="webfilm" src="/assets/kinu-film-web.webp" width="1280" height="800" loading="lazy" decoding="async"
        alt="Four recorded views of the Kinu web app: a new workspace's mission, an agent mid-task, the search explorer, and the work queue." />
    </figure>
  </section>

  <section class="section">
    <p class="label"><b>§ 04</b>Self-evolution</p>
    <h2 class="title">Evolution on four timescales.</h2>
    <p class="lede">The shorter clocks feed the longer ones.</p>
    <div class="grid two">
      ${CLOCKS.map(([kicker, title, body]) => `<div class="cell"><span class="num">${kicker}</span><h2>${title}</h2><p>${body}</p></div>`).join('\n      ')}
    </div>
    <p class="dim foot">Execution evidence feeds tool selection only. Nothing wider is promoted on it.</p>
  </section>

  <section class="section">
    <p class="label"><b>§ 05</b>What you get</p>
    <div class="grid three">
      ${CAPABILITIES.map(([title, body]) => `<div class="cell"><h2>${title}</h2><p>${body}</p></div>`).join('\n      ')}
    </div>
  </section>

  <section class="section" id="deploy">
    <p class="label"><b>§ 06</b>Deploy your own</p>
    <h2 class="title">The same Worker, in your Cloudflare account.</h2>
    <p class="lede">kinu.run runs the open-source Worker from this repository. Deploy it yourself, and your agents, files, and model spend stay in your account.</p>
    <div class="actions">
      <a class="btn solid" href="${deployUrl}" target="_blank" rel="noopener noreferrer">Deploy to Cloudflare</a>
      <a class="btn" href="${guideUrl}" target="_blank" rel="noopener noreferrer">Read the self-hosting guide</a>
    </div>
    <div class="grid three">
      ${DEPLOY_STEPS.map(([num, title, body, id, cmd]) => `<div class="cell"><span class="num">${num}</span><h2>${title}</h2><p>${body}</p><div class="cmd"><code id="${id}">${cmd}</code><button class="copy" type="button" data-copy="${id}">Copy</button></div></div>`).join('\n      ')}
    </div>
    <p class="dim foot">The button forks the repository and starts a build. The plan, the zone, the root secret, and the OAuth apps are manual steps; the guide covers each one.</p>
  </section>

  <section class="section">
    <p class="label"><b>§ 07</b>Open source</p>
    <div class="duo">
      <div>
        <h2 class="title">One MIT-licensed repository.</h2>
        <p class="body">The agent, both backends, the CLI, and this site are in one repository.</p>
        <div class="actions">
          <a class="btn" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_ICON}Read the source</a>
        </div>
      </div>
      ${specRows([
        ['Licence', 'MIT'],
        ['Source', 'github.com/AshishKumar4/kinu'],
        ['Backends', 'Cloudflare Workers · POSIX'],
        ['Docs', 'architecture · exploration · evolution · deployment'],
      ])}
    </div>
  </section>
</main>
`,
    footer: publicFooter(),
    script: `${COPY_SCRIPT}\n${INSTALL_PANEL_SCRIPT}\n${TAGLINE_SCRIPT}\n${GROW_SCRIPT}\n${WEAVE_SCRIPT}\n${CLI_FILM_SCRIPT}`,
  });
}

const LANDING_CSS = `
main{display:flex;flex-direction:column}
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.04fr);
gap:calc(var(--gutter) * 1.05);align-items:center;
padding:calc(var(--gutter) * 1.5) var(--gutter);border-bottom:var(--rule)}
/* The silk. A ground layer under the hero's two columns: the SVG still is
   what the server sends, the canvas is the same field once the script wakes
   it, and the cross-fade between them is the only transition. Content sits
   above on its own stacking level, and the layer takes no events. */
.hero>.say,.hero>.show{position:relative;z-index:1}
.weave{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.weave svg,.weave canvas{position:absolute;inset:0;width:100%;height:100%}
.weave canvas{opacity:0;transition:opacity 1600ms var(--ease)}
.weave[data-live] canvas{opacity:1}
.weave[data-live] .weave-still{opacity:0;transition:opacity 1600ms var(--ease)}
@media (prefers-reduced-motion:reduce){.weave canvas{display:none}}
h1 em{font-style:italic}
/* The rotating headline. Every variant is stacked on one grid cell, so the
   hero is sized by the tallest line once and never reflows on a swap. A
   hidden variant is invisible to the accessibility tree, and with no script
   the first line simply stays. */
h1.taglines{display:grid}
h1.taglines>span{grid-area:1/1;visibility:hidden;opacity:0;
transition:opacity 460ms var(--ease),visibility 0s 460ms}
h1.taglines>span[data-shown]{visibility:visible;opacity:1;
transition:opacity 460ms var(--ease)}
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

/* Deep sections: a display-face claim, prose beside a rail of mono facts. */
.title{margin:0;font-family:var(--font-display);font-size:clamp(27px,3.4vw,40px);
line-height:1.1;font-weight:500;letter-spacing:-0.018em;max-width:30ch}
.body{margin:18px 0 0;max-width:60ch;color:var(--c-text-2);font-size:14.5px;line-height:1.65}
.lede+.grid,.actions+.grid{margin-top:26px}
.duo{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
gap:calc(var(--gutter) * 1.1);align-items:start;margin-top:26px}
.spec{display:grid;margin:0;border-top:var(--rule)}
.spec>div{display:flex;justify-content:space-between;gap:18px;padding:11px 0;
border-bottom:var(--rule)}
.spec dt{color:var(--c-text-3);padding-top:2px}
.spec dd{margin:0;text-align:right;color:var(--c-text-2);font-size:13.5px;line-height:1.55}
.spec dd code{font-size:12px}

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

/* The films. Both carry the hero's own annotation rails. The terminal player
   is text: it ships finished, plays back on approach, and every line of it is
   held against the recording by the gate. The web film is one lazy animated
   image below the fold, sized in the markup so its arrival shifts nothing. */
.film{margin:26px 0 0}
.term{margin:0;padding:16px 18px;max-height:430px;overflow-y:auto;
border:1px solid var(--c-input-border);border-radius:var(--r-row);background:var(--c-recessed);
font-family:var(--font-mono);font-size:12px;line-height:1.75;
white-space:pre-wrap;overflow-wrap:anywhere}
.term .line{display:block}
.term .line[data-kind="cmd"] b{color:var(--c-text-3);font-weight:inherit}
.term .line[data-kind="call"]{margin-top:12px;color:var(--c-text-2)}
.term .line[data-kind="call"] b{color:var(--c-accent-fg);font-weight:inherit}
.term .line[data-kind="why"]{color:var(--c-text-3)}
.term .line[data-kind="out"]{margin-top:4px;color:var(--c-text-2)}
.term .line[data-kind="text"]{margin-top:10px}
.term[data-playing] .line:not([data-shown]){display:none}
.term[data-playing] [data-typed]::after{content:"▋";color:var(--c-accent-fg)}
.webfilm{display:block;width:100%;height:auto;margin-top:14px;
border:1px solid var(--c-input-border);border-radius:var(--r-row)}

@media (max-width:880px){
.hero{grid-template-columns:1fr;gap:32px;padding:32px var(--gutter) 36px}
.actions{margin-top:24px}
.actions .btn{flex:1 1 auto}
.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:30px;padding-top:22px}
.duo{grid-template-columns:1fr;gap:28px}
.spec dd{text-align:left}
.spec>div{flex-direction:column;gap:5px}
.tree{padding:16px 0}
.term{max-height:360px;font-size:11px}
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
 * Rotate the headline through its variants.
 *
 * The server sends every line with the first one shown, so with no script,
 * or a reader who asked for less motion, the page holds the strongest claim
 * and rotates nothing. A hidden tab skips swaps instead of queueing them,
 * so a returning reader never lands mid-fade on a line nobody saw.
 */
const TAGLINE_SCRIPT = `
const lines = document.querySelectorAll('[data-taglines] > span');
if (lines.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let shown = 0;
  setInterval(() => {
    if (document.hidden) return;
    lines[shown].removeAttribute('data-shown');
    shown = (shown + 1) % lines.length;
    lines[shown].setAttribute('data-shown', '');
  }, 3600);
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
