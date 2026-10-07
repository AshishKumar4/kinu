/** A Plan turn's one outcome: the Markdown plan, submitted for the owner's review. */
import * as v from 'valibot';
import { PlanEditSchema } from '../types/plans';
import { defineOperation } from './operation';

export const PLAN = {
  submit: defineOperation({
    ns: 'plan', name: 'submit', impact: 'externalSend', plan: true, availability: 'native', slate: false,
    help: [
      'Submit the current Markdown implementation plan for interactive owner review.',
      'On the first call, write the full plan with one edit starting at line 1. After changes are requested, use the line numbers in the feedback turn to make targeted edits.',
      'Line numbers are one-indexed and inclusive; omit end to replace through the end of the plan. Do not implement after submission: end the turn and await the owner decision.',
    ].join('\n'),
    input: v.strictObject({ edits: v.pipe(v.array(PlanEditSchema), v.minLength(1)) }),
    output: v.strictObject({ planId: v.string(), revision: v.number(), status: v.string(), message: v.string() }),
  }),
} as const;
