/**
 * A personal part as its viewer sees it, in the app's frame inside the slate's page (docs/SLATE-SHARING-NIMBUS.md §3):
 * the part's own markup, already cut by Kinu, in a nested frame that runs no scripts; Kinu's own controls under it; and,
 * when the part cannot show yet, what stands in its place and the one thing to do about it. The decisions it leads to
 * (allow, approve, show everyone) open in the app page at the top, where the slate's script cannot cover them.
 *
 * The slate's page can count the frames inside a part's frame, though it can read nothing else of it. So every state
 * holds the same one nested frame (`SealedContent`), drawn only when the part is shown, and no state differs in frames.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EyeIcon, LockSimpleIcon, PlugIcon, SignInIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { PartAction, PartRunAnswer } from "@kinu.run/core";
import { serverWords } from "./words";
import { TextInput } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";

/** What the frame does for its viewer; the decisions among them open in the top page. */
export interface PartControls {
  readonly act: (action: { id: string; input: string | null }) => void;
  readonly decide: (kind: "consent" | "approval" | "show") => void;
  readonly signIn: () => void;
  readonly retry: () => void;
}

/** A small control under the part's own content. */
function PartButton({ children, onClick, ...data }: {
  children: ReactNode;
  onClick: () => void;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <Button size="sm" onClick={onClick} {...data} className="text-left">{children}</Button>
  );
}

/** A part held back from its viewer: it fills the part, so the slate's page shows no gap where it stands. */
function InPlace({ icon, said, action, onAct, ...data }: {
  icon: ReactNode;
  said: string;
  action: string | null;
  onAct: () => void;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <Surface look="well" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center" {...data}>
      <span className="shrink-0 p-text-3">{icon}</span>
      <p className="t-body max-w-sm p-text-2">{said}</p>
      {action !== null && <Button variant="primary" size="sm" onClick={onAct}>{action}</Button>}
    </Surface>
  );
}

/** One of the part's own controls: a button, or a field and its button when it asks for something. */
function ActionControl({ action, onAct }: { action: PartAction; onAct: PartControls["act"] }) {
  const [text, setText] = useState("");

  if (action.input === undefined) return <PartButton data-part-action={action.id} onClick={() => onAct({ id: action.id, input: null })}>{action.label}</PartButton>;

  return (
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); onAct({ id: action.id, input: text }); }}>
      <TextInput size="sm" className="min-w-0 flex-1" value={text} onChange={(event) => setText(event.target.value)} aria-label={action.label} data-part-action-input={action.id} />
      <PartButton data-part-action={action.id} onClick={() => onAct({ id: action.id, input: text })}>{action.label}</PartButton>
    </form>
  );
}

/**
 * The part's markup in the one nested frame every state of its frame holds, kept in place from the first render on:
 * `html`, Kinu's cut of it, is drawn when the part is shown, and otherwise the frame stays, empty and out of view.
 */
export function SealedContent({ html }: { html: string | null }) {
  // Sealed: Kinu cut it to script-free, resource-free markup, and its frame runs nothing besides.
  return (
    <iframe srcDoc={html ?? ""} sandbox="" title="Part" data-part-content
      className={html === null ? "hidden" : "block h-0 min-h-0 w-full flex-1 border-0 bg-transparent"} />
  );
}

/** What a shown part draws in its `SealedContent`, null in every other state. */
export const shownMarkup = (answer: PartRunAnswer | null): string | null => (answer?.kind === "shown" ? answer.html : null);

/** The part as its last answer says, beside its `SealedContent`, with the slate's title to name it by. */
export function PartView({ answer, slate, controls }: { answer: PartRunAnswer; slate: string; controls: PartControls }) {
  switch (answer.kind) {
    case "shown": {
      // Its markup is in the sealed frame above; under it, Kinu's own controls.
      if (answer.actions.length === 0 && answer.show === null) return null;

      return (
        <div className="flex flex-wrap items-center gap-2">
          {answer.actions.map((action) => <ActionControl key={action.id} action={action} onAct={controls.act} />)}
          {answer.show !== null && (
            <PartButton data-part-show onClick={() => controls.decide("show")}><EyeIcon size={13} />Show to everyone…</PartButton>
          )}
        </div>
      );
    }

    case "needs-consent": {
      return (
        <InPlace data-part-needs="consent" icon={<PlugIcon size={22} />} said={`${slate} wants to use your ${serverWords(answer.ask)} to show you this part.`}
          action="Review…" onAct={() => controls.decide("consent")} />
      );
    }

    case "needs-approval": {
      return (
        <InPlace data-part-needs="approval" icon={<WarningCircleIcon size={22} />}
          said={`This part wants to make a change on your ${serverWords(answer.ask)}. Nothing happens until you approve it.`}
          action="Review…" onAct={() => controls.decide("approval")} />
      );
    }

    case "stub": {
      return answer.reason === "signed-out"
        ? <InPlace data-part-stub="signed-out" icon={<SignInIcon size={22} />} said={answer.message} action="Sign in" onAct={controls.signIn} />
        : <InPlace data-part-stub="no-part" icon={<LockSimpleIcon size={22} />} said={answer.message} action={null} onAct={controls.retry} />;
    }

    case "failed": {
      return <InPlace data-part-failed icon={<WarningCircleIcon size={22} />} said={answer.message} action="Try again" onAct={controls.retry} />;
    }
  }
}

/** A part frame opened outside its slate's page, or one whose page has no app above it: nothing of the viewer shows. */
export function PartOutsideItsSlate() {
  return (
    <div data-part-outside className="flex flex-1 items-center justify-center px-4 text-center">
      <p className="t-body max-w-sm p-text-2">This part shows only inside its slate, opened from Kinu.</p>
    </div>
  );
}
