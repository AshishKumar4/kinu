/** Authenticated tier model's opt-in native-tool benchmark, isolated by a unique request marker. */
import * as v from 'valibot';
import { JsonObjectSchema } from '@kinu.run/core';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

export const PERF_IO_MARKER = 'KINU_PERF_IO ';

const WorkSchema = v.object({
  name: v.picklist(['file', 'shell']), arguments: JsonObjectSchema,
  /** Generated here, not copied into the user's ask: a 1 MiB write's input is still short. */
  writeBytes: v.optional(v.number()),
});

const PerfIoSchema = v.object({
  id: v.string(), work: v.array(WorkSchema), answer: v.optional(v.string(), 'Perf complete.'),
});

export function perfIoModel(request: ScriptedRequest): ScriptedAnswer | null {
  if (!request.streamed) return null;
  const prompt = request.userTexts.findLast((text) => text.startsWith(PERF_IO_MARKER));

  if (prompt === undefined) return null;
  const plan = v.parse(PerfIoSchema, JSON.parse(prompt.slice(PERF_IO_MARKER.length)));

  const work = plan.work.map((step) => {
    const args = { ...step.arguments };

    if (step.writeBytes !== undefined) args.content = 'x'.repeat(step.writeBytes);

    return { name: step.name, arguments: args };
  });

  // Count the planned calls in the whole request: a runtime reminder in the user role does not restart the script.
  const planned = new Set(work.map((step) => `${step.name}:${JSON.stringify(step.arguments)}`));
  const made = request.calls.filter((call) => planned.has(`${call.name}:${call.arguments}`)).length;
  const next = work[made];

  return next === undefined ? { text: `${plan.id}: ${plan.answer}` } : { toolCall: next };
}
