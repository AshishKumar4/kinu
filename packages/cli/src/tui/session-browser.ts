import type { CliSessionInfo } from '../session.js';

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

function sessionLabel(session: CliSessionInfo): string {
  const title = session.name ?? session.firstUserText ?? '(untitled)';
  const cleanTitle = title.replace(/\s+/g, ' ').slice(0, 80);
  return `${session.id}  ${cleanTitle}  ${session.entries} entries`;
}
