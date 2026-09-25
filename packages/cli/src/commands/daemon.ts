import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import type { HostedAgentRef } from '@kinu.run/core';
import {
  LocalAgentHost,
  openWorkspaceCLI,
  writeSecretFile,
  type LocalHostedAgent,
  type SessionEvent,
} from '@kinu.run/cli-backend';
import {
  AGENT_HOME,
  agentDbPath,
  CONFIG_PATH,
  createOAuthStore,
  ensureAgentHome,
  listLocalRefsAllProjects,
  readProviderRevision,
  resolveMcpServers,
  resolveProviderCredentials,
} from '../config';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import { createProfileAuthorityReader } from '../profiles';
import { appendDaemonLog, readDaemonLogTail } from '../daemon-log';
import { DIM, OK, WARN } from '../display';

const PID_PATH = join(AGENT_HOME, 'daemon.pid');

const LOG_PATH = join(AGENT_HOME, 'daemon.log');

const MAX_SLEEP_MS = 30_000;

const MIN_SLEEP_MS = 500;

/** SIGTERM grace before escalating — a tick mid-agent-turn takes a moment. */
const STOP_GRACE_MS = 5_000;

const STOP_FORCE_MS = 2_000;

export async function daemonCommand(action: string | undefined, agent?: string): Promise<void> {
  const sub = action ?? 'status';

  if (sub === 'start') {
    const pid = startDaemon();
    console.log(pid !== null
      ? `${OK('✓')} Local scheduler daemon started ${DIM(`pid ${pid} · ${LOG_PATH}`)}`
      : `${DIM('Local scheduler daemon is already running')} ${DIM(LOG_PATH)}`);

    return;
  }

  if (sub === 'stop') {
    const pid = await stopDaemon();
    console.log(pid !== null
      ? `${OK('✓')} Local scheduler daemon stopped ${DIM(`pid ${pid}`)}`
      : DIM('Local scheduler daemon is not running'));

    return;
  }

  if (sub === 'restart') {
    const stopped = await stopDaemonForRestart();
    const pid = startDaemon();

    if (pid === null) throw new Error(`Local scheduler daemon failed to start. See ${LOG_PATH}`);
    console.log(stopped !== null
      ? `${OK('✓')} Local scheduler daemon restarted ${DIM(`pid ${stopped} → ${pid} · ${LOG_PATH}`)}`
      : `${OK('✓')} Local scheduler daemon started ${DIM(`pid ${pid} · ${LOG_PATH}`)} ${DIM('(it was not running)')}`);

    return;
  }

  if (sub === 'status') {
    const pid = readLivePid();
    console.log(`${DIM('Local scheduler:')} ${pid ? OK(`running pid ${pid}`) : WARN('stopped')}`);
    console.log(`${DIM('Log:')} ${LOG_PATH}`);

    return;
  }

  if (sub === 'logs') {
    const tail = readDaemonLogTail(LOG_PATH, 120);
    console.log(tail ?? DIM(`No daemon log at ${LOG_PATH}`));

    return;
  }

  if (sub === 'shell') {
    await runDaemonLoop();

    return;
  }

  // One foreground pass of the daemon-owned host for machines without a resident daemon.
  if (sub === 'tick') {
    ensureAgentHome();
    const host = createDaemonHost();
    const unsubscribe = host.subscribe(logSessionEvent);

    try {
      const refs = listLocalRefsAllProjects();
      const due = agent ? refs.filter((ref) => ref.name === agent) : refs;

      if (agent && due.length === 0) {
        throw new Error(`No local agent "${agent}" is placed in a project. `
          + 'Create it with `kinu create`, or open it from `kinu list` to place it in this project.');
      }

      const now = Date.now();

      for (const ref of due) {
        const result = await host.tick(ref.name, now);
        const where = DIM(`${ref.workspaceId} · ${ref.cwd}`);
        // A pass another driver owns converted nothing here; name the holder instead of printing a tick.
        console.log(result.ran
          ? `${OK('✓')} ticked ${ref.name} ${where}`
          : `${WARN('⋯')} deferred ${ref.name} ${DIM(`the ${result.heldBy?.kind ?? 'other'} driver`
            + `${result.heldBy ? ` in process ${String(result.heldBy.pid)}` : ''} is running it`)} ${where}`);
      }
    } finally {
      unsubscribe();
      await host.close();
    }

    return;
  }

  throw new Error('Usage: kinu daemon [start|stop|restart|status|logs|tick [workspace]]');
}

export function ensureLocalDaemonRunning(): void {
  // Skip daemon startup when explicitly disabled (e.g. in tests).
  if (process.env.KINU_SKIP_DAEMON === '1') return;
  startDaemon({ quiet: true });
}

/** The new daemon's pid, or null when a live daemon already owns the pidfile. */
function startDaemon(opts: { quiet?: boolean } = {}): number | null {
  ensureAgentHome();

  if (readLivePid()) return null;

  const entry = process.argv[1];

  if (!entry) {
    if (!opts.quiet) throw new Error('Cannot locate Kinu CLI entrypoint for daemon startup.');

    return null;
  }

  // Spawning a daemon from a test entry would re-run the test and fork forever. Match the file's basename only:
  // a checkout path containing "test" is not a test script.
  if (/test|spec|e2e/i.test(basename(entry))) {
    if (!opts.quiet) throw new Error(`Refusing to start daemon from a test script: ${entry}`);

    return null;
  }

  const logFd = openSync(LOG_PATH, 'a');

  try {
    const child = spawn(process.execPath, [entry, 'daemon', 'shell'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });

    child.unref();
    writePid(child.pid);

    return child.pid ?? null;
  } finally {
    closeSync(logFd);
  }
}

/** Waits for the reap: the daemon unlinks its pidfile on exit, so a replacement started earlier would lose its
 * pidfile to the old one. */
async function stopDaemon(): Promise<number | null> {
  return stopDaemonUntil(isReaped);
}

/** Waits only for the old pidfile unlink, which precedes the reap; fixed reap caps fail under load. A pidfile
 * outliving grace still escalates to SIGKILL. */
async function stopDaemonForRestart(): Promise<number | null> {
  return stopDaemonUntil(isReleased);
}

/** Shared escalation: SIGTERM, grace, SIGKILL, force, then admit defeat. */
async function stopDaemonUntil(released: (pid: number) => boolean): Promise<number | null> {
  const pid = readLivePid();

  if (pid === null) return null;

  // ESRCH is the one tolerable outcome; EPERM means alive and not ours.
  tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');

  if (!await waitUntilRelease(pid, released, STOP_GRACE_MS)) {
    tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');

    if (!await waitUntilRelease(pid, released, STOP_FORCE_MS)) {
      throw new Error(`Local scheduler daemon (pid ${pid}) did not exit.`);
    }
  }

  // The daemon unlinks its own pidfile on exit, so it is often already gone.
  tolerate(() => unlinkSync(PID_PATH), 'enoent');

  return pid;
}

function isReaped(pid: number): boolean {
  return tolerate(() => process.kill(pid, 0), 'esrch') === undefined;
}

/** Pidfile gone, or pid dead: either precedes the reap, so a starved reaper cannot fail it. */
function isReleased(pid: number): boolean {
  return !existsSync(PID_PATH) || isReaped(pid);
}

async function waitUntilRelease(
  pid: number,
  released: (pid: number) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (released(pid)) return true;

    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

function soonest(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;

  return current === null ? candidate : Math.min(current, candidate);
}

async function runDaemonLoop(): Promise<void> {
  ensureAgentHome();
  writePid(process.pid);
  log('local scheduler daemon started');
  let stopping = false;
  let wakeFromSleep: (() => void) | null = null;
  const stop = () => { stopping = true; wakeFromSleep?.(); };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  /** A peer outbox retry armed while asleep; cleared by the pass that honours it. */
  let armedAt: number | null = null;

  const host = createDaemonHost((at) => {
    armedAt = armedAt === null ? at : Math.min(armedAt, at);

    if (at <= Date.now()) wakeFromSleep?.();
  });

  const unsubscribe = host.subscribe(logSessionEvent);

  try {
    while (!stopping) {
      const now = Date.now();
      let nextAt: number | null = armedAt;
      armedAt = null;

      // Every placed local agent in every project; the start directory decides nothing.
      for (const ref of listLocalRefsAllProjects()) {
        try {
          const result = await host.tick(ref.name, now);
          nextAt = soonest(nextAt, result.nextAt);
        } catch (error) {
          log(`${ref.name}: ${renderThrownChain({ cause: error })}`);
        }
      }

      const delay = nextAt === null
        ? MAX_SLEEP_MS
        : Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, nextAt - Date.now()));

      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, delay);
        wakeFromSleep = wake;

        function wake() {
          clearTimeout(timer);
          wakeFromSleep = null;
          resolve();
        }
      });
    }
  } finally {
    unsubscribe();
    await host.close();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    log('local scheduler daemon stopped');
    tolerate(() => unlinkSync(PID_PATH), 'enoent');
  }
}

function createDaemonHost(wakeAt?: (at: number) => void): LocalAgentHost {
  const options = {
    roster: listLocalRefsAllProjects,
    dbPath: agentDbPath,
    open: openDaemonAgent,
    // Both callers are the daemon. As `interactive` the resident daemon would hold every lease forever and no
    // foreground driver could preempt it.
    driverKind: 'daemon' as const,
  };

  return new LocalAgentHost(wakeAt ? { ...options, wakeAt } : options);
}

/** Installs the same profile authority as interactive clients, so a role resolves identically in both. */
async function openDaemonAgent(
  ref: HostedAgentRef,
  db: Database,
  dbPath: string,
): Promise<LocalHostedAgent> {
  const { llmConfig, resolver: modelResolver } =
    createConfiguredLocalModelResolver({ agentName: ref.name });

  const openConfig = {
    llm: llmConfig,
    providerCredentials: resolveProviderCredentials(),
    oauthStore: createOAuthStore(),
    oauthConfigPath: CONFIG_PATH,
    // The ref's stored directory, never process.cwd(): a daemon serves every project.
    cwd: ref.cwd,
  };

  const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

  return {
    rt,
    openConfig,
    modelResolver,
    mcpServers: resolveMcpServers(),
    profileAuthority: createProfileAuthorityReader(),
    // A resident daemon stays bound for days; `kinu provider connect` happens in processes it cannot see.
    providerRevision: readProviderRevision,
  };
}

function logSessionEvent(agentName: string, event: SessionEvent): void {
  if (event.type === 'turn-start') log(`${agentName}: ${event.kind} turn ${event.event ?? ''}`.trim());

  if (event.type === 'turn-end') log(`${agentName}: turn completed in ${event.turn.durationMs}ms`);

  if (event.type === 'error') log(`${agentName}: error: ${event.message}`);

  if (event.type === 'evolution' || event.type === 'background') log(`${agentName}: [${event.event}] ${event.message}`);
}

function readLivePid(): number | null {
  const contents = tolerate(() => readFileSync(PID_PATH, 'utf-8'), 'enoent');

  if (contents === undefined) return null;
  const pid = Number(contents.trim());

  if (!Number.isInteger(pid) || pid <= 0) return null;

  // Only ESRCH means a stale pidfile; EPERM is a live process that is not ours.
  if (tolerate(() => process.kill(pid, 0), 'esrch') === undefined) {
    tolerate(() => unlinkSync(PID_PATH), 'enoent');

    return null;
  }

  return pid;
}

function writePid(pid: number | undefined): void {
  if (!pid) return;
  writeSecretFile(PID_PATH, `${pid}\n`);
}

function log(message: string): void {
  appendDaemonLog(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
}
