/**
 * The owner's landing page, as React components.
 *
 * Source of truth: ~/kinu-landing-design/"Kinu Landing Page.dc.html", ported
 * section for section with his copy verbatim and his inline styles carried
 * over value-for-value. Two systematic changes, neither visual:
 *
 *   · every colour reads a `--c-*` token instead of a hex literal, so the
 *     page follows the palette both faces share (his dark values are the
 *     tokens' source; light mode re-points them);
 *   · hover states move from the artifact's `style-hover` attribute into
 *     classes in `LANDING_CSS`, which is also where the responsive rules
 *     live — the artifact is desktop-only by construction.
 *
 * Rendered once at build time (`scripts/prerender-landing.ts`) into
 * `landing-body.generated.ts`; the Worker serves that string. No React on
 * the wire: behaviour ships as CSP-safe inline scripts from
 * `lib/landing-scripts.ts`, the same way round every signed-out page uses.
 */

import type { CSSProperties, ReactElement } from 'react';

import { PLATFORM_CATALOG } from '@kinu.run/core';

/** The storage quota the self-host cells quote, read off the catalog rather
 *  than retyped — the platform gate refuses a second copy of the number.
 *  The value is bytes; the page speaks his decimal GB. */
const STORAGE_GB = PLATFORM_CATALOG['do.storage.bytes'].limit.value / 1e9;

const MONO = 'var(--font-mono)';
const DIM = 'var(--c-text-2)';
const FAINT = 'var(--c-text-3)';
const CODE_INK = 'var(--c-text)';

export const HERO_PHRASES = [
  'get better with use.',
  'craft their own tools.',
  'command scored swarms.',
  'work while you sleep.',
  'improve their prompts.',
  'run cloud, or local.',
] as const;

/** His label voice, as shared objects — the values are his, verbatim. */
const s = {
  eyebrow: { fontFamily: MONO, fontSize: 12, letterSpacing: '.22em', color: 'var(--c-accent)', marginBottom: 24 } satisfies CSSProperties,
  h1: { fontWeight: 600, fontSize: 'clamp(34px, 4.5vw, 58px)', lineHeight: 1.04, letterSpacing: '-.03em', margin: '0 0 24px 0', textWrap: 'pretty' } satisfies CSSProperties,
  h2: { margin: '20px 0 16px 0', maxWidth: 780 },
  lede: { fontSize: 17, lineHeight: 1.65, color: DIM, marginBottom: 48, textWrap: 'pretty' } satisfies CSSProperties,
  cellKey: { fontSize: 11, letterSpacing: '.16em', marginBottom: 12 },
  glow: { position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 45% at 50% 118%, color-mix(in srgb, var(--c-accent-fg) 18%, transparent), transparent 70%)', pointerEvents: 'none' } satisfies CSSProperties,
  dotField: { position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(color-mix(in srgb, var(--c-text) 4.5%, transparent) 1px, transparent 1px)', backgroundSize: '18px 18px', pointerEvents: 'none' } satisfies CSSProperties,
} satisfies Record<string, CSSProperties>;

function Tick({ corner }: { corner: 'tl' | 'br' | 'tr' | 'bl' }): ReactElement {
  return <i className={`cx ${corner}`} />;
}

/* ── Hero ──────────────────────────────────────────────────────────────── */

function HeroLeft({ install }: { install: string }): ReactElement {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 24 }}>THE SELF-EVOLVING AGENT PLATFORM</div>
      <h1 style={s.h1}>
        {'Agents that '}
        <span data-typewriter style={{ display: 'block', height: '1.08em', whiteSpace: 'nowrap', color: 'var(--c-accent)' }}>
          {HERO_PHRASES[0]}
          <span data-caret aria-hidden="true" className="caret" />
        </span>
      </h1>
      <p className="lede hero-lede" style={{ margin: '0 0 34px 0', maxWidth: 540 }}>
        Persistent workspaces with files, sessions, and memory. Hosted on Cloudflare, so tasks
        keep running after you close the laptop — or fully native on your machine, in the
        terminal or your editor.
      </p>
      <div className="cmd hero-install" style={{ maxWidth: 560 }}>
        <Tick corner="tl" />
        <Tick corner="br" />
        <code><span className="dollar">$</span> {install}</code>
        <button className="copy" type="button" data-copy="landing-install-command">COPY</button>
      </div>
      <div id="landing-install-command" hidden>{install}</div>
      <div style={{ display: 'flex', gap: 18, marginTop: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href="/login" className="btn solid">TRY CLOUD AGENTS →</a>
        <a href="#deploy" className="btn">DEPLOY YOUR OWN</a>
        <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>MIT · open source</span>
      </div>
    </div>
  );
}

const TABS = ['optimise', 'research', 'ideate'] as const;

function HeroRight(): ReactElement {
  return (
    <div className="hero-fig" style={{ position: 'relative', padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <div data-hero-tabs style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: FAINT }}>FIG.01</span>
          {TABS.map((m, at) => (
            <span
              key={m}
              role="button"
              tabIndex={0}
              data-mode={m}
              data-active={at === 0 ? '' : undefined}
              style={{
                fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', cursor: 'pointer',
                textTransform: 'uppercase',
                borderBottom: at === 0 ? '1px solid color-mix(in srgb, var(--c-accent) 50%, transparent)' : '1px solid transparent',
                paddingBottom: 2,
              }}
            >
              {m}
            </span>
          ))}
        </div>
        <span data-hero-status style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: 'var(--c-accent)' }} />
      </div>
      {/* MotionRedesign2 owns this figure's data module; until it lands the
          owner's own procedural canvas ships, driven by HERO_TREE_SCRIPT. */}
      <canvas id="hero-tree" width={1120} height={880} style={{ width: '100%', height: 'auto', display: 'block' }} />
    </div>
  );
}

function ClaimStrip(): ReactElement {
  const claims: ReadonlyArray<readonly [k: string, body: string]> = [
    ['LEARNS FROM USE', 'Every turn is graded against your next message. Lessons that later turns confirm persist.'],
    ['CRAFTS ITS OWN TOOLS', 'Recurring patterns become tools it builds, scores, and calls on its own.'],
    ['COMMANDS AGENT SWARMS', 'A hard task forks a scored tree of whole agents. The best attempt wins.'],
    ['YOUR CLOUD OR YOURS ALONE', 'Run it on kinu.run today, or deploy the same Worker into your own account.'],
  ];
  return (
    <div className="grid four claims">
      {claims.map(([k, body]) => (
        <div className="claim" key={k}>
          <div className="stat-k">{k}</div>
          <p>{body}</p>
        </div>
      ))}
    </div>
  );
}

function Hero({ install }: { install: string }): ReactElement {
  return (
    <div id="top" className="hero-wrap">
      <div className="dots hero-dots-left" />
      <div className="dots hero-dots-right" />
      <div className="hero-panel">
        <Tick corner="tl" />
        <div style={s.glow} />
        <div style={s.dotField} />
        <div className="hero-grid">
          <HeroLeft install={install} />
          <HeroRight />
        </div>
      </div>
      <ClaimStrip />
    </div>
  );
}

/* ── § 01 THE PLATFORM ─────────────────────────────────────────────────── */

function Platform(): ReactElement {
  return (
    <section id="platform" className="section">
      <div className="label">§ 01&nbsp;&nbsp;THE PLATFORM</div>
      <h2 style={{ ...s.h2, marginTop: 20 }}>
        Close the laptop. <span className="gold">The agent keeps working.</span>
      </h2>
      <p className="lede" style={{ ...s.lede, maxWidth: 660 }}>
        Kinu is a cloud-native agent platform on Cloudflare — workspaces and sandboxes are
        hosted, so a task you start keeps running after you close the browser. And the same agent
        runs fully native on your own machine.
      </p>
      <div className="g two">
        <div className="panel pad-32">
          <Tick corner="tl" />
          <div className="key" style={{ ...s.cellKey, marginBottom: 14 }}>IN THE CLOUD</div>
          <h3>Hosted workspaces and sandboxes</h3>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: DIM, marginTop: 12 }}>
            Start a task, shut your computer, come back to the result. Agents live in Durable
            Objects and keep working in the background — schedules, webhooks, and email reach
            them while you're away.
          </p>
        </div>
        <div className="panel pad-32">
          <Tick corner="br" />
          <div className="key" style={{ ...s.cellKey, marginBottom: 14 }}>ON YOUR MACHINE</div>
          <h3>TUI, CLI, or your editor</h3>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: DIM, marginTop: 12 }}>
            Run it fully native and local: a full-screen TUI, a one-shot CLI, or inside your
            editor over ACP. The TUI also connects to your cloud agents — the terminal replaces
            the web UI whenever you prefer it.
          </p>
        </div>
      </div>
      <div className="core-bar">ONE BACKEND-AGNOSTIC CORE RUNS BOTH</div>
      <div className="grid three hovers">
        <div>
          <div className="key" style={s.cellKey}>RESEARCH, OVERNIGHT</div>
          <p>Hand it a question in the evening. The brief, with sources, is waiting in the morning.</p>
        </div>
        <div>
          <div className="key" style={s.cellKey}>PRS REVIEWED IN THE BACKGROUND</div>
          <p>A webhook wakes the agent on every pull request. The review is posted by the time you look.</p>
        </div>
        <div>
          <div className="key" style={s.cellKey}>PRS CREATED WHILE YOU'RE AWAY</div>
          <p>Describe the change. The agent branches, builds, tests, and opens the pull request.</p>
        </div>
      </div>
    </section>
  );
}

/* ── § 02 QUICKSTART ───────────────────────────────────────────────────── */

function Quickstart({ install }: { install: string }): ReactElement {
  return (
    <section id="quickstart" className="section ruled-top">
      <div className="label">§ 02&nbsp;&nbsp;QUICKSTART</div>
      <h2 style={{ ...s.h2, marginTop: 20, maxWidth: 800 }}>
        Start in the cloud, <span className="gold">or entirely on your own machines.</span>
      </h2>
      <p className="lede" style={{ ...s.lede, maxWidth: 620 }}>
        Both are the same core. Reach one workspace from the web app, the TUI, or the CLI.
      </p>
      <div className="g three">
        <div className="panel qs-card">
          <Tick corner="tl" />
          <div className="num">IN THE BROWSER</div>
          <h3>Web</h3>
          <p className="qs-body">
            Sign in and create a workspace. Nothing to install, and the same workspace opens from
            every client.
          </p>
          <a className="inline-link" href="/login">SIGN IN →</a>
          <div className="glimpse" data-glimpse="web" />
        </div>
        <div className="panel qs-card">
          <div className="num">IN THE TERMINAL</div>
          <h3>TUI</h3>
          <p className="qs-body">
            <code style={{ color: CODE_INK, fontSize: 12 }}>kinu chat</code> opens the full-screen
            app: pick a workspace, talk, and watch it work.
          </p>
          <div className="mini-cmd"><span className="dollar">$</span> kinu chat triage</div>
          <div className="glimpse" data-glimpse="tui" />
        </div>
        <div className="panel qs-card">
          <Tick corner="br" />
          <div className="num">IN THE TERMINAL</div>
          <h3>CLI</h3>
          <p className="qs-body">
            One command installs kinu on macOS or Linux. Create a workspace, then hand it a task.
          </p>
          <div className="mini-cmd multi">
            <span className="dollar">$</span> {install}<br />
            <span className="dollar">$</span> kinu create triage
          </div>
          <div className="glimpse" data-glimpse="cli" />
        </div>
      </div>
      <p className="dim" style={{ marginTop: 28 }}>
        A workspace created anywhere opens from the others, with its files, sessions, and search
        history intact.
      </p>
    </section>
  );
}

/* ── § 03 CLIENTS ──────────────────────────────────────────────────────── */

function Clients({ cliFilm }: { cliFilm: string }): ReactElement {
  return (
    <section id="clients" className="section ruled-top">
      <div className="label">§ 03&nbsp;&nbsp;ONE WORKSPACE, EVERY CLIENT</div>
      <h2 style={{ ...s.h2, marginTop: 20, maxWidth: 820 }}>
        Work from the browser, the terminal, <span className="gold">your editor, or email.</span>
      </h2>
      <p className="lede" style={{ ...s.lede, maxWidth: 660 }}>
        Every client opens the same workspace, with the same files and history. Start a run at
        your desk, check it over SSH from the terminal, read the result in your editor.
      </p>
      <div className="grid four hovers">
        <div>
          <div className="key" style={s.cellKey}>THE BROWSER</div>
          <p>kinu.run shows your workspaces: files, sessions, and every search they have run.</p>
        </div>
        <div>
          <div className="key" style={s.cellKey}>THE TERMINAL</div>
          <p>
            <code style={{ color: CODE_INK, fontSize: 12 }}>kinu chat</code> opens a conversation.{' '}
            <code style={{ color: CODE_INK, fontSize: 12 }}>kinu run</code> executes one task and
            exits, for scripts and CI.
          </p>
        </div>
        <div>
          <div className="key" style={s.cellKey}>YOUR EDITOR</div>
          <p>
            <code style={{ color: CODE_INK, fontSize: 12 }}>kinu acp</code> speaks the Agent
            Client Protocol, so editors like Zed can drive a workspace from a panel.
          </p>
        </div>
        <div>
          <div className="key" style={s.cellKey}>EMAIL</div>
          <p>
            Each workspace has an email address. Mail to it starts a turn, and the reply arrives
            on the same thread. Not yet enabled on kinu.run.
          </p>
        </div>
      </div>
      {/* The recorded CLI film is generated markup from lib/cli-film — a
          projection of a recording, not authored JSX. */}
      <div dangerouslySetInnerHTML={{ __html: cliFilm }} />
      <div className="duo prev-duo">
        <TuiPreview />
        <WorkspacePreview />
      </div>
      <p className="dim" style={{ marginTop: 28 }}>
        Schedules, webhooks, and finished background jobs start turns the same way.
      </p>
    </section>
  );
}

function TuiPreview(): ReactElement {
  const lines: ReadonlyArray<readonly [kind: string, text: ReactElement]> = [
    ['cmd', <><span className="dollar">$</span> kinu chat triage</>],
    ['say', <>Reading the repo and timing every test file.</>],
    ['tool', <>run · laptop <span style={{ color: FAINT }}>time bun test</span></>],
    ['out', <>7 pass · 912 ms total</>],
    ['say', <>Slowest: summary.test.ts (~864 ms). dedupe is O(n²) — a Map keyed by id makes it linear.</>],
  ];
  return (
    <figure className="film tui-preview" data-preview="tui">
      <div className="anno ruled"><span>FIG.04 · TUI · INTERACTIVE</span><span>KINU CHAT · LIVE PREVIEW</span></div>
      <pre className="term" data-beats={String(lines.length + 1)}>
        {lines.map(([kind, text], i) => (
          <span className="line" data-kind={kind} data-beat={i} key={i}>{text}</span>
        ))}
        <span className="line" data-kind="status" data-beat={lines.length}>● swarm ready · 3 branches idle</span>
      </pre>
    </figure>
  );
}

function WorkspacePreview(): ReactElement {
  return (
    <figure className="film ws-preview" data-preview="ws">
      <div className="anno ruled"><span>FIG.05 · WORKSPACE · INTERACTIVE</span><span>WEB APP · SAME TOKENS</span></div>
      <div className="ws">
        <div className="ws-rail">
          <div className="ws-item active">triage</div>
          <div className="ws-item">research</div>
          <div className="ws-item">site-reliability</div>
        </div>
        <div className="ws-main">
          <div className="ws-bubble" data-beat="0">Find the slowest test in this repo and explain why.</div>
          <div className="ws-tool" data-beat="1"><span className="key">▸ run</span> time bun test <span className="metric">7 pass · 912 ms</span></div>
          <div className="ws-tool" data-beat="2"><span className="key">▸ run</span> bun test tests/summary.test.ts <span className="metric">864 ms</span></div>
          <div className="ws-say" data-beat="3">Slowest: summary.test.ts (~864 ms of 912). dedupe is O(n²); a Map keyed by id makes it one pass.</div>
          <div className="ws-job" data-beat="4"><span className="stat-k">JOB</span> detached · wakes when settled</div>
          <div className="ws-inspector" data-beat="5">
            <div className="fig">INSPECTOR</div>
            <div>src/dedupe.ts <span className="metric">O(n²)</span></div>
            <div>tests/summary.test.ts <span className="metric">864 ms</span></div>
          </div>
        </div>
      </div>
    </figure>
  );
}

/* ── § 04 SELF-EVOLUTION ───────────────────────────────────────────────── */

function Evolution(): ReactElement {
  const clocks: ReadonlyArray<readonly [kicker: string, title: string, body: ReactElement]> = [
    ['PER STEP · EVERY SETTLED TOOL CALL', 'TOOL FITNESS', <>Crafted tools are scored every time they run. Tools that keep failing drop out of the callable set mid-run.</>],
    ['PER TURN · THE NEXT MESSAGE', 'TURN REVIEW', <>Each turn is graded against your next message. A lesson persists only when later turns corroborate it.</>],
    ['PER SESSION · EVERY FIVE TURNS', 'CONSOLIDATION', <>Recurring patterns become reusable tools, and the agent can propose changes to its own loop. Proposals pass four structural gates and a shadow eval before they land.</>],
    [
      'PER LIFETIME · EVERY FIVE WINDOWS',
      'RETIREMENT AND SEARCH',
      <>Tool scores decay with time, and low scores retire the tool.{' '}<code style={{ color: CODE_INK, fontSize: 12 }}>kinu evolve</code> searches over the loop itself, scored on graded turns.</>,
    ],
  ];
  return (
    <section id="evolution" className="section ruled-top">
      <div className="label">§ 04&nbsp;&nbsp;SELF-EVOLUTION</div>
      <h2 style={{ ...s.h2, marginTop: 20, maxWidth: 760 }}>
        Evolution <span className="gold">on four timescales.</span>
      </h2>
      <p className="lede" style={{ ...s.lede, maxWidth: 640 }}>
        The shorter clocks feed the longer ones. None of it needs your upkeep: scoring,
        consolidation, and retirement run inside the workspace.
      </p>
      <div className="grid four">
        {clocks.map(([kicker, title, body]) => (
          <div key={title}>
            <div className="num" style={{ marginBottom: 16 }}>{kicker}</div>
            <div className="key" style={{ ...s.cellKey, marginBottom: 10 }}>{title}</div>
            <p>{body}</p>
          </div>
        ))}
      </div>
      <p className="dim" style={{ marginTop: 28 }}>
        Execution evidence feeds tool selection only. Nothing wider is promoted on it.
      </p>
    </section>
  );
}

/* ── § 05 THE TREE OF AGENTS ───────────────────────────────────────────── */

function Swarm(): ReactElement {
  return (
    <section id="swarm" className="section ruled-top">
      <div className="label">§ 05&nbsp;&nbsp;THE TREE OF AGENTS</div>
      <div className="duo" style={{ margin: '20px 0 52px 0' }}>
        <div>
          <h2 style={{ marginBottom: 16 }}>
            Run one task <span className="gold">as a tree of agents.</span>
          </h2>
          <p className="lede left" style={{ marginBottom: 14 }}>
            One tool call builds the tree. Each node is a whole agent that attempts the task its
            own way, in its own directory, with its own credential. Weak branches are pruned
            mid-run, and the winner answers.
          </p>
          <p className="lede left" style={{ marginBottom: 14 }}>
            The agent turns your ask into an objective: a metric, a target, and a verifier. A
            verifier is code that runs in the workspace, and its number picks the winner.
          </p>
          <p className="lede left">
            What you get back is the winner plus the record: every branch, its score, and the
            verifier number behind each pick. Results persist per objective, so the next search
            starts from the record instead of from zero.
          </p>
        </div>
        <div className="well" style={{ padding: '24px 28px' }}>
          <Tick corner="tr" />
          <div className="fig" style={{ marginBottom: 16 }}>FIG.03 · ONE CALL</div>
          <div style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.9, color: DIM }}>
            agents({'{'}
            <br />
            &nbsp;&nbsp;action: <span style={{ color: 'var(--c-accent-fg)' }}>'swarm'</span>, preset:{' '}
            <span style={{ color: 'var(--c-accent-fg)' }}>'optimise'</span>,
            <br />
            &nbsp;&nbsp;task: <span style={{ color: 'var(--c-accent-fg)' }}>'make the p95 faster'</span>,
            <br />
            &nbsp;&nbsp;objective: {'{'}
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;metric: <span style={{ color: 'var(--c-accent-fg)' }}>'p95_latency'</span>, unit:{' '}
            <span style={{ color: 'var(--c-accent-fg)' }}>'ms'</span>,
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;direction: <span style={{ color: 'var(--c-accent-fg)' }}>'down'</span>, target:{' '}
            <span style={{ color: 'var(--c-success)' }}>120</span>,
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;verifier: <span style={{ color: 'var(--c-accent)' }}>'bench.p95'</span>{' '}
            <span style={{ color: FAINT }}>// code, not a judge</span>
            <br />
            &nbsp;&nbsp;{'}'}
            <br />
            {'})'}
          </div>
          <div style={{ borderTop: '1px dashed var(--c-border-strong)', marginTop: 18, paddingTop: 14, fontFamily: MONO, fontSize: 11, lineHeight: 1.9, color: FAINT }}>
            The shape follows the scenario: <span style={{ color: 'var(--c-accent)' }}>ideate</span> fans flat,{' '}
            <span style={{ color: 'var(--c-accent)' }}>optimise</span> climbs with UCT,{' '}
            <span style={{ color: 'var(--c-accent)' }}>prove</span> goes deepest,{' '}
            <span style={{ color: 'var(--c-accent)' }}>research · audit · redteam</span> cover a scored grid.
          </div>
        </div>
      </div>
      <p className="dim">The tree in the hero is the repo's own search — switch its tabs to see each preset's shape.</p>
    </section>
  );
}

/* ── § 06 SELF-HOST ────────────────────────────────────────────────────── */

function Deploy({ repoUrl }: { repoUrl: string }): ReactElement {
  const deployUrl = `https://deploy.workers.cloudflare.com/?url=${repoUrl}`;
  const guideUrl = `${repoUrl}/blob/main/docs/SELF-HOSTING.md`;
  const steps: ReadonlyArray<readonly [step: string, body: ReactElement, cmd: string]> = [
    ['STEP ONE', <><b>Bring the account.</b> Workers Paid plan, a zone, a wrangler login. Provisioning prints everything it cannot create for you.</>, 'bun run infra:provision'],
    ['STEP TWO', <><b>Deploy, then provision again.</b> The deploy ships the Worker, its Durable Objects and its container. Secrets install on a Worker that exists.</>, 'bun run deploy'],
    ['STEP THREE', <><b>Prove the account.</b> The infra gate checks every declared resource exists and the deployed Worker is bound to it. It exits non-zero when one is not.</>, 'bun run gate:infra'],
  ];
  const values: ReadonlyArray<readonly [title: string, body: string]> = [
    ['UNLIMITED WORKSPACES', 'Workspaces are Durable Objects: nothing bills while they sit idle — you pay for what runs and what you store.'],
    [`${STORAGE_GB} GB PER WORKSPACE`, `Every workspace keeps its own durable file plane — files, shell state, runtimes — on SQLite-backed storage (${STORAGE_GB} GB on Workers Paid, platform-catalog do.storage.bytes).`],
    ['TRUE LINUX ON DEMAND', 'When an agent needs one, it attaches a full Linux sandbox on Cloudflare Containers.'],
    ['YOUR OWN DEVICES', 'Connect your PC and your agents can use it too — every access behind your consent.'],
  ];
  return (
    <section id="deploy" className="section ruled-top">
      <div className="label">§ 06&nbsp;&nbsp;SELF-HOST</div>
      <div className="duo">
        <div>
          <h2 style={{ marginBottom: 16 }}>
            Host Kinu agents <span className="gold">yourself.</span>
          </h2>
          <p className="lede left" style={{ marginBottom: 32 }}>
            The whole cloud platform deploys into your own Cloudflare account, backed by Durable
            Objects. Your agents, files, and model spend stay with you.
          </p>
          <div className="actions start">
            <a className="btn solid" href={deployUrl} target="_blank" rel="noopener noreferrer">DEPLOY TO CLOUDFLARE →</a>
            <a className="btn" href={guideUrl} target="_blank" rel="noopener noreferrer">SELF-HOSTING GUIDE</a>
          </div>
        </div>
        <div className="rows">
          {steps.map(([step, body, cmd]) => (
            <div className="row" key={step}>
              <div className="fig">{step}</div>
              <p>{body}</p>
              <div className="metric">{cmd}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid four" style={{ marginTop: 24 }}>
        {values.map(([title, body]) => (
          <div key={title}>
            <div className="key" style={s.cellKey}>{title}</div>
            <p>{body}</p>
          </div>
        ))}
      </div>
      <p className="dim" style={{ marginTop: 28, maxWidth: 900 }}>
        When the infra gate passes, the Worker serving your requests is the same one kinu.run runs.
      </p>
    </section>
  );
}

/* ── § 07 OPEN SOURCE ──────────────────────────────────────────────────── */

function OpenSource({ repoUrl }: { repoUrl: string }): ReactElement {
  const docs: ReadonlyArray<readonly [label: string, file: string]> = [
    ['architecture', 'ARCHITECTURE.md'],
    ['exploration', 'EXPLORATION.md'],
    ['evolution', 'EVOLUTION.md'],
    ['deployment', 'DEPLOYMENT.md'],
  ];
  return (
    <section id="cta" className="cta-band">
      <div className="duo cta-grid">
        <div>
          <div className="label">§ 07&nbsp;&nbsp;OPEN SOURCE</div>
          <h2 style={{ margin: '20px 0 18px 0' }}>
            Open source, <span className="gold">end to end.</span>
          </h2>
          <p className="lede left" style={{ maxWidth: 520, marginBottom: 36 }}>
            MIT-licensed — the agent, both backends, and the CLI.
          </p>
          <div className="actions start">
            <a className="btn solid" href={repoUrl} target="_blank" rel="noopener noreferrer">READ THE SOURCE →</a>
            <a className="btn" href="/login">TRY CLOUD AGENTS</a>
          </div>
        </div>
        <div className="well spec-well">
          <Tick corner="tl" />
          <Tick corner="br" />
          <div className="spec-row"><div className="fig">LICENCE</div><div style={{ fontFamily: MONO, fontSize: 12 }}>MIT</div></div>
          <div className="spec-row"><div className="fig">SOURCE</div><div style={{ fontFamily: MONO, fontSize: 12 }}><a href={repoUrl} target="_blank" rel="noopener noreferrer">github.com/AshishKumar4/kinu</a></div></div>
          <div className="spec-row"><div className="fig">BACKENDS</div><div style={{ fontFamily: MONO, fontSize: 12 }}>Cloudflare Workers · POSIX</div></div>
          <div className="spec-row last"><div className="fig">DOCS</div>
            <div style={{ fontFamily: MONO, fontSize: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {docs.map(([label, file]) => (
                <a key={file} href={`${repoUrl}/blob/main/docs/${file}`} target="_blank" rel="noopener noreferrer">{label}</a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The landing, as one component. `install` is the command for THIS origin,
 *  so a preview deployment shows its own; `cliFilm` is the recorded terminal
 *  figure the clients section mounts. */
export function Landing({ install, cliFilm }: { install: string; cliFilm: string }): ReactElement {
  const repoUrl = 'https://github.com/AshishKumar4/kinu';
  return (
    <>
      <Hero install={install} />
      <Platform />
      <Quickstart install={install} />
      <Clients cliFilm={cliFilm} />
      <Evolution />
      <Swarm />
      <Deploy repoUrl={repoUrl} />
      <OpenSource repoUrl={repoUrl} />
    </>
  );
}
