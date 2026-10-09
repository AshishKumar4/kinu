/**
 * The one device-connect implementation behind every "link this PC" surface. The daemon ships inside the release, so connect
 * fetches no code. One daemon owns a machine via `~/.kinu/pc-agent.pid`, which the daemon also claims itself.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import * as v from 'valibot';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { isolatedBunArgs } from '@kinu.run/core';
import { classify, classifyErrorCode, diagnostics, KinuError, renderThrownChain, settle, settleSync, tolerate, toKinuError } from '@kinu.run/core/obs';
import { describeGpuNodes, effectiveDeviceMode, sandboxReasonFix } from '@kinu.run/core';
import { enforceOwnerOnly, ensureSecretDir } from '@kinu.run/cli-backend';
import { AGENT_HOME, ensureAgentHome, loadConfigFile, requireAuthConfig, resolveCloudSession, updateConfigFile } from './config';
import { listCloudDevices, registerCloudDevice, type CloudDevice, type CloudDeviceSandbox } from './cloud-api';
import { readDaemonLogTail, rotateDaemonLogIfNeeded } from './daemon-log';
import { waitForAnswer, type StoppableWaitOptions } from '@kinu.run/core';
import PC_AGENT_DAEMON_SOURCE from '../../pc-agent/src/index.js' with { type: 'text' };
import PC_AGENT_SANDBOX_SOURCE from '../../pc-agent/src/sandbox.js' with { type: 'text' };
import PC_AGENT_PTY_SOURCE from '../../pc-agent/src/pty.js' with { type: 'text' };
import PC_AGENT_UPDATE_SOURCE from '../../pc-agent/src/update.js' with { type: 'text' };
import DEVICE_PROTOCOL from '../../core/src/execution/device-protocol.json';
import { DIM, VERSION } from './display';

const PID_PATH = join(AGENT_HOME, 'pc-agent.pid');

/** Where a pidfile's contents are written before they are linked into place; the daemon writes its claim here too. */
const CLAIMS_DIR = join(AGENT_HOME, 'pc-agent.pid.claims');

const SCRIPT_PATH = join(AGENT_HOME, 'pc-agent.js');

/** The installed daemon's build; reported in HELLO so the hub can push updates. The daemon's updater rewrites it. */
const VERSION_STAMP_PATH = join(AGENT_HOME, 'pc-agent.version');

/** Written by the daemon while its successor starts; with a stale pidfile, the successor died and `.prev` last ran. */
const UPDATE_PENDING_PATH = join(AGENT_HOME, 'pc-agent.update-pending');

/** Every sibling the daemon `require`s. */
const DAEMON_SIBLINGS: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'sandbox.js', source: PC_AGENT_SANDBOX_SOURCE },
  { name: 'pty.js', source: PC_AGENT_PTY_SOURCE },
  { name: 'update.js', source: PC_AGENT_UPDATE_SOURCE },
  { name: 'device-protocol.json', source: JSON.stringify(DEVICE_PROTOCOL) },
];

/**
 * chatgpt.js is read, not imported as text: the CLI imports it as a module too, and Bun's bundler gives one
 * file one loader (21 of 40 builds failed). The release and the source tree put it beside their daemon.
 */
function daemonSiblings(): readonly { readonly name: string; readonly source: string }[] {
  const file = [join(import.meta.dir, 'pc-agent', 'chatgpt.js'), join(import.meta.dir, '..', '..', 'pc-agent', 'src', 'chatgpt.js')].find(existsSync);

  return [...DAEMON_SIBLINGS, { name: 'chatgpt.js', source: readFileSync(file ?? join(import.meta.dir, 'pc-agent', 'chatgpt.js'), 'utf8') }];
}

export const DAEMON_LOG_PATH = join(AGENT_HOME, 'pc-agent.log');

export const DEVICE_CONFIG_PATH = join(AGENT_HOME, 'device.json');

/** The daemon reports this root in HELLO and the hub composes `<root>/<workspace>/home`; the daemon owns everything under it. */
const AGENT_ROOT = join(AGENT_HOME, 'agents');

const CONNECT_POLL_MS = 1_000;

export function defaultDeviceName(): string {
  return hostname().trim();
}

/** Owner-only, with a verified chmod so an existing group-readable root is tightened. */
function ensureAgentRoot(): void {
  ensureSecretDir(AGENT_ROOT);
}

/** Lives in `@kinu.run/core` because the web connect panel renders the same lines. */
export { DEVICE_CONNECT_DISCLOSURE } from '@kinu.run/core';

export interface DeviceAuth {
  origin: string;
  token: string;
}

export interface ConnectDeviceOptions {
  label?: string;
  session?: boolean;
  onWaiting?: () => void;
  /** The daemon keeps running and trying to connect. */
  signal?: AbortSignal;
}

export interface ConnectOutcomeDescription {
  ok: boolean;
  message: string;
}

export type ConnectDeviceResult =
  | { kind: 'connected'; deviceId: string; label: string; sandbox: CloudDeviceSandbox; wholeMachine: boolean }
  | { kind: 'cancelled'; deviceId: string }
  | { kind: 'already-running'; connected: boolean };

export function connectDevice(auth: DeviceAuth, opts: ConnectDeviceOptions = {}): Promise<ConnectDeviceResult> {
  return settle(Effect.gen(function* () {
    if (opts.session && (yield* runningDaemonPid()) !== null) {
      // The running daemon owns device.json and its credentials.
      const devices = yield* listDevicesForConnect(auth, 'checking whether the installed daemon is connected');

      return { kind: 'already-running', connected: devices.some((device) => device.connected) } satisfies ConnectDeviceResult;
    }

    yield* assertDaemonPlatformSupported();
    const runtime = yield* daemonRuntime();
    const device = yield* registerDeviceForConnect(auth, opts.label, previousDeviceToken(auth.origin));
    yield* installDaemonFiles(device);
    const launch = yield* startInstalledDaemon(opts.session === true, runtime);
    // The daemon must show as connected on the server before success is claimed.
    const connected = yield* waitForDeviceConnected(auth, device.deviceId, launch, opts);

    if (connected === undefined) return { kind: 'cancelled', deviceId: device.deviceId } satisfies ConnectDeviceResult;
    thisDeviceConnected = true;

    // The hub is the authority on the machine's name, not the name typed at the prompt.
    return {
      kind: 'connected', deviceId: device.deviceId, label: connected.label, sandbox: connected.sandbox, wholeMachine: connected.wholeMachine,
    } satisfies ConnectDeviceResult;
  }));
}

export interface DaemonStatus {
  deviceConfigPresent: boolean;
  logPresent: boolean;
  daemonPid: number | null;
  sessionActive: boolean;
}

/** Read-only; a successor that dies before connecting is rolled back by the daemon (`pc-agent/src/update.js`). */
export function daemonStatus(): DaemonStatus {
  return settleSync(Effect.map(runningDaemonPid(), (daemonPid) => ({
    deviceConfigPresent: existsSync(DEVICE_CONFIG_PATH),
    logPresent: existsSync(DAEMON_LOG_PATH),
    daemonPid,
    sessionActive: sessionDaemon !== null && sessionDaemon.exitCode === null && !sessionDaemon.killed,
  })));
}

let offerConsumed = false;

let thisDeviceConnected: boolean | null = null;

/** Compares hostnames: `device.json` holds no device id, so the hostname is the only local identity. */
function isThisMachine(device: CloudDevice): boolean {
  return device.hostname !== null && device.hostname.trim() === defaultDeviceName();
}

/**
 * Cloud auth present, not dismissed, and this machine (not the account) not connected; a true answer consumes the
 * per-invocation latch. Suppressing on any connected device hid the offer from everyone with another machine linked.
 */
export function shouldOfferDeviceConnect(): Promise<boolean> {
  return settle(Effect.gen(function* () {
    if (offerConsumed) return false;

    if (loadConfigFile().deviceConnectPromptDismissed) return false;
    const auth = resolveCloudSession();

    if (!auth) return false;

    if (thisDeviceConnected === null) {
      const listed = yield* Effect.tryPromise({ try: () => listCloudDevices(auth.origin, auth.token), catch: (error) => ({ error }) }).pipe(
        // An unreachable cloud is not evidence of no device; a malformed origin is a local bug and must throw.
        Effect.catch((failed) => (classify({ cause: failed.error }) === 'malformed-input' ? Effect.die(failed.error) : Effect.succeed(null))),
      );

      if (listed === null) return false;
      thisDeviceConnected = listed.some((device) => device.connected && isThisMachine(device));
    }

    if (thisDeviceConnected) return false;
    offerConsumed = true;

    return true;
  }));
}

export async function dismissDeviceConnectPrompt(): Promise<void> {
  await updateConfigFile((config) => {
    config.deviceConnectPromptDismissed = true;
  });
}

export function deviceStatusLine(): Promise<string> {
  return settle(Effect.tryPromise({
    try: async () => {
      const auth = requireAuthConfig();

      return listCloudDevices(auth.origin, auth.token);
    },
    catch: (err) => ({ err }),
  }).pipe(Effect.match({
    onFailure: ({ err }) => `Device status unavailable: ${renderThrownChain({ cause: err })}`,
    onSuccess: (devices) => {
      thisDeviceConnected = devices.some((device) => device.connected && isThisMachine(device));
      const connected = devices.filter((device) => device.connected);

      if (connected.length > 0) {
        const named = connected.map((device) => `${device.label} (${device.wholeMachine ? 'whole machine' : sandboxStateTag(device.sandbox)})`);

        return `Connected: ${named.join(', ')}`;
      }

      if (devices.length > 0) return `${devices.length} registered device${devices.length === 1 ? '' : 's'}, none connected.`;

      return 'No PC is connected to your account yet.';
    },
  })));
}

export function describeConnectOutcome(result: ConnectDeviceResult, session: boolean): ConnectOutcomeDescription {
  switch (result.kind) {
    case 'already-running':
      return result.connected
        ? { ok: true, message: 'This PC is already connected.' }
        : { ok: false, message: 'The daemon is installed here but not connected. Run: kinu connect' };
    case 'cancelled':
      return { ok: false, message: 'Stopped waiting for the daemon. It keeps trying to connect; check: kinu desktop logs' };
    case 'connected':
      return {
        ok: true,
        message: session
          ? 'Connected for this session. The daemon stops when you leave the CLI.'
          : 'Connected. This PC stays connected after you leave the CLI.',
      };
  }
}

export interface WaitingDots {
  readonly onWaiting: () => void;
  readonly end: () => void;
}

export function waitingDots(indent: string): WaitingDots {
  let waiting = false;

  return {
    onWaiting: () => {
      if (!waiting) {
        process.stdout.write(DIM(`${indent}Waiting for the daemon to connect`));
        waiting = true;
      }

      process.stdout.write(DIM('.'));
    },
    end: () => {
      if (waiting) process.stdout.write('\n');
    },
  };
}

/** The fix sentence comes from `@kinu.run/core`; the daemon's reason code is not printed. */
export function describeDeviceSandbox(sandbox: CloudDeviceSandbox, wholeMachine = false): string[] {
  if (wholeMachine) {
    return ['Linked from /, so the agent has this whole machine: every file you can open, and its commands run as you.'];
  }

  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed':
      return [
        'Sandbox on. The agent sees its home plus the folders you picked. Your other files stay invisible.'
        + ` GPU: ${describeGpuNodes(sandbox.gpu)}.`,
      ];
    case 'raw':
      return ['Sandbox is OFF for this device. Commands run as you, with full access.'];
    case 'files_only':
      return [
        'This machine cannot sandbox.',
        ...(sandbox.detail === null ? [] : [`The daemon said: ${sandbox.detail}`]),
        sandboxReasonFix(sandbox.reason),
        'Nothing runs here until you fix that, or turn Sandbox off for this device.',
      ];
  }
}

function sandboxStateTag(sandbox: CloudDeviceSandbox): string {
  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed': return 'sandbox on';
    case 'raw': return 'sandbox OFF';
    case 'files_only': return 'cannot sandbox';
  }
}

let sessionDaemon: ChildProcess | null = null;

let sessionCleanupInstalled = false;

interface DaemonLaunch {
  child: ChildProcess;
  failure: KinuError | null;
}

function listingFailure(auth: DeviceAuth, doing: string, { cause }: { readonly cause: unknown }): KinuError {
  return new KinuError(
    classifyErrorCode({ cause }) ?? 'unavailable',
    doing,
    { cause: new Error(redactSecrets(renderThrownChain({ cause }), [auth.token])) },
  );
}

function listDevicesForConnect(auth: DeviceAuth, doing: string): Effect.Effect<CloudDevice[], KinuError> {
  return Effect.tryPromise({ try: () => listCloudDevices(auth.origin, auth.token), catch: (cause) => listingFailure(auth, doing, { cause }) });
}

/** This machine's token on `origin`: linking again replaces its registration. */
function previousDeviceToken(origin: string): string | undefined {
  const text = tolerate(() => readFileSync(DEVICE_CONFIG_PATH, 'utf-8'), 'enoent');

  if (text === undefined) return undefined;
  const parsed = v.safeParse(PreviousDeviceSchema, tolerate(() => JSON.parse(text), 'malformed-input'));

  if (!parsed.success || parsed.output.origin.replace(/\/+$/, '') !== origin.replace(/\/+$/, '')) return undefined;

  return parsed.output.token;
}

const PreviousDeviceSchema = v.object({ origin: v.string(), token: v.string() });

function registerDeviceForConnect(auth: DeviceAuth, label: string | undefined, replaces: string | undefined) {
  return Effect.tryPromise({
    try: () => registerCloudDevice(auth.origin, auth.token, label, replaces),
    catch: (cause) => {
      const detail = redactSecrets(renderThrownChain({ cause }), [auth.token, ...(replaces === undefined ? [] : [replaces])]);

      if (/\b(?:duplicate|already exists|already in use)\b/i.test(detail)) {
        return new KinuError(
          'bad_input',
          'that device name is already registered; choose another name',
          { cause: new Error(detail) },
        );
      }

      return new KinuError(
        classifyErrorCode({ cause }) ?? 'unavailable',
        'registering this device with Kinu',
        { cause: new Error(detail) },
      );
    },
  });
}

function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;

  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[redacted]');
  }

  return redacted;
}

const io = <A>(doing: string, run: () => A): Effect.Effect<A, KinuError> =>
  Effect.try({ try: run, catch: (cause) => toKinuError({ doing, cause, otherwise: 'io' }) });

const failedWhile = (doing: string, { cause }: { readonly cause: unknown }): Effect.Effect<never, KinuError> =>
  Effect.fail(cause instanceof KinuError ? cause : toKinuError({ doing, cause, otherwise: 'io' }));

const removeAfter = (doing: string, { cause }: { readonly cause: unknown }, paths: readonly (string | null)[]): Effect.Effect<void, KinuError> => Effect.try({
  try: () => {
    for (const path of paths) {
      if (path !== null) rmSync(path, { force: true });
    }
  },
  catch: (cleanup) => toKinuError({ doing, cause: new AggregateError([cause, cleanup], 'device install and cleanup both failed'), otherwise: 'io' }),
});

function installDaemonFiles(device: { origin: string; userId: string; token: string }): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    yield* io(`preparing the device install directory ${AGENT_HOME}`, () => {
      ensureAgentHome();
      ensureAgentRoot();
    });

    const config = `${JSON.stringify({
      user: device.userId,
      token: device.token,
      origin: device.origin.replace(/\/+$/, ''),
      // The directory `kinu connect` ran in is the consented root.
      root: process.cwd(),
    }, null, 2)}\n`;

    const scriptTemporary = yield* stageInstallFile(SCRIPT_PATH, PC_AGENT_DAEMON_SOURCE, 0o700);

    // Siblings ship with the release, never fetched.
    const siblingTemporaries = yield* Effect.forEach(daemonSiblings(), (sibling) => Effect.map(
      stageInstallFile(join(AGENT_HOME, sibling.name), sibling.source, 0o700),
      (temporary) => ({ target: join(AGENT_HOME, sibling.name), temporary }),
    ));

    const stampTemporary = yield* stageInstallFile(VERSION_STAMP_PATH, `${VERSION}\n`, 0o600);

    let scriptPending: string | null = scriptTemporary;
    let stampPending: string | null = stampTemporary;
    const siblingsPending = new Set(siblingTemporaries.map((entry) => entry.temporary));
    let configPending: string | null = null;

    const land = Effect.gen(function* () {
      const configTemporary = yield* stageInstallFile(DEVICE_CONFIG_PATH, config, 0o600);

      configPending = configTemporary;

      // Siblings land before the daemon and the config lands last, so a crash never leaves a daemon beside missing siblings
      // or new credentials beside an unverified script.
      yield* Effect.try({
        try: () => {
          for (const entry of siblingTemporaries) {
            renameSync(entry.temporary, entry.target);
            siblingsPending.delete(entry.temporary);
            enforceOwnerOnly(entry.target, 0o700);
          }

          renameSync(scriptTemporary, SCRIPT_PATH);
          scriptPending = null;
          enforceOwnerOnly(SCRIPT_PATH, 0o700);
          // The stamp lands after the daemon; a crash leaves an old stamp, which the hub reads as behind and re-lands.
          renameSync(stampTemporary, VERSION_STAMP_PATH);
          stampPending = null;
          enforceOwnerOnly(VERSION_STAMP_PATH, 0o600);
          rmSync(UPDATE_PENDING_PATH, { force: true });
          renameSync(configTemporary, DEVICE_CONFIG_PATH);
          configPending = null;
          enforceOwnerOnly(DEVICE_CONFIG_PATH, 0o600);
          syncAgentDirectory();
        },
        catch: (cause) => cause,
      });
    });

    yield* Effect.catch(land, (cause) => Effect.andThen(
      removeAfter('cleaning up a failed device install', { cause }, [scriptPending, stampPending, ...siblingsPending, configPending]),
      failedWhile('installing the device daemon', { cause }),
    ));
  });
}

function stageInstallFile(file: string, content: string, mode: number): Effect.Effect<string, KinuError> {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let created = false;

  return Effect.try({
    try: () => {
      const descriptor = openSync(temporary, 'wx', mode);
      created = true;

      try {
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }

      enforceOwnerOnly(temporary, mode);

      return temporary;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => Effect.andThen(
    created ? removeAfter(`cleaning up the failed device install at ${file}`, { cause }, [temporary]) : Effect.void,
    failedWhile(`preparing the device install at ${file}`, { cause }),
  )));
}

/** Byte equality with the daemon this CLI carries; a served digest would only prove the download arrived whole. */
function syncAgentDirectory(): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(AGENT_HOME, 'r');

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Ends only when the roster row reads connected, the daemon exits, or the user interrupts. No deadline. */
function waitForDeviceConnected(
  auth: DeviceAuth,
  deviceId: string,
  launch: DaemonLaunch,
  opts: Pick<ConnectDeviceOptions, 'onWaiting' | 'signal'>,
): Effect.Effect<CloudDevice | undefined, KinuError> {
  return Effect.suspend(() => {
    const stop = new AbortController();
    const stopOnCaller = () => stop.abort();
    opts.signal?.addEventListener('abort', stopOnCaller, { once: true });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const outcome = signal ?? (code === null ? 'unknown exit' : `exit code ${code}`);
      launch.failure = new KinuError(
        'unavailable',
        `the device daemon exited before it could connect (${outcome}). Its last lines:\n${daemonTailForFailure()}\nSee ${DAEMON_LOG_PATH}`,
      );
      stop.abort();
    };

    const onError = () => stop.abort();
    launch.child.once('exit', onExit);
    // spawnDaemonChild's own listener records the failure; this one ends the wait.
    launch.child.once('error', onError);

    if (launch.failure !== null) stop.abort();
    const wait: StoppableWaitOptions = { intervalMs: CONNECT_POLL_MS, signal: stop.signal };

    if (opts.onWaiting) wait.onWaiting = opts.onWaiting;

    const connecting = Effect.gen(function* () {
      const connected = yield* Effect.promise(() => waitForAnswer(async () => {
        // A transient GET error while the daemon lives is not-yet; recorded as a shape, never a sentinel a healthy answer could return.
        let miss: { readonly transient: string } | undefined;
        let rows: CloudDevice[] | undefined;

        try {
          rows = await listCloudDevices(auth.origin, auth.token);
        } catch (thrown) {
          const cause = listingFailure(auth, 'checking whether the device daemon connected', { cause: thrown });
          const failure = toKinuError({ doing: 'checking whether the device daemon connected', cause, otherwise: 'unavailable' });
          diagnostics.failure('device.connect.list_transient', failure);
          miss = { transient: renderThrownChain({ cause: failure }) };
        }

        if (miss !== undefined) {
          diagnostics.event('device.connect.list_transient_not_yet', { detail: miss.transient });

          return undefined;
        }

        return rows?.find((device) => device.id === deviceId && device.connected);
      }, wait));

      if (connected !== undefined) return connected;

      if (launch.failure !== null) return yield* launch.failure;

      return undefined;
    });

    return Effect.ensuring(connecting, Effect.sync(() => {
      launch.child.off('exit', onExit);
      launch.child.off('error', onError);
      opts.signal?.removeEventListener('abort', stopOnCaller);
    }));
  });
}

function daemonTailForFailure(): string {
  return readDaemonLogTail(DAEMON_LOG_PATH, 15) ?? `no daemon log yet at ${DAEMON_LOG_PATH}`;
}

function startInstalledDaemon(session: boolean, runtime?: string): Effect.Effect<DaemonLaunch, KinuError> {
  return Effect.gen(function* () {
    yield* assertDaemonPlatformSupported();
    yield* io(`preparing the device install directory ${AGENT_HOME}`, () => { ensureAgentHome(); });
    const executable = runtime ?? (yield* daemonRuntime());
    yield* stopSessionDaemon();

    if (!session) yield* stopRunningDaemon();

    const launch = yield* spawnDaemonChild(executable, session);

    if (session) {
      sessionDaemon = launch.child;
      installSessionCleanup();

      return launch;
    }

    const pid = launch.child.pid;

    if (!pid) return launch;

    const claimed = yield* Effect.catch(claimDaemonPid(pid), (failure) => Effect.andThen(stopChild(launch.child), Effect.fail(failure)));

    if (!claimed) {
      yield* stopChild(launch.child);

      return yield* new KinuError(
        'unavailable',
        'another device connect is already starting the daemon on this machine; retry in a moment',
      );
    }

    launch.child.unref();

    return launch;
  });
}

function spawnDaemonChild(runtime: string, session: boolean): Effect.Effect<DaemonLaunch, KinuError> {
  return Effect.gen(function* () {
    const logDescriptor = yield* io(`opening the device daemon log at ${DAEMON_LOG_PATH}`, () => {
      // Roll before the append fd exists; copy-truncate keeps the inode so later rolls also cap a running daemon.
      rotateDaemonLogIfNeeded(DAEMON_LOG_PATH);

      return openSync(DAEMON_LOG_PATH, 'a');
    });

    return yield* Effect.ensuring(io('starting the device daemon', () => {
      const child = spawn(runtime, isolatedBunArgs(SCRIPT_PATH, []), session
        ? { cwd: dirname(SCRIPT_PATH), stdio: ['ignore', logDescriptor, logDescriptor] }
        : { cwd: dirname(SCRIPT_PATH), detached: true, stdio: ['ignore', logDescriptor, logDescriptor] });

      const launch: DaemonLaunch = { child, failure: null };
      child.once('error', (cause) => {
        launch.failure = toKinuError({ doing: 'starting the device daemon', cause, otherwise: 'io' });
      });

      return launch;
    }), Effect.sync(() => { closeSync(logDescriptor); }));
  });
}

function recordedDaemonPid(): Effect.Effect<number | null, KinuError> {
  if (!existsSync(PID_PATH)) return Effect.succeed(null);

  return Effect.map(io(`reading the device daemon pidfile at ${PID_PATH}`, () => readFileSync(PID_PATH, 'utf-8')), (contents) => {
    const pid = Number(contents.trim());

    return Number.isInteger(pid) && pid > 0 ? pid : null;
  });
}

function runningDaemonPid(): Effect.Effect<number | null, KinuError> {
  return Effect.flatMap(recordedDaemonPid(), (pid) => (pid === null
    ? Effect.succeed(null)
    : Effect.map(processAlive(pid), (alive) => (alive ? pid : null))));
}

function claimDaemonPid(pid: number): Effect.Effect<boolean, KinuError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (yield* writePidfile(pid)) return true;

      const recorded = yield* recordedDaemonPid();

      // The daemon claims this same file, so a pidfile naming this pid is this claim.
      if (recorded === pid) return true;

      if (recorded !== null && (yield* processAlive(recorded))) return false;
      yield* removePidfileNaming(recorded);
    }

    return false;
  });
}

/**
 * Publishes `pid` as the machine's daemon, or answers false when a pidfile is already there. The pidfile appears whole
 * or not at all: the pid is written to a file of its own under {@link CLAIMS_DIR} and linked into place, which fails
 * when one exists. An exclusive create written afterwards left an empty pidfile for a moment, which the other claimant
 * (this or the daemon's `claimMachine`) read as stale and removed: two connects at once each claimed and returned with
 * two daemons running (4 in 360 runs of "concurrent connects leave one daemon owner", 2026-10-08). The daemon claims
 * the same way.
 */
function writePidfile(pid: number): Effect.Effect<boolean, KinuError> {
  const claim = join(CLAIMS_DIR, `${pid}-${randomBytes(8).toString('hex')}`);

  const publish = Effect.try({
    try: () => {
      mkdirSync(CLAIMS_DIR, { recursive: true, mode: 0o700 });
      const descriptor = openSync(claim, 'wx', 0o600);

      try {
        writeFileSync(descriptor, `${pid}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }

      linkSync(claim, PID_PATH);
      syncAgentDirectory();

      return true;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => (classify({ cause }) === 'eexist'
    ? Effect.succeed(false)
    : Effect.fail(toKinuError({ doing: `writing the device daemon pidfile at ${PID_PATH}`, cause, otherwise: 'io' })))));

  return Effect.ensuring(publish, Effect.sync(() => { rmSync(claim, { force: true }); }));
}

function stopRunningDaemon(): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const recorded = yield* recordedDaemonPid();
    const running = recorded !== null && (yield* processAlive(recorded));

    if (running && (yield* processIsInstalledDaemon(recorded))) yield* stopInstalledDaemon(recorded);

    yield* removePidfileNaming(recorded);
  });
}

/**
 * Removes the pidfile only while it still names `pid` (null: one naming no pid). It is moved aside whole and read; one
 * naming another pid is a claim made since `pid` was read, and is linked back. A plain remove after the check removed
 * such a claim: a connect that waited for the old daemon to exit removed the claim another connect made meanwhile, and
 * both started a daemon (2026-10-08). The daemon removes its pidfile the same way.
 */
function removePidfileNaming(pid: number | null): Effect.Effect<void, KinuError> {
  const aside = join(CLAIMS_DIR, `aside-${process.pid}-${randomBytes(8).toString('hex')}`);

  return io(`removing the stale device daemon pidfile at ${PID_PATH}`, () => {
    mkdirSync(CLAIMS_DIR, { recursive: true, mode: 0o700 });

    const moved = tolerate(() => {
      renameSync(PID_PATH, aside);

      return true;
    }, 'enoent');

    if (moved === undefined) return;
    const named = Number(readFileSync(aside, 'utf-8').trim());

    if ((Number.isInteger(named) && named > 0 ? named : null) !== pid) tolerate(() => { linkSync(aside, PID_PATH); }, 'eexist');
    rmSync(aside, { force: true });
  });
}

/**
 * A stopped daemon drains before it exits (`exitWhenQuiet`), and until it exits the machine runs two. So a connect that
 * stops one waits for its exit, with no deadline, before it goes on: two connects at once left two daemons running
 * after both returned (3 in 120 runs of "concurrent connects leave one daemon owner", a8baa8c24, 2026-10-08).
 */
function stopChild(child: ChildProcess): Effect.Effect<void> {
  return Effect.promise(() => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const exited = Promise.withResolvers<void>();

    child.once('exit', () => { exited.resolve(); });
    tolerate(() => child.kill('SIGTERM'), 'esrch');

    return exited.promise;
  });
}

/** How often a connect looks again for a daemon it stopped that is not its own child; the wait ends on the exit. */
const STOP_POLL_MS = 50;

/** The installed daemon a pidfile names, stopped as {@link stopChild} stops a child: the wait ends when it is gone. */
function stopInstalledDaemon(pid: number): Effect.Effect<void, KinuError> {
  return Effect.andThen(
    io(`stopping the device daemon (pid ${pid})`, () => tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch')),
    Effect.tryPromise({
      try: () => waitForAnswer(async () => (stillInstalledDaemon(pid) ? undefined : true), { intervalMs: STOP_POLL_MS }),
      catch: (cause) => toKinuError({ doing: `waiting for the device daemon (pid ${pid}) to exit`, cause, otherwise: 'io' }),
    }),
  );
}

/** On Linux by {@link linuxRunsInstalledDaemon}; elsewhere by presence. */
function stillInstalledDaemon(pid: number): boolean {
  if (process.platform === 'linux') return linuxRunsInstalledDaemon(pid);

  return tolerate(() => process.kill(pid, 0), 'esrch') !== undefined;
}

/** `/proc/<pid>/<file>`, or undefined when the process is gone: no entry, or reaped mid-read (ESRCH). */
function procRead(pid: number, file: string): string | undefined {
  return tolerate(() => tolerate(() => readFileSync(`/proc/${pid}/${file}`, 'utf-8'), 'enoent'), 'esrch');
}

/**
 * Whether `pid` runs the installed daemon. A process just spawned has an empty command line until its exec lands
 * (empty right after `spawn` in 1,442 of 1,600 bun spawns on armada, 2026-10-08), so an empty one that is no zombie is
 * the daemon its starter just recorded. Reading it as another program let a second connect remove a fresh claim and
 * start a second daemon. A zombie, an exited daemon not yet reaped, has an empty command line too, and is gone.
 */
function linuxRunsInstalledDaemon(pid: number): boolean {
  const args = procRead(pid, 'cmdline');

  if (args === undefined) return false;

  if (args !== '') return args.split('\0').includes(SCRIPT_PATH);
  const stat = procRead(pid, 'stat') ?? '';
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);

  return state !== '' && state !== 'Z';
}

const PS_NO_SUCH_PROCESS = 1;

function psCommand(pid: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }, (cause, stdout) => {
    if (cause) reject(cause);
    else resolve(stdout);
  });

  return promise;
}

function processIsInstalledDaemon(pid: number): Effect.Effect<boolean, KinuError> {
  return Effect.tryPromise({
    try: async () => {
      if (process.platform === 'linux') return linuxRunsInstalledDaemon(pid);

      if (process.platform === 'darwin') return (await psCommand(pid)).includes(SCRIPT_PATH);

      return false;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => {
    if (classify({ cause }) === 'enoent') return Effect.succeed(false);

    if (cause instanceof Error && 'code' in cause && (cause.code === 'EACCES' || cause.code === 'EPERM')) {
      return Effect.succeed(false);
    }

    if (process.platform === 'darwin' && cause instanceof Error && 'code' in cause && cause.code === PS_NO_SUCH_PROCESS) {
      return Effect.succeed(false);
    }

    return Effect.fail(toKinuError({
      doing: `checking whether pid ${pid} is the installed device daemon`,
      cause,
      otherwise: 'io',
    }));
  }));
}

export function killSessionDaemon(): void {
  return settleSync(stopSessionDaemon());
}

function stopSessionDaemon(): Effect.Effect<void, KinuError> {
  return Effect.suspend(() => {
    const daemon = sessionDaemon;

    const stopping = daemon && daemon.exitCode === null && !daemon.killed
      ? io('stopping the session device daemon', () => { tolerate(() => daemon.kill('SIGTERM'), 'esrch'); })
      : Effect.void;

    return Effect.andThen(stopping, Effect.sync(() => { sessionDaemon = null; }));
  });
}

function installSessionCleanup(): void {
  if (sessionCleanupInstalled) return;
  sessionCleanupInstalled = true;
  process.on('exit', () => {
    killSessionDaemon();
  });
}

/** `kill(pid, 0)` reports presence under another user as EPERM, not only absence as ESRCH. */
function processAlive(pid: number): Effect.Effect<boolean, KinuError> {
  return Effect.try({
    try: () => {
      process.kill(pid, 0);

      return true;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => {
    if (classify({ cause }) === 'esrch') return Effect.succeed(false);

    if (cause instanceof Error && 'code' in cause && cause.code === 'EPERM') return Effect.succeed(true);

    return Effect.fail(toKinuError({ doing: `checking whether the device daemon pid ${pid} is running`, cause, otherwise: 'io' }));
  }));
}

function assertDaemonPlatformSupported(): Effect.Effect<void, KinuError> {
  if (process.platform === 'linux' || process.platform === 'darwin') return Effect.void;

  return Effect.fail(new KinuError('unsupported', 'The daemon runs on Linux and macOS only.'));
}

/** The Bun running this CLI; PATH `node` is never used, since the daemon needs `globalThis.WebSocket`. */
function daemonRuntime(): Effect.Effect<string, KinuError> {
  if ('bun' in process.versions) return Effect.succeed(process.execPath);

  return Effect.fail(new KinuError(
    'unsupported',
    'The Kinu CLI must run under its bundled Bun to start the desktop daemon.',
  ));
}
