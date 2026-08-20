import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { DEFAULT_SESSION_REFLECTION_INTERVAL } from '@proteus/core';
import { renderThrownChain, tolerate } from '@proteus/core/obs';
import {
  LocalAgentSession,
  openWorkspaceCLI,
  resolveChatModel,
  writeSecretFile,
  type SessionEvent,
} from '@proteus/cli-backend';
import {
  AGENT_HOME,
  agentDbPath,
  CONFIG_PATH,
  createCodexAuthStore,
  ensureAgentHome,
  listAgentDirs,
  resolveMcpServers,
  resolveProviderCredentials,
} from '../config';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import { appendDaemonLog, readDaemonLogTail } from '../daemon-log';
import { DIM, OK, WARN } from '../display';

const PID_PATH = join(AGENT_HOME, 'daemon.pid');
const LOG_PATH = join(AGENT_HOME, 'daemon.log');
const MAX_SLEEP_MS = 30_000;
const MIN_SLEEP_MS = 500;
/** SIGTERM grace before escalating — a tick mid-agent-turn takes a moment. */
const STOP_GRACE_MS = 5_000;
const STOP_FORCE_MS = 2_000;

export async function daemonCommand(action: string | undefined): Promise<void> {
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
  throw new Error('Usage: proteus daemon [start|stop|restart|status|logs|run]');
}

export function ensureLocalDaemonRunning(): void {
  // Skip daemon startup when explicitly disabled (e.g. in tests).
  if (process.env.PROTEUS_SKIP_DAEMON === '1') return;
  startDaemon({ quiet: true });
}

/** The new daemon's pid, or null when a live daemon already owns the pidfile. */
function startDaemon(opts: { quiet?: boolean } = {}): number | null {
  ensureAgentHome();
  if (readLivePid()) return null;

  const entry = process.argv[1];
  if (!entry) {
    if (!opts.quiet) throw new Error('Cannot locate Proteus CLI entrypoint for daemon startup.');
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
  // A stop must not wait out the poll interval — cut the sleep short.
  let wakeFromSleep: (() => void) | null = null;
  const stop = () => { stopping = true; wakeFromSleep?.(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const now = Date.now();
    let nextAt: number | null = null;
    for (const name of listAgentDirs()) {
      try {
        const agentNext = await tickAgent(name, now);
        if (agentNext !== null) nextAt = nextAt === null ? agentNext : Math.min(nextAt, agentNext);
      } catch (err) {
        log(`${name}: ${renderThrownChain({ cause: err })}`);
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

  log('local scheduler daemon stopped');
  tolerate(() => unlinkSync(PID_PATH), 'enoent');
}

async function tickAgent(name: string, now: number): Promise<number | null> {
  const dbPath = agentDbPath(name);
  const db = new Database(dbPath);
  try {
    const nextBefore = nextTriggerAt(db);
    const triggersDue = nextBefore !== null && nextBefore <= now;
    // The daemon is also the host for the evolution work a one-shot `proteus
    // exec` process cannot afford to finish (see AgentOrchestrator's exit
    // contract): the cadence pass its window is due, and the turn reviews it
    // deferred. Both are checked with plain SQL so a workspace with nothing to
    // do costs two queries, not a session.
    const evolutionDue = sessionEvolutionDue(db) || deferredReviewsDue(db);
    if (!triggersDue && !evolutionDue) return nextBefore;

    const { llmConfig, resolver: modelResolver } = createConfiguredLocalModelResolver({ agentName: name });
    const providerCredentials = resolveProviderCredentials();
    const codexAuthStore = createCodexAuthStore();
    const mcpServers = resolveMcpServers();
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH });
    const session = new LocalAgentSession({
      rt,
      db,
      model: resolveChatModel(llmConfig),
      modelResolver,
      onEvent: (event) => logSessionEvent(name, event),
    });
    try {
      if (Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
      await session.recoverBackgroundJobs();
      if (triggersDue) {
        const result = await session.fireDueTriggers(now);
        if (result.fired > 0) log(`${name}: fired ${result.fired} timer trigger${result.fired === 1 ? '' : 's'}`);
        // fireDueTriggers only ARMS the debounced drain; end() would disarm it
        // before it fires. Flush synchronously so the fired trigger's autonomous
        // turn actually runs (also drains any recovered background-job wake).
        await session.flushPendingDrains();
      }
      // Last, so any turn this tick just ran is in the window it evolves over.
      await session.runDueEvolution();
    } finally {
      try {
        await session.end();
      } catch (error) {
        log(`${name}: session teardown failed: ${renderThrownChain({ cause: error })}`);
      }
    }
    return nextTriggerAt(db);
  } finally {
    db.close();
  }
}

/**
 * Whether this workspace's durable evolution window has reached the
 * session-reflection interval — the same test AgentOrchestrator applies, read
 * straight from the table so the daemon can skip idle workspaces without
 * opening a runtime. The interval is core's default (5); a session that
 * overrides it only makes the daemon's check conservative, and the pass itself
 * re-checks under the session's own interval before claiming anything.
 */
function sessionEvolutionDue(db: Database): boolean {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_window'`).get();
  if (!table) return false;
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM session_window WHERE in_window = 1').get();
  return (row?.n ?? 0) >= DEFAULT_SESSION_REFLECTION_INTERVAL;
}

/**
 * Whether any one-shot process left a turn review undrained
 * (evolution/review-queue.ts). Read the same way and for the same reason as the
 * window above — and it is a SEPARATE test, because a workspace driven only by
 * `proteus exec` accumulates reviews long before its window reaches the
 * reflection interval, and gating the tick on the window alone left exactly
 * those reviews with no host at all.
 */
function deferredReviewsDue(db: Database): boolean {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_review_queue'`).get();
  if (!table) return false;
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM turn_review_queue').get();
  return (row?.n ?? 0) > 0;
}

function nextTriggerAt(db: Database): number | null {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triggers'`).get();
  if (!table) return null;
  const row = db.query<{ next_fire_at: number | null }, []>(`
    SELECT MIN(next_fire_at) AS next_fire_at
    FROM triggers
    WHERE state = 'active' AND next_fire_at IS NOT NULL
  `).get();
  return row?.next_fire_at ?? null;
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
