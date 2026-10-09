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

  const choose = (label: string): void => {
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
                <input type={many ? "checkbox" : "radio"} name={name} className="mt-0.5 shrink-0 accent-[var(--p-accent)]" checked={checked}
                  onChange={() => choose(option.label)} onFocus={() => setFocused(index)} />
                <span className="min-w-0">
                  <span className="p-row-text p-text">
                    {option.label}
                    {question.recommended === index && <span className="ml-1 p-meta p-accent-fg" data-question-recommended> (Recommended)</span>}
                  </span>
                  {option.description !== undefined && <span className="block p-meta p-text-2">{option.description}</span>}
                </span>
              </label>
            );
          })}
          <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:p-fill" data-question-option={OTHER_OPTION}>
            <input type={many ? "checkbox" : "radio"} name={name} className="mt-0.5 shrink-0 accent-[var(--p-accent)]" checked={draft.other !== null}
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
          <pre className="max-h-48 min-w-0 overflow-auto rounded-md px-2 py-1.5 p-t-code p-text-2 whitespace-pre p-fill" data-question-preview>{preview}</pre>
        )}
      </div>
    </fieldset>
  );
}

export function QuestionCard({ asking, busy, onAnswer, onDismiss }: {
  asking: AskingAgent;
  busy: boolean;
  onAnswer: (answers: readonly OwnerAnswer[]) => void;
  onDismiss: () => void;
}): ReactNode {
  const { questions } = asking.asked;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, AnswerDraft>>(new Map());
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const draftOf = (id: string): AnswerDraft => drafts.get(id) ?? EMPTY;
  const answers = questions.map((question) => answerOf(question, draftOf(question.id)));
  const ready = answers.every((answer) => answer !== null);

  const send = (): void => {
    const [first] = questions;
    const noted = note.trim();

    onAnswer(answers.flatMap((answer) => {
      if (answer === null) return [];

      return noted !== "" && answer.id === first?.id ? [{ ...answer, note: noted }] : [answer];
    }));
  };

  return (
    <div data-question-card={asking.asked.id}>
      <div className="flex flex-col gap-3">
        {questions.map((question) => (
          <QuestionField key={question.id} question={question} draft={draftOf(question.id)} busy={busy}
            onDraft={(draft) => setDrafts((was) => new Map([...was, [question.id, draft]]))} />
        ))}
      </div>
      {noting ? (
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="A note for the agent" aria-label="A note for the agent"
          className="mt-2 block w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring" />
      ) : (
        <button type="button" className="mt-1.5 p-meta p-accent-fg hover:underline" onClick={() => setNoting(true)}>Add a note</button>
      )}
      <div className="mt-1 p-meta p-text-3">{asking.actor === null ? "Asked" : `${asking.agent} asked`} {timeAgo(asking.asked.askedAt)}. The agent waits for your answer.</div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss} data-question-dismiss>
          <XIcon size={12} weight="bold" aria-hidden />Dismiss
        </Button>
        <FilledButton disabled={busy || !ready} onClick={send} data-question-answer>
          <CheckIcon size={12} weight="bold" aria-hidden />Answer
        </FilledButton>
      </div>
    </div>
  );
}

/** The agent's questions, closed or open, by the call that asked them: what the transcript's record of each reads. */
export const AskedQuestionsContext = createContext<ReadonlyMap<string, AskedQuestions>>(new Map());

const CLOSED_AS = { dismissed: "Dismissed", in_chat: "Answered in the chat" } as const;

/** Where the agent asked, a small record of what it asked and what came back; the questions themselves are answered in the stack. */
export function AskRecord({ callId, input }: { callId: string; input: unknown }): ReactNode {
  const asked = useContext(AskedQuestionsContext).get(callId);
  const parsed = v.safeParse(AskOwnerInputSchema, input);
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
