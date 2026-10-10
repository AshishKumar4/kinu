/**
 * An agent's questions to the owner, answered in the attention stack: each question's options as radios, or checkboxes
 * where it takes several, the recommended one marked, "Other" to write an answer, a note, and for a single-choice
 * question a preview of the focused option. Answering sends every question's answer at once; Dismiss closes them.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import * as v from "valibot";
import { Button } from "@cloudflare/kumo";
import { ChatCircleTextIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import { AskOwnerInputSchema, OTHER_OPTION, timeAgo, type AskedQuestions, type AskingAgent, type OwnerAnswer, type OwnerQuestion } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";

interface AnswerDraft {
  readonly selected: readonly string[];
  /** What the owner wrote for "Other"; null while "Other" is not chosen. */
  readonly other: string | null;
  readonly note: string;
}

const EMPTY: AnswerDraft = { selected: [], other: null, note: "" };

function answerOf(question: OwnerQuestion, draft: AnswerDraft): OwnerAnswer | null {
  const other = draft.other?.trim() ?? "";
  const note = draft.note.trim();

  if (question.multi !== true && draft.selected.length === 0 && other === "") return null;

  return { id: question.id, selected: [...draft.selected], ...(other !== "" && { other }), ...(note !== "" && { note }) };
}

function QuestionField({ question, draft, onDraft, busy }: {
  question: OwnerQuestion;
  draft: AnswerDraft;
  onDraft: (draft: AnswerDraft) => void;
  busy: boolean;
}): ReactNode {
  const many = question.multi === true;
  const [focused, setFocused] = useState(question.recommended ?? 0);
  const preview = many ? undefined : question.options[focused]?.preview;
  const name = `question-${question.id}`;

  const choose = (label: string, index: number): void => {
    setFocused(index);

    if (many) {
      onDraft({ ...draft, selected: draft.selected.includes(label) ? draft.selected.filter((each) => each !== label) : [...draft.selected, label] });

      return;
    }

    onDraft({ ...draft, selected: [label], other: null });
  };

  return (
    <fieldset className="min-w-0" data-question={question.id} disabled={busy}>
      <legend className="flex min-w-0 items-baseline gap-1.5">
        {question.header !== undefined && <span className="shrink-0 rounded-sm px-1.5 p-meta p-badge-neutral" data-question-header>{question.header}</span>}
        <span className="p-row-text p-text">{question.question}</span>
      </legend>
      <div className={preview === undefined ? "mt-1.5" : "mt-1.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"}>
        <div className="flex min-w-0 flex-col gap-1" role={many ? "group" : "radiogroup"} aria-label={question.question}>
          {question.options.map((option, index) => {
            const checked = draft.selected.includes(option.label);

            return (
              <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:p-fill" data-question-option={option.label}
                onMouseEnter={() => setFocused(index)}>
                <input type={many ? "checkbox" : "radio"} name={name} className="mt-0.5 shrink-0 accent-[var(--c-accent)]" checked={checked}
                  onChange={() => choose(option.label, index)} onFocus={() => setFocused(index)} />
                <span className="min-w-0">
                  <span className="p-row-text p-text">
                    {option.label}
                    {question.recommended === index && <span className="ml-1 p-meta p-accent" data-question-recommended> (Recommended)</span>}
                  </span>
                  {option.description !== undefined && <span className="block p-meta p-text-2">{option.description}</span>}
                </span>
              </label>
            );
          })}
          <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:p-fill" data-question-option={OTHER_OPTION}>
            <input type={many ? "checkbox" : "radio"} name={name} className="mt-0.5 shrink-0 accent-[var(--c-accent)]" checked={draft.other !== null}
              onChange={() => onDraft(draft.other === null ? { ...draft, other: "", selected: many ? draft.selected : [] } : { ...draft, other: null })} />
            <span className="min-w-0 flex-1">
              <span className="p-row-text p-text">{OTHER_OPTION}</span>
              {draft.other !== null && (
                <textarea value={draft.other} onChange={(event) => onDraft({ ...draft, other: event.target.value })} aria-label={`Your answer to: ${question.question}`}
                  placeholder="Write your answer" rows={2} autoFocus data-question-other
                  className="mt-1 block w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring" />
              )}
            </span>
          </label>
        </div>
        {preview !== undefined && (
          <pre className="p-code max-h-48 min-w-0 overflow-auto rounded-md px-2.5 py-2 text-xs leading-5 whitespace-pre" data-question-preview>{preview}</pre>
        )}
      </div>
    </fieldset>
  );
}

interface Unsent {
  readonly drafts: ReadonlyMap<string, AnswerDraft>;
  /** The note being written; null until "Add a note". */
  readonly note: string | null;
}

/** What the owner chose and has not sent, by questions: the stack shows one card at a time, and one set aside keeps it. */
const UNSENT = new Map<string, Unsent>();

export function QuestionCard({ asking, busy, onAnswer, onDismiss }: {
  asking: AskingAgent;
  busy: boolean;
  onAnswer: (answers: readonly OwnerAnswer[]) => void;
  onDismiss: () => void;
}): ReactNode {
  const { id, questions } = asking.asked;
  const [unsent, setUnsent] = useState<Unsent>(() => UNSENT.get(id) ?? { drafts: new Map(), note: null });
  const draftOf = (question: string): AnswerDraft => unsent.drafts.get(question) ?? EMPTY;
  const answers = questions.map((question) => answerOf(question, draftOf(question.id)));
  const ready = answers.every((answer) => answer !== null);

  const keep = (next: Unsent): void => {
    UNSENT.set(id, next);
    setUnsent(next);
  };

  const send = (): void => {
    const [first] = questions;
    const noted = unsent.note?.trim() ?? "";

    UNSENT.delete(id);
    onAnswer(answers.flatMap((answer) => {
      if (answer === null) return [];

      return noted !== "" && answer.id === first?.id ? [{ ...answer, note: noted }] : [answer];
    }));
  };

  const dismiss = (): void => {
    UNSENT.delete(id);
    onDismiss();
  };

  return (
    <div data-question-card={id}>
      <div className="-mx-1 flex max-h-[min(55vh,32rem)] flex-col gap-3 overflow-y-auto px-1">
        {questions.map((question) => (
          <QuestionField key={question.id} question={question} draft={draftOf(question.id)} busy={busy}
            onDraft={(draft) => keep({ ...unsent, drafts: new Map([...unsent.drafts, [question.id, draft]]) })} />
        ))}
      </div>
      {unsent.note === null ? (
        <button type="button" className="mt-1.5 p-meta p-accent hover:underline" onClick={() => keep({ ...unsent, note: "" })}>Add a note</button>
      ) : (
        <textarea value={unsent.note} onChange={(event) => keep({ ...unsent, note: event.target.value })} rows={2} placeholder="A note for the agent"
          aria-label="A note for the agent"
          className="mt-2 block w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring" />
      )}
      <div className="mt-1 p-meta p-text-3">{asking.actor === null ? "Asked" : `${asking.agent} asked`} {timeAgo(asking.asked.askedAt)}. The agent waits for your answer.</div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={dismiss} data-question-dismiss>
          <XIcon size={12} weight="bold" aria-hidden />Dismiss
        </Button>
        <FilledButton disabled={busy || !ready} onClick={send} data-question-answer>
          <CheckIcon size={12} weight="bold" aria-hidden />Answer
        </FilledButton>
      </div>
    </div>
  );
}

/** One agent's questions, closed or open: what the transcript's record of each call reads. */
export const AskedQuestionsContext = createContext<readonly AskedQuestions[]>([]);

/** The questions `actor` asked (null: the workspace agent). */
export function askedBy(asking: readonly AskingAgent[], actor: string | null): readonly AskedQuestions[] {
  return asking.filter((each) => each.actor === actor).map((each) => each.asked);
}

const CLOSED_AS = { dismissed: "Dismissed", in_chat: "Answered in the chat" } as const;

/** Where the agent asked, a small record of what it asked and what came back; the questions themselves are answered in the stack. */
export function AskRecord({ callId, input }: { callId: string; input: unknown }): ReactNode {
  const parsed = v.safeParse(AskOwnerInputSchema, input);

  // Each side as the schema reads it, so key order (the model's, or the store's) cannot tell one ask from another.
  const canonical = (questions: readonly OwnerQuestion[]): string | null => {
    const read = v.safeParse(AskOwnerInputSchema, { questions });

    return read.success ? JSON.stringify(read.output.questions) : null;
  };

  const asked = useContext(AskedQuestionsContext)
    // A provider may reuse a call id across turns: the questions tell the calls apart, as the store's digest does.
    .find((each) => each.callId === callId && (!parsed.success || canonical(each.questions) === canonical(parsed.output.questions)));

  const questions = asked?.questions ?? (parsed.success ? parsed.output.questions : []);

  return (
    <div className="rounded-md border p-border px-3 py-2" data-ask-record={asked?.status ?? "asked"}>
      <div className="flex items-center gap-1.5 p-meta p-text-3">
        <ChatCircleTextIcon size={12} aria-hidden />
        <span>{asked?.status === "open" ? "Asked you, waiting for your answer" : "Asked you"}</span>
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {questions.map((question) => {
          const answer = asked?.answers?.find((each) => each.id === question.id);
          const said = [...answer?.selected ?? [], ...(answer?.other === undefined ? [] : [`“${answer.other}”`])].join(", ");

          return (
            <li key={question.id} className="min-w-0">
              <div className="p-row-text p-text-2">{question.question}</div>
              {asked?.status === "answered" && <div className="p-row-text p-text" data-ask-answer={question.id}>{said}{answer?.note !== undefined && <span className="p-meta p-text-3"> · {answer.note}</span>}</div>}
            </li>
          );
        })}
      </ul>
      {(asked?.status === "dismissed" || asked?.status === "in_chat") && <div className="mt-1 p-meta p-text-3">{CLOSED_AS[asked.status]}</div>}
    </div>
  );
}
