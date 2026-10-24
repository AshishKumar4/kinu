/**
 * The Personal assistant's checks: programs a watcher runs before it wakes the agent (`events/ingress/watch.ts`), each
 * reading what is new through the owner's connection and answering `{ fire, brief?, state? }`. A check makes no model
 * call, so a quiet inbox costs nothing; only what needs the owner wakes the agent, with the check's brief as the turn's.
 * The first check only marks where to start: what came before the watcher is not news to it. What one brief cannot hold
 * waits in the check's state and wakes the agent at the next check, so every new item reaches it. The owner asked that
 * the assistant's schedules work this way, 2026-10-23.
 */
import type { WatchCheck } from '../types/watch';

/** How much of a brief a check fills: the turn reads 600 characters of it (`EVENT_BRIEF_MAX_CHARS`). */
const BRIEF_CHARS = 520;

/** The lines of `pending` that fit one brief, after `opening`, and the brief, which counts what waits for the next
 *  check: the lines left, and `waiting` more not yet written as lines. */
const BATCH = `const batched = (pending, opening, waiting) => {
  const lines = [];
  let size = opening.length;
  for (const line of pending) {
    if (lines.length > 0 && size + line.length + 1 > ${String(BRIEF_CHARS)}) break;
    lines.push(line);
    size += line.length + 1;
  }
  const more = pending.length - lines.length + waiting;
  return { lines, brief: opening + lines.join('\\n') + (more > 0 ? '\\n(' + more + ' more at the next check)' : '') };
};`;

/**
 * GitHub's notifications since the newest one seen, read conditionally (`If-Modified-Since`), so an unchanged inbox is a
 * 304 at no cost to the rate limit, and every page of what changed. `since` is exclusive at GitHub, so the read reaches
 * a second back and what was seen at its edge is known by id and update. Fires on a review asked of the owner, a mention
 * of them or their team, or Actions failing on their work (`ci_activity`); each other reason is read past.
 * docs.github.com/rest/activity/notifications, read 2026-10-24.
 */
export const GITHUB_NOTIFICATIONS_CHECK: WatchCheck = {
  reads: ['github'],
  code: `${BATCH}
const NEEDS = { review_requested: 'review requested', mention: 'mentioned', team_mention: 'team mentioned', ci_activity: 'checks failed' };
const seen = state ?? {};
const edge = (at) => new Date(Date.parse(at) - 1000).toISOString();
const items = [];
let modified = seen.modified;
for (let page = 1; page <= 10; page += 1) {
  const read = await github.read('/notifications', {
    query: { all: false, per_page: 50, page, ...(seen.since === undefined ? {} : { since: edge(seen.since) }) },
    ...(page === 1 && seen.modified !== undefined ? { ifModifiedSince: seen.modified } : {}),
  });
  if (page === 1 && read.status === 304) break;
  // Refused or not understood: read again at the next check, from the same place.
  if (read.status !== 200 || !Array.isArray(read.body)) return { fire: false };
  if (page === 1 && read.lastModified !== undefined) modified = read.lastModified;
  items.push(...read.body);
  if (read.body.length < 50) break;
}
const key = (item) => item.id + '@' + item.updated_at;
const newest = items.reduce((at, item) => (item.updated_at > at ? item.updated_at : at), seen.since ?? '');
const since = newest === '' ? new Date().toISOString() : newest;
const known = seen.keys ?? [];
const keys = [...new Set([...known, ...items.map(key)])].filter((each) => each.slice(each.indexOf('@') + 1) >= edge(since));
const link = (item) => String(item.subject.url ?? '').replace('https://api.github.com/repos/', 'https://github.com/').replace('/pulls/', '/pull/');
const title = (item) => (item.subject.title.length > 70 ? item.subject.title.slice(0, 67) + '...' : item.subject.title);
const fresh = seen.since === undefined ? [] : items.filter((item) => NEEDS[item.reason] !== undefined && !known.includes(key(item)));
const pending = [...(seen.pending ?? []), ...fresh.map((item) => NEEDS[item.reason] + ': ' + item.repository.full_name + ' "' + title(item) + '" ' + link(item))];
const { lines, brief } = batched(pending, '', 0);
const rest = pending.slice(lines.length);
const next = { since, keys, ...(modified === undefined ? {} : { modified }), ...(rest.length > 0 ? { pending: rest } : {}) };
return lines.length === 0 ? { fire: false, state: next } : { fire: true, brief, state: next };`,
};

/**
 * Gmail's inbox since the history id last read, in the mailbox it was read in: the profile's history id says whether
 * anything moved, and the history since it names each message added to the inbox, every page of it. A history id too
 * old for Gmail to keep (a 404), or another mailbox connected, starts again from now.
 * developers.google.com/gmail/api/reference/rest/v1/users.history/list, read 2026-10-24.
 */
export const GMAIL_INBOX_CHECK: WatchCheck = {
  reads: ['google'],
  code: `${BATCH}
const profile = await google.read('gmail.users.getProfile', { params: { userId: 'me' } });
// Refused or out of reach: read again at the next check, from the same place.
if (profile.status !== 200) return { fire: false };
const mailbox = profile.body.emailAddress;
const now = String(profile.body.historyId);
const seen = state ?? {};
if (seen.mailbox !== mailbox || seen.history === undefined) return { fire: false, state: { mailbox, history: now } };
const pending = [...(seen.pending ?? [])];
let history = seen.history;
if (now !== seen.history) {
  let page;
  let last = seen.history;
  for (let pages = 0; pages < 10; pages += 1) {
    const read = await google.read('gmail.users.history.list', { params: {
      userId: 'me', startHistoryId: seen.history, historyTypes: ['messageAdded'], labelId: 'INBOX', maxResults: 100, ...(page === undefined ? {} : { pageToken: page }),
    } });
    if (read.status !== 200) {
      if (/not found/i.test(JSON.stringify(read))) return { fire: false, state: { mailbox, history: now, ...(pending.length > 0 ? { pending } : {}) } };
      return { fire: false };
    }
    for (const record of read.body.history ?? []) {
      last = String(record.id);
      for (const { message } of record.messagesAdded ?? []) {
        const labels = message.labelIds ?? [];
        if (labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT') && !pending.includes(message.id)) pending.push(message.id);
      }
    }
    page = read.body.nextPageToken;
    // Read through: the mailbox's own history id. Cut short: the last record read, from which the next check goes on.
    history = page === undefined ? String(read.body.historyId ?? now) : last;
    if (page === undefined) break;
  }
}
const described = [];
for (const id of pending.slice(0, 8)) {
  const message = await google.read('gmail.users.messages.get', { params: { userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] } });
  const header = (name) => (message.body?.payload?.headers ?? []).find((each) => each.name === name)?.value ?? '';
  described.push(message.status === 200 ? header('From') + ': "' + header('Subject').slice(0, 80) + '" (' + id + ')' : 'message ' + id);
}
const { lines, brief } = batched(described, 'New in the inbox:\\n', pending.length - described.length);
const rest = pending.slice(lines.length);
const next = { mailbox, history, ...(rest.length > 0 ? { pending: rest } : {}) };
return lines.length === 0 ? { fire: false, state: next } : { fire: true, brief, state: next };`,
};
