import { AuthError, authenticateRequest } from './auth/session.js';
import { buildCliInstallCommand } from './cli/install-command.js';
import { publicHtmlHeaders } from './lib/security-headers.js';
import { escapeHtml } from './lib/http.js';

export async function handleLandingRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  try {
    await authenticateRequest(request, env);
    return null;
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) {
      return request.method === 'HEAD' ? new Response(null, landingInit()) : landingResponse(url.origin);
    }
    throw e;
  }
}

function landingResponse(origin: string): Response {
  const installCommand = buildCliInstallCommand({ origin });
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Proteus</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --ink: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.08);
      --accent: #a78bfa;
      --accent-strong: #8b5cf6;
      --accent-soft: rgba(139, 92, 246, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    canvas {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0.42;
    }
    .shell {
      position: relative;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      border-inline: 1px solid var(--line);
      width: min(1180px, calc(100vw - 28px));
      margin: 0 auto;
      background: linear-gradient(90deg, rgba(9, 9, 11, 0.96), rgba(9, 9, 11, 0.86) 58%, rgba(9, 9, 11, 0.38));
    }
    header, footer {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(11, 15, 16, 0.72);
      backdrop-filter: blur(16px);
    }
    footer {
      border-top: 1px solid var(--line);
      border-bottom: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 720;
    }
    .mark {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(79, 215, 188, 0.55);
      border-color: rgba(167, 139, 250, 0.55);
      color: var(--accent);
      font-weight: 780;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    .link {
      color: var(--muted);
      font-size: 14px;
    }
    .button {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(245, 241, 232, 0.22);
      padding: 0 14px;
      background: rgba(245, 241, 232, 0.08);
      font-weight: 660;
      white-space: nowrap;
    }
    .button.primary {
      border-color: rgba(167, 139, 250, 0.62);
      background: var(--accent-soft);
    }
    main {
      display: grid;
      align-items: center;
      min-height: calc(100vh - 128px);
      padding: 80px 24px 56px;
    }
    .hero {
      width: min(880px, 100%);
    }
    .eyebrow {
      color: var(--accent);
      font-size: 13px;
      font-weight: 720;
      text-transform: uppercase;
      margin: 0 0 18px;
    }
    h1 {
      margin: 0;
      font-size: 112px;
      line-height: 0.9;
      font-weight: 780;
      letter-spacing: 0;
    }
    .lede {
      width: min(650px, 100%);
      margin: 26px 0 0;
      color: var(--muted);
      font-size: 20px;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 34px;
    }
    .install-panel[hidden] {
      display: none;
    }
    .install-panel {
      width: min(860px, 100%);
      margin-top: 20px;
      border: 1px solid var(--line);
      background: rgba(7, 10, 11, 0.9);
      padding: 14px;
    }
    .install-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
    }
    code {
      display: block;
      overflow-x: auto;
      white-space: nowrap;
      color: #f4d28a;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .copy {
      min-height: 36px;
      border: 1px solid rgba(245, 241, 232, 0.2);
      background: rgba(245, 241, 232, 0.1);
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
      white-space: nowrap;
    }
    .install-note {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .capabilities {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin-top: 58px;
      border: 1px solid var(--line);
      background: var(--line);
      width: min(860px, 100%);
    }
    .cell {
      min-height: 104px;
      padding: 16px;
      background: rgba(11, 15, 16, 0.84);
    }
    .cell strong {
      display: block;
      font-size: 14px;
      margin-bottom: 6px;
    }
    .cell span {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .workflow {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      width: min(860px, 100%);
      margin-top: 18px;
      border: 1px solid var(--line);
      background: var(--line);
    }
    .workflow article {
      min-height: 126px;
      padding: 18px;
      background: rgba(245, 241, 232, 0.055);
    }
    .workflow h2 {
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 720;
    }
    .workflow p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    @media (max-width: 720px) {
      .shell { width: 100%; border-inline: 0; background: rgba(9, 9, 11, 0.92); }
      header { padding: 0 16px; }
      nav .link { display: none; }
      main { padding: 64px 16px 38px; }
      h1 { font-size: 52px; }
      .lede { font-size: 18px; }
      .capabilities, .workflow { grid-template-columns: 1fr; }
      .install-row { grid-template-columns: 1fr; }
      code { white-space: normal; overflow-wrap: anywhere; }
      .copy { width: 100%; }
      footer { align-items: flex-start; flex-direction: column; padding: 16px; }
    }
    @media (min-width: 721px) and (max-width: 980px) {
      h1 { font-size: 84px; }
    }
  </style>
</head>
<body>
  <canvas id="field" aria-hidden="true"></canvas>
  <div class="shell">
    <header>
      <a class="brand" href="/" aria-label="Proteus home"><span class="mark">P</span><span>Proteus</span></a>
      <nav>
        <a class="link" href="#install" data-install-toggle aria-expanded="false">Install CLI</a>
        <a class="button primary" href="/login">Sign in</a>
      </nav>
    </header>
    <main>
      <section class="hero" aria-labelledby="hero-title">
        <p class="eyebrow">Persistent agents for serious work</p>
        <h1 id="hero-title">Proteus</h1>
        <p class="lede">Create AI agents that keep state across sessions, work from the dashboard or terminal, and use your computer as the execution surface when local access matters.</p>
        <div class="actions">
          <a class="button primary" href="/login">Sign in</a>
          <a class="button" href="#install" data-install-toggle aria-expanded="false">Install CLI</a>
        </div>
        <div id="install" class="install-panel" hidden>
          <div class="install-row">
            <code id="landing-install-command">${escapeHtml(installCommand)}</code>
            <button class="copy" type="button" data-copy-install>Copy command</button>
          </div>
          <p class="install-note">Run it in a terminal. The installer sets up the CLI and starts the browser sign-in flow.</p>
        </div>
        <div class="capabilities" aria-label="Proteus capabilities">
          <div class="cell"><strong>Cloud persistence</strong><span>Agents live beyond a browser tab with durable memory, background work, and event-driven triggers.</span></div>
          <div class="cell"><strong>Local backend</strong><span>Run fully local agents from the CLI with the same core runtime contracts as cloud agents.</span></div>
          <div class="cell"><strong>Desktop execution</strong><span>Connect your machine so agents can operate on real files, commands, and local development workflows.</span></div>
        </div>
        <div class="workflow" aria-label="Ways to work with Proteus">
          <article>
            <h2>Dashboard for persistent agents</h2>
            <p>Use the web app for long-running agents, settings, credentials, triggers, product-change review, and workspace state.</p>
          </article>
          <article>
            <h2>CLI for daily work</h2>
            <p>Create agents, choose cloud or local mode, assign aliases, and call the same agent from any directory.</p>
          </article>
        </div>
      </section>
    </main>
    <footer>
      <span>Proteus</span>
      <span>Durable agents, local execution, and user-controlled automation.</span>
    </footer>
  </div>
  <script>
    const canvas = document.getElementById('field');
    const ctx = canvas.getContext('2d');
    const colors = ['#a78bfa', '#14b8a6', '#d29922', '#f85149'];
    let nodes = [];
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(innerWidth * dpr);
      canvas.height = Math.floor(innerHeight * dpr);
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(26, Math.min(58, Math.floor(innerWidth / 24)));
      nodes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        c: colors[i % colors.length],
      }));
    }
    function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, innerWidth, innerHeight);
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = innerWidth + 20;
        if (n.x > innerWidth + 20) n.x = -20;
        if (n.y < -20) n.y = innerHeight + 20;
        if (n.y > innerHeight + 20) n.y = -20;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < 170) {
            ctx.globalAlpha = (1 - d / 170) * 0.22;
            ctx.strokeStyle = a.c;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      for (const n of nodes) {
        ctx.fillStyle = n.c;
        ctx.fillRect(n.x - 2, n.y - 2, 4, 4);
      }
      requestAnimationFrame(tick);
    }
    addEventListener('resize', resize, { passive: true });
    resize();
    tick();

    const installPanel = document.getElementById('install');
    const installCode = document.getElementById('landing-install-command');
    const installToggles = Array.from(document.querySelectorAll('[data-install-toggle]'));
    const copyInstall = document.querySelector('[data-copy-install]');

    function openInstallPanel() {
      if (!installPanel) return;
      installPanel.hidden = false;
      for (const toggle of installToggles) toggle.setAttribute('aria-expanded', 'true');
      installPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    for (const toggle of installToggles) {
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        openInstallPanel();
      });
    }

    if (copyInstall && installCode) {
      copyInstall.addEventListener('click', async () => {
        await navigator.clipboard.writeText(installCode.textContent || '');
        const previous = copyInstall.textContent;
        copyInstall.textContent = 'Copied';
        window.setTimeout(() => { copyInstall.textContent = previous; }, 1200);
      });
    }
  </script>
</body>
</html>`, landingInit());
}

function landingInit(): ResponseInit {
  return {
    headers: publicHtmlHeaders(),
  };
}
