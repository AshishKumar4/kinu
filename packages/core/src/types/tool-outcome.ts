/** The tool-call outcome contract, declared at the platform layer: the run-event
 *  ledger records it and the tools layer produces it. */

import * as v from 'valibot';
import { ERROR_CODES } from '../obs/index';
import { FILE_REFUSAL_REASONS } from './file-edits';

export const ToolOutcomeSchema = v.variant('success', [
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    reason: v.nullable(v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS])),
    execution: v.optional(v.object({ exitCode: v.number() })),
  }),
]);

export type ToolOutcome = v.InferOutput<typeof ToolOutcomeSchema>;
