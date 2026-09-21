import * as v from 'valibot';
import type { RunEvent } from '../../packages/core/src/index';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const ActionSchema = v.object({
  action: v.string(), lifetime: v.optional(v.picklist(['durable', 'task'])), agent: v.optional(v.string()),
});

const HireSchema = v.object({ name: v.string() });

const TaskSchema = v.object({
  status: v.picklist(['completed', 'failed']), lifetime: v.literal('task'), agent: v.string(), answer: v.string(),
});

const RosterSchema = v.object({ subordinates: v.array(v.object({ name: v.string() })) });

function calls(events: readonly RunEvent[], action: string): ToolCallEnd[] {
  return events.filter((event): event is ToolCallEnd => {
    if (event.type !== 'tool_call_end' || event.name !== 'agents') return false;
    const args = v.safeParse(ActionSchema, event.args);

    return args.success && args.output.action === action
      && event.error === undefined && event.outcome?.success !== false;
  });
}

export function observeDelegationHires(input: {
  readonly taskEvents: readonly RunEvent[];
  readonly rosterEvents: readonly RunEvent[];
  readonly reply: string;
  readonly word: string;
}) {
  const taskHire = calls(input.taskEvents, 'hire').find((call) =>
    v.parse(ActionSchema, call.args).lifetime === 'task' && v.safeParse(TaskSchema, call.result).success);

  const task = v.safeParse(TaskSchema, taskHire?.result);

  const durableHire = calls(input.rosterEvents, 'hire').find((call) =>
    v.parse(ActionSchema, call.args).lifetime !== 'task' && v.safeParse(HireSchema, call.result).success);

  const durable = v.safeParse(HireSchema, durableHire?.result);
  const durableName = durable.success ? durable.output.name : null;

  const wordReported = task.success && task.output.status === 'completed'
    && task.output.answer.trim() === input.word && input.reply.includes(input.word);

  const shown = durableName !== null && calls(input.rosterEvents, 'list')
    .some((call) => {
      const roster = v.safeParse(RosterSchema, call.result);

      return roster.success && roster.output.subordinates.some((row) => row.name === durableName);
    });

  return { taskHire, durableName, wordReported, shown };
}

export function observeDelegationRetirement(events: readonly RunEvent[], name: string) {
  const dismisses = calls(events, 'dismiss').filter((call) =>
    v.parse(ActionSchema, call.args).agent === name);

  const retired = calls(events, 'list').some((call) => {
    const roster = v.safeParse(RosterSchema, call.result);

    return roster.success && !roster.output.subordinates.some((row) => row.name === name)
      && dismisses.some((dismiss) => call.runId === dismiss.runId && call.eventIndex > dismiss.eventIndex);
  });

  return { dismisses: dismisses.length, retired };
}
