import { Effect, Cause } from 'effect';
import { requireAuthConfig, resolveCloudOrigin, resolveCloudSession } from '../config';
import { whoami } from '../cloud-api';
import {
  connectDevice,
  daemonStatus,
  DAEMON_LOG_PATH,
  defaultDeviceName,
  describeConnectOutcome,
  describeDeviceSandbox,
  DEVICE_CONFIG_PATH,
  joinDevice,
  waitingDots,
  WHOLE_MACHINE_LINKED,
} from '../device-connect';
import { readDaemonLogTail } from '../daemon-log';
import { ACCENT, DIM, ERR, OK } from '../display';
import { ask, canPrompt, confirm } from '../prompt';
import { authCommand } from './auth';
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import { DEVICE_CONNECT_DISCLOSURE, deviceJoinTicketUser } from '@kinu.run/core';

function daemonLogTail(lines: number): string {
  return readDaemonLogTail(DAEMON_LOG_PATH, lines) ?? DIM(`No daemon log at ${DAEMON_LOG_PATH}`);
}

export interface ConnectCommandOptions {
  label?: string;
  device?: string;
  /** The ticket a browser's connect command carries, which joins this machine with no sign-in here. */
  join?: string;
  root?: string;
}

export function desktopCommand(action: string | undefined, opts: ConnectCommandOptions): Promise<void> {
  return settle(Effect.gen(function* () {
    const sub = action ?? 'status';

    if (sub === 'connect' || sub === 'install') {
      const joining = opts.join === undefined ? null : yield* joinTicket(opts.join);
      const auth = joining === null ? yield* authOrLogin() : yield* sessionOf(joining.account);

      if (joining !== null && auth === null) return yield* joinByTicket(joining, opts);

      if (auth === null) return;
      const name = yield* confirmConnect(opts.label);

      if (!name) {
        console.log(`${DIM('Nothing was installed. This machine is not linked.')}`);

        return;
      }

      const result = yield* linking((onWaiting) => connectDevice(auth, { label: name, device: opts.device, root: opts.root, onWaiting }));

      if (result.kind !== 'connected') {
        console.error(`${ERR('✗')} ${describeConnectOutcome(result, false).message}`);
        process.exit(1);
      }

      console.log('');
      console.log(`${OK('✓')} Connected as ${ACCENT(result.label)}`);

      if (result.replacedLocalConfig) console.log('Replaced the malformed local device config.');

      for (const line of describeDeviceSandbox(result.sandbox, result.wholeMachine)) console.log(`  ${line}`);
      console.log(`${DIM('Manage it under Account settings → Devices.')}`);
      console.log(`${DIM('Daemon log:')} ${DAEMON_LOG_PATH}`);
      console.log('');

      return;
    }

    if (sub === 'status') {
      const status = yield* Effect.promise(() => daemonStatus());
      console.log(`${DIM('Device config:')} ${status.deviceConfigPresent ? OK('present') : 'missing'} ${DIM(DEVICE_CONFIG_PATH)}`);
      console.log(`${DIM('Daemon log:')} ${status.logPresent ? OK('present') : 'missing'} ${DIM(DAEMON_LOG_PATH)}`);
      console.log(`${DIM('Daemon process:')} ${status.daemonPid ? OK(`running (pid ${status.daemonPid})`) : 'not running'}`);

      return;
    }

    if (sub === 'logs') {
      console.log(daemonLogTail(80));

      return;
    }

    return yield* Effect.die(new Error('Usage: kinu desktop [connect|status|logs]'));
  }));
}

/** Runs a link behind its waiting dots; a failure ends the command in its own words. */
function linking<R>(link: (onWaiting: () => void) => Promise<R>): Effect.Effect<R> {
  return Effect.gen(function* () {
    const dots = waitingDots('');

    const result = yield* Effect.catchCause(Effect.promise(async () => link(dots.onWaiting)), (failed) => Effect.sync((): never => {
      // The readiness failure already quotes the daemon log; this only ends the progress line.
      dots.end();
      console.error(`${ERR('✗')} ${renderThrownChain({ cause: Cause.squash(failed) })}`);
      process.exit(1);
    }));

    dots.end();

    return result;
  });
}

/** A browser's connect command's ticket, and the account it names. */
interface JoinTicket {
  readonly ticket: string;
  readonly account: string;
}

function joinTicket(ticket: string): Effect.Effect<JoinTicket> {
  const account = deviceJoinTicketUser(ticket);

  return account === null ? refuseConnect(JOIN_TICKET_UNREADABLE) : Effect.succeed({ ticket, account });
}

/**
 * The session a connect command links through: this machine's, when it is signed in to the account the command names,
 * which leaves the ticket unspent. Signed in to another, it refuses rather than switch accounts; with no session here,
 * none, and the ticket joins the machine with nobody asked to sign in.
 */
function sessionOf(account: string): Effect.Effect<{ origin: string; token: string } | null> {
  return Effect.gen(function* () {
    const session = resolveCloudSession();

    if (session === null || session.origin !== resolveCloudOrigin()) return null;

    const { user } = yield* Effect.catchCause(Effect.promise(() => whoami(session.origin, session.token)), (failed) =>
      refuseConnect(`Could not tell which account this machine's Kinu CLI is signed in to (${renderThrownChain({ cause: Cause.squash(failed) })}). `
        + 'Nothing was changed. Run `kinu logout`, then run the command again.'));

    return user.id === account ? session : yield* refuseConnect(signedInElsewhere(user.email));
  });
}

function joinByTicket(joining: JoinTicket, opts: ConnectCommandOptions): Effect.Effect<void> {
  return Effect.gen(function* () {
    const name = yield* confirmConnect(opts.label);

    if (!name) {
      console.log(`${DIM('Nothing was installed. This machine is not linked.')}`);

      return;
    }

    const result = yield* linking((onWaiting) => joinDevice(resolveCloudOrigin(), joining.ticket, joining.account, { label: name, root: opts.root, onWaiting }));

    if (result.kind !== 'connected') {
      console.error(`${ERR('✗')} Stopped waiting for the daemon. It keeps trying to connect; check: kinu desktop logs`);
      process.exit(1);
    }

    console.log('');
    console.log(`${OK('✓')} Connected as ${ACCENT(result.label)}`);

    if (result.replacedLocalConfig) console.log('Replaced the malformed local device config.');

    if (result.wholeMachine) console.log(`  ${WHOLE_MACHINE_LINKED}`);
    console.log(`${DIM('Its sandbox, and the workspaces it serves, are under Account settings → Devices.')}`);
    console.log(`${DIM('Daemon log:')} ${DAEMON_LOG_PATH}`);
    console.log('');
  });
}

const JOIN_TICKET_UNREADABLE = 'This connect command carries no valid ticket. Copy it again from Connect a machine, or run `kinu connect` signed in.';

function signedInElsewhere(email: string): string {
  return `This machine's Kinu CLI is signed in as ${email}, and this command connects it to another account. Nothing was changed. `
    + 'To connect it to that account, run `kinu logout`, then run the command again.';
}

function refuseConnect(reason: string): Effect.Effect<never> {
  return Effect.sync((): never => {
    console.error(`${ERR('✗')} ${reason}`);
    process.exit(1);
  });
}

/** Linking is never a side effect: without a terminal to state the terms in, this refuses. Null when the answer is no. */
function confirmConnect(label?: string): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    console.log('');

    for (const line of DEVICE_CONNECT_DISCLOSURE) console.log(`  ${DIM(line)}`);
    console.log('');

    if (!canPrompt()) {
      return yield* Effect.die(new Error(
        'Linking a machine needs a terminal. Re-run `kinu connect` from one.',
      ));
    }

    const given = label?.trim();
    const name = given === undefined || given === '' ? (yield* Effect.promise(async () => ask('Device name', defaultDeviceName()))) : given;
    const proceed = yield* Effect.promise(async () => confirm('Link and start the daemon?', true));

    return proceed ? name : null;
  });
}

function authOrLogin(): Effect.Effect<{ origin: string; token: string; user?: { id: string; email: string; displayName?: string | null } }> {
  return Effect.catchCause(Effect.sync(() => requireAuthConfig()), (failed) => Effect.gen(function* () {
    const err = Cause.squash(failed);

    if (!/Not authenticated/.test(renderThrownChain({ cause: err }))) return yield* Effect.die(err);
    const origin = resolveCloudOrigin();
    console.log(`${DIM('Not signed in. Starting Kinu sign-in…')}`);
    yield* Effect.promise(() => authCommand({ origin }));

    return requireAuthConfig();
  }));
}
