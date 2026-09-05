import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import {
  defaultOrigin, listCliSessions, logout, pollCliAuth, revokeCliSessionByHash, revokeAllCliSessions, startCliAuth, whoami,
  type CliAuthPoll,
} from '../cloud-api';
import { bumpProviderRevision, loadConfigFile, requireAuthConfig, updateConfigFile } from '../config';
import { ACCENT, DIM, formatWhen, OK, WARN } from '../display';
import { renderThrownChain } from '@kinu.run/core/obs';
import { waitForAnswer } from '../wait';

export interface CliAuthCallbacks {
  started?(flow: { verificationUrl: string; userCode: string }): void;
  pending?(): void;
  completed?(email: string): void;
}

export async function authenticateCli(
  opts: { origin?: string },
  callbacks: CliAuthCallbacks = {},
): Promise<void> {
  const origin = defaultOrigin(opts);
  const flow = await startCliAuth(origin, hostname());
  callbacks.started?.({ verificationUrl: flow.verificationUrl, userCode: flow.userCode });
  openBrowser(flow.verificationUrl);

  // The hub owns the request's deadline: once it passes, the poll answers
  // `expired` by itself, so the wait ends on that answer or on approval.
  const status = await waitForAnswer(async (): Promise<CliAuthPoll | undefined> => {
    const poll = await pollCliAuth(origin, flow.deviceToken);
    return poll.status === 'pending' ? undefined : poll;
  }, { intervalMs: Math.max(1, flow.intervalSeconds) * 1000, onWaiting: () => callbacks.pending?.() });
  if (status.status === 'expired') throw new Error(status.message ?? 'CLI auth expired.');
  if (!status.token || !status.user) throw new Error('Auth approved but no token returned.');
  updateConfigFile((config) => {
    config.origin = status.origin ?? origin;
    config.accessToken = status.token;
    config.tokenExpiresAt = status.expiresAt;
    config.user = status.user;
  });
  // Signing in changes which providers a model resolution can reach — the
  // account's credentials become available through the proxy — so a resident
  // session's cached provider listing is now stale.
  bumpProviderRevision();
  callbacks.completed?.(status.user.email);
}

export async function authCommand(opts: { origin?: string }): Promise<void> {
  console.log('');
  await authenticateCli(opts, {
    started(flow) {
      console.log(`${DIM('Open:')} ${ACCENT(flow.verificationUrl)}`);
      console.log(`${DIM('Code:')} ${ACCENT(flow.userCode)}`);
      console.log('');
    },
    pending() { process.stdout.write('.'); },
    completed(email) {
      console.log('');
      console.log(`${OK('✓')} Signed in as ${ACCENT(email)}`);
    },
  });
}

export async function whoamiCommand(opts: { origin?: string }): Promise<void> {
  const config = loadConfigFile();
  const origin = defaultOrigin(opts);
  const token = config.accessToken;
  if (!token) throw new Error('Not authenticated. Run: kinu auth');
  const result = await whoami(origin, token);
  console.log(`${ACCENT(result.user.email)} ${DIM(result.user.id)}`);
}

export async function logoutCommand(opts: { origin?: string }): Promise<void> {
  const config = loadConfigFile();
  const origin = defaultOrigin(opts);
  if (config.accessToken) {
    let revoked = true;
    try {
      await logout(origin, config.accessToken);
    } catch (error) {
      // The remote session is the thing that outlives this command when the
      // revocation cannot land, and the raw token is the ONLY copy of it — the
      // server stores a hash. Deleting it here would orphan a live 180-day
      // bearer with nothing able to name it, so it stays as a pending
      // revocation the next logout (or `kinu sessions revoke --all`) retries.
      const reason = renderThrownChain({ cause: error });
      console.error(`${WARN('!')} Could not revoke the session at ${origin} (${reason}); it may still be valid.`);
      updateConfigFile((current) => {
        current.pendingRevocation = {
          token: config.accessToken ?? '',
          origin,
          at: Date.now(),
        };
      });
      revoked = false;
    }
    if (!revoked) {
      bumpProviderRevision();
      console.log(`${OK('✓')} Logged out locally. Session NOT revoked`);
      console.log(DIM(`Run \`kinu logout\` again when reachable, or \`kinu sessions\` from any machine to revoke by inventory.`));
      return;
    }
  }
  updateConfigFile((current) => {
    delete current.accessToken;
    delete current.tokenExpiresAt;
    delete current.user;
    delete current.pendingRevocation;
  });
  // The inverse of sign-in: every account-held provider just became unreachable.
  bumpProviderRevision();
  console.log(`${OK('✓')} Logged out`);
}

/** Revoke a session by the hash the inventory prints. */
async function revokeSessionCommand(hash: string): Promise<void> {
  const auth = requireAuthConfig();
  await revokeCliSessionByHash(auth.origin, auth.token, hash);
  console.log(`${OK('✓')} Session ${ACCENT(hash.slice(0, 12))}… revoked`);
}

/** `kinu sessions` — the inventory every orphaned bearer needed: what is still
 *  live on the account, and how to end any of it. */
export async function sessionsCommand(
  action: string | undefined, hash: string | undefined,
): Promise<void> {
  const sub = action ?? 'list';
  if (sub === 'revoke') {
    if (hash === undefined || hash === '--all') {
      const auth = requireAuthConfig();
      const result = await revokeAllCliSessions(auth.origin, auth.token);
      console.log(`${OK('✓')} Revoked ${ACCENT(String(result.revoked))} session(s)`);
      return;
    }
    return revokeSessionCommand(hash);
  }
  if (sub !== 'list') {
    throw new Error('Usage: kinu sessions [list | revoke <hash> | revoke --all]');
  }
  const auth = requireAuthConfig();
  const { sessions } = await listCliSessions(auth.origin, auth.token);
  if (sessions.length === 0) {
    console.log(DIM('No live CLI sessions. Sign in with: kinu auth'));
    return;
  }
  for (const session of sessions) {
    console.log(`${ACCENT(session.tokenHash.slice(0, 16))}…  ${DIM(session.label)}`);
    console.log(`  ${DIM('created')} ${formatWhen(session.createdAt)}  ${DIM('last used')} ${session.lastUsedAt ? formatWhen(session.lastUsedAt) : 'never'}  ${DIM('expires')} ${formatWhen(session.expiresAt)}`);
  }
  console.log(DIM('Revoke one: kinu sessions revoke <hash>   All: kinu sessions revoke --all'));
}

export function openBrowser(url: string): void {
  const command = platform() === 'darwin'
    ? 'open'
    : platform() === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
