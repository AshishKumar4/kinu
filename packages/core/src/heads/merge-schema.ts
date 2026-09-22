// Valibot implements StandardSchemaV1, so generateObject({ schema }) accepts it directly.
import * as v from 'valibot';

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
  // List fields default to [] so a good narrative alone still validates.
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
  // The only field not derived from what heads said: a shared omission. Revert it if over a third of
  // `head_merge` rows are empty, restate unresolved_questions, or are generic.
  blind_spots: v.optional(v.pipe(
    v.array(v.string()),
    v.description('Aspects of the task that NO head addressed.'),
  ), []),
});

export type MergeOutput = v.InferOutput<typeof MergeOutputSchema>;
