/** The tool-call outcome contract, declared at the platform layer: the run-event
 *  ledger records it and the tools layer produces it. */

import * as v from 'valibot';
import { ERROR_CODES } from '../obs/index';
import { FILE_REFUSAL_REASONS } from './file-edits';

export const ToolFailureValueSchema = v.object({
  success: v.literal(false),
  reason: v.nullable(v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS])),
  error: v.string(),
  execution: v.optional(v.object({ exitCode: v.number() })),
});

export const BindingFailureSchema = v.object({
  ...ToolFailureValueSchema.entries,
  tool: v.string(),
  action: v.nullable(v.string()),
});

export type BindingFailure = v.InferOutput<typeof BindingFailureSchema>;

const failures = v.optional(v.array(BindingFailureSchema));

export const ToolOutcomeSchema = v.variant('success', [
  v.object({ success: v.literal(true), failures }),
  v.object({
    success: v.literal(false),
    reason: v.nullable(v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS])),
    execution: v.optional(v.object({ exitCode: v.number() })),
    failures,
  }),
]);

export type ToolOutcome = v.InferOutput<typeof ToolOutcomeSchema>;
