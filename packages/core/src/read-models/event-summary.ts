/**
 * What an event the agent was handed says to the person: a label, what it is about, and one line, from the event's
 * structured fields. Never from the text the agent was given: that is written for the model, in its tags and
 * instructions, and a person reading the chat sees what happened instead.
 */

import * as v from 'valibot';

export interface EventSummary {
  /** What happened, short: "Task reminder". */
  readonly label: string;
  /** Who or what it is about, when that is not in the line. */
  readonly about?: string;
  /** One line a person reads. */
  readonly line: string;
  /** Words a person wrote that came with it (the owner's feedback), shown when the event is opened. */
  readonly detail?: string;
}

/** Where a task reminder's turn keeps the titles of the open tasks it named, beside its event. */
export const TASK_REMINDER_OPEN_KEY = 'kinuOpenTasks';

/** The most of someone's own words a card's field keeps: the turn's text carries them whole, so no second full copy. */
const CARD_WORDS_MAX_CHARS = 400;

/** `text`, bounded for a card's field, which a producer writes beside the text that carries it whole. */
export function cardWords(text: string): string {
  return text.length <= CARD_WORDS_MAX_CHARS ? text : `${text.slice(0, CARD_WORDS_MAX_CHARS).trimEnd()}...`;
}

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

const SummaryFieldsSchema = v.looseObject({
  [TASK_REMINDER_OPEN_KEY]: v.optional(v.array(v.string())),
  approved: v.optional(Count),
  denied: v.optional(Count),
  decision: v.optional(v.string()),
  name: v.optional(v.string()),
  what: v.optional(v.nullable(v.string())),
  runs: v.optional(v.array(v.string())),
  heads: v.optional(Count),
  slate: v.optional(v.string()),
  said: v.optional(v.string()),
  ask: v.optional(v.boolean()),
  stage: v.optional(v.string()),
  reason: v.optional(v.string()),
  planTitle: v.optional(v.string()),
  feedback: v.optional(v.string()),
});

type SummaryFields = v.InferOutput<typeof SummaryFieldsSchema>;

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

function taskReminder(fields: SummaryFields): EventSummary {
  const titles = fields[TASK_REMINDER_OPEN_KEY] ?? [];

  // A reminder recorded before its titles were kept names none.
  if (titles.length === 0) return { label: 'Task reminder', line: 'Asked the agent to finish its open tasks or close them' };

  return { label: 'Task reminder', line: `${plural(titles.length, 'open task')}: ${titles.join(' · ')}` };
}

function deviceConsent(fields: SummaryFields): EventSummary {
  const approved = fields.approved ?? 0;
  const denied = fields.denied ?? 0;

  if (approved > 0 && denied > 0) return { label: 'Device use', line: `You approved ${plural(approved, 'command')} and denied ${plural(denied, 'command')}` };

  if (denied > 0) return { label: 'Device use', line: `You denied ${plural(denied, 'command')} on your computer` };

  if (approved > 0) return { label: 'Device use', line: `You approved ${plural(approved, 'command')} on your computer` };

  return { label: 'Device use', line: "You answered the agent's request to use your computer" };
}

function workspaceProposal(fields: SummaryFields): EventSummary {
  const named = fields.name === undefined ? 'the proposed workspace' : `"${fields.name}"`;

  if (fields.decision === 'declined') return { label: 'Workspace proposal', line: `You declined ${named}` };

  if (fields.decision === 'failed') return { label: 'Workspace proposal', line: `You approved ${named}, but creating it failed` };

  return { label: 'Workspace proposal', line: `You approved ${named}, and it was created` };
}

/** What each of the container's incident stages means to the person, by devbox's `IncidentStage`. */
const SANDBOX_STAGE_LINES = new Map([
  ['attach', 'The computer started without all of its files'],
  ['checkpoint', 'Recent work on the computer is not saved yet'],
  ['process', 'A process on the computer ended without a result'],
  ['port', 'A preview on the computer stopped answering'],
  ['quiesce', 'The computer could not read what it was running'],
  ['rest', 'The computer asks to rest'],
  ['recovered', 'The computer recovered'],
]);

/** The container's own words for what happened go below the line, read once the event is opened. */
function sandboxLifecycle(fields: SummaryFields): EventSummary {
  const line = SANDBOX_STAGE_LINES.get(fields.stage ?? '') ?? 'Something went wrong on the computer';

  return { label: 'Computer', line, ...(fields.reason !== undefined && { detail: fields.reason }) };
}

function planDecision(fields: SummaryFields, approved: boolean): EventSummary {
  const plan = fields.planTitle === undefined || fields.planTitle === '' ? 'the plan' : `"${fields.planTitle}"`;
  const detail = fields.feedback === undefined || fields.feedback === '' ? {} : { detail: fields.feedback };

  return { label: 'Plan', line: approved ? `You approved ${plan}: the agent builds it` : `You asked for changes to ${plan}`, ...detail };
}

function slate(fields: SummaryFields): EventSummary {
  const about = fields.slate === undefined ? {} : { about: fields.slate };
  const said = fields.said ?? 'A message from a slate';

  return { label: fields.ask === true ? 'Slate asks' : 'Slate', ...about, line: said };
}

/** The other events a turn can open on, each said in a fixed line: they carry nothing more a person needs. */
const FIXED = new Map<string, EventSummary>([
  ['output_continuation', { label: 'Continued', line: "The answer reached the model's length limit, so the agent carried on" }],
  ['overflow_retry', { label: 'Retried', line: "The conversation outgrew the model's window: it was compacted and the turn run again" }],
  ['completion_gate', { label: 'Runtime check', line: 'Asked the agent to check its task is finished' }],
  ['take_pick', { label: 'Take picked', line: 'You picked a take: the agent continues from it' }],
]);

/**
 * The summary of an event that has no card of its own, from its name and its metadata's fields. An event this does
 * not know is named, and nothing more: what it handed the agent may be instructions only the agent should read.
 */
export function summarizeSystemEvent(event: string, row: { metadata: unknown }): EventSummary {
  const parsed = v.safeParse(SummaryFieldsSchema, row.metadata);
  const fields: SummaryFields = parsed.success ? parsed.output : {};

  switch (event) {
    case 'task_reminder': return taskReminder(fields);
    case 'device_consent': return deviceConsent(fields);
    case 'workspace_proposal': return workspaceProposal(fields);
    case 'sandbox_lifecycle_failure': return sandboxLifecycle(fields);
    case 'plan_approved': return planDecision(fields, true);
    case 'plan_feedback': return planDecision(fields, false);
    case 'slate': return slate(fields);
    case 'fork_interrupted': {
      const heads = fields.heads ?? 0;
      const runs = fields.runs?.length ?? 0;

      return { label: 'Swarm interrupted', line: heads > 0 && runs > 0
        ? `${plural(heads, 'branch', 'branches')} in ${plural(runs, 'swarm')} stopped when the agent restarted: none will report`
        : 'A swarm stopped when the agent restarted: none will report' };
    }

    case 'owner_waits_cleared':
      return { label: 'Waits cleared', line: fields.what === undefined || fields.what === null
        ? 'You handled everything that waited on you'
        : `You handled: ${fields.what}` };
    default: {
      const fixed = FIXED.get(event);

      if (fixed !== undefined) return fixed;

      return { label: 'System', line: event === 'system' ? 'A note from Kinu to the agent' : event.replace(/_/g, ' ') };
    }
  }
}
