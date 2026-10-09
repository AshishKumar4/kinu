import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createTestRuntime } from '@kinu.run/test-utils';
import { settleSync } from '../src/obs/effect';
import { KinuError } from '../src/obs/error';
import { initOwnerQuestionsTable, OwnerQuestionStore, type OwnerAnswer } from '../src/plans/owner-questions';
import { settleUnpairedToolCalls } from '../src/prompting/interrupted-tool-calls';
import type { JsonObject } from '../src/utils/json';

const UNITS = { id: 'units', question: 'Which unit?', options: [{ label: 'Cents' }, { label: 'Dollars' }], recommended: 0 };

const ASK: JsonObject = {
  questions: [UNITS, { id: 'checks', question: 'Which checks?', options: [{ label: 'Totals' }, { label: 'Rounding' }, { label: 'Old rows' }], multi: true }],
};

function store() {
  const { rt } = createTestRuntime();
  initOwnerQuestionsTable(rt.storage.execRaw);

  return new OwnerQuestionStore(rt.storage.sql, rt.actor);
}

const TURN = { turnId: 't1', mode: 'build' } as const;

describe('the owner\'s questions', () => {
  test('a replayed step keeps the questions it already asked, and an invalid ask keeps none', () => {
    const questions = store();
    const [asked] = questions.ask([{ toolCallId: 'c1', input: ASK }], TURN);

    expect(questions.ask([{ toolCallId: 'c1', input: ASK }], TURN).map((row) => row.id)).toEqual([asked?.id]);
    expect(questions.ask([{ toolCallId: 'c2', input: { questions: [{ id: 'x', question: 'One?', options: [{ label: 'Only' }] }] } }], TURN)).toEqual([]);
    expect(questions.open()).toHaveLength(1);
  });

  test('an answer takes offered options, one apiece unless the question takes several, and every question', () => {
    const questions = store();
    const [asked] = questions.ask([{ toolCallId: 'c1', input: ASK }], TURN);
    const id = asked?.id ?? '';

    const refused = (answers: OwnerAnswer[]) => expect(() => settleSync(questions.answer(id, answers))).toThrow(KinuError);

    refused([{ id: 'units', selected: ['Euros'] }, { id: 'checks', selected: [] }]);
    refused([{ id: 'units', selected: ['Cents', 'Dollars'] }, { id: 'checks', selected: [] }]);
    refused([{ id: 'units', selected: ['Cents'] }]);
    expect(questions.outcome({ toolCallId: 'c1', input: ASK })).toBeNull();

    settleSync(questions.answer(id, [{ id: 'units', selected: [], other: 'Millicents' }, { id: 'checks', selected: ['Totals', 'Old rows'] }]));
    expect(questions.get(id)?.status).toBe('answered');
    refused([{ id: 'units', selected: ['Cents'] }, { id: 'checks', selected: [] }]);

    const outcome = questions.outcome({ toolCallId: 'c1', input: ASK }) ?? '';

    for (const said of ['Millicents', 'Totals', 'Old rows']) expect(outcome).toContain(said);
    expect(outcome).not.toContain('Rounding');
  });

  test('the answer is owed a turn until one opens for it', () => {
    const questions = store();
    const [asked] = questions.ask([{ toolCallId: 'c1', input: ASK }], TURN);
    const id = asked?.id ?? '';
    settleSync(questions.answer(id, [{ id: 'units', selected: ['Cents'] }, { id: 'checks', selected: [] }]));

    expect(questions.owedResumes().map((row) => row.id)).toEqual([id]);
    questions.markResumed(id);
    expect(questions.owedResumes()).toEqual([]);
  });

  test('a dismissal and a message in the chat each close the questions, and the call\'s result says which', () => {
    const questions = store();
    const units = { questions: [UNITS] };
    questions.ask([{ toolCallId: 'c1', input: ASK }], TURN);
    questions.close('dismissed');
    questions.ask([{ toolCallId: 'c2', input: units }], TURN);
    questions.close('in_chat');

    expect(questions.hasOpen()).toBe(false);
    expect(questions.owedResumes()).toEqual([]);
    const dismissed = questions.outcome({ toolCallId: 'c1', input: ASK });
    const inChat = questions.outcome({ toolCallId: 'c2', input: units });

    expect(dismissed).not.toBeNull();
    expect(inChat).not.toBeNull();
    expect(dismissed).not.toBe(inChat);
  });

  test('the repair pairs an answered call right after the message that asked, ahead of what the model wrote since', () => {
    const asked: ModelMessage = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ask_owner', input: ASK }] };
    const continued: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'Cents, then.' }] };
    const messages: ModelMessage[] = [{ role: 'user', content: 'Migrate.' }, asked, continued];

    const paired = settleUnpairedToolCalls(messages, (call) => (call.toolName === 'ask_owner' ? { state: 'settled', result: 'The owner answered: units: Cents' } : null));

    expect(paired?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(JSON.stringify(paired?.[2])).toContain('units: Cents');
  });
});
