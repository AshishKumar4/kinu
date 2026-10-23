/** A plan submitted for the owner's review, and the agent's replies in its comment threads. */
import * as v from 'valibot';
import { PlanEditSchema } from '../types/plans';
import { defineOperation } from './operation';

export const PLAN = {
  submit: defineOperation({
    ns: 'plan', name: 'submit', impact: 'externalSend', plan: true, slate: false,
    help: [
      'Submit a Markdown implementation plan for the owner\'s review.',
      'First call: the whole plan as one edit at line 1. After changes are requested, edit by the line numbers the feedback gives (one-indexed, inclusive; omit `end` to replace to the end).',
      'Then end the turn and wait for the owner\'s decision; do not implement.',
    ].join('\n'),
    input: v.strictObject({
      edits: v.pipe(v.array(PlanEditSchema, 'a list of edits, each { start, end?, content }, sent as an array and not as text'), v.minLength(1)),
    }),
    output: v.strictObject({ planId: v.string(), revision: v.number(), status: v.string(), message: v.string() }),
  }),
  reply: defineOperation({
    ns: 'plan', name: 'reply', impact: 'externalSend', plan: true, slate: false,
    help: [
      'Reply in the thread of one of the owner\'s review comments; they read it under their comment.',
      'Answer a comment that asks a question, and say how the next revision handles a comment it does not simply follow. The plan itself changes only through submit_plan; reply before you submit the revision.',
    ].join('\n'),
    input: v.strictObject({
      comment: v.pipe(v.string(), v.nonEmpty(), v.description('The comment\'s id, as the review feedback names it.')),
      text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(4000), v.description('The reply, in Markdown.')),
    }),
    output: v.strictObject({ planId: v.string(), revision: v.number(), comment: v.string(), reply: v.string() }),
  }),
} as const;
