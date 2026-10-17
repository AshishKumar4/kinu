// Words a person types while the agent's step runs a long command move that command to a job at once, as its window
// would: the model reads the job's handle and the words in one request, and nothing waits as queued. Words typed while
// the model still writes its step keep today's order: queued until the step ends.
import { describe, expect, test } from 'bun:test';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { handClock } from '@kinu.run/test-utils';
import { gatedToolCallStream, setup, steerStatuses, textStream, toolSequenceModel } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

/** What a call moved to the background because the person wrote is told (core `jobs/threshold.ts`). */
const RELEASED_FOR_PERSON = 'The person wrote while this ran; backgrounded: still running, not cancelled.';

const WORDS = 'While that runs, what port will it serve on?';

/** What a request sent, in order: its tool results and the person's words, each as its text. */
function partsOf(options: LanguageModelV2CallOptions): { role: string; text: string }[] {
  return options.prompt.flatMap((message) => (message.role === 'tool' || message.role === 'user'
    ? [{ role: message.role, text: JSON.stringify(message.content) }]
    : []));
}

describe('a person who writes while a tool call runs', () => {
  test("moves a long command to a job, and the model reads its handle and the words in one request, never queued", async () => {
    const clock = handClock(Date.now());
    const asked: LanguageModelV2CallOptions[] = [];
    // Runs until the test lets it end: a dev server, a long build.
    const command = 'while [ ! -e finished ]; do sleep 0.05; done; echo served';

    const { db, rt, session, events } = setup('unused', toolSequenceModel([{ name: 'shell', input: { command, why: 'serve' } }], (options) => { asked.push(options); }), {
      backgroundPolicy: { detachAfterMs: 30_000, settleGraceMs: 60_000, wakesAfterTurn: true }, clock,
    });

    const turn = session.send('start the server', { id: crypto.randomUUID() });

    // The command runs, its window armed on a clock nothing moves.
    await clock.whenArmed(1);
    expect(await session.send(WORDS, { id: 'words-mid-call' })).toBe('mid-turn');
    await turn;

    const second = asked[1] === undefined ? [] : partsOf(asked[1]);
    const handle = second.findIndex((part) => part.role === 'tool' && part.text.includes(RELEASED_FOR_PERSON));

    expect(handle).toBeGreaterThanOrEqual(0);
    expect(second.slice(handle + 1).some((part) => part.role === 'user' && part.text.includes(WORDS))).toBe(true);
    expect(steerStatuses(events).filter((status) => status.steerId === 'words-mid-call').map((status) => status.status)).toEqual(['landed']);

    const job = db.query<{ id: string; status: string }, [string]>(`SELECT id, status FROM background_jobs WHERE actor_id = ? AND kind = 'shell'`).get(rt.actor.actorId);

    expect(job?.status).toBe('running');
    expect(second[handle]?.text).toContain(job?.id ?? 'no job');

    // The command ends; its end wakes the agent.
    await Bun.write(`${rt.cwd}/finished`, '');
    await session.settleBackgroundWork();
    expect(db.query(`SELECT status FROM background_jobs WHERE id = ?`).get(job?.id ?? '')).toEqual({ status: 'completed' });
    expect(events.items.some((event) => event.type === 'turn-start' && event.kind === 'programmatic' && event.event === 'background_job')).toBe(true);
    await session.end();
  });

  test('words typed while the model still writes its step wait as queued, as before: no call runs yet to move', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async () => {
        calls += 1;

        return { stream: calls === 1 ? gatedToolCallStream('call-1', gate, usage) : textStream('read it', usage), response: { headers: {} } };
      },
    });

    const { session, events } = setup('unused', model);
    const turn = session.send('read the probe', { id: crypto.randomUUID() });

    await events.until((frames) => frames.some((event) => event.type === 'tool-call'));
    // Taken now, landed once the step ends, which the model's release lets happen.
    const sent = session.send(WORDS, { id: 'words-queued' });

    await events.until(() => steerStatuses(events).some((status) => status.steerId === 'words-queued'));
    release();
    await turn;
    expect(await sent).toBe('mid-turn');

    expect(steerStatuses(events).filter((status) => status.steerId === 'words-queued').map((status) => status.status)).toEqual(['queued', 'landed']);
    await session.end();
  });
});
