// The stop-time reminder: a turn that ends while its task list still holds open
// items gets one queued turn telling it so — as a terminal effect, so the once
// is enforced by the ledger rather than by the model's goodwill.
//
// The algorithm is OMP's `TodoTracker.checkCompletion` (todo-tracker.ts)
// narrowed to this list's shape: the cap, the awaiting-answer skip, the
// background-work skip, and the "a reminder with no tool result since blocks
// the next" latch all port over; what does not is the tool-choice "user-force"
// skip, which has no analogue here — Kinu signals are the ledger's own, not a
// user prompt — and plan mode, which has one: `workMode: 'plan'` settles a turn
// whose product is the plan, so a reminder there would lecture a turn for the
// artifact it was told to leave.

import type { ActiveRoster } from '../prompting/volatile-context';
import type { AgentTaskTree } from './store';
import type { WorkMode } from '../types/turn';

/** The queued turn's `kinuEvent`, stamped on its durable row and read back by
 *  the admit pre-flight: a signal is admitted only while the ledger still owes
 *  its reminder row, and a stale replay drops. */
export const TASK_REMINDER_EVENT = 'task_reminder';

/** The idempotency key the effect queues its signal under, scoped to the turn
 *  that owed the reminder — the roster's one scope per claim. */
export const taskReminderIdempotencyKey = (scope: string): string => `task-reminder:${scope}`;

/** How many reminders one stretch of silence earns. OMP's `todo.remindersMax`
 *  is 3; the cap here is 2 because the same reminder a second time tells the
 *  model nothing the first did not. */
const TASK_REMINDER_MAX_ATTEMPTS = 2;

// The awaiting-answer predicates below are OMP's `todo-tracker.ts` verbatim —
// same regexes, same line-shape rules, narrowed only to take the assistant's
// text directly rather than an AssistantMessage.
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;

const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;

const QUESTION_PROMPT_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;

const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;

const USER_RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;

/** A trailing question mark is the universal signal that a line is a question,
 *  but the English word/pronoun gates above exist to filter incidental "?" out
 *  of prose (e.g. a TypeScript `foo?: string` tail). Non-English text has no
 *  cheap word list, yet any non-ASCII character in a "?"/"？"-terminated line
 *  reliably marks it as genuine prose — CJK/Japanese/Korean, Spanish `¿…?`,
 *  accented Latin — so treat it as a real user-directed question. */
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

/** An assistant turn that is waiting on the operator rather than ending its
 *  work: the last prose line asks a question or cues an answer. Reminding a
 *  turn that stopped to ASK would punish the behaviour the reminder exists to
 *  protect. */
function isAwaitingUserAnswer(assistantText: string): boolean {
  const text = assistantText.trim();

  if (text.length === 0) return false;
  const lastLine = text.split(/\r?\n/).at(-1)?.trim();

  return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}

/** One session's reminder memory. The attempt count rides the conversation —
 *  the operator's words start it over, an empty list parks it, and a fired
 *  reminder that earned no tool result blocks the next one: asking again
 *  before the model had a chance to answer the first reminder is noise. */
export class TaskReminders {
  private attempts = 0;
  private awaitingProgress = false;

  /** The operator spoke: the count AND the latch start over, exactly as a
   *  fresh prompt runs OMP's `resetCycle` — a user answer is itself the
   *  progress the latch was waiting on. Read on a USER turn's admission. */
  noteUserPrompt(): void {
    this.attempts = 0;
    this.awaitingProgress = false;
  }
  /** Any tool result is progress on the last reminder — the model worked —
   *  so the next settle is judged fresh. Read when the turn's stream observes
   *  a `tool-result` event. */
  noteToolResult(): void {
    this.awaitingProgress = false;
  }

  /** The terminal-decision half of `checkCompletion`: given the turn's
   *  outcome and the open list as it stands NOW (read at commit, never
   *  captured), the reminder this turn owes, or null and why it does not. */
  decide(input: {
    readonly open: ActiveRoster<AgentTaskTree>;
    readonly assistantText: string;
    readonly workMode: WorkMode;
    readonly completed: boolean;
    readonly asyncWakePending: boolean;
  }): { readonly text: string } | null {
    // A turn that errored or was interrupted owes its recovery effects, not a
    // reminder — the ledger's other rows carry that turn.
    if (!input.completed) return null;

    if (input.workMode === 'plan') return null;

    // The list's state is read before the latch: a clean list closes the
    // question the last reminder asked, so the count and the latch park too.
    // `listOpen` already pre-filters: a parent is here because it or one of
    // its subtasks is still open — a done parent carried for context counts
    // nothing itself.
    const groups = input.open.items;

    if (groups.length === 0) {
      this.attempts = 0;
      this.awaitingProgress = false;

      return null;
    }

    // The last reminder is still unanswered: the model has not produced a tool
    // result since it fired, so it may not even have read the reminder yet.

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

/** The reminder's text, the OMP shape narrowed to one level of nesting: the
 *  open parent and its open subtasks, the count, and the attempt marker. */
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
