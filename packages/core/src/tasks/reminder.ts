// Stop-time reminder for open tasks, queued as a terminal effect keyed on the open list's state, so the agent's
// transcript enforces once per state across restarts. Ports OMP's `TodoTracker.checkCompletion`, minus its user-force
// skip and its in-memory count; plan mode never reminds (the plan is the product).

import type { ActiveRoster } from '../types/dynamic-context';
import type { AgentTaskTree } from '../tools/task-store';
import type { WorkMode } from '../types/turn';
import { fnv1a32Hex } from '../utils/fnv1a';
import { SYSTEM_REMINDER_TAG } from '../utils/prompt-sections';

/** Admit pre-flight drops a signal once the ledger no longer owes its reminder row. */
export const TASK_REMINDER_EVENT = 'task_reminder';

/** A reminder the agent is owed: its text, what it names (kept for the person's card), and the state it was owed for. */
export interface TaskReminder {
  readonly text: string;
  /** Each open task's and subtask's title, in the list's order: as many as the text counts. */
  readonly titles: readonly string[];
  /** The open list's state ({@link openListState}): its terminal effect's scope, so one state is reminded once. */
  readonly state: string;
}

/** Scoped to the open list's state it reminds of: a second turn ending on that state finds its turn already on disk. */
export const taskReminderIdempotencyKey = (scope: string): string => `task-reminder:${scope}`;

/** The open list as the agent last left it: each open task's and subtask's id and status. A new task, a closed one or a
 *  status moved is a new state, reminded once more; the same list left again is not. */
function openListState(open: ActiveRoster<AgentTaskTree>): string {
  const entries = open.items.map((tree) => [tree, ...tree.subtasks].map((task) => `${task.id}=${task.status}`).join(','));

  return `${String(open.total)}-${fnv1a32Hex(entries.join(';'))}`;
}

/**
 * Whether a result owed to the agent will wake it, which a reminder would only race: a hire that has not answered its
 * assignment (its roster row `working`), or a job that ends on its own (the job store's `countAwaited`). A
 * hire that waits on the agent (`awaiting_input`) and a process started to keep running owe it nothing.
 */
export function resultOwed(hireStatuses: Iterable<string>, jobsAwaited: number): boolean {
  if (jobsAwaited > 0) return true;

  for (const status of hireStatuses) if (status === 'working') return true;

  return false;
}

// Awaiting-answer predicates are OMP's `todo-tracker.ts` verbatim, taking assistant text directly.
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;

const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;

const QUESTION_PROMPT_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;

const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;

const USER_RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;

/** A non-ASCII character in a "?"-terminated line marks genuine prose where the English word gates cannot. */
// eslint-disable-next-line no-control-regex -- the non-ASCII gate is OMP's, verbatim: the whole point is catching bytes outside 7-bit prose.
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;


interface PromptLine {
  readonly text: string;
  readonly hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
  const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, '').trim();
  const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, '').trim();

  return { text: withoutPromptLabel, hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix };
}

function isQuestionPromptLine(line: string): boolean {
  const candidate = promptLine(line);

  if (!/[?？]\s*$/.test(candidate.text)) return false;

  return candidate.hadPromptLabel
    || QUESTION_PROMPT_RE.test(candidate.text)
    || USER_DIRECTED_PROMPT_RE.test(candidate.text)
    || NON_ASCII_TEXT_RE.test(candidate.text);
}

function isResponseCueLine(line: string): boolean {
  const candidate = promptLine(line).text.replace(/[.!?。！？]+$/, '').trim();

  return USER_RESPONSE_CUE_RE.test(candidate);
}

/** The last prose line asks a question or cues an answer; reminding it would punish asking. */
function isAwaitingUserAnswer(assistantText: string): boolean {
  const text = assistantText.trim();

  if (text.length === 0) return false;
  const lastLine = text.split(/\r?\n/).at(-1)?.trim();

  return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}

/** What a settled turn owes of its open tasks: a reminder once per state of the list, none while a result owed to the
 *  agent will wake it, and none for a turn that asked the person something. The list is read at commit, never captured. */
export function taskReminderOf(input: {
  readonly open: ActiveRoster<AgentTaskTree>;
  readonly assistantText: string;
  readonly workMode: WorkMode;
  readonly completed: boolean;
  readonly resultOwed: boolean;
}): TaskReminder | null {
  if (!input.completed || input.workMode === 'plan') return null;

  const groups = input.open.items;

  if (groups.length === 0 || input.resultOwed || isAwaitingUserAnswer(input.assistantText)) return null;

  // A finished task stays listed while a subtask under it is open; only what is open counts, and is named.
  const titles = groups.flatMap((tree) => [...(tree.status === 'open' || tree.status === 'active' ? [tree.title] : []), ...tree.subtasks.map((subtask) => subtask.title)]);

  return { text: renderTaskReminder(groups, titles.length), titles, state: openListState(input.open) };
}

/** OMP's shape narrowed to one level of nesting. */
function renderTaskReminder(groups: readonly AgentTaskTree[], incomplete: number): string {
  const todoList = groups.map((tree) => {
    const lines = [`- ${tree.title}`];

    for (const subtask of tree.subtasks) lines.push(`  - ${subtask.title}`);

    return lines.join('\n');
  }).join('\n');

  return `<${SYSTEM_REMINDER_TAG}>\n`
    + `You stopped with ${incomplete} open task(s):\n${todoList}\n\n`
    + 'Continue working on these tasks or mark them done if finished.\n'
    + `</${SYSTEM_REMINDER_TAG}>`;
}
