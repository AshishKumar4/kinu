// Schema for the merge LLM's structured output. Valibot — it implements
// StandardSchemaV1 so the AI SDK's generateObject({ schema }) accepts it
// directly, and the bundle is ~1.5kB vs Zod's ~12kB.
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
  // The only field that is not a function of what the heads SAID. Every other
  // one summarizes them: unresolved_questions are questions heads RAISED,
  // recommendations are steps heads PROPOSED, narrative integrates what heads
  // FOUND. So when all N heads share a framing — which correlated models do —
  // the shared omission has no field to surface in and the merge narrates it as
  // a confident answer. The merge model is the only actor holding all N reports
  // at once, so it is the only one positioned to be asked.
  //
  // ARGUED, NOT MEASURED — and falsifiable on purpose. Every merge records its
  // list on the `head_merge` run event, so the verdict is a query, not a
  // reread. Over the next ~30 real merges that reached a model:
  //
  //   SELECT json_extract(payload, '$.blindSpots') AS spots
  //   FROM run_events WHERE type = 'head_merge';
  //
  // REVERT the field if more than a third of those rows are empty `[]`, restate
  // an entry already in that merge's unresolved_questions, or are generic enough
  // to fit any split at all ("did not consider performance", "no security
  // review"). Any one of the three means it is not earning its tokens. Passing
  // looks like entries naming ground specific to THAT task which no head's
  // report mentions.
  blind_spots: v.optional(v.pipe(
    v.array(v.string()),
    v.description('Aspects of the task that NO head addressed.'),
  ), []),
});

export type MergeOutput = v.InferOutput<typeof MergeOutputSchema>;
