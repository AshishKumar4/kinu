import * as v from 'valibot';
import type { RunEvent } from '../../packages/core/src/index';
import type { PublicMessage } from '../../evals/src/session';
import { messagesOfStep, type StepMessages } from '../../evals/src/transcript';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const OpSchema = v.object({
  op: v.string(), lifetime: v.optional(v.picklist(['durable', 'task'])), agent: v.optional(v.string()),
});

const TaskHireArgsSchema = v.looseObject({ op: v.literal('hire'), lifetime: v.literal('task'), mission: v.string() });

/** A task hire as `agents` answers it: at once, its helper still at work (cafab2bfc, SUBAGENTS.md s4). */
const HiredSchema = v.looseObject({ status: v.literal('working'), lifetime: v.literal('task'), agent: v.string() });

const HireSchema = v.object({ name: v.string() });

const RosterSchema = v.object({ subordinates: v.array(v.object({ name: v.string() })) });

/** A step's messages, each one's content read as its text: a plain string, or the parts the SDK sends. */
const StepMessagesSchema = v.array(v.looseObject({
  role: v.string(),
  content: v.union([
    v.string(),
    v.pipe(v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })), v.transform((parts) => parts.map((part) => part.text ?? '').join(''))),
  ]),
}));

function calls(events: readonly RunEvent[], op: string): ToolCallEnd[] {
  return events.filter((event): event is ToolCallEnd => {
    if (event.type !== 'tool_call_end' || event.name !== 'agents') return false;
    const args = v.safeParse(OpSchema, event.args);

    return args.success && args.output.op === op
      && event.error === undefined && event.outcome?.success !== false;
  });
}

/** One task hire, by the helper it named and the mission it gave. */
export interface TaskHire {
  readonly call: ToolCallEnd;
  readonly agent: string;
  readonly mission: string;
}

/** The task hires `events` made, oldest first. */
export function taskHires(events: readonly RunEvent[]): TaskHire[] {
  return calls(events, 'hire').flatMap((call) => {
    const args = v.safeParse(TaskHireArgsSchema, call.args);
    const hired = v.safeParse(HiredSchema, call.result);

    return args.success && hired.success ? [{ call, agent: hired.output.agent, mission: args.output.mission }] : [];
  });
}

/** How a helper's answer reached its hirer: the message that brought it, and the hirer's reply to that message. */
export interface Delivery {
  readonly text: string;
  readonly reply: string;
}

/** The first message after the hirer's `ask` that names `agent`, from the hirer's own history; null before it arrives. */
export function delivered(history: readonly PublicMessage[], ask: string, agent: string): Delivery | null {
  const asked = history.map((row) => row.role === 'user' && row.text.trim() === ask.trim()).lastIndexOf(true);

  if (asked === -1) return null;
  const at = history.findIndex((row, index) => index > asked && row.role === 'user' && row.text.includes(agent));

  if (at === -1) return null;

  return { text: history[at]?.text ?? '', reply: history.slice(at + 1).find((row) => row.role === 'assistant')?.text ?? '' };
}

/** Whether a turn in an actor's own ledger opened on a message that names `agent`: its answer, delivered there. */
export function deliveredInLedger(events: readonly RunEvent[], agent: string): boolean {
  return events.some((event) => event.type === 'run_start' && (event.turn?.text ?? event.userMessage ?? '').includes(agent));
}

/** What an actor's own turns ended on: the text of its last finished step. */
export function finalAnswer(events: readonly RunEvent[], output: StepMessages): string {
  const last = [...events]
    .filter((event): event is Extract<RunEvent, { type: 'step_finish' }> => event.type === 'step_finish' && event.reason === 'stop')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventIndex - b.eventIndex)
    .at(-1);

  const messages = v.safeParse(StepMessagesSchema, last === undefined ? [] : messagesOfStep(last, output));

  if (!messages.success) return '';

  return messages.output
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('')
    .trim();
}

/** The durable hire a turn made, by the name it answered with, and whether that turn's roster listed it. */
export function observeDurableHire(events: readonly RunEvent[]) {
  const durableHire = calls(events, 'hire').find((call) =>
    v.parse(OpSchema, call.args).lifetime !== 'task' && v.safeParse(HireSchema, call.result).success);

  const durable = v.safeParse(HireSchema, durableHire?.result);
  const durableName = durable.success ? durable.output.name : null;

  const shown = durableName !== null && calls(events, 'list')
    .some((call) => {
      const roster = v.safeParse(RosterSchema, call.result);

      return roster.success && roster.output.subordinates.some((row) => row.name === durableName);
    });

  return { durableName, shown };
}

export function observeDelegationRetirement(events: readonly RunEvent[], name: string) {
  const dismisses = calls(events, 'dismiss').filter((call) =>
    v.parse(OpSchema, call.args).agent === name);

  const retired = calls(events, 'list').some((call) => {
    const roster = v.safeParse(RosterSchema, call.result);

    return roster.success && !roster.output.subordinates.some((row) => row.name === name)
      && dismisses.some((dismiss) => call.runId === dismiss.runId && call.eventIndex > dismiss.eventIndex);
  });

  return { dismisses: dismisses.length, retired };
}
