import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { AGENT_HOME } from './config.js';

export type CliSessionMode = 'record' | 'none';

export interface CliSessionOptions {
  continue?: boolean;
  resume?: boolean;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  name?: string;
  fork?: string;
}

export interface CliSessionHeader {
  type: 'session';
  version: 1;
  id: string;
  agent: string;
  cwd: string;
  startedAt: string;
  name?: string;
  parentSession?: string;
}

export interface CliSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface CliSession {
  mode: CliSessionMode;
  id: string;
  agent: string;
  path?: string;
  parentId: string | null;
  append(type: string, data?: Record<string, unknown>): CliSessionEntry | null;
}

export interface CliSessionInfo {
  id: string;
  path: string;
  agent: string;
  cwd: string;
  name?: string;
  startedAt: string;
  modifiedAt: number;
  entries: number;
  firstUserText?: string;
}

const DEFAULT_SESSION_ID = 'default';

export function defaultAgentSessionId(): string {
  return DEFAULT_SESSION_ID;
}

export function defaultSessionRoot(): string {
  return join(AGENT_HOME, 'sessions');
}

export function sessionRoot(opts?: Pick<CliSessionOptions, 'sessionDir'>): string {
  return opts?.sessionDir ? resolve(opts.sessionDir) : defaultSessionRoot();
}

export function createCliSession(agent: string, opts: CliSessionOptions = {}): CliSession {
  if (opts.noSession) {
    return inMemorySession(agent);
  }

  const root = sessionRoot(opts);
  const agentDir = join(root, cleanPathSegment(agent));
  mkdirSync(agentDir, { recursive: true });

  const existing = resolveRequestedSession(agent, opts);
  if (existing && !opts.fork) {
    return fileSession(agent, existing.path, existing.id, existing.lastEntryId);
  }

  const parent = opts.fork ? resolveRequestedSession(agent, { ...opts, session: opts.fork, fork: undefined }) : null;
  const id = createSessionId();
  const path = join(agentDir, `${id}.jsonl`);
  const header: CliSessionHeader = {
    type: 'session',
    version: 1,
    id,
    agent,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    ...(opts.name ? { name: opts.name } : {}),
    ...(parent?.id ? { parentSession: parent.id } : {}),
  };
  writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });

  if (parent) {
    appendFileSync(path, `${JSON.stringify({
      type: 'forked_from',
      id: createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      source: parent.id,
      sourcePath: parent.path,
    })}\n`);
  }

  return fileSession(agent, path, id, null);
}

export function listCliSessions(agent: string, opts: Pick<CliSessionOptions, 'sessionDir'> = {}): CliSessionInfo[] {
  const dir = join(sessionRoot(opts), cleanPathSegment(agent));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readSessionInfo(join(dir, name)))
    .filter((info): info is CliSessionInfo => info !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function resolveRequestedSession(
  agent: string,
  opts: CliSessionOptions = {},
): { id: string; path: string; lastEntryId: string | null } | null {
  const explicit = opts.session;
  if (explicit) {
    const byPath = explicit.includes('/') || explicit.endsWith('.jsonl')
      ? resolve(explicit)
      : null;
    if (byPath && existsSync(byPath)) return sessionPointer(byPath);

    const match = listCliSessions(agent, opts).find((s) => s.id === explicit || s.id.startsWith(explicit));
    if (!match) throw new Error(`Session not found: ${explicit}`);
    return sessionPointer(match.path);
  }

  if (opts.continue || opts.resume) {
    const latest = listCliSessions(agent, opts)[0];
    if (latest) return sessionPointer(latest.path);
  }

  return null;
}

export function exportSessionPath(agent: string, ref: string | undefined, opts: CliSessionOptions = {}): string | null {
  if (ref) {
    return resolveRequestedSession(agent, { ...opts, session: ref })?.path ?? null;
  }
  return listCliSessions(agent, opts)[0]?.path ?? null;
}

function inMemorySession(agent: string): CliSession {
  return {
    mode: 'none',
    id: `ephemeral-${Date.now()}`,
    agent,
    parentId: null,
    append() { return null; },
  };
}

function fileSession(agent: string, path: string, id: string, parentId: string | null): CliSession {
  let lastId = parentId;
  return {
    mode: 'record',
    id,
    agent,
    path,
    get parentId() { return lastId; },
    append(type, data = {}) {
      const entry: CliSessionEntry = {
        type,
        id: createEntryId(),
        parentId: lastId,
        timestamp: new Date().toISOString(),
        ...data,
      };
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
      lastId = entry.id;
      return entry;
    },
  };
}

function sessionPointer(path: string): { id: string; path: string; lastEntryId: string | null } {
  const parsed = readSessionRaw(path);
  if (!parsed.header) throw new Error(`Invalid session file: ${path}`);
  return { id: parsed.header.id, path, lastEntryId: parsed.lastEntryId };
}

function readSessionInfo(path: string): CliSessionInfo | null {
  const parsed = readSessionRaw(path);
  if (!parsed.header) return null;
  const st = statSync(path);
  return {
    id: parsed.header.id,
    path,
    agent: parsed.header.agent,
    cwd: parsed.header.cwd,
    name: parsed.header.name,
    startedAt: parsed.header.startedAt,
    modifiedAt: st.mtimeMs,
    entries: parsed.entryCount,
    firstUserText: parsed.firstUserText,
  };
}

function readSessionRaw(path: string): {
  header: CliSessionHeader | null;
  lastEntryId: string | null;
  entryCount: number;
  firstUserText?: string;
} {
  let header: CliSessionHeader | null = null;
  let lastEntryId: string | null = null;
  let entryCount = 0;
  let firstUserText: string | undefined;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (isRecord(entry) && entry.type === 'session') {
      header = entry as unknown as CliSessionHeader;
      continue;
    }
    if (!isRecord(entry)) continue;
    entryCount += 1;
    if (typeof entry.id === 'string') lastEntryId = entry.id;
    if (!firstUserText && entry.type === 'user' && typeof entry.text === 'string') {
      firstUserText = entry.text.slice(0, 160);
    }
  }
  return { header, lastEntryId, entryCount, firstUserText };
}

export function rotateSessionFile(path: string, suffix = 'bak'): string {
  const next = `${path}.${suffix}-${Date.now()}`;
  renameSync(path, next);
  return next;
}

function createSessionId(): string {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${time}-${randomUUID().slice(0, 8)}`;
}

function createEntryId(): string {
  return randomUUID().slice(0, 12);
}

function cleanPathSegment(input: string): string {
  return (basename(input).replace(/[^A-Za-z0-9._-]/g, '_') || 'agent').slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
