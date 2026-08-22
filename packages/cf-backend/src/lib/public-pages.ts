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

/** The four claims a visitor decides on, each one the repo can answer for.
 *  They sit under the hero as a hairline row: what you get, in one line
 *  each. */
const CLAIMS: ReadonlyArray<readonly [claim: string, support: string]> = [
  [
    'Learns from use',
    'Every turn is graded against your next message. Lessons that later turns confirm persist.',
  ],
  [
    'Crafts its own tools',
    'Recurring patterns become tools it builds, scores, and calls on its own.',
  ],
  [
    'Commands agent swarms',
    'A hard task forks a scored tree of whole agents. The best attempt wins.',
  ],
  [
    'Your cloud or yours alone',
    'Run it on kinu.run today, or deploy the same Worker into your own account.',
  ],
];

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

/** Mono term → value rows, the annotation device the frame uses. */
function specRows(rows: ReadonlyArray<readonly [term: string, value: string]>): string {
  return `<dl class="spec">
        ${rows.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('\n        ')}
      </dl>`;
}

/** The page as text. `install` is the command for THIS origin, so a preview
 *  deployment shows its own. */
export function landingDocument(
  install: string,
): string {
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
    <div class="block">
      <span class="chip">The self-evolving agent platform</span>
      <h1>An agent of your own that gets better every time it works.</h1>
      <p class="say">It learns from every conversation, builds its own tools from the patterns it proves, and commands a scored swarm of agents when a task is hard.</p>
      <div class="actions"><a class="btn solid" href="/login">Sign in</a></div>
    </div>
    <div id="install" class="panel" hidden>
      <div class="cmd">
        <code id="landing-install-command">${escapeHtml(install)}</code>
        <button class="copy" type="button" data-copy="landing-install-command">Copy</button>
      </div>
      <p class="dim">Run it in a terminal on macOS or Linux. The installer adds the <code>kinu</code> command, then starts browser sign-in.</p>
    </div>
    <figure class="show">
      <span class="fig">Fig. 01</span>
      <div class="anno ruled"><span>Search · UCT</span><span>${HERO_FACTS.rollouts} rollouts · depth ${HERO_FACTS.depth}</span></div>
      ${heroFigure()}
      <div class="anno ruled"><span>Fill · measured score</span><span>${HERO_FACTS.abandoned} branches abandoned</span></div>
      <figcaption class="dim">A recorded search. Each node is one agent’s attempt, shaded by its measured score; the bright path is the winning branch.</figcaption>
    </figure>
    <ul class="stats">
      ${CLAIMS.map(([claim, support]) => `<li class="stat"><strong>${claim}</strong><span>${support}</span></li>`).join('\n      ')}
    </ul>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="head">
      <p class="label"><b>§ 01</b>Quickstart</p>
      <h2>Start in the cloud on kinu.run, or run it entirely on your own machines.</h2>
      <p class="lede">Both are the same core. Reach one workspace from the web app, the TUI, or the CLI.</p>
    </div>
    <div class="grid three">
      <div class="cell">
        <span class="num">In the browser</span>
        <h3>Web</h3>
        <p>Sign in and create a workspace. Nothing to install, and the same workspace opens from every client.</p>
        <div class="actions start"><a class="btn solid" href="/login">Sign in</a></div>
        <div class="glimpse" data-glimpse="web"></div>
      </div>
      <div class="cell">
        <span class="num">In the terminal</span>
        <h3>TUI</h3>
        <p><code>kinu chat</code> opens the full-screen app: pick a workspace, talk, and watch it work.</p>
        <div class="cmd"><code id="step-chat">kinu chat triage</code><button class="copy" type="button" data-copy="step-chat">Copy</button></div>
        <div class="glimpse" data-glimpse="tui"></div>
      </div>
      <div class="cell">
        <span class="num">In the terminal</span>
        <h3>CLI</h3>
        <p>One command installs <code>kinu</code> on macOS or Linux. Create a workspace, then hand it a task.</p>
        <div class="cmd"><code id="step-install">${escapeHtml(install)}</code><button class="copy" type="button" data-copy="step-install">Copy</button></div>
        <div class="cmd"><code id="step-create">kinu create triage</code><button class="copy" type="button" data-copy="step-create">Copy</button></div>
        <div class="glimpse" data-glimpse="cli"></div>
      </div>
    </div>
    <p class="dim foot">A workspace created anywhere opens from the others, with its files, sessions, and search history intact.</p>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="head">
      <p class="label"><b>§ 02</b>One workspace, every client</p>
      <h2>Work from the browser, the terminal, your editor, or email.</h2>
      <p class="lede">Start a run at your desk, check it over SSH from the terminal, read the result in your editor.</p>
    </div>
    <div class="grid two">
      ${CLIENTS.map(([title, body]) => `<div class="cell"><h3>${title}</h3><p>${body}</p></div>`).join('\n      ')}
    </div>
    <figure class="film" data-mount="tui-film"></figure>
    ${cliFilmFigure()}
    <p class="dim foot">Schedules, webhooks, and finished background jobs start turns the same way.</p>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="head">
      <p class="label"><b>§ 03</b>The tree of agents</p>
      <h2>Run one task as a tree of agents.</h2>
      <p class="lede">It is a directed graph: every node is an attempt with its measured score, weak branches are pruned mid-run, and the winner answers.</p>
    </div>
    <figure class="dag-wrap" data-mount="swarm-dag"></figure>
    <div class="duo">
      <div>
        <p class="lede left">One tool call builds the tree. Each node is a whole agent that attempts the task its own way, in its own directory, with its own credential.</p>
        <p class="body">The agent turns your ask into an objective: a metric, a target, and a verifier. A verifier is code that runs in the workspace, and its number picks the winner. Unregistered verifier names fail the run.</p>
        <p class="body">What you get back is the winner plus the record: every branch, its score, and the verifier number behind each pick. Results persist per objective, so the next search starts from the record instead of from zero.</p>
        <p class="pull">“Scored by code that runs in the workspace — and the winner answers with its record.”</p>
      </div>
      ${specRows([
        ['Recorded', 'the search above is a real one'],
        ['Winner', 'highest verifier number'],
        ['Records', 'persist per objective'],
        ['Presets', 'ideate · research · audit · redteam · optimise · prove'],
      ])}
    </div>
    <figure class="film" data-mount="workspace-demo"></figure>
    <p class="dim foot">The tree in the header is a recorded search.</p>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="head">
      <p class="label"><b>§ 04</b>Self-evolution</p>
      <h2>Evolution on four timescales.</h2>
      <p class="lede">The shorter clocks feed the longer ones. None of it needs your upkeep: scoring, consolidation, and retirement run inside the workspace.</p>
    </div>
    <div class="grid two">
      ${CLOCKS.map(([kicker, title, body]) => `<div class="cell"><span class="num">${kicker}</span><h3>${title}</h3><p>${body}</p></div>`).join('\n      ')}
    </div>
    <p class="dim foot">Execution evidence feeds tool selection only. Nothing wider is promoted on it.</p>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="head">
      <p class="label"><b>§ 05</b>What you get</p>
      <h2>Everything in this grid ships today, on both backends.</h2>
    </div>
    <div class="grid three">
      ${CAPABILITIES.map(([title, body]) => `<div class="cell"><h3>${title}</h3><p>${body}</p></div>`).join('\n      ')}
    </div>
  </section>
  <hr class="rule">

  <section class="section" id="deploy">
    <div class="block">
      <span class="chip">Self-hosting</span>
      <h2>The same Worker, in your Cloudflare account.</h2>
      <p class="say">kinu.run runs the open-source Worker from this repository. Deploy it yourself, and your agents, files, and model spend stay in your account.</p>
      <div class="actions">
        <a class="btn solid" href="${deployUrl}" target="_blank" rel="noopener noreferrer">Deploy to Cloudflare</a>
        <a class="btn" href="${guideUrl}" target="_blank" rel="noopener noreferrer">Read the self-hosting guide</a>
      </div>
    </div>
    <div class="grid three steps">
      ${DEPLOY_STEPS.map(([num, title, body, id, cmd]) => `<div class="cell"><span class="num">${num}</span><h3>${title}</h3><p>${body}</p><div class="cmd"><code id="${id}">${cmd}</code><button class="copy" type="button" data-copy="${id}">Copy</button></div></div>`).join('\n      ')}
    </div>
    <p class="dim foot">The button forks the repository and starts a build. The plan, the zone, the root secret, and the OAuth apps are manual steps; the guide covers each one. When the infra gate passes, the Worker serving your requests is the same one kinu.run runs.</p>
  </section>
  <hr class="rule">

  <section class="section">
    <div class="duo">
      <div>
        <p class="label"><b>§ 07</b>Open source</p>
        <h2>One MIT-licensed repository.</h2>
        <p class="body">The agent, both backends, the CLI, and this site are in one repository. The gates that hold this page honest run from it too: film provenance, weight budgets, measured contrast. Audit the claims yourself.</p>
        <div class="actions start">
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
    script: `${COPY_SCRIPT}\n${INSTALL_PANEL_SCRIPT}\n${GROW_SCRIPT}\n${WEAVE_SCRIPT}\n${CLI_FILM_SCRIPT}`,
  });
}

const LANDING_CSS = `
main{display:flex;flex-direction:column}
/* ── Hero ─────────────────────────────────────────────────────────────
   The champagne block carries the claim; the silk moves behind it on the
   dark ground; the recorded search sits below as Fig. 01 with the numbers
   the drawing itself supports. The block is nearly flat on purpose — its
   power is the confidence of the colour field. */
.hero{position:relative;padding-top:clamp(48px,7vw,92px)}
.weave{position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:.85}
.weave svg,.weave canvas{position:absolute;inset:0;width:100%;height:100%}
.weave canvas{opacity:0;transition:opacity 1600ms var(--ease)}
.weave[data-live] canvas{opacity:1}
.weave[data-live] .weave-still{opacity:0;transition:opacity 1600ms var(--ease)}
@media (prefers-reduced-motion:reduce){.weave canvas{display:none}}
.block{z-index:1}
#install{z-index:1;position:relative}
.show{position:relative;z-index:1;margin:clamp(44px,6vw,76px) auto 0;max-width:860px;
width:100%;text-align:center}
.ruled{display:flex;justify-content:space-between;gap:16px;padding:9px 0;
border-bottom:var(--rule)}
.ruled:first-of-type{border-top:var(--rule)}
figcaption{margin:16px auto 0;max-width:52ch}
.foot{display:block;margin:20px auto 0;max-width:min(var(--measure),72ch);text-align:center}
/* The claims: a hairline row under the hero, one line each. Display face
   on the claim, plain prose under it — never a label to decode. */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;
list-style:none;margin:clamp(48px,6vw,80px) var(--gutter) 0;padding:0;
background:var(--c-border);border:var(--rule);position:relative;z-index:1}
.stat{margin:0;padding:24px;background:var(--c-bg);text-align:left}
.stat strong{display:block;font-size:19px;font-weight:520;letter-spacing:-0.012em;line-height:1.3}
.stat span{display:block;margin-top:9px;color:var(--c-text-2);font-size:13.5px;line-height:1.6}

/* ── Sections ───────────────────────────────────────────────────────── */
.grid{margin-top:clamp(36px,4vw,56px)}
.cell h3{margin-top:12px}
.cell .cmd{margin-top:16px}
/* A command in a third of the column is narrow, so it wraps rather than
   clipping: the reader has to be able to see what they are about to run. */
.cell .cmd code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.actions.start{justify-content:flex-start;margin-top:18px}
.duo{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
gap:calc(var(--gutter) * 1.2);align-items:start;max-width:1060px;
margin:clamp(36px,4vw,56px) auto 0}
.duo>.lede.left{margin-left:0;text-align:left}
.duo h2{margin-top:14px}
.spec{display:grid;margin:0;border-top:var(--rule);align-self:start}
.spec>div{display:flex;justify-content:space-between;gap:18px;padding:11px 0;
border-bottom:var(--rule)}
.spec dt{color:var(--c-text-3);padding-top:2px}
.spec dd{margin:0;text-align:right;color:var(--c-text-2);font-size:13.5px;line-height:1.55}
.spec dd code{font-size:12px}
/* Mounts MotionRedesign2 fills on rebase. An unfilled mount holds no space:
   a slot that reserves height around nothing ships a page of empty boxes the
   first time a script fails or an asset is slow. */
.dag-wrap:empty,.film:empty,.glimpse:empty{display:none}
.dag-wrap{margin:clamp(36px,4vw,56px) auto 0}
.film{margin:clamp(36px,4vw,56px) auto 0}
/* Deep-section prose keeps a reading measure even beside the spec rail. */
.body{margin-left:auto;margin-right:auto}
.pull{margin-top:30px}

/* ── The tree. Every rule is the app's own reading of a search: weight and
   radius track rollouts, fill tracks the measured score, the kept line is
   the one thing drawn in the accent, and an abandoned branch is dashed. */
.tree{display:block;width:100%;height:auto;padding:22px 0;overflow:visible}
.tree .e{fill:none;stroke:var(--c-border-strong);stroke-linecap:round}
.tree .e[data-status="kept"]{stroke:var(--c-accent-fg)}
.tree .e[data-status="pruned"]{stroke-opacity:0.4;stroke-dasharray:3 4}
.tree .n{stroke:var(--c-bg);stroke-width:1}
.tree .n[data-status="pruned"]{fill-opacity:0.45}
.tree .n[data-status="kept"]{stroke:var(--c-accent-fg);stroke-width:1.5}
.tree[data-growing] .e,.tree[data-growing] .n{opacity:0}
.tree[data-growing] [data-shown]{opacity:1;transition:opacity 300ms var(--ease)}

/* ── Films. Both carry the annotation rails. The terminal player is text:
   it ships finished, plays back on approach, and every line of it is held
   against the recording by the gate. The web film is one lazy animated
   image below the fold, sized in the markup so its arrival shifts nothing. */
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
.steps{max-width:1060px;margin-left:auto;margin-right:auto}

@media (max-width:880px){
.hero{padding-top:40px}
.stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.duo{grid-template-columns:1fr;gap:28px}
.spec dd{text-align:left}
.spec>div{flex-direction:column;gap:5px}
.tree{padding:16px 0}
.term{max-height:360px;font-size:11px}
.actions .btn{flex:1 1 auto}
}
`;

/** Opening the panel is the only toggle state on the page. */
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
