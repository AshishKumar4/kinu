/** Every signed-out page, kept together so copy is reviewable and pages are pure for tests. */

import { escapeHtml } from './http';
import {
  COPY_SCRIPT, GITHUB_ICON, REPO_URL, mark, publicFooter, publicPage,
} from './public-shell';


export interface LoginProvider {
  /** Already escaped for an attribute. */
  readonly href: string;
  readonly label: string;
}

/** Built-in sign-in, offered where no OAuth app is configured (`auth/builtin.ts`). */
export interface BuiltinSignIn {
  /** `setup`: no owner and no setup token, so no form. */
  readonly mode: 'owner' | 'invite' | 'reset' | 'sign-in' | 'setup';
  readonly reset?: string;
  /** `invite` mode: the token, and the one address it admits. */
  readonly invite?: string;
  readonly email?: string;
  /** Replaces the mode's own line. */
  readonly notice?: string;
  readonly returnTo: string;
}

export function loginDocument(providers: readonly LoginProvider[], builtin: BuiltinSignIn | null = null): string {
  if (builtin !== null) return authDocument('Sign in to Kinu.run', builtinBody(builtin), builtin.mode === 'setup' ? undefined : BUILTIN_SCRIPT);

  const body = providers.length === 0
    ? '<p class="lede">Sign-in is unavailable.</p><p>This deployment declares an OAuth provider whose client id or secret is missing, so no one can sign in until it is fixed. Built-in sign-in stays off while any provider is declared.</p><div class="providers"><a class="provider" href="/install">Run Kinu locally</a></div>'
    : `<div class="providers">${providers.map((provider) => (
      `<a class="provider" href="${provider.href}">Continue with ${escapeHtml(provider.label)}</a>`
    )).join('')}</div>`;

  return authDocument('Sign in to Kinu.run', body);
}

const BUILTIN_COPY = {
  owner: {
    lede: 'Create the first account. It becomes the owner of this deployment. Enter the setup token its deployer set.',
    password: 'Create account', passkey: 'Create account with a passkey',
  },
  invite: { lede: 'You were invited. Create your account for this address.', password: 'Create account', passkey: 'Create account with a passkey' },
  reset: {
    lede: 'Set a new password or register a new passkey. It replaces this account\'s old ones and signs it out everywhere.',
    password: 'Set new password', passkey: 'Register a new passkey',
  },
  'sign-in': { lede: null, password: 'Sign in', passkey: 'Sign in with a passkey' },
  setup: { lede: null, password: '', passkey: '' },
} as const;

const SETUP_FIELD = '<label>Setup token<input type="password" name="setup" autocomplete="off" required /></label>';

const OWNER_RECOVERY = `<details class="recovery">
    <summary>Set up or recover the owner</summary>
    <form id="owner-recovery" class="fields" novalidate>
      <p class="muted">The setup token replaces the owner's password and passkeys and signs the owner out everywhere.</p>
      ${SETUP_FIELD}
      <label>New password<input type="password" name="password" autocomplete="new-password" minlength="10" aria-describedby="recovery-rule" /></label>
      <p id="recovery-rule" class="muted">At least 10 characters, or register a passkey instead.</p>
      <button type="submit">Set the owner's password</button>
      <button type="button" class="provider" id="recovery-passkey">Register a new owner passkey</button>
    </form>
  </details>`;

function builtinBody({ mode, invite, reset, email, notice, returnTo }: BuiltinSignIn): string {
  const copy = BUILTIN_COPY[mode];
  const registering = mode !== 'sign-in';
  const lede = notice ?? copy.lede;

  if (mode === 'setup') return `<p class="lede">${escapeHtml(lede ?? '')}</p>`;

  return `${lede === null ? '' : `<p class="lede">${escapeHtml(lede)}</p>`}
  <form id="builtin-sign-in" class="fields" data-mode="${registering ? 'register' : 'sign-in'}" data-return-to="${escapeHtml(returnTo)}" data-invite="${escapeHtml(invite ?? '')}" data-reset="${escapeHtml(reset ?? '')}" data-resetting="${mode === 'reset' ? '1' : ''}" novalidate>
    <label>Email<input type="email" name="email" autocomplete="${registering ? 'email' : 'username webauthn'}" required${email === undefined ? '' : ` value="${escapeHtml(email)}" readonly`} /></label>
    ${mode === 'owner' ? SETUP_FIELD : ''}
    <label>Password<input type="password" name="password" autocomplete="${registering ? 'new-password' : 'current-password'}"${registering ? ' minlength="10" aria-describedby="password-rule"' : ''} /></label>
    ${registering ? `<p id="password-rule" class="muted">At least 10 characters.${mode === 'reset' ? '' : ' Not needed with a passkey.'}</p>` : ''}
    <button type="submit">${copy.password}</button>
  </form>
  <div class="or" aria-hidden="true">or</div>
  <div class="providers"><button type="button" class="provider" id="passkey">${copy.passkey}</button></div>
  <p class="status" id="status" role="alert" aria-live="assertive"></p>
  ${registering ? '' : `<p class="muted">New here? Ask the owner of this deployment for an invite link.</p>
  ${OWNER_RECOVERY}`}`;
}

/** Posts to `/api/auth/builtin/*` and follows the session it sets; passkeys through `navigator.credentials`. */
const BUILTIN_SCRIPT = `
const form = document.getElementById('builtin-sign-in');
const status = document.getElementById('status');
const passkey = document.getElementById('passkey');
const registering = form.dataset.mode === 'register';
const invite = form.dataset.invite || null;
const reset = form.dataset.reset || null;
const resetting = form.dataset.resetting === '1';
const returnTo = form.dataset.returnTo || '/';
const bytes = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const text = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const say = (message) => { status.textContent = message; };
const busy = (on) => { for (const control of document.querySelectorAll('button, input')) control.disabled = on; };
async function post(path, body) {
  const response = await fetch('/api/auth/builtin/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error || 'Sign-in failed (' + response.status + ').');
  return answer;
}
const done = (answer) => { location.assign(answer.returnTo || returnTo); };
const email = () => form.elements.email.value.trim();
const setup = () => (form.elements.setup ? form.elements.setup.value : null);
async function createPasskey(options) {
  const created = await navigator.credentials.create({ publicKey: { ...options, challenge: bytes(options.challenge),
    user: { ...options.user, id: bytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })) } });
  done(await post('passkey/register', { returnTo, response: { id: created.id, rawId: text(created.rawId), type: created.type,
    clientExtensionResults: created.getClientExtensionResults(),
    response: { clientDataJSON: text(created.response.clientDataJSON), attestationObject: text(created.response.attestationObject),
      transports: created.response.getTransports ? created.response.getTransports() : [] } } }));
}
async function run(work) {
  say('');
  busy(true);
  try { await work(); } catch (error) { say(error.name === 'NotAllowedError' ? 'The passkey request was cancelled.' : error.message); busy(false); }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!form.elements.email.checkValidity()) return say('Enter an email address.');
  if (form.elements.setup && !setup()) return say('Enter the setup token.');
  run(async () => done(await post(resetting ? 'password/reset' : registering ? 'password/register' : 'password/sign-in',
    resetting ? { reset, password: form.elements.password.value, returnTo }
      : { email: email(), password: form.elements.password.value, invite, setup: setup(), returnTo })));
});
passkey.addEventListener('click', () => {
  if (!window.PublicKeyCredential) return say('This browser does not support passkeys.');
  if (registering && !form.elements.email.checkValidity()) return say('Enter your email first: it names the account.');
  run(async () => {
    if (registering) {
      await createPasskey(resetting ? await post('passkey/reset/options', { reset })
        : await post('passkey/register/options', { email: email(), invite, setup: setup() }));
    } else {
      const options = await post('passkey/sign-in/options', {});
      const got = await navigator.credentials.get({ publicKey: { ...options, challenge: bytes(options.challenge),
        allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })) } });
      done(await post('passkey/sign-in', { returnTo, response: { id: got.id, rawId: text(got.rawId), type: got.type,
        clientExtensionResults: got.getClientExtensionResults(),
        response: { clientDataJSON: text(got.response.clientDataJSON), authenticatorData: text(got.response.authenticatorData),
          signature: text(got.response.signature), ...(got.response.userHandle ? { userHandle: text(got.response.userHandle) } : {}) } } }));
    }
  });
});
const recovery = document.getElementById('owner-recovery');
if (recovery) {
  const token = () => recovery.elements.setup.value;
  recovery.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!token()) return say('Enter the setup token.');
    run(async () => done(await post('password/reset', { setup: token(), password: recovery.elements.password.value, returnTo })));
  });
  document.getElementById('recovery-passkey').addEventListener('click', () => {
    if (!window.PublicKeyCredential) return say('This browser does not support passkeys.');
    if (!token()) return say('Enter the setup token.');
    run(async () => createPasskey(await post('passkey/reset/options', { setup: token() })));
  });
}`;

export function authDocument(title: string, body: string, script?: string): string {
  return publicPage({
    title: title.includes('Kinu') ? title : `${title} - Kinu.run`,
    styles: CARD_CSS,
    nav: `<a class="quiet" href="/install">Install CLI</a><a class="icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Kinu on GitHub">${GITHUB_ICON}</a>`,
    body: `<main class="gate"><section class="card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
  <a class="modal-close" href="/" aria-label="Close sign in">×</a>
  <h1 id="auth-title">${escapeHtml(title)}</h1>
  ${body}
</section></main>\n`,
    ...(script !== undefined && { script }),
  });
}

/** Device-approval pages: deliberately no header or footer (opened from a terminal, read once). */
export function approvalDocument(title: string, body: string): string {
  return publicPage({
    title: `${title} - Kinu.run`,
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
.provider::after{content:"\\2192";color:var(--c-text-3)}
.provider:hover::after{color:var(--c-accent-fg)}
dl{display:grid;margin:22px 0 0;border-top:var(--rule)}
dl>div{display:flex;justify-content:space-between;gap:18px;padding:9px 0;
border-bottom:var(--rule);font-size:14px}
dt{color:var(--c-text-3)}
dd{margin:0;text-align:right}
form{margin-top:20px}
.fields{display:grid;gap:14px;margin-top:24px}
.fields label{display:grid;gap:6px;color:var(--c-text-2);font-size:13px;font-weight:560}
.fields input{min-height:42px;padding:0 13px;border:1px solid var(--c-input-border);border-radius:var(--r-row);
background:var(--c-bg);color:var(--c-text);font:inherit;font-size:14.5px}
.fields input:focus-visible{outline:2px solid var(--c-accent);outline-offset:1px;border-color:var(--c-accent)}
.fields .muted{margin:-6px 0 0}
.or{display:flex;align-items:center;gap:12px;margin-top:22px;color:var(--c-text-3);font-size:12.5px}
.or::before,.or::after{content:"";flex:1;border-top:var(--rule)}
.or+.providers{margin-top:16px}
button.provider{width:100%;font:inherit;font-size:14.5px;font-weight:600;cursor:pointer;text-align:left}
button:disabled{opacity:.6;cursor:progress}
.status{min-height:0;color:var(--c-danger)!important}
.status:empty{display:none}
.recovery{margin-top:18px;border-top:var(--rule);padding-top:14px}
.recovery summary{width:max-content;color:var(--c-text-3);font-size:13px;cursor:pointer;border-radius:var(--r-row)}
.recovery summary:hover{color:var(--c-text)}
.recovery summary:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
.recovery .fields{margin-top:12px}
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
