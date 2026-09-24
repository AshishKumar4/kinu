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
import { JsonValueSchema, parseJsonValue, type JsonObject, type JsonValue } from '@kinu.run/core';
import { classify } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { AGENT_HOME } from './config';

/** JSONL files are diagnostic artifacts, never conversations to reopen. */
export interface CliSessionOptions {
  transcriptDir?: string;
  /** In-memory sink. */
  noTranscript?: boolean;
  /** Defaults to the artifact's own id. */
  conversationId?: string;
}

export type CliSessionMode = 'record' | 'none';

export interface CliSessionHeader {
  type: 'session';
  version: 1;
  id: string;
  agent: string;
  cwd: string;
  startedAt: string;
  conversationId?: string;
}

export interface CliSessionEntry extends JsonObject {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface CliSession {
  mode: CliSessionMode;
  id: string;
  agent: string;
  conversationId: string;
  path?: string;
  parentId: string | null;
  append(type: string, data?: JsonObject): CliSessionEntry | null;
}

export interface CliSessionInfo {
  id: string;
  path: string;
  agent: string;
  cwd: string;
  conversationId?: string;
  startedAt: string;
  modifiedAt: number;
  entries: number;
  firstUserText?: string;
}


const CliSessionHeaderSchema = v.object({
  type: v.literal('session'),
  version: v.literal(1),
  id: v.string(),
  agent: v.string(),
  cwd: v.string(),
  startedAt: v.string(),
  conversationId: v.optional(v.string()),
});

const CliSessionEntrySchema = v.objectWithRest({
  type: v.string(),
  id: v.string(),
  parentId: v.nullable(v.string()),
  timestamp: v.string(),
}, JsonValueSchema);

interface ParsedSession {
  header: CliSessionHeader | null;
  entryCount: number;
  firstUserText?: string;
}


/** Keeps its original on-disk name. */
function transcriptRoot(opts?: Pick<CliSessionOptions, 'transcriptDir'>): string {
  return opts?.transcriptDir ? resolve(opts.transcriptDir) : join(AGENT_HOME, 'sessions');
}

export function createCliSession(agent: string, opts: CliSessionOptions = {}): CliSession {
  if (opts.noTranscript) {
    return inMemorySession(agent);
  }

  const agentDir = join(transcriptRoot(opts), cleanPathSegment(agent));
  mkdirSync(agentDir, { recursive: true });

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
  };

  writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600 });

  return fileSession(agent, path, id, conversationId);
}

export function listCliSessions(agent: string, opts: Pick<CliSessionOptions, 'transcriptDir'> = {}): CliSessionInfo[] {
  const dir = join(transcriptRoot(opts), cleanPathSegment(agent));

  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readSessionInfo(join(dir, name)))
    .filter((info): info is CliSessionInfo => info !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function findTranscriptPath(
  agent: string,
  ref: string,
  opts: Pick<CliSessionOptions, 'transcriptDir'> = {},
): string | null {
  if (ref.includes('/') || ref.endsWith('.jsonl')) {
    const byPath = resolve(ref);

    return existsSync(byPath) ? byPath : null;
  }

  const byId = join(transcriptRoot(opts), cleanPathSegment(agent), `${ref}.jsonl`);

  return existsSync(byId) ? byId : null;
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

function fileSession(agent: string, path: string, id: string, conversationId: string): CliSession {
  let lastId: string | null = null;

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


function readSessionInfo(path: string): CliSessionInfo | null {
  const parsed = readSessionRaw(path);

  if (!parsed.header) return null;

  return sessionInfoFromParsed(path, parsed.header, parsed.entryCount, parsed.firstUserText);
}

function readSessionRaw(path: string): ParsedSession {
  let header: CliSessionHeader | null = null;
  let entryCount = 0;
  let firstUserText: string | undefined;
  const content = readFileSync(path, 'utf-8');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let decoded: JsonValue;

    try { decoded = parseJsonValue(line); } catch (error) {
      if (classify({ cause: error }) !== 'malformed-input') throw error;
      continue;
    }

    const parsedHeader = v.safeParse(CliSessionHeaderSchema, decoded);

    if (parsedHeader.success) {
      header = parsedHeader.output;
      continue;
    }

    const parsedEntry = v.safeParse(CliSessionEntrySchema, decoded);

    if (!parsedEntry.success) continue;
    const entry = parsedEntry.output;
    entryCount += 1;
    const text = v.safeParse(v.string(), entry.text);

    if (!firstUserText && entry.type === 'user' && text.success) {
      firstUserText = text.output.slice(0, 160);
    }
  }

  return { header, entryCount, firstUserText };
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
    conversationId: header.conversationId,
    startedAt: header.startedAt,
    modifiedAt: st.mtimeMs,
    entries: entryCount,
    firstUserText,
  };
}
