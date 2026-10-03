import * as v from 'valibot';

export const ToolTurnUseSchema = v.object({ name: v.string(), usageCount: v.optional(v.number()) });

type ToolTurnUse = v.InferOutput<typeof ToolTurnUseSchema>;

/** The public counter records reviewed-turn observations, not individual calls inside an eval. */
export function reusedInLaterTurn(before: readonly ToolTurnUse[], after: readonly ToolTurnUse[], name: string): boolean {
  const previous = before.filter((tool) => tool.name === name);
  const current = after.filter((tool) => tool.name === name);

  return previous.length === 1 && current.length === 1
    && (current[0]?.usageCount ?? 0) > (previous[0]?.usageCount ?? 0);
}
