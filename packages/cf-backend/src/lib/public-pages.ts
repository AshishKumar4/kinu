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
  COPY_SCRIPT, GITHUB_ICON, REPO_URL, mark, publicFooter, publicPage,
} from './public-shell';


/* ── Sign-in, and the pages the OAuth flow can fail to ───────────────── */

export interface LoginProvider {
  /** Where "Continue with …" goes, already escaped for an attribute. */
  readonly href: string;
  readonly label: string;
}

/** Sign-in is one decision: choose a configured provider. */
export function loginDocument(providers: readonly LoginProvider[]): string {
  const body = providers.length === 0
    ? '<p class="lede">Sign-in is unavailable.</p>'
    : `<div class="providers">${providers.map((provider) => (
      `<a class="provider" href="${provider.href}">Continue with ${escapeHtml(provider.label)}</a>`
    )).join('')}</div>`;
  return authDocument('Sign in to Kinu.run', body);
}

/** Sign-in, and its two failures, on one card. */
export function authDocument(title: string, body: string): string {
  return publicPage({
    title: title.includes('Kinu') ? title : `${title} — Kinu.run`,
    styles: CARD_CSS,
    nav: `<a class="quiet" href="/install">Install CLI</a><a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a>`,
    body: `<main class="gate"><section class="card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
  <a class="modal-close" href="/" aria-label="Close sign in">×</a>
  <h1 id="auth-title">${escapeHtml(title)}</h1>
  ${body}
</section></main>\n`,
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
.page:has(.gate){width:100%;max-width:none;border-inline:0;background:var(--c-bg)}
.gate{position:relative;isolation:isolate;flex:1;display:flex;align-items:flex-start;justify-content:center;
overflow:hidden;padding:clamp(64px,13vh,140px) 24px 96px}
.gate::before{content:"";position:absolute;z-index:-1;inset:0;
background:radial-gradient(circle at 50% 22%,var(--c-accent-subtle),transparent 36%)}
.card{position:relative;width:min(500px,100%);padding:32px;border:var(--rule);
border-radius:var(--r-card);background:var(--c-surface);box-shadow:var(--shadow-overlay)}
.card h1{margin:0;padding-right:34px;font-size:32px;letter-spacing:-0.025em;max-width:none}
.card h1.small{font-size:23px;letter-spacing:-0.015em}
.card .lede{margin:16px 0 0;font-size:15px;max-width:none}
.card p{margin:16px 0 0;color:var(--c-text-2);font-size:15px}
.card .muted{color:var(--c-text-3);font-size:13px}
.card code{overflow-wrap:anywhere}
.modal-close{position:absolute;top:16px;right:16px;display:flex;align-items:center;
justify-content:center;width:30px;height:30px;border-radius:var(--r-row);color:var(--c-text-3);
font-size:22px;line-height:1}
.modal-close:hover{background:var(--c-fill);color:var(--c-text)}
.providers{display:grid;gap:12px;margin-top:26px}
.provider{display:flex;align-items:center;justify-content:space-between;gap:12px;
min-height:48px;padding:0 17px;border:1px solid var(--c-input-border);border-radius:var(--r-row);
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
@media(max-width:600px){
.gate{padding:48px 18px 72px}
.card{padding:24px}
.card h1{font-size:28px}
}
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
    <p class="dim">Add <code>--no-setup</code> for a script-only install with no sign-in and no local setup.</p>
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
