/**
 * A decision port over a chat model, for a host no decision model serves. Each question takes one category, and each
 * category stands for a fixed answer of its own (`STRUCTURED_NOUL`), not Clef's probabilities. Untrusted until
 * `scripts/decision-agreement.ts` measures it against Clef on recorded turns.
 */

import * as v from 'valibot';
import type { DecisionAnswer, DecisionPort, DecisionQuestion, DecisionRequest } from './decision-model';
import { extractJsonObject, jsonObjectOnlyInstruction } from './structured';
import type { LLM } from '../types/primitives';
import { KinuError, settle, tolerate } from '../obs/index';
import { renderIssues } from '../utils/json';
import { Effect } from 'effect';

/** What each yes-or-no category stands for: the categorical thresholds this port answers with in place of a probability. */
const STRUCTURED_NOUL = { yes: 0.9, no: 0.1, unclear: 0.5 } as const;

const NOUL_ANSWERS = ['yes', 'no', 'unclear'] as const;

/** The categories one question allows: yes, no or unclear; a criterion's number; or a choice's key. */
function categories(question: DecisionQuestion): readonly string[] {
  switch (question.type) {
    case 'noul': return NOUL_ANSWERS;
    case 'score': return question.criteria.map((_, index) => String(index));
    case 'choice': return Object.keys(question.criteria);
  }
}

function renderQuestion(id: string, question: DecisionQuestion): string {
  const allowed = categories(question).join(', ');

  switch (question.type) {
    case 'noul': return `- ${id} (one of ${allowed}): ${question.instructions}`;
    case 'score': return [`- ${id} (one of ${allowed}): ${question.instructions}`, ...question.criteria.map((text, index) => `    ${String(index)}: ${text}`)].join('\n');
    case 'choice': return [`- ${id} (one of ${allowed}): ${question.instructions}`, ...Object.entries(question.criteria).map(([key, text]) => `    ${key}: ${text}`)].join('\n');
  }
}

function renderPrompt(request: DecisionRequest): string {
  const example = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, categories(question)[0] ?? '']));

  return [
    'Read the state below and answer every question with exactly one of the answers it allows.',
    '',
    'STATE:',
    request.state,
    '',
    'QUESTIONS:',
    Object.entries(request.questions).map(([id, question]) => renderQuestion(id, question)).join('\n'),
    '',
    `Answer as one JSON object with one key per question, for example ${JSON.stringify(example)}.`,
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

function answerOf(question: DecisionQuestion, category: string): DecisionAnswer {
  switch (question.type) {
    case 'noul': return { type: 'noul', noul: STRUCTURED_NOUL[v.parse(v.picklist(NOUL_ANSWERS), category)] };
    case 'score': return { type: 'score', score: Number(category) };
    case 'choice': return { type: 'choice', choice: category };
  }
}

/** Usage is the chat model's own report, through the `LLM` it was handed. */
export function createStructuredDecisionPort(opts: { readonly llm: () => LLM }): DecisionPort {
  return (request) => settle(Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => opts.llm().complete(renderPrompt(request)),
      catch: (cause) => new KinuError('unavailable', 'the chat model answering decisions failed', { cause }),
    });

    const schema = v.strictObject(Object.fromEntries(Object.entries(request.questions)
      .map(([id, question]) => [id, v.picklist(categories(question))])));

    // A criterion's number may come back as a JSON number; it is the same category.
    const object = tolerate(() => extractJsonObject(text), 'malformed-input');
    const read = object === undefined ? undefined : Object.fromEntries(Object.entries(object).map(([id, answer]) => [id, typeof answer === 'number' ? String(answer) : answer]));
    const parsed = v.safeParse(schema, read);

    if (!parsed.success) return yield* Effect.fail(new KinuError('bad_input', `the chat model did not answer every decision: ${renderIssues(parsed.issues)}`));

    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerOf(question, String(parsed.output[id]))]));

    return { answers, usage: { input: 0, output: 0 } };
  }));
}
