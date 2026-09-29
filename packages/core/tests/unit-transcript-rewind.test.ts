/** A rewind deletes the entry it names and everything after it, and records that it did. */
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

async function seeded(): Promise<Fixture> {
  const ws = createTestWorkspace();
  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-head', 'head');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  await history.record(CHAT_SESSION_ID, { id: 'u1', origin: 'input',
    message: { role: 'user', content: 'build the chess app' } });
  await history.record(CHAT_SESSION_ID, { id: 'a1', origin: 'output',
    message: { role: 'assistant', content: 'on it' } });
  await history.record(CHAT_SESSION_ID, { id: 'u2', origin: 'input',
    message: { role: 'user', content: 'add a clock' } });

  return { ...ws, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

describe('a rewind', () => {
  test('ends the chat just before that entry and says so, rather than reading as lost rows', async () => {
    const fixture = await seeded();
    const logger = createRecordingLogger();
    restore = setDiagnosticsSink(logger);

    fixture.history.revertTo(CHAT_SESSION_ID, 'u2', () => {});

    expect(fixture.transcript.newestId()).toBe('a1');
    expect(fixture.transcript.count()).toBe(2);

    const rewound = logger.emitted.filter((line: RecordedLog) => line.event === 'session.transcript_rewound');
    expect(rewound).toHaveLength(1);
    expect(present(rewound[0], 'the recorded rewind').fields).toMatchObject({ session: CHAT_SESSION_ID, from: 'u2', position: 2 });
  });

  test('rewinding the first turn empties the thread and records where it cut', async () => {
    const fixture = await seeded();
    const logger = createRecordingLogger();
    restore = setDiagnosticsSink(logger);

    fixture.history.revertTo(CHAT_SESSION_ID, 'u1', () => {});

    expect(fixture.transcript.newestId()).toBeNull();
    expect(await fixture.transcript.history()).toEqual([]);

    const rewound = logger.emitted.filter((line: RecordedLog) => line.event === 'session.transcript_rewound');
    expect(present(rewound[0], 'the recorded rewind').fields).toMatchObject({ from: 'u1', position: 0 });
  });
});
