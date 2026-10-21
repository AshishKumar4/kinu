/**
 * Setup's personal assistant step: one question, the assistant's face (drawn from the person's name, as Home and the
 * rail draw it) and its name, which they may change. Set it up is chosen when the step opens, so Next installs it;
 * Not now leaves Home as it is, and Explore keeps it for later. What it reaches and when it briefs them are its own
 * defaults, changed later in its settings.
 */
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { ChatMascot, personMascot } from "@/components/Marks";

export interface AssistantChoice {
  readonly install: boolean;
  readonly name: string;
}

export const DEFAULT_ASSISTANT: AssistantChoice = { install: true, name: "Kinu" };

function Answer({ chosen, onChoose, value, title, badge }: {
  chosen: boolean; onChoose: () => void; value: string; title: string; badge?: string;
}) {
  return (
    <label data-assistant-tile={value}
      className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border p-border px-4 py-3 transition-colors hover:border-[var(--c-border-strong)] has-[:checked]:border-[var(--c-accent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--c-selected)]">
      <input type="radio" name="assistant" value={value} checked={chosen} onChange={onChoose} className="sr-only" />
      <span className="t-item p-text">{title}</span>
      {badge !== undefined && <span className="t-meta p-text-3">{badge}</span>}
    </label>
  );
}

export function AssistantStep({ choice, onChange, person }: {
  choice: AssistantChoice;
  onChange: (choice: AssistantChoice) => void;
  /** What the person is called: their assistant's look is drawn from it. */
  person: string;
}) {
  const look = personMascot(person);

  return (
    <div className="space-y-5" data-assistant-step>
      <div className={`flex items-center gap-4 transition-opacity ${choice.install ? "" : "opacity-50"}`} data-assistant-preview>
        <ChatMascot seed={look.seed} colour={look.colour} activity="idle" size={48} />
        <div className="min-w-0 flex-1">
          {/* Reads as its name until pressed; an edit is optional, never asked for. */}
          <label className="group/name flex w-fit max-w-full items-center gap-2">
            <input value={choice.name} maxLength={40} onChange={(event) => onChange({ ...choice, name: event.target.value })}
              aria-label="Its name" size={Math.max(4, choice.name.length + 1)}
              className="t-title min-w-0 rounded-md border border-transparent bg-transparent px-1 -mx-1 p-text transition-colors hover:border-[var(--c-border)]" />
            <PencilSimpleIcon size={13} aria-hidden className="shrink-0 p-text-3 opacity-60 group-hover/name:opacity-100" />
          </label>
          <p className="t-body mt-px p-text-2">An assistant that lives on Home: it reads your mail, tells you each morning what needs you, and takes on bigger jobs.</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="A personal assistant" className="grid gap-3 sm:grid-cols-2">
        <Answer value="yes" chosen={choice.install} onChoose={() => onChange({ ...choice, install: true })} title="Set it up" badge="Recommended" />
        <Answer value="no" chosen={!choice.install} onChoose={() => onChange({ ...choice, install: false })} title="Not now" />
      </div>
    </div>
  );
}
