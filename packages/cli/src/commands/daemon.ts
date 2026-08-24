import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  createCodexAuthStore,
  ensureAgentHome,
  listLocalRefsAllProjects,
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
    const stopped = await stopDaemon();
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
    console.log(tail === null ? DIM(`No daemon log at ${LOG_PATH}`) : tail);
    return;
  }
  if (sub === 'run') {
    await runDaemonLoop();
    return;
  }
  // One foreground pass of the daemon-owned host for machines without a
  // resident daemon. It drives the same recovery/event/trigger/evolution/
  // peer-outbox path once, then releases every agent handle.
  if (sub === 'tick') {
    ensureAgentHome();
    const host = createDaemonHost();
    const unsubscribe = host.subscribe(logSessionEvent);
    try {
      const refs = listLocalRefsAllProjects();
      const due = agent ? refs.filter((ref) => ref.name === agent) : refs;
      if (agent && due.length === 0) {
        throw new Error(`No local agent "${agent}" is placed in a project — `
          + 'create it with `kinu create` or adopt it with `kinu adopt`.');
      }
      const now = Date.now();
      for (const ref of due) {
        await host.tick(ref.name, now);
        console.log(`${OK('✓')} ticked ${ref.name} ${DIM(`${ref.workspaceId} · ${ref.cwd}`)}`);
      }
    } finally {
      unsubscribe();
      await host.close();
    }
    return;
  }
  throw new Error('Usage: kinu daemon [start|stop|restart|status|logs|run|tick [agent]]');
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

  // Guard against recursive spawning: if the entry point is a test script
  // (not the real CLI), spawning a daemon child would re-execute the test,
  // which would call ensureLocalDaemonRunning() again, creating an infinite
  // fork loop.  Refuse silently in quiet mode, throw loudly otherwise.
  // The FILE is what decides — a checkout whose path merely contains
  // "test"/"spec"/"e2e" (a worktree name, a user's directory) is not a test
  // script, and matching the whole path made the real CLI refuse its daemon
  // from such a checkout.
  if (/test|spec|e2e/i.test(basename(entry))) {
    if (!opts.quiet) throw new Error(`Refusing to start daemon from a test script: ${entry}`);
    return null;
  }

  const logFd = openSync(LOG_PATH, 'a');
  try {
    const child = spawn(process.execPath, [entry, 'daemon', 'run'], {
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

/**
 * Stop the daemon and wait for the process to actually be gone — the pidfile
 * is the daemon's own, and it unlinks it on exit, so starting a replacement
 * before the old one dies lets the corpse delete the new daemon's pidfile.
 *
 * Returns the pid that was stopped, or null when nothing was running.
 */
async function stopDaemon(): Promise<number | null> {
  const pid = readLivePid(); // clears a stale pidfile on its way out
  if (pid === null) return null;

  // A pid that vanished between the liveness probe and the signal is the one
  // tolerable outcome; EPERM means it is alive and not ours, and claiming we
  // stopped it would be a lie.
  tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');
  if (!await waitForExit(pid, STOP_GRACE_MS)) {
    tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
    if (!await waitForExit(pid, STOP_FORCE_MS)) {
      throw new Error(`Local scheduler daemon (pid ${pid}) did not exit.`);
    }
  }
  // The daemon unlinks its own pidfile on exit, so it is often already gone.
  tolerate(() => unlinkSync(PID_PATH), 'enoent');
  return pid;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gone = tolerate(() => process.kill(pid, 0), 'esrch') === undefined;
    if (gone) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
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

  /** Soonest moment the host has asked to be re-driven — a peer outbox retry
   *  armed while this loop was already asleep. Folded into the next delay and
   *  cleared by the pass that honours it, so it never re-shortens a later one. */
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
      // Every placed local agent, in every project. A resident scheduler keeps
      // each virtual workspace's peers and background queues draining, so the
      // directory this process happened to start in decides nothing.
      for (const ref of listLocalRefsAllProjects()) {
        try {
          const agentNext = await host.tick(ref.name, now);
          if (agentNext !== null) nextAt = nextAt === null ? agentNext : Math.min(nextAt, agentNext);
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
    // The refs are the authority: which agents exist, which directory each
    // binds, and which virtual workspace groups it with its peers.
    roster: (): HostedAgentRef[] => listLocalRefsAllProjects(),
    dbPath: agentDbPath,
    childDbPath: (parentDbPath: string, child: string) =>
      join(dirname(parentDbPath), 'subordinates', child, 'agent.db'),
    open: openDaemonAgent,
  };
  return new LocalAgentHost(wakeAt ? { ...options, wakeAt } : options);
}

/**
 * One daemon-hosted agent's runtime inputs. Everything a turn needs that this
 * process owns rather than the agent database: its provider wiring, its model
 * resolver, its MCP servers, and the profile authority its turns resolve
 * under.
 *
 * That last one is the same reader the interactive clients install. Without
 * it a daemon-driven turn resolves from the workspace's own bootstrap while an
 * interactive turn of the SAME agent resolves from the account or local
 * catalog, so a role only one of them knows about fails in one process and
 * runs in the other.
 */
export async function openDaemonAgent(
  ref: HostedAgentRef,
  db: Database,
  dbPath: string,
): Promise<LocalHostedAgent> {
  const { llmConfig, resolver: modelResolver } =
    createConfiguredLocalModelResolver({ agentName: ref.name });
  const openConfig = {
    llm: llmConfig,
    providerCredentials: resolveProviderCredentials(),
    codexAuthStore: createCodexAuthStore(),
    codexConfigPath: CONFIG_PATH,
    // The stored directory, never process.cwd(): a daemon serves every
    // project at once, so the plane an agent works in is the one its ref
    // records and nothing about where this process was launched.
    cwd: ref.cwd,
  };
  const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);
  return {
    rt,
    openConfig,
    modelResolver,
    mcpServers: resolveMcpServers(),
    profileAuthority: createProfileAuthorityReader(),
  };
}

function logSessionEvent(agentName: string, event: SessionEvent): void {
  if (event.type === 'turn-start') log(`${agentName}: ${event.kind} turn ${event.event ?? ''}`.trim());
  if (event.type === 'turn-end') log(`${agentName}: turn completed in ${event.turn.durationMs}ms`);
  if (event.type === 'error') log(`${agentName}: error: ${event.message}`);
  if (event.type === 'evolution') log(`${agentName}: [${event.event}] ${event.message}`);
}

function readLivePid(): number | null {
  const contents = tolerate(() => readFileSync(PID_PATH, 'utf-8'), 'enoent');
  if (contents === undefined) return null;
  const pid = Number(contents.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Only ESRCH means the pidfile outlived its daemon. EPERM means the process
  // is alive and merely not ours to signal — treating that as dead would have
  // us delete a live daemon's pidfile and report no daemon at all.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
