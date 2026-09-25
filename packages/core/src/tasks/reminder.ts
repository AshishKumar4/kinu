// Stop-time reminder for open tasks, queued as a terminal effect so the ledger enforces the once. Ports OMP's
// `TodoTracker.checkCompletion`, minus its user-force skip; plan mode never reminds (the plan is the product).

import type { ActiveRoster } from '../types/dynamic-context';
import type { AgentTaskTree } from '../tools/task-store';
import type { WorkMode } from '../types/turn';

/** Admit pre-flight drops a signal once the ledger no longer owes its reminder row. */
export const TASK_REMINDER_EVENT = 'task_reminder';

/** Scoped to the turn that owed the reminder. */
export const taskReminderIdempotencyKey = (scope: string): string => `task-reminder:${scope}`;

/** OMP's `todo.remindersMax` is 3; a second identical reminder tells the model nothing new. */
const TASK_REMINDER_MAX_ATTEMPTS = 2;

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

/** A fired reminder that earned no tool result blocks the next one; operator words reset the count. */
export class TaskReminders {
  private attempts = 0;
  private awaitingProgress = false;

  /** Resets count and latch, like OMP's `resetCycle`; read on a user turn's admission. */
  noteUserPrompt(): void {
    this.attempts = 0;
    this.awaitingProgress = false;
  }
  /** Any tool result is progress on the last reminder. */
  noteToolResult(): void {
    this.awaitingProgress = false;
  }

  /** The open list is read at commit, never captured. */
  decide(input: {
    readonly open: ActiveRoster<AgentTaskTree>;
    readonly assistantText: string;
    readonly workMode: WorkMode;
    readonly completed: boolean;
    readonly asyncWakePending: boolean;
  }): { readonly text: string } | null {
    if (!input.completed) return null;

    if (input.workMode === 'plan') return null;

    // Read the list before the latch: a clean list closes the last reminder's question.
    const groups = input.open.items;

    if (groups.length === 0) {
      this.attempts = 0;
      this.awaitingProgress = false;

      return null;
    }

    if (this.awaitingProgress) return null;

    if (this.attempts >= TASK_REMINDER_MAX_ATTEMPTS) return null;

    const incomplete = groups.reduce((count, tree) => count + (tree.status === 'open' || tree.status === 'active' ? 1 : 0) + tree.subtasks.length, 0);

    if (isAwaitingUserAnswer(input.assistantText)) return null;

    if (input.asyncWakePending) return null;

    this.attempts += 1;
    this.awaitingProgress = true;

    return { text: renderTaskReminder(groups, incomplete, this.attempts) };
  }
}

/** OMP's shape narrowed to one level of nesting. */
function renderTaskReminder(groups: readonly AgentTaskTree[], incomplete: number, attempt: number): string {
  const todoList = groups.map((tree) => {
    const lines = [`- ${tree.title}`];

    for (const subtask of tree.subtasks) lines.push(`  - ${subtask.title}`);

    return lines.join('\n');
  }).join('\n');

  return '<system-reminder>\n'
    + `You stopped with ${incomplete} open task(s):\n${todoList}\n\n`
    + 'Continue working on these tasks or mark them done if finished.\n'
    + `(Reminder ${attempt}/${TASK_REMINDER_MAX_ATTEMPTS})\n`
    + '</system-reminder>';
}
