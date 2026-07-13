import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import {
  LocalAgentSession,
  openWorkspaceCLI,
  resolveChatModel,
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
} from '../config.js';
import { createConfiguredLocalModelResolver } from '../local-model-resolver.js';
import { DIM, OK, WARN } from '../display.js';

const PID_PATH = join(AGENT_HOME, 'daemon.pid');
const LOG_PATH = join(AGENT_HOME, 'daemon.log');
const MAX_SLEEP_MS = 30_000;
const MIN_SLEEP_MS = 500;

export async function daemonCommand(action: string | undefined): Promise<void> {
  const sub = action ?? 'status';
  if (sub === 'start') {
    const started = startDaemon();
    console.log(started
      ? `${OK('✓')} Local scheduler daemon started ${DIM(LOG_PATH)}`
      : `${DIM('Local scheduler daemon is already running')} ${DIM(LOG_PATH)}`);
    return;
  }
  if (sub === 'stop') {
    stopDaemon();
    console.log(`${OK('✓')} Local scheduler daemon stopped`);
    return;
  }
  if (sub === 'status') {
    const pid = readLivePid();
    console.log(`${DIM('Local scheduler:')} ${pid ? OK(`running pid ${pid}`) : WARN('stopped')}`);
    console.log(`${DIM('Log:')} ${LOG_PATH}`);
    return;
  }
  if (sub === 'logs') {
    if (!existsSync(LOG_PATH)) {
      console.log(DIM(`No daemon log at ${LOG_PATH}`));
      return;
    }
    console.log(readFileSync(LOG_PATH, 'utf-8').split('\n').slice(-120).join('\n'));
    return;
  }
  if (sub === 'run') {
    await runDaemonLoop();
    return;
  }
  throw new Error('Usage: proteus daemon [start|stop|status|logs|run]');
}

export function ensureLocalDaemonRunning(): void {
  startDaemon({ quiet: true });
}

function startDaemon(opts: { quiet?: boolean } = {}): boolean {
  ensureAgentHome();
  mkdirSync(AGENT_HOME, { recursive: true });
  chmodSync(AGENT_HOME, 0o700);
  if (readLivePid()) return false;

  const entry = process.argv[1];
  if (!entry) {
    if (!opts.quiet) throw new Error('Cannot locate Proteus CLI entrypoint for daemon startup.');
    return false;
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
    return true;
  } finally {
    closeSync(logFd);
  }
}

function stopDaemon(): void {
  const pid = readLivePid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  try { unlinkSync(PID_PATH); } catch { /* already gone */ }
}

async function runDaemonLoop(): Promise<void> {
  ensureAgentHome();
  writePid(process.pid);
  log('local scheduler daemon started');
  let stopping = false;
  const stop = () => { stopping = true; };
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
        log(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const delay = nextAt === null
      ? MAX_SLEEP_MS
      : Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, nextAt - Date.now()));
    await sleep(delay);
  }

  log('local scheduler daemon stopped');
  try { unlinkSync(PID_PATH); } catch { /* already gone */ }
}

async function tickAgent(name: string, now: number): Promise<number | null> {
  const dbPath = agentDbPath(name);
  const db = new Database(dbPath);
  try {
    const nextBefore = nextTriggerAt(db);
    if (nextBefore === null || nextBefore > now) return nextBefore;

    const { llmConfig, resolver: modelResolver } = createConfiguredLocalModelResolver({ agentName: name });
    const providerCredentials = resolveProviderCredentials();
    const codexAuthStore = createCodexAuthStore();
    const mcpServers = resolveMcpServers();
    const { rt } = openWorkspaceCLI(db, dbPath, { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH });
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
      const result = await session.fireDueTriggers(now);
      if (result.fired > 0) log(`${name}: fired ${result.fired} timer trigger${result.fired === 1 ? '' : 's'}`);
      // fireDueTriggers only ARMS the debounced drain; end() would disarm it
      // before it fires. Flush synchronously so the fired trigger's autonomous
      // turn actually runs (also drains any recovered background-job wake).
      await session.flushPendingDrains();
    } finally {
      await session.end().catch(() => {});
    }
    return nextTriggerAt(db);
  } finally {
    db.close();
  }
}

function nextTriggerAt(db: Database): number | null {
  const table = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triggers'`).get();
  if (!table) return null;
  const row = db.query(`
    SELECT MIN(next_fire_at) AS next_fire_at
    FROM triggers
    WHERE state = 'active' AND next_fire_at IS NOT NULL
  `).get() as { next_fire_at: number | null } | null;
  return typeof row?.next_fire_at === 'number' ? row.next_fire_at : null;
}

function logSessionEvent(agentName: string, event: SessionEvent): void {
  if (event.type === 'turn-start') log(`${agentName}: ${event.kind} turn ${event.event ?? ''}`.trim());
  if (event.type === 'turn-end') log(`${agentName}: turn completed in ${event.turn.durationMs}ms`);
  if (event.type === 'error') log(`${agentName}: error: ${event.message}`);
  if (event.type === 'evolution') log(`${agentName}: [${event.event}] ${event.message}`);
}

function readLivePid(): number | null {
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf-8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    try { unlinkSync(PID_PATH); } catch { /* already gone */ }
    return null;
  }
}

function writePid(pid: number | undefined): void {
  if (!pid) return;
  writeFileSync(PID_PATH, `${pid}\n`, { mode: 0o600 });
  try { chmodSync(PID_PATH, 0o600); } catch { /* nop */ }
}

function log(message: string): void {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
