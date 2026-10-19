/**
 * What an event the agent was handed says to the person: a label, what it is about, and one line, from the event's
 * structured fields. Never from the text the agent was given: that is written for the model, in its tags and
 * instructions, and a person reading the chat sees what happened instead.
 */

import * as v from 'valibot';
import { CHAT_REWOUND_EVENT } from '../orchestrator/rewind-notice';

export interface EventSummary {
  /** What happened, short: "Task reminder". */
  readonly label: string;
  /** Who or what it came from, when that is not in the line. */
  readonly about?: string;
  /** The event's fields in one line: "1 open task: Store the export". Absent when the event carries none. */
  readonly line?: string;
  /** Words a person or the computer wrote that came with it, shown once the event is opened. */
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
  rewoundFiles: v.optional(Count),
  rewoundPaths: v.optional(v.array(v.string())),
  rewoundCommands: v.optional(Count),
  runningProcesses: v.optional(Count),
  exposedPorts: v.optional(v.array(v.number())),
});

type SummaryFields = v.InferOutput<typeof SummaryFieldsSchema>;

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** The parts there are, joined: "2 approved · 1 denied". */
const joined = (parts: readonly (string | false | undefined)[]): string | undefined => {
  const present = parts.filter((part): part is string => typeof part === 'string' && part !== '');

  return present.length === 0 ? undefined : present.join(' · ');
};

const withLine = (label: string, line: string | undefined, rest: Omit<EventSummary, 'label' | 'line'> = {}): EventSummary =>
  ({ label, ...rest, ...(line !== undefined && { line }) });

/** A reminder recorded before its titles were kept names none. */
function taskReminder(fields: SummaryFields): EventSummary {
  const titles = fields[TASK_REMINDER_OPEN_KEY] ?? [];

  return withLine('Task reminder', titles.length === 0 ? undefined : `${plural(titles.length, 'open task')}: ${titles.join(' · ')}`);
}

const PROPOSAL_DECISIONS = new Map([['created', 'created'], ['declined', 'declined'], ['failed', 'creation failed']]);

/** What each of the container's incident stages was, by devbox's `IncidentStage`. */
const SANDBOX_STAGES = new Map([
  ['attach', 'Attach failed'],
  ['checkpoint', 'Checkpoint failed'],
  ['process', 'Process lost'],
  ['port', 'Port closed'],
  ['quiesce', 'Process list unreadable'],
  ['rest', 'Rest requested'],
  ['recovered', 'Recovered'],
]);

const planDecision = (approved: boolean) => (fields: SummaryFields): EventSummary =>
  withLine(approved ? 'Plan approved' : 'Plan changes requested', fields.planTitle === '' ? undefined : fields.planTitle, {
    ...(fields.feedback !== undefined && fields.feedback !== '' && { detail: fields.feedback }),
  });

const counted = (count: number | undefined, said: (count: number) => string): string | false => (count ?? 0) > 0 && said(count ?? 0);

/** A chat-only rewind's notice (`rewind-notice.ts`): what the rewound turns changed, and what the computer holds now. */
function rewound(fields: SummaryFields): EventSummary {
  const ports = fields.exposedPorts ?? [];
  const paths = fields.rewoundPaths ?? [];
  const unnamed = (fields.rewoundFiles ?? 0) - paths.length;

  return withLine('Rewound', joined([
    counted(fields.rewoundFiles, (count) => `${plural(count, 'file')} changed`),
    counted(fields.rewoundCommands, (count) => plural(count, 'command')),
    counted(fields.runningProcesses, (count) => `${plural(count, 'process', 'processes')} running`),
    ports.length > 0 && `${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`,
  ]), { ...(paths.length > 0 && { detail: [...paths, ...(unnamed > 0 ? [`and ${plural(unnamed, 'more file')}`] : [])].join('\n') }) });
}

/** The events with fields to say, each by its own summary. */
const SUMMARIES = new Map<string, (fields: SummaryFields) => EventSummary>([
  ['task_reminder', taskReminder],
  ['device_consent', (fields) => withLine('Device use', joined([
    counted(fields.approved, (count) => `${String(count)} approved`), counted(fields.denied, (count) => `${String(count)} denied`),
  ]))],
  ['workspace_proposal', (fields) => withLine('Workspace proposal', joined([fields.name, PROPOSAL_DECISIONS.get(fields.decision ?? '')]))],
  ['sandbox_lifecycle_failure', (fields) => withLine('Computer', SANDBOX_STAGES.get(fields.stage ?? ''), {
    ...(fields.reason !== undefined && { detail: fields.reason }),
  })],
  ['plan_approved', planDecision(true)],
  ['plan_feedback', planDecision(false)],
  ['slate', (fields) => withLine(fields.ask === true ? 'Slate ask' : 'Slate', fields.said, { ...(fields.slate !== undefined && { about: fields.slate }) })],
  ['fork_interrupted', (fields) => withLine('Swarm interrupted', joined([
    counted(fields.heads, (count) => plural(count, 'branch', 'branches')), counted(fields.runs?.length, (count) => plural(count, 'run')),
  ]))],
  ['owner_waits_cleared', (fields) => withLine('Waits cleared', fields.what ?? undefined)],
  [CHAT_REWOUND_EVENT, rewound],
]);

/** The other events a turn can open on, each the same every time: they carry no fields. */
const FIXED = new Map<string, EventSummary>([
  ['output_continuation', { label: 'Continued', line: 'Output limit reached' }],
  ['overflow_retry', { label: 'Retried', line: 'Context window exceeded, compacted' }],
  ['completion_gate', { label: 'Runtime check' }],
  ['take_pick', { label: 'Take picked' }],
]);

/**
 * The summary of an event that has no card of its own, from its name and its metadata's fields. An event this does
 * not know is named, and nothing more: what it handed the agent may be instructions only the agent should read.
 */
export function summarizeSystemEvent(event: string, row: { metadata: unknown }): EventSummary {
  const parsed = v.safeParse(SummaryFieldsSchema, row.metadata);
  const fields: SummaryFields = parsed.success ? parsed.output : {};

  const summarize = SUMMARIES.get(event);

  if (summarize !== undefined) return summarize(fields);

  return FIXED.get(event) ?? withLine('System', event === 'system' ? undefined : event.replace(/_/g, ' '));
}
