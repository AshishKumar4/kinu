/**
 * Zod schema for the merge LLM's structured output.
 *
 * Aligned with MergeResult — the controller validates the LLM's response
 * against this schema and rejects if parse fails (with a clear error so
 * the LLM can retry).
 *
 * We use Zod (already a Proteus dep + Vercel AI SDK's tool inputSchema
 * standard) rather than Valibot here for consistency; the Phase-4
 * Valibot migration can swap this out behind the same MergeResult shape.
 */

import { z } from 'zod';

export const EvidenceItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool_output', 'fact', 'citation', 'artifact']),
  body: z.string(),
  ref: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const DecisionSchema = z.object({
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  supportingEvidence: z.array(z.string()).optional(),
});

export const MergeOutputSchema = z.object({
  /** The unified narrative the parent head writes back into the conversation. */
  narrative: z.string()
    .min(1, 'narrative must be non-empty')
    .describe('Coherent narrative that integrates the heads\' findings.'),

  /** Decisions the LLM selected as final answers across all heads. */
  selected_decisions: z.array(DecisionSchema)
    .describe('Final answers the merge has chosen from the heads\' decision lists.'),

  /** Questions the heads disagreed on or could not resolve. */
  unresolved_questions: z.array(z.string())
    .describe('Questions raised by one or more heads that remain open.'),

  /** Concrete next-step suggestions the parent should consider. */
  recommendations: z.array(z.string())
    .describe('Actionable next steps. Each item should be one short imperative sentence.'),
});

export type MergeOutput = z.infer<typeof MergeOutputSchema>;
