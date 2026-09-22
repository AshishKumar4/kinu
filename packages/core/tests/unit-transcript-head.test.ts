/**
 * The conversation head, and what a read does when it no longer resolves.
 *
 * `conversation_heads` is the entry every transcript read walks back from, and
 * `newestId()` trusted it without asking whether it still names a row. The
 * owner's report ("the chat had been cleared and only my original msg
 * remained") is what that produces: a head naming an entry this session does
 * not hold takes every read down an ancestry walk that dies on an anonymous
 * "entry is missing", with nothing naming the head, nothing recorded, and the
 * next message chaining onto the dangling id.
 *
 * So a head that does not resolve is a REPORTED fault — the refusal names the
 * session and the entry, and a diagnostics record carries it — and the writer
 * that could store one refuses instead.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { createRecordingLogger, setDiagnosticsSink, type RecordedLog } from '../src/obs/index';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { SessionHistory } from '../src/session/history';
import type { SessionTranscript } from '../src/session/transcript';
import type { ActorHandle } from '../src/identity/actor-handle';
import { createTestActor, createTestWorkspace, type TestWorkspace } from './helpers';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

interface Fixture extends TestWorkspace {
  readonly actor: ActorHandle;
  readonly history: SessionHistory;
  readonly transcript: SessionTranscript;
}

/** Three entries through the canonical writers, then the head they left. */
async function seeded(): Promise<Fixture> {
  const ws = createTestWorkspace();
  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-head', 'head');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  await history.record(CHAT_SESSION_ID, { id: 'u1', parentId: null, origin: 'input',
    message: { role: 'user', content: 'build the chess app' } });
  await history.record(CHAT_SESSION_ID, { id: 'a1', parentId: 'u1', origin: 'output',
    message: { role: 'assistant', content: 'on it' } });
  await history.record(CHAT_SESSION_ID, { id: 'u2', parentId: 'a1', origin: 'input',
    message: { role: 'user', content: 'add a clock' } });

  return { ...ws, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** Storage carrying a head no writer is allowed to produce. */
function danglingHead(fixture: Fixture, entryId: string): void {
  void fixture.sql`UPDATE conversation_heads SET entry_id=${entryId}
    WHERE actor_id=${fixture.actor.actorId} AND session_id=${CHAT_SESSION_ID}`;
}

describe('a conversation head that no longer resolves', () => {
  test('every read refuses, naming the head — never a short history', async () => {
    const fixture = await seeded();
    danglingHead(fixture, 'gone');

    for (const read of [
      () => fixture.transcript.newestId(),
      () => fixture.transcript.count(),
      () => fixture.transcript.pageIds({}),
      () => fixture.transcript.history(),
    ]) {
      expect(read).toThrow(/conversation head names entry "gone"/);
    }
  });

  test('the refusal is recorded, so a wedged conversation is diagnosable', async () => {
    const fixture = await seeded();
    danglingHead(fixture, 'gone');
    const logger = createRecordingLogger();
    restore = setDiagnosticsSink(logger);

    expect(() => fixture.transcript.newestId()).toThrow();

    const recorded = logger.emitted.filter((line: RecordedLog) => line.event === 'session.transcript_head_unresolvable');
    expect(recorded).toHaveLength(1);
    expect(present(recorded[0], 'the recorded refusal').fields).toMatchObject({ session: CHAT_SESSION_ID, entry: 'gone' });
  });

  test('the writer refuses to store one', async () => {
    const fixture = await seeded();

    expect(() => fixture.transcript.setHead('never-recorded'))
      .toThrow(/conversation head names entry "never-recorded"/);
    expect(fixture.transcript.newestId()).toBe('u2');
  });
});

describe('a head the revert deliberately moved back', () => {
  test('walks back to that entry and says so, rather than reading as empty', async () => {
    const fixture = await seeded();
    const logger = createRecordingLogger();
    restore = setDiagnosticsSink(logger);

    fixture.history.revertTo(CHAT_SESSION_ID, 'u2', () => {});

    expect(fixture.transcript.newestId()).toBe('a1');
    expect(fixture.transcript.count()).toBe(2);

    const moved = logger.emitted.filter((line: RecordedLog) => line.event === 'session.transcript_head_moved');
    expect(moved).toHaveLength(1);
    expect(present(moved[0], 'the recorded head move').fields).toMatchObject({ session: CHAT_SESSION_ID, from: 'u2', to: 'a1' });
  });

  test('reverting the first turn empties the thread and records the head it left', async () => {
    const fixture = await seeded();
    const logger = createRecordingLogger();
    restore = setDiagnosticsSink(logger);

    fixture.history.revertTo(CHAT_SESSION_ID, 'u1', () => {});

    expect(fixture.transcript.newestId()).toBeNull();
    expect(await fixture.transcript.history()).toEqual([]);

    const moved = logger.emitted.filter((line: RecordedLog) => line.event === 'session.transcript_head_moved');
    expect(present(moved[0], 'the recorded head move').fields).toMatchObject({ from: 'u1', to: '' });
  });
});
