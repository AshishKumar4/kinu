import * as v from 'valibot';
import { ERROR_CODES } from '../obs/index';
import { FILE_REFUSAL_REASONS } from './file-edits';

export const ToolFailureValueSchema = v.object({
  success: v.literal(false),
  reason: v.nullable(v.picklist([...ERROR_CODES, ...FILE_REFUSAL_REASONS])),
  error: v.string(),
  execution: v.optional(v.object({ exitCode: v.number() })),
  /** db.batch's refused operation index, part of the refusal a program branches on. */
  failedIndex: v.optional(v.number()),
});

/** `ToolFailureValueSchema` as the eval description declares it: once, and every namespace names it. */
export const REFUSAL_TYPE = [
  `/** Branch on \`reason\`; the last ${FILE_REFUSAL_REASONS.length} are the file plane's verdicts on an anchor or read. \`execution\` is a command's exit, \`failedIndex\` db.batch's failed operation. */`,
  `type Refusal = { success: false; reason: ${ToolFailureValueSchema.entries.reason.wrapped.options.map((reason) => JSON.stringify(reason)).join(' | ')} | null; `
    + 'error: string; execution?: { exitCode: number }; failedIndex?: number };',
].join('\n');

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
