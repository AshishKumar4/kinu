// Schema for the merge LLM's structured output. Valibot — it implements
// StandardSchemaV1 so the AI SDK's generateObject({ schema }) accepts it
// directly, and the bundle is ~1.5kB vs Zod's ~12kB.
import * as v from 'valibot';

export const EvidenceItemSchema = v.object({
  id: v.string(),
  kind: v.picklist(['tool_output', 'fact', 'citation', 'artifact']),
  body: v.string(),
  ref: v.optional(v.string()),
  confidence: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

export const DecisionSchema = v.object({
  question: v.string(),
  choice: v.string(),
  rationale: v.string(),
  supportingEvidence: v.optional(v.array(v.string())),
});

export const MergeOutputSchema = v.object({
  narrative: v.pipe(
    v.string(),
    v.minLength(1, 'narrative must be non-empty'),
    v.description("Coherent narrative that integrates the heads' findings."),
  ),
  // The list fields default to [] when the model omits them — only the
  // narrative is essential, so a merge that produced a good narrative but no
  // explicit decisions/questions still validates instead of falling back.
  selected_decisions: v.optional(v.pipe(
    v.array(DecisionSchema),
    v.description("Final answers the merge has chosen from the heads' decision lists."),
  ), []),
  unresolved_questions: v.optional(v.pipe(
    v.array(v.string()),
    v.description('Questions raised by one or more heads that remain open.'),
  ), []),
  recommendations: v.optional(v.pipe(
    v.array(v.string()),
    v.description('Actionable next steps. Each item should be one short imperative sentence.'),
  ), []),
});

export type MergeOutput = v.InferOutput<typeof MergeOutputSchema>;
