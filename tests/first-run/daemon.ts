/**
 * ATTACH A REAL MACHINE — one daemon per machine, several at once.
 *
 * WHY THIS EXISTS AND `connectDevice` DOES NOT SERVE. The CLI's connect
 * implementation is correct and single-slot by design: it installs into the ONE
 * `AGENT_HOME` this process bound at import, claims the ONE pidfile there, and a
 * second call finds the first daemon and leaves it alone. That is right for a
 * person — one machine has one daemon — and it is exactly why nothing in this
 * tree could ever bring up TWO machines. The defect the owner hit needs two, so
 * this attaches them the way two separate laptops arrive: one registration each,
 * one home each, one daemon process each.
 *
 * IT IS THE SHIPPED DAEMON. `packages/pc-agent/src/index.js` is spawned as
 * itself, beside its own `sandbox.js`, under a per-machine `KINU_HOME` — the
 * same file `installDaemonFiles` stages and the same protocol the hub speaks. A
 * stand-in daemon here would put the fixture back where the missed defects live.
 *
 * WHAT MAKES TWO MACHINES ON ONE HOST HONEST. Everything a daemon owns is keyed
 * to its home: `device.json`, the pidfile, its agent-home root, and — because
 * the daemon reads it from the environment rather than from its home —
 * `KINU_INFLIGHT_ROOT`. The three would otherwise be shared and the second
 * daemon would exit with `ALREADY_RUNNING_EXIT`. Each machine also gets its own
 * `hostname`, as a program earlier on its own PATH: two real laptops answer that
 * question differently, and on one host they would not. The shim writes the
 * machine's own exec log beside it, which is what makes "the other machine never
 * ran it" a fact somebody can read afterwards rather than an inference from a
 * reply.
 */
import { chmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';

import { infraBoundary } from '@kinu.run/test-utils';
import { listCloudDevices, registerCloudDevice } from '../../packages/cli/src/cloud-api';
import { grantDeviceConsent, revokeDeviceOverUserRoute, type DeviceAccount } from '../evals/device-session';

/** How long a spawned daemon is given to report connected. The product's own
 *  connect waits on the daemon's signals with no clock; a first-run case has
 *  to end, so this is the tier's bound. 20 s is the figure the product carried
 *  until 2026-09-05; the tier keeps it as its own. */
const ARRIVAL_DEADLINE_MS = 20_000;

/** The daemon this release ships, and the policy it requires beside itself. */
const DAEMON_ENTRY = resolve(import.meta.dirname, '../../packages/pc-agent/src/index.js');

/**
 * How many times a machine's arrival is polled inside the product's own connect
 * deadline. A COUNT rather than a second duration, for the reason the device arm
 * states: the product owns the bound, and how finely this harness samples inside
 * it belongs to no contract.
 */
const ARRIVAL_PROBES = 40;

/** One attached machine: what the account calls it, and how to put it away. */
export interface AttachedMachine {
  /** The device row's id on the account. */
  readonly deviceId: string;
  /** The machine's NAME — its registration label, which is what the fleet
   *  answers by and what a person types when they say which machine. */
  readonly name: string;
  /** This machine's own home. Its config, pidfile, agent roots and exec log all
   *  live under here, so two machines share nothing. */
  readonly home: string;
  /** Every command this machine's `hostname` answered, oldest first. Written by
   *  the machine itself, so an empty list is that machine standing idle rather
   *  than a routing assumption. */
  execLog(): readonly string[];
  /** Stop the daemon. The device row is revoked by {@link detachMachine}, which
   *  is what a teardown calls. */
  stop(): void;
}

export interface AttachMachineRequest {
  readonly account: DeviceAccount;
  /** The name this machine will be known by. Distinct per machine: the fleet
   *  resolves a name to a device id, and two machines sharing one name are two
   *  machines nobody can address. */
  readonly name: string;
  /** Where this machine's home goes — a directory this run owns. */
  readonly home: string;
}

/**
 * Register a machine on the account and bring its daemon up.
 *
 * The registration is the CLI's own (`registerCloudDevice`, `POST
 * /api/cli/devices`), so the row on the account is the row `kinu connect`
 * creates. The daemon is not trusted to have arrived because it was spawned: the
 * DEPLOYMENT has to report it connected, which is the same check `connectDevice`
 * makes and the same one that was answering 500 when the owner's connect
 * reported failure on two machines at once.
 */
export async function attachMachine(request: AttachMachineRequest): Promise<AttachedMachine> {
  const { account, name, home } = request;
  const registration = await infraBoundary(
    `POST ${account.origin}/api/cli/devices (${name})`,
    () => registerCloudDevice(account.origin, account.cliToken, name),
  );

  const binDir = join(home, 'bin');
  const execLogPath = join(home, 'exec.log');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'inflight'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, 'device.json'),
    `${JSON.stringify({
      user: registration.userId,
      token: registration.token,
      origin: registration.origin.replace(/\/+$/, ''),
      // The directory this machine consented, as `kinu connect` records the one
      // it ran in. Its own home, so a command that writes lands on this machine
      // and nowhere near the checkout.
      root: home,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  // This machine's own `hostname`, earlier on its PATH than the real one. Two
  // laptops answer differently; two daemons on one host would not, and a case
  // that cannot tell the machines apart cannot prove a command reached one of
  // them. It also appends to this machine's exec log, so what a machine RAN is
  // recorded by that machine.
  writeFileSync(
    join(binDir, 'hostname'),
    ['#!/usr/bin/env bash',
      `printf '%s\\n' "$(date -Is) hostname" >> ${JSON.stringify(execLogPath)}`,
      `printf '%s\\n' ${JSON.stringify(name)}`,
      ''].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(join(binDir, 'hostname'), 0o700);

  // The daemon's output goes to a LOG FILE, the way `installDaemonFiles` runs
  // it — never to a pipe nobody drains. Measured on staging 2026-09-03: a
  // piped daemon that no process reads blocks on its own console.log once the
  // pipe buffer fills, misses the hub's liveness window, and is dropped from
  // the fleet while its row still says it registered — the machine the case
  // had attached "vanishing" mid-run with no failure anywhere.
  const logPath = join(home, 'pc-agent.log');
  // A numeric fd, not a FileSink: Bun.spawn's stdout/stderr accept a file
  // descriptor, and the fd needs no reader on this side to stay unblocked —
  // the kernel writes the daemon's log straight to disk.
  const logFd = openSync(logPath, 'a');
  const daemon = Bun.spawn({
    cmd: [process.execPath, DAEMON_ENTRY],
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      KINU_HOME: home,
      // Read from the environment by the daemon rather than derived from its
      // home, so two daemons would otherwise share one in-flight root and
      // reconcile each other's commands.
      KINU_INFLIGHT_ROOT: join(home, 'inflight'),
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    stdout: logFd,
    stderr: logFd,
  });

  const machine: AttachedMachine = {
    deviceId: registration.deviceId,
    name,
    home,
    execLog: () => readExecLog(execLogPath),
    stop: () => { stopDaemon(daemon); },
  };

  const arrived = await machineArrives(account, registration.deviceId);
  if (!arrived) {
    machine.stop();
    throw new Error(`the machine ${name} (${registration.deviceId}) never reported connected `
      + `within ${String(ARRIVAL_DEADLINE_MS)}ms — the daemon's own log: `
      + `${readDaemonLogTail(logPath)}`);
  }
  return machine;
}

/**
 * Put a machine away: stop its daemon, then revoke its row.
 *
 * BOTH, and in that order, and never conditionally: a stopped daemon whose row
 * survives leaves a machine registered on the account that no process answers
 * for, and a revoked row whose daemon lives keeps a socket dialling a
 * credential the deployment has already refused. Throws nothing — a teardown
 * that raises hides the failure the case was reporting.
 */
export async function detachMachine(
  account: DeviceAccount, machine: AttachedMachine,
): Promise<string | null> {
  machine.stop();
  try {
    const answer = await revokeDeviceOverUserRoute(account, machine.deviceId);
    if (answer.status !== 200) {
      return `DELETE /api/user/devices/${machine.deviceId} → ${String(answer.status)} ${answer.body}`;
    }
  } catch (error) {
    return `revoking ${machine.name}: ${String(error)}`;
  }
  try {
    rmSync(machine.home, { recursive: true, force: true });
  } catch (error) {
    return `removing ${machine.home}: ${String(error)}`;
  }
  return null;
}

/** Grant one workspace the machine, through the route Account settings uses.
 *  Re-exported here so a first-run case reaches one module for "attach a
 *  machine and let this workspace use it". */
export { grantDeviceConsent };

/** Whether the deployment reports this device connected, polled inside the
 *  tier's own arrival bound. A machine's arrival is OBSERVED, never assumed
 *  from a spawn that returned. */
async function machineArrives(account: DeviceAccount, deviceId: string): Promise<boolean> {
  const deadline = Date.now() + ARRIVAL_DEADLINE_MS;
  const between = Math.floor(ARRIVAL_DEADLINE_MS / ARRIVAL_PROBES);
  for (;;) {
    const devices = await listCloudDevices(account.origin, account.cliToken);
    if (devices.some((device) => device.id === deviceId && device.connected)) return true;
    if (Date.now() >= deadline) return false;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, between);
    await tick.promise;
  }
}

function readExecLog(path: string): readonly string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch (cause) {
    // ABSENCE ONLY. The shim writes this file on its first run, so "no file" and
    // "no lines" are the same fact: this machine has been asked nothing. Any
    // other failure — a permission refusal, an I/O fault — would make an empty
    // log indistinguishable from an unreadable one, and the case that asserts
    // "the other machine ran nothing" would pass on a broken read.
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return [];
    throw new Error(`could not read the machine's own exec log at ${path}`, { cause });
  }
}

/** Stop the daemon and everything it started. `kill` reaches the process group
 *  the daemon leads, so a supervised command does not outlive its machine. */
function stopDaemon(daemon: Subprocess): void {
  try {
    daemon.kill('SIGTERM');
  } catch (cause) {
    // A daemon that died on its own is stopped, which is what the caller asked
    // for — but the reason is RECORDED rather than dropped: a kill that failed
    // for any other reason leaves a live daemon holding a socket to the
    // account, and a silent catch is how that becomes invisible.
    console.warn(`    [first-run] a daemon did not take SIGTERM: ${String(cause)}`);
  }
}


/** The daemon's own last words, for a failure that has to explain itself. The
 *  CLI's identical helper tails the same log `installDaemonFiles` runs it into;
 *  bounded, because a daemon that logged a megabyte before failing is not more
 *  informative than its last lines. */
function readDaemonLogTail(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.trim().split('\n').slice(-8).join('\n') || '(the daemon said nothing)';
  } catch (cause) {
    // ABSENCE ONLY. A daemon that never started writing has no log at all;
    // an unreadable one is a harness fault worth the words.
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return '(no daemon log was written)';
    }
    return `the daemon log at ${path} could not be read: ${String(cause)}`;
  }
}
