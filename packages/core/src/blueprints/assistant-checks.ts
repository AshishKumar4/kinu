/**
 * The Personal assistant's checks: programs a watcher runs before it wakes the agent (`events/ingress/watch.ts`), each
 * reading what is new through the owner's connection and answering `{ fire, brief?, state? }`. A check makes no model
 * call, so a quiet inbox costs nothing; only what needs the owner wakes the agent, with the check's brief as the turn's.
 * The first check only marks where to start: what came before the watcher is not news to it. The owner asked that the
 * assistant's schedules work this way, 2026-10-23.
 */
import type { WatchCheck } from '../types/watch';

/**
 * GitHub's notifications since the newest one seen, read conditionally (`If-Modified-Since`), so an unchanged inbox is a
 * 304 at no cost to the rate limit. Fires on a review asked of the owner, a mention of them or their team, or Actions
 * failing on their work (`ci_activity`); each other reason is read past. docs.github.com/rest/activity/notifications.
 */
export const GITHUB_NOTIFICATIONS_CHECK: WatchCheck = {
  reads: ['github'],
  code: `const NEEDS = { review_requested: 'review requested', mention: 'mentioned', team_mention: 'team mentioned', ci_activity: 'checks failed' };
const seen = state ?? {};
const read = await github.read('/notifications', {
  query: { all: false, per_page: 50, ...(seen.since === undefined ? {} : { since: seen.since }) },
  ...(seen.modified === undefined ? {} : { ifModifiedSince: seen.modified }),
});
if (read.status === 304) return { fire: false };
// Refused or not understood: read again at the next check, from the same place.
if (read.status !== 200 || !Array.isArray(read.body)) return { fire: false };
const items = read.body;
const newest = items.reduce((at, item) => (item.updated_at > at ? item.updated_at : at), seen.since ?? '');
const since = newest === '' ? new Date().toISOString() : newest;
const atNewest = items.filter((item) => item.updated_at === since).map((item) => item.id);
const ids = [...new Set([...(since === seen.since ? seen.ids ?? [] : []), ...atNewest])];
const next = { since, ids, ...(read.lastModified === undefined ? {} : { modified: read.lastModified }) };
if (seen.since === undefined) return { fire: false, state: next };
const fresh = items.filter((item) => NEEDS[item.reason] !== undefined
  && (item.updated_at > seen.since || (item.updated_at === seen.since && !(seen.ids ?? []).includes(item.id))));
if (fresh.length === 0) return { fire: false, state: next };
const link = (item) => String(item.subject.url ?? '').replace('https://api.github.com/repos/', 'https://github.com/').replace('/pulls/', '/pull/');
const title = (item) => (item.subject.title.length > 70 ? item.subject.title.slice(0, 69) + '...' : item.subject.title);
const lines = fresh.slice(0, 4).map((item) => NEEDS[item.reason] + ': ' + item.repository.full_name + ' "' + title(item) + '" ' + link(item));
const more = fresh.length > 4 ? '\\n...and ' + (fresh.length - 4) + ' more' : '';
return { fire: true, brief: lines.join('\\n') + more, state: next };`,
};

/**
 * Gmail's history since the history id last read: the messages added to the inbox, read at no model call. A history id
 * too old for Gmail to keep (a 404) starts again from now. developers.google.com/gmail/api/reference/rest/v1/users.history/list.
 */
export const GMAIL_INBOX_CHECK: WatchCheck = {
  reads: ['google'],
  code: `const now = async () => {
  const profile = await google.read('gmail.users.getProfile', { params: { userId: 'me' } });
  return profile.status === 200 ? { cursor: String(profile.body.historyId) } : null;
};
if (state?.cursor === undefined) {
  const start = await now();
  return start === null ? { fire: false } : { fire: false, state: start };
}
const added = [];
let cursor = state.cursor;
let page;
for (let pages = 0; pages < 5; pages += 1) {
  const history = await google.read('gmail.users.history.list', { params: {
    userId: 'me', startHistoryId: state.cursor, historyTypes: ['messageAdded'], labelId: 'INBOX', maxResults: 100, ...(page === undefined ? {} : { pageToken: page }),
  } });
  if (history.status !== 200) {
    if (/not found/i.test(JSON.stringify(history))) {
      const start = await now();
      return start === null ? { fire: false } : { fire: false, state: start };
    }
    // Refused or out of reach: read again at the next check, from the same place.
    return { fire: false };
  }
  for (const record of history.body.history ?? []) {
    for (const { message } of record.messagesAdded ?? []) {
      const labels = message.labelIds ?? [];
      if (labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT') && !added.includes(message.id)) added.push(message.id);
    }
  }
  cursor = String(history.body.historyId ?? cursor);
  page = history.body.nextPageToken;
  if (page === undefined) break;
}
if (added.length === 0) return { fire: false, state: { cursor } };
const lines = [];
for (const id of added.slice(0, 4)) {
  const message = await google.read('gmail.users.messages.get', { params: { userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] } });
  const header = (name) => (message.body?.payload?.headers ?? []).find((each) => each.name === name)?.value ?? '';
  if (message.status === 200) lines.push(header('From') + ': "' + header('Subject').slice(0, 80) + '" (' + id + ')');
}
const more = added.length > 4 ? '\\n...and ' + (added.length - 4) + ' more' : '';
return { fire: true, brief: added.length + ' new in the inbox:\\n' + lines.join('\\n') + more, state: { cursor } };`,
};
