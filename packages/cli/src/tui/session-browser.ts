import type { CliSessionEntry, CliSessionInfo, CliSessionTranscript } from '../session.js';
import type { DisplayMessage } from './messages.js';

export type SessionBrowserMode = 'list' | 'resume';

export interface SessionSelection {
  info: CliSessionInfo;
  label: string;
}

export function renderSessionBrowser(mode: SessionBrowserMode, sessions: CliSessionInfo[]): string {
  if (sessions.length === 0) return 'No recorded CLI sessions yet.';

  const title = mode === 'resume' ? 'Resume Session' : 'Sessions';
  const hint = mode === 'resume'
    ? 'Type a number or session id to resume. Type /cancel to keep the current chat.'
    : 'Type /resume, then choose a number or session id to continue one here.';

  return [
    title,
    '',
    ...sessions.slice(0, 12).map((session, index) => `${index + 1}. ${sessionLabel(session)}`),
    '',
    hint,
  ].join('\n');
}

export function selectSession(sessions: CliSessionInfo[], input: string): SessionSelection | null {
  const value = input.trim();
  if (!value) return null;

  const index = Number(value);
  if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
    const info = sessions[index - 1]!;
    return { info, label: sessionLabel(info) };
  }

  const exact = sessions.find((session) => session.id === value);
  if (exact) return { info: exact, label: sessionLabel(exact) };

  const prefixMatches = sessions.filter((session) => session.id.startsWith(value));
  if (prefixMatches.length !== 1) return null;
  return { info: prefixMatches[0]!, label: sessionLabel(prefixMatches[0]!) };
}

export function transcriptToMessages(transcript: CliSessionTranscript, maxEntries = 40): DisplayMessage[] {
  const entries = transcript.entries
    .filter(isRenderableEntry)
    .slice(-maxEntries);

  const messages: DisplayMessage[] = [{
    id: `session-${transcript.info.id}`,
    role: 'system',
    content: `Resumed ${transcript.info.id}\n${sessionSummary(transcript.info)}`,
  }];

  for (const entry of entries) {
    const message = entryToMessage(entry);
    if (message) messages.push(message);
  }

  if (messages.length === 1) {
    messages.push({
      id: `session-${transcript.info.id}-empty`,
      role: 'system',
      content: 'This session has no recorded turns yet.',
    });
  }

  return messages;
}

function sessionLabel(session: CliSessionInfo): string {
  const title = session.name ?? session.firstUserText ?? '(untitled)';
  const cleanTitle = title.replace(/\s+/g, ' ').slice(0, 80);
  return `${session.id}  ${cleanTitle}  ${session.entries} entries`;
}

function sessionSummary(session: CliSessionInfo): string {
  const title = session.name ?? session.firstUserText;
  return [
    title ? `Title: ${title.replace(/\s+/g, ' ').slice(0, 120)}` : null,
    `Entries: ${session.entries}`,
    `Started: ${session.startedAt}`,
    `CWD: ${session.cwd}`,
  ].filter((line): line is string => line !== null).join('\n');
}

function isRenderableEntry(entry: CliSessionEntry): boolean {
  return entry.type === 'user'
    || entry.type === 'assistant'
    || entry.type === 'tool_call'
    || entry.type === 'tool_result'
    || entry.type === 'error';
}

function entryToMessage(entry: CliSessionEntry): DisplayMessage | null {
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

function textEntry(entry: CliSessionEntry, role: 'user' | 'assistant'): DisplayMessage | null {
  const text = entry.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  return { id: entry.id, role, content: text.trim() };
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
