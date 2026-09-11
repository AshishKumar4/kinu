// Mint the eval-service CLI bearer for the deployment, when none is persisted.
//
// The first-run tier runs inside the deploy, against the build it just shipped,
// and its browser plane already holds the deployment's `DEV_IDENTITY_SECRET`
// (`KINU_EVAL_WEB_IDENTITY`). Its CLI plane needs a bearer for the same account,
// and the only way to get one is the device flow `kinu auth` runs — with the
// approval made by the eval identity instead of a person in a browser. That
// approval is `POST /cli/auth` presenting the secret in `x-kinu-dev-identity`,
// which `authenticateRequest` honours for exactly that header and nothing else.
//
// Writes `~/.config/kinu/eval-session/config.json` (mode 0600), the file
// `scripts/eval-credentials.ts` reads. Never touches the person's own config.
// Exits 0 having written nothing when a bearer for this origin already exists.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname } from 'node:path';
import * as v from 'valibot';
import { EVAL_DEPLOYMENT_ORIGIN, EVAL_IDENTITY_ENV, evalTargetVerdict } from '@kinu.run/test-utils';
import { pollCliAuth, startCliAuth } from '../packages/cli/src/cloud-api';

const persistedPath = `${homedir()}/.config/kinu/eval-session/config.json`;

const origin = process.env[EVAL_IDENTITY_ENV.origin]?.trim() || EVAL_DEPLOYMENT_ORIGIN;

const target = evalTargetVerdict(origin);

if (target.kind === 'refused') {
  console.error(`eval-session-mint: REFUSED — ${target.reason}`);
  process.exit(1);
}

const webIdentity = process.env.KINU_EVAL_WEB_IDENTITY?.trim();

if (!webIdentity) {
  console.error('eval-session-mint: KINU_EVAL_WEB_IDENTITY is not set; nothing can approve the flow.');
  process.exit(1);
}

if (existsSync(persistedPath)) {
  const persisted = v.safeParse(v.object({ origin: v.string() }), JSON.parse(readFileSync(persistedPath, 'utf8')));

  if (persisted.success && persisted.output.origin === target.origin) {
    console.error(`eval-session-mint: a session for ${target.origin} is already persisted`);
    process.exit(0);
  }

  // Another deployment's bearer lives here, and this is the only copy of it.
  console.error(`eval-session-mint: REFUSED — ${persistedPath} holds a session for ` +
    `${persisted.success ? persisted.output.origin : 'an unreadable origin'}, not ${target.origin}; move it aside first.`);
  process.exit(1);
}

const flow = await startCliAuth(target.origin, `eval-service@${hostname()}`);

// The approval is the browser form: GET issues the CSRF cookie and the form
// carrying its twin; POST returns both with a same-origin `Origin`. The dev
// identity travels in its header on both, and only there.
const identity = { 'x-kinu-dev-identity': webIdentity };

const page = await fetch(`${target.origin}/cli/auth?code=${encodeURIComponent(flow.userCode)}`, { headers: identity });

if (page.status >= 400) {
  console.error(`eval-session-mint: the deployment refused the approval page (${page.status}); ` +
    'does it set DEV_USER_EMAIL, and does KINU_EVAL_WEB_IDENTITY match its DEV_IDENTITY_SECRET?');
  process.exit(1);
}

const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];

const cookie = page.headers.get('set-cookie')?.split(';')[0];

if (!csrf || !cookie) {
  console.error('eval-session-mint: the approval page carried no CSRF pair; the route changed shape.');
  process.exit(1);
}

const approval = await fetch(`${target.origin}/cli/auth`, {
  method: 'POST',
  headers: { ...identity, cookie, origin: target.origin },
  body: new URLSearchParams({ userCode: flow.userCode, csrf }),
});

if (approval.status >= 400) {
  console.error(`eval-session-mint: the deployment refused the approval (${approval.status})`);
  process.exit(1);
}

const poll = await pollCliAuth(target.origin, flow.deviceToken);

if (poll.status !== 'approved' || !poll.token) {
  console.error(`eval-session-mint: the flow is ${poll.status} after approval${poll.message ? `: ${poll.message}` : ''}`);
  process.exit(1);
}

mkdirSync(dirname(persistedPath), { recursive: true, mode: 0o700 });

writeFileSync(persistedPath, JSON.stringify({
  origin: poll.origin ?? target.origin, accessToken: poll.token, tokenExpiresAt: poll.expiresAt ?? null, user: poll.user ?? null,
}, null, 2) + '\n', { mode: 0o600 });

chmodSync(persistedPath, 0o600);

console.error(`eval-session-mint: minted ${poll.user?.email ?? 'the eval service'} @ ${target.origin}`);
