import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { AGENT_HOME } from './config.js';
import type { AgentTranscriptMessage } from './agent-client.js';

export type CliSessionMode = 'record' | 'none';

export interface CliSessionOptions {
  continue?: boolean;
  resume?: boolean;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  name?: string;
  fork?: string;
  conversationId?: string;
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
  conversationId?: string;
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
  conversationId: string;
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
  conversationId?: string;
  startedAt: string;
  modifiedAt: number;
  entries: number;
  firstUserText?: string;
}

export interface CliSessionTranscript {
  info: CliSessionInfo;
  entries: CliSessionEntry[];
}

const DEFAULT_SESSION_ID = 'default';

export function defaultAgentSessionId(): string {
  return DEFAULT_SESSION_ID;
}

export function defaultConversationIdForCliOptions(opts: Pick<CliSessionOptions, 'continue' | 'resume' | 'session' | 'fork' | 'noSession'> = {}): string | undefined {
  if (opts.noSession || opts.continue || opts.resume || opts.session || opts.fork) return undefined;
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
    return fileSession(agent, existing.path, existing.id, existing.lastEntryId, existing.conversationId);
  }

  const parent = opts.fork ? resolveRequestedSession(agent, { ...opts, session: opts.fork, fork: undefined }) : null;
  const id = createSessionId();
  const conversationId = opts.conversationId ?? id;
  const path = join(agentDir, `${id}.jsonl`);
  const header: CliSessionHeader = {
    type: 'session',
    version: 1,
    id,
    agent,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    conversationId,
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

  return fileSession(agent, path, id, null, conversationId);
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
): { id: string; path: string; lastEntryId: string | null; conversationId: string } | null {
  const explicit = opts.session;
  if (explicit) {
    const byPath = explicit.includes('/') || explicit.endsWith('.jsonl')
      ? resolve(explicit)
      : null;
    if (byPath && existsSync(byPath)) return sessionPointer(byPath);

    const matches = listCliSessions(agent, opts).filter((s) => s.id === explicit || s.id.startsWith(explicit));
    if (matches.length === 0) throw new Error(`Session not found: ${explicit}`);
    if (matches.length > 1) throw new Error(`Session reference is ambiguous: ${explicit}`);
    const match = matches[0]!;
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

export function readCliSessionTranscript(
  agent: string,
  ref: string,
  opts: Pick<CliSessionOptions, 'sessionDir'> = {},
): CliSessionTranscript {
  const pointer = resolveRequestedSession(agent, { ...opts, session: ref });
  if (!pointer) throw new Error(`Session not found: ${ref}`);
  const parsed = readSessionRaw(pointer.path);
  if (!parsed.header) throw new Error(`Invalid session file: ${pointer.path}`);
  return {
    info: sessionInfoFromParsed(pointer.path, parsed.header, parsed.entryCount, parsed.firstUserText),
    entries: parsed.entries,
  };
}

function inMemorySession(agent: string): CliSession {
  const id = `ephemeral-${Date.now()}`;
  return {
    mode: 'none',
    id,
    agent,
    conversationId: id,
    parentId: null,
    append() { return null; },
  };
}

function fileSession(agent: string, path: string, id: string, parentId: string | null, conversationId: string): CliSession {
  let lastId = parentId;
  return {
    mode: 'record',
    id,
    agent,
    conversationId,
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

function sessionPointer(path: string): { id: string; path: string; lastEntryId: string | null; conversationId: string } {
  const parsed = readSessionRaw(path);
  if (!parsed.header) throw new Error(`Invalid session file: ${path}`);
  return {
    id: parsed.header.id,
    path,
    lastEntryId: parsed.lastEntryId,
    conversationId: parsed.header.conversationId ?? parsed.header.id,
  };
}

function readSessionInfo(path: string): CliSessionInfo | null {
  const parsed = readSessionRaw(path);
  if (!parsed.header) return null;
  return sessionInfoFromParsed(path, parsed.header, parsed.entryCount, parsed.firstUserText);
}

function readSessionRaw(path: string): {
  header: CliSessionHeader | null;
  entries: CliSessionEntry[];
  lastEntryId: string | null;
  entryCount: number;
  firstUserText?: string;
} {
  let header: CliSessionHeader | null = null;
  const entries: CliSessionEntry[] = [];
  let lastEntryId: string | null = null;
  let entryCount = 0;
  let firstUserText: string | undefined;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (isSessionHeader(entry)) {
      header = entry;
      continue;
    }
    if (!isSessionEntry(entry)) continue;
    entries.push(entry);
    entryCount += 1;
    lastEntryId = entry.id;
    if (!firstUserText && entry.type === 'user' && typeof entry.text === 'string') {
      firstUserText = entry.text.slice(0, 160);
    }
  }
  return { header, entries, lastEntryId, entryCount, firstUserText };
}

/** Map recorded JSONL entries to renderable transcript messages. */
export function transcriptMessages(entries: CliSessionEntry[], maxEntries = 40): AgentTranscriptMessage[] {
  return entries
    .filter(isRenderableEntry)
    .slice(-maxEntries)
    .flatMap((entry) => {
      const message = entryToMessage(entry);
      return message ? [message] : [];
    });
}

function isRenderableEntry(entry: CliSessionEntry): boolean {
  return entry.type === 'user'
    || entry.type === 'assistant'
    || entry.type === 'tool_call'
    || entry.type === 'tool_result'
    || entry.type === 'error';
}

function entryToMessage(entry: CliSessionEntry): AgentTranscriptMessage | null {
  switch (entry.type) {
    case 'user':
      return textEntry(entry, 'user');
    case 'assistant':
      return textEntry(entry, 'assistant');
    case 'tool_call':
      return {
        id: entry.id,
        role: 'tool_call',
        content: '',
        toolName: typeof entry.toolName === 'string' ? entry.toolName : 'tool',
        args: safeJson(entry.args),
      };
    case 'tool_result':
      return {
        id: entry.id,
        role: 'tool_result',
        content: typeof entry.result === 'string' ? entry.result : safeJson(entry.result),
      };
    case 'error':
      return {
        id: entry.id,
        role: 'system',
        content: `Error: ${typeof entry.message === 'string' ? entry.message : safeJson(entry.message)}`,
      };
    default:
      return null;
  }
}

function textEntry(entry: CliSessionEntry, role: 'user' | 'assistant'): AgentTranscriptMessage | null {
  const text = entry.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  return { id: entry.id, role, content: text.trim(), ...(entry.steered === true ? { steered: true } : {}) };
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function isSessionHeader(value: unknown): value is CliSessionHeader {
  return isRecord(value)
    && value.type === 'session'
    && value.version === 1
    && typeof value.id === 'string'
    && typeof value.agent === 'string'
    && typeof value.cwd === 'string'
    && typeof value.startedAt === 'string'
    && (value.conversationId === undefined || typeof value.conversationId === 'string');
}

function isSessionEntry(value: unknown): value is CliSessionEntry {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.id === 'string'
    && (typeof value.parentId === 'string' || value.parentId === null)
    && typeof value.timestamp === 'string';
}

function sessionInfoFromParsed(
  path: string,
  header: CliSessionHeader,
  entryCount: number,
  firstUserText: string | undefined,
): CliSessionInfo {
  const st = statSync(path);
  return {
    id: header.id,
    path,
    agent: header.agent,
    cwd: header.cwd,
    name: header.name,
    conversationId: header.conversationId,
    startedAt: header.startedAt,
    modifiedAt: st.mtimeMs,
    entries: entryCount,
    firstUserText,
  };
}
