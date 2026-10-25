import { Cause, Effect } from 'effect';
import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import {
  defaultOrigin, listCliSessions, logout, pollCliAuth, revokeCliSessionByHash, revokeAllCliSessions, startCliAuth, whoami,
  type CliAuthPoll,
} from '../cloud-api';
import { bumpProviderRevision, loadConfigFile, requireAuthConfig, storedSessionOrigin, updateConfigFile } from '../config';
import { ACCENT, DIM, formatWhen, OK, WARN } from '../display';
import { KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import { waitForAnswer } from '@kinu.run/core';

export interface CliAuthCallbacks {
  /** `opened` is false where no browser could be seen (SSH, or no display): the person approves on another device. */
  started?(flow: { verificationUrl: string; userCode: string; opened: boolean }): void;
  pending?(): void;
  completed?(email: string): void;
}

export function authenticateCli(
  opts: { origin?: string },
  callbacks: CliAuthCallbacks = {},
): Promise<void> {
  return settle(Effect.gen(function* () {
    const origin = defaultOrigin(opts);
    const flow = yield* Effect.promise(async () => startCliAuth(origin, hostname()));
    const opened = openBrowser(flow.verificationUrl);
    callbacks.started?.({ verificationUrl: flow.verificationUrl, userCode: flow.userCode, opened });

    // The hub owns the deadline: the poll answers `expired` by itself.
    const status = yield* Effect.promise(async () => waitForAnswer(async (): Promise<CliAuthPoll | undefined> => {
      const poll = await pollCliAuth(origin, flow.deviceToken);

      return poll.status === 'pending' ? undefined : poll;
    }, { intervalMs: Math.max(1, flow.intervalSeconds) * 1000, onWaiting: () => callbacks.pending?.() }));

    if (status.status === 'expired') return yield* Effect.die(new Error(status.message ?? 'The sign-in code expired. Run kinu auth again.'));

    if (!status.token || !status.user) return yield* Effect.die(new Error('Sign-in was approved, but the server sent no token. Run kinu auth again.'));
    yield* Effect.promise(async () => updateConfigFile((config) => {
      config.origin = status.origin ?? origin;
      config.accessToken = status.token;
      config.tokenExpiresAt = status.expiresAt;
      config.user = status.user;
    }));
    // Signing in makes account credentials reachable through the proxy, so cached provider listings are stale.
    yield* Effect.promise(async () => bumpProviderRevision());
    callbacks.completed?.(status.user.email);
  }));
}

export async function authCommand(opts: { origin?: string }): Promise<void> {
  console.log('');
  await authenticateCli(opts, {
    started(flow) {
      if (flow.opened) {
        console.log(`${DIM('Open:')} ${ACCENT(flow.verificationUrl)}`);
      } else {
        console.log('No browser was opened here (SSH or no display). Open this link on any device and approve:');
        console.log(`  ${ACCENT(flow.verificationUrl)}`);
      }

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

/** The session every other command uses: `KINU_TOKEN` first, else the stored, unexpired one. */
export function whoamiCommand(opts: { origin?: string }): Promise<void> {
  return settle(Effect.gen(function* () {
    const { token } = requireAuthConfig();
    const result = yield* Effect.promise(async () => whoami(defaultOrigin(opts), token));
    console.log(`${ACCENT(result.user.email)} ${DIM(result.user.id)}`);
  }));
}

export function logoutCommand(opts: { origin?: string }): Promise<void> {
  return settle(Effect.gen(function* () {
    const config = loadConfigFile();
    // The stored token is its own deployment's: sent elsewhere it is leaked, and that deployment's 401 would read as ended.
    const origin = storedSessionOrigin(config);
    const asked = defaultOrigin(opts);
    const token = config.accessToken;

    if (token && new URL(asked).origin !== new URL(origin).origin) {
      return yield* Effect.fail(new KinuError('bad_input', `Signed in to ${origin}, not ${asked}: run kinu logout without --origin or KINU_ORIGIN to sign out of ${origin}.`));
    }

    if (token) {
      const revoked = yield* Effect.catchCause(Effect.as(Effect.promise(() => logout(origin, token)), true), (failed) => Effect.gen(function* () {
        // The raw token is the only copy (the server stores a hash); deleting it would orphan a live 180-day bearer,
        // so it stays pending for the next logout or `kinu auth revoke --all`.
        const reason = renderThrownChain({ cause: Cause.squash(failed) });
        console.error(`${WARN('!')} Could not revoke the session at ${origin} (${reason}); it may still be valid.`);
        yield* Effect.promise(() => updateConfigFile((current) => {
          current.pendingRevocation = {
            token,
            origin,
            at: Date.now(),
          };
        }));

        return false;
      }));

      if (!revoked) {
        yield* Effect.promise(() => bumpProviderRevision());
        console.log(`${WARN('!')} Not signed out: the session is still valid, and this PC keeps its token so a later logout can revoke it.`);
        console.log(DIM(`Run \`kinu logout\` again once ${origin} is reachable, or end it with \`kinu auth revoke --all\` from any PC.`));

        return;
      }
    }

    yield* Effect.promise(() => updateConfigFile((current) => {
      delete current.accessToken;
      delete current.tokenExpiresAt;
      delete current.user;
      delete current.pendingRevocation;
    }));
    // The inverse of sign-in: every account-held provider just became unreachable.
    yield* Effect.promise(() => bumpProviderRevision());
    console.log(`${OK('✓')} Signed out`);
  }));
}

const AUTH_USAGE = 'Usage: kinu auth [sessions | revoke <session> | revoke --all]';

/** `kinu auth sessions` and `kinu auth revoke`: the account's CLI sign-ins, so a bearer stored only as a hash can be ended. */
export function authSessionsCommand(
  action: string, session: string | undefined, opts: { origin?: string; all?: boolean },
): Promise<void> {
  return settle(Effect.gen(function* () {
    const auth = requireAuthConfig();

    // The sessions listed and ended are the signed-in deployment's: a different --origin is refused, never ignored.
    if (opts.origin !== undefined && new URL(defaultOrigin(opts)).origin !== new URL(auth.origin).origin) {
      return yield* Effect.fail(new KinuError('bad_input', `Signed in to ${auth.origin}, not ${opts.origin}: sign in there first with kinu auth --origin ${opts.origin}`));
    }

    if (action === 'revoke') {
      if (opts.all === true && session === undefined) {
        const result = yield* Effect.promise(async () => revokeAllCliSessions(auth.origin, auth.token));
        console.log(`${OK('✓')} Revoked ${ACCENT(String(result.revoked))} session(s)`);

        return;
      }

      if (opts.all === true || session === undefined) return yield* Effect.fail(new KinuError('bad_input', AUTH_USAGE));
      yield* Effect.promise(async () => revokeCliSessionByHash(auth.origin, auth.token, session));
      console.log(`${OK('✓')} Session ${ACCENT(session.slice(0, 12))}… revoked`);

      return;
    }

    if (action !== 'sessions') return yield* Effect.fail(new KinuError('bad_input', AUTH_USAGE));
    const { sessions } = yield* Effect.promise(async () => listCliSessions(auth.origin, auth.token));

    if (sessions.length === 0) {
      console.log(DIM('No live CLI sessions. Sign in with: kinu auth'));

      return;
    }

    for (const live of sessions) {
      console.log(`${ACCENT(live.tokenHash)}  ${DIM(live.label)}`);
      console.log(`  ${DIM('created')} ${formatWhen(live.createdAt)}  ${DIM('last used')} ${live.lastUsedAt ? formatWhen(live.lastUsedAt) : 'never'}  ${DIM('expires')} ${formatWhen(live.expiresAt)}`);
    }

    console.log(DIM('Revoke one: kinu auth revoke <session>   All: kinu auth revoke --all'));
  }));
}

function browserOpener(os: string): string {
  if (os === 'darwin') return 'open';

  return os === 'win32' ? 'cmd' : 'xdg-open';
}

/**
 * Starts the system browser on `url` where the person can see it; false where it started none. Over SSH a browser opens
 * on the remote machine's screen, not the one being read, and Linux without a display has none: there `xdg-open` falls
 * back to a terminal browser (w3m, lynx) that nobody asked for. Every caller prints the link as well.
 */
export function openBrowser(url: string): boolean {
  const os = platform();
  const set = (name: string): boolean => (process.env[name] ?? '') !== '';

  if (['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].some(set)) return false;

  if (os === 'linux' && !['DISPLAY', 'WAYLAND_DISPLAY'].some(set)) return false;
  const args = os === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(browserOpener(os), args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();

  return true;
}
