/**
 * A turn that fought a tool teaches one lesson about it (docs/EVOLUTION-REDESIGN.md §2): every completed turn records
 * its struggles whether or not anything rates it, the fast tier writes the lesson, and the later turns that were shown
 * it and used its tool score it until it retires. A rewrite is a new revision whose evidence starts at none.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import { present } from '@kinu.run/test-utils';
import { chatTerminalEffects } from '../src/orchestrator/terminal-effects';
import type { CompletedTurn } from '../src/evolution/types';
import { applyStruggleLesson, listToolLessons, type Struggle } from '../src/evolution/struggles';
import { createTestRuntime } from './helpers';

const LESSON = 'Name `path` in every edit call; edit refuses one without it.';

const REFUSED: Struggle = { kind: 'schema_refusal', tool: 'edit', count: 2, sample: 'edit: path is required' };

function turn(turnId: string, struggles: readonly Struggle[], shown: CompletedTurn['shownLessons'] = []): CompletedTurn {
  return {
    userMessage: 'fix the typo in the README', assistantResponse: 'Fixed.',
    toolCalls: [
      { name: 'edit', args: { text: 'teh' }, result: 'edit: path is required', outcome: { success: false, reason: 'bad_input' } },
      { name: 'edit', args: { path: 'README.md', text: 'the' }, result: 'ok', outcome: { success: true } },
    ],
    durationMs: 1, steps: 3, hadError: false, feedback: null, turnId, sessionId: 'default', origin: 'user',
    struggles, shownLessons: shown,
  };
}

type Answer = { update: string | null; text: string };

/** The fast tier answers every lesson prompt with the current `answer`, and the prompts it read are kept. */
function engine(first: Answer) {
  const { rt, stores } = createTestRuntime();
  const prompts: string[] = [];
  let answer = first;

  rt.fastLlm = {
    stream: (opts) => rt.llm.stream(opts),
    complete: async (prompt) => {
      prompts.push(prompt);

      return JSON.stringify(answer);
    },
  };

  const lessons = () => rt.storage.sql<{ id: string; revision: number; text: string; helpful: number; harmful: number; status: string }>`
    SELECT id, revision, text, helpful, harmful, status FROM tool_lessons ORDER BY created_at, id`;

  const evolution = new EvolutionEngine(rt, stores.history);

  return {
    rt, lessons, prompts, evolution,
    learn: (completed: CompletedTurn) => evolution.learnFromTurn(completed),
    answerWith: (next: Answer) => { answer = next; },
  };
}

describe('a struggling turn teaches one lesson about its tool', () => {
  test('a turn nobody rates records its struggles, and the fast tier writes the lesson', async () => {
    const { rt, lessons, learn } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', [REFUSED]));

    expect(rt.storage.sql<{ turn_id: string; errors: number; steps: number; struggles: string }>`
      SELECT turn_id, errors, steps, struggles FROM turn_struggles`)
      .toEqual([{ turn_id: 't-1', errors: 1, steps: 3, struggles: JSON.stringify([REFUSED]) }]);
    expect(lessons()).toEqual([{ id: 'tl-t-1', revision: 1, text: LESSON, helpful: 0, harmful: 0, status: 'active' }]);
  });

  test('the agent\'s learning setting, switched off, stops the next turn learning; switched on, it learns again', async () => {
    const { rt, lessons, prompts, learn, evolution } = engine({ update: null, text: LESSON });

    rt.actor.config.setLearning(false);
    expect(evolution.recordsTurns).toBe(false);
    await learn(turn('t-off', [REFUSED]));
    expect(rt.storage.sql<{ turn_id: string }>`SELECT turn_id FROM turn_struggles`).toEqual([]);
    expect(prompts).toEqual([]);

    rt.actor.config.setLearning(true);
    await learn(turn('t-on', [REFUSED]));
    expect(rt.storage.sql<{ turn_id: string }>`SELECT turn_id FROM turn_struggles`).toEqual([{ turn_id: 't-on' }]);
    expect(lessons()).toHaveLength(1);
  });

  test('a detached turn tail keeps its own learning gate after the turn closes', async () => {
    const { rt, lessons, learn, evolution } = engine({ update: null, text: LESSON });
    const continueTail = Promise.withResolvers<void>();

    const tail = evolution.withTurnLearning(async () => {
      await continueTail.promise;
      await learn(turn('tail', [REFUSED]));
    });

    rt.actor.config.setLearning(false);
    await learn(turn('independent', [REFUSED]));
    expect(lessons()).toEqual([]);
    continueTail.resolve();
    await tail;
    expect(lessons()).toHaveLength(1);
    expect(rt.storage.sql<{ turn_id: string }>`SELECT turn_id FROM turn_struggles`).toEqual([{ turn_id: 'tail' }]);
  });

  test('learning twice from one turn records, scores and asks once', async () => {
    const { lessons, prompts, learn } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', [REFUSED]));
    await learn(turn('t-1', [REFUSED]));

    expect({ asked: prompts.length, lessons: lessons().length }).toEqual({ asked: 1, lessons: 1 });
  });

  test('a turn without a struggle or a shown lesson records nothing and asks no model', async () => {
    const { rt, lessons, prompts, learn } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', []));

    expect(rt.storage.sql<{ turn_id: string }>`SELECT turn_id FROM turn_struggles`).toEqual([]);
    expect({ lessons: lessons(), asked: prompts.length }).toEqual({ lessons: [], asked: 0 });
  });

  test('a rewrite is a new revision whose evidence starts at none, and old exposures no longer score it', async () => {
    const { lessons, learn, answerWith } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', [REFUSED]));
    answerWith({ update: 'tl-t-1', text: 'Name `path`, relative to the workspace root.' });

    for (const id of ['t-2', 't-3', 't-4']) await learn(turn(id, [], [{ id: 'tl-t-1', revision: 1 }]));
    expect(lessons()[0]).toMatchObject({ revision: 1, helpful: 3, harmful: 0 });

    // A struggle shown revision 1 scores it harmful, then rewrites it.
    await learn(turn('t-5', [REFUSED], [{ id: 'tl-t-1', revision: 1 }]));
    expect(lessons()[0]).toMatchObject({ revision: 2, helpful: 0, harmful: 0 });

    // A turn shown revision 1 before the rewrite scores nothing now.
    await learn(turn('t-6', [], [{ id: 'tl-t-1', revision: 1 }]));
    expect(lessons()[0]).toMatchObject({ revision: 2, helpful: 0, harmful: 0 });

    // Five uses of the new revision that hurt more than they helped retire it; the old record shields nothing. These
    // struggles teach lessons of their own rather than rewriting it again.
    answerWith({ update: null, text: 'Read the file before editing it.' });

    for (const id of ['t-7', 't-8', 't-9', 't-10', 't-11']) {
      await learn(turn(id, id === 't-7' ? [] : [{ ...REFUSED, kind: 'repeated_failure' }], [{ id: 'tl-t-1', revision: 2 }]));
    }

    expect(lessons()[0]).toMatchObject({ helpful: 1, harmful: 4, status: 'retired' });
  });

  test('only a lesson the turn was shown, and whose tool it used, is scored', async () => {
    const { rt, lessons, learn } = engine({ update: null, text: LESSON });
    applyStruggleLesson(rt.storage.sql, rt.actor, { turnId: 'seed-edit', tool: 'edit', answer: { update: null, text: 'shown' } });
    applyStruggleLesson(rt.storage.sql, rt.actor, { turnId: 'seed-unshown', tool: 'edit', answer: { update: null, text: 'unshown' } });
    applyStruggleLesson(rt.storage.sql, rt.actor, { turnId: 'seed-shell', tool: 'shell', answer: { update: null, text: 'shell' } });

    await learn(turn('t-1', [], [{ id: 'tl-seed-edit', revision: 1 }, { id: 'tl-seed-shell', revision: 1 }]));

    // By id: seeds written across a millisecond tick list in insertion order.
    expect(lessons().map(({ id, helpful }) => ({ id, helpful })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'tl-seed-edit', helpful: 1 }, { id: 'tl-seed-shell', helpful: 0 }, { id: 'tl-seed-unshown', helpful: 0 },
    ]);
  });

  test('a hundred lessons about one tool cost a step five and a reflection a bounded prompt', async () => {
    const { rt, prompts, learn } = engine({ update: null, text: LESSON });

    for (let n = 0; n < 100; n++) {
      applyStruggleLesson(rt.storage.sql, rt.actor, { turnId: `seed-${String(n)}`, tool: 'edit', answer: { update: null, text: 'x'.repeat(300) } });
    }

    expect(listToolLessons(rt.storage.sql, rt.actor, ['edit', 'shell'], 5)).toHaveLength(5);

    const struggling = turn('t-1', [REFUSED]);
    const many: CompletedTurn = { ...struggling, toolCalls: Array.from({ length: 30 }, () => struggling.toolCalls).flat() };
    await learn(many);

    expect(prompts.map((prompt) => prompt.length < 20_000)).toEqual([true]);
  });

  test('the owed effect learns from the turn its row recorded, once however often it runs', async () => {
    const { lessons, prompts, evolution } = engine({ update: null, text: LESSON });

    const effect = present(chatTerminalEffects({
      chat: () => { throw new Error('the lessons owe no turn'); },
      orchestrator: {
        recordTurn: () => { throw new Error('the lessons record no turn'); },
        recordedTurn: () => { throw new Error('the lessons record no turn'); },
        drainPendingEvents: () => Promise.reject(new Error('the lessons drain nothing')),
      },
      engine: evolution,
    }).turn_lessons, 'the lessons body');

    const input = JSON.parse(JSON.stringify({ turn: turn('t-1', [REFUSED]) }));

    for (let run = 0; run < 2; run++) {
      if (effect.synchronous) throw new Error('turn_lessons runs detached');
      await effect.run(input, 'm-1');
    }

    expect({ asked: prompts.length, lessons: lessons().map(({ id }) => id) }).toEqual({ asked: 1, lessons: ['tl-t-1'] });
  });

  test('a rewrite in the same words keeps its evidence, so a harmful lesson still retires', async () => {
    const { lessons, learn, answerWith } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', [REFUSED]));
    answerWith({ update: 'tl-t-1', text: LESSON });

    for (const id of ['t-2', 't-3', 't-4', 't-5', 't-6']) await learn(turn(id, [REFUSED], [{ id: 'tl-t-1', revision: 1 }]));

    expect(lessons()[0]).toMatchObject({ id: 'tl-t-1', revision: 1, harmful: 5, status: 'retired' });
  });

  test('a stall alone teaches no lesson, as no one tool owns it', async () => {
    const { lessons, learn } = engine({ update: null, text: LESSON });

    await learn(turn('t-1', [{ kind: 'no_progress', tool: null, count: 12, sample: '' }]));

    expect(lessons()).toEqual([]);
  });
});
