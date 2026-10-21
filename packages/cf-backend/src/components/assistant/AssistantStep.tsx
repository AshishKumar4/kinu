/**
 * Setup's personal assistant step: one question, the assistant's face (drawn from the person's name, as Home and the
 * rail draw it) and its name, which they may change. Set it up is chosen when the step opens, so Next installs it;
 * Not now leaves Home as it is, and Explore keeps it for later. What it reaches and when it briefs them are its own
 * defaults, changed later in its settings.
 */
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { ChatMascot, personMascot } from "@/components/ui/Marks";
import { Choices } from "@/components/ui/Choices";
import { TextInput } from "@/components/ui/Field";

export interface AssistantChoice {
  readonly install: boolean;
  readonly name: string;
}

export const DEFAULT_ASSISTANT: AssistantChoice = { install: true, name: "Kinu" };

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
            <TextInput bare value={choice.name} maxLength={40} onChange={(event) => onChange({ ...choice, name: event.target.value })}
              aria-label="Its name" style={{ width: `${String(Math.max(4, choice.name.length + 1))}ch` }} className="t-title min-w-0 p-text" />
            <PencilSimpleIcon size={13} aria-hidden className="shrink-0 p-text-3 opacity-60 group-hover/name:opacity-100" />
          </label>
          <p className="t-body mt-px p-text-2">An assistant that lives on Home: it reads your mail, tells you each morning what needs you, and takes on bigger jobs.</p>
        </div>
      </div>

      <Choices tiles label="A personal assistant" marker="data-assistant-tile" value={choice.install ? "yes" : "no"}
        onChange={(id) => onChange({ ...choice, install: id === "yes" })}
        options={[{ id: "yes", label: "Set it up", aside: <span className="t-meta p-text-3">Recommended</span> }, { id: "no", label: "Not now" }]} />
    </div>
  );
}
