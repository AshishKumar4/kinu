import { expect, test } from 'bun:test';
import { LiveReadsNotice, readsWrittenBy, type ReadsChangedFrame } from '../src/read-models/live-reads';

test('a write names the reads of its table and nothing else', () => {
  expect(readsWrittenBy('INSERT OR IGNORE INTO background_jobs (id) VALUES (?)'))
    .toEqual(['listBackgroundJobs', 'getWorkspaceTabPresence']);
  expect(readsWrittenBy('UPDATE plan_reviews SET status = ? WHERE id = ?')).toContain('getActivePlanReview');
  expect(readsWrittenBy('INSERT INTO conversation_entries (id) VALUES (?)')).toEqual([]);
  expect(readsWrittenBy('SELECT * FROM background_jobs')).toEqual([]);
  expect(readsWrittenBy('INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = excluded.a')).toEqual([]);
});

test('a swarm worker added or removed moves tab presence; its status moves only the Agents panel', () => {
  expect(readsWrittenBy('INSERT INTO head_journal (id) VALUES (?)')).toEqual(['listWorkspaceAgents', 'getWorkspaceTabPresence']);
  expect(readsWrittenBy('DELETE FROM search_nodes WHERE root_id = ?')).toEqual(['getWorkspaceTabPresence']);
  expect(readsWrittenBy('UPDATE head_journal SET status = ? WHERE id = ?')).toEqual(['listWorkspaceAgents']);
});

// 2026-09-28: the workerd parity record held these notices and flaked with the timer's latency; the mapping is pinned here.
test('a turn claim taken or released moves the Agents panel', () => {
  expect(readsWrittenBy('INSERT INTO actor_turn_claims (actor_id, turn_id) VALUES (?, ?)')).toContain('listWorkspaceAgents');
  expect(readsWrittenBy('DELETE FROM actor_turn_claims WHERE turn_id = ?')).toContain('listWorkspaceAgents');
});

test('many writes in one tick send one frame naming each moved read once', () => {
  const frames: ReadsChangedFrame[] = [];
  const owed: (() => void)[] = [];
  const notice = new LiveReadsNotice((frame) => { frames.push(frame); }, (flush) => { owed.push(flush); });

  for (let write = 0; write < 500; write++) notice.moved(readsWrittenBy('UPDATE crafted_tools SET uses = ?'));
  notice.moved([]);

  for (const flush of owed.splice(0)) flush();

  expect(frames).toEqual([{
    type: 'reads_changed',
    reads: ['getToolDescriptions', 'getEvolutionChangelog', 'listPendingActions', 'getWorkspaceTabPresence'],
  }]);

  notice.moved(readsWrittenBy('INSERT INTO turn_feedback (id) VALUES (?)'));

  for (const flush of owed.splice(0)) flush();
  expect(frames).toHaveLength(1);
});
