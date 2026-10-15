/**
 * Decisions, in the live page and never in a part's frame, which the slate's code could cover (security §6). What a
 * person chooses for themselves (whom to show their own data to, letting a part use their connection) opens as a dialog
 * they started. What others ask of a holder (to see a part, to run an effect, to send their data on, to lend again)
 * arrives as a card that waits beside their work.
 */
import { useState } from "react";
import { CheckIcon, EyeIcon, LockSimpleIcon, PlugIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import type { RoomAsk, RoomCall, RoomReach, RoomView, ShowScope } from "@kinu.run/core";
import type { RoomDecision } from "@/lib/room-bridge";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { askOf, cannotOf, canOf, firstName, names } from "./words";

/** Choosing whom to show one's own data to; it applies to that part only. */
function ShowChoice({ source, members, onShow, onClose }: {
  source: string;
  /** The people added to the slate, by first name, when the room names them. */
  members: readonly string[] | null;
  onShow: (scope: ShowScope) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<ShowScope>("members");

  const options: readonly { id: ShowScope; label: string }[] = [
    { id: "members", label: members === null || members.length === 0 ? "Everyone here now" : `Everyone here now (${names(members)})` },
    { id: "anyone", label: "Anyone who can open this slate" },
  ];

  return (
    <Modal title="Show this part" icon={<EyeIcon size={18} className="p-accent" />} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>Not now</Button><FilledButton data-show-confirm onClick={() => onShow(scope)}>Show</FilledButton></div>}>
      <p className="flex items-center gap-1.5 p-meta p-text-3"><LockSimpleIcon size={13} className="shrink-0" />From {source} · only this part</p>
      <div role="radiogroup" aria-label="Show to" className="space-y-1">
        {options.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={scope === option.id} data-show-scope={option.id} onClick={() => setScope(option.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left ${scope === option.id ? "border-[var(--c-accent)]" : "border-[var(--c-border-strong)]"}`}>
            <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${scope === option.id ? "border-[var(--c-accent)]" : "border-[var(--c-border-strong)]"}`}>
              {scope === option.id && <span className="size-2 rounded-full bg-[var(--c-accent)]" />}
            </span>
            <span className="p-row-text p-text">{option.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * Letting a part use this person's own connection, for this slate only, where the part first needs it; again, after
 * someone else changed the part.
 */
function GrantAsk({ slate, reach, again, onAllow, onClose }: {
  slate: string;
  reach: RoomReach;
  /** Who changed the part since this person last allowed it; null for a first time. */
  again: string | null;
  onAllow: () => void;
  onClose: () => void;
}) {
  const title = again === null ? `Let ${slate} ${askOf(reach)}?` : `${again} changed this part. Let it ${askOf(reach)} again?`;

  return (
    <Modal title={title} icon={<PlugIcon size={18} className="p-accent" />} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>Not now</Button><FilledButton data-grant-allow onClick={onAllow}>{again === null ? "Allow" : "Use again"}</FilledButton></div>}>
      <ul className="space-y-1.5 p-row-text">
        <li className="flex gap-2 p-text"><CheckIcon size={15} weight="bold" className="mt-0.5 shrink-0 p-success" />{canOf(reach)}</li>
        <li className="flex gap-2 p-text-2"><XIcon size={15} weight="bold" className="mt-0.5 shrink-0 p-text-3" />{cannotOf(reach)}</li>
      </ul>
      <p className="p-meta p-text-3">For this slate only. Take it back in Drive.</p>
    </Modal>
  );
}

/** One answer to an ask: its words and the call it makes. */
interface Answer {
  readonly label: string;
  readonly call: RoomCall;
}

/** What an ask says and how it can be answered, the first answer the main one. */
export interface AskWords {
  readonly said: string;
  readonly answers: readonly Answer[];
}

function askWords(ask: RoomAsk, slate: string): AskWords {
  switch (ask.kind) {
    case "show": {
      return {
        said: `${firstName(ask.from)} asked to see what ${ask.part.fn} returns from ${ask.source.label} on ${slate}.`,
        answers: [
          { label: `Show to ${firstName(ask.from)}`, call: { op: "showTo", ask: ask.id } },
          { label: "Show to everyone here", call: { op: "showToMembers", ask: ask.id } },
          { label: "Not now", call: { op: "decline", ask: ask.id } },
        ],
      };
    }

    case "effect": {
      return {
        said: `${firstName(ask.from)} wants ${ask.tool.title} on ${ask.scope ?? ask.service.title} for ${ask.argument}.`,
        answers: [{ label: "Approve", call: { op: "approve", ask: ask.id } }, { label: "Decline", call: { op: "decline", ask: ask.id } }],
      };
    }

    case "outflow": {
      return {
        // The argument names where the data goes ("to bob@acme.dev"); the service, how.
        said: `This part sends data from ${ask.source.label} ${ask.argument} by ${ask.service.title}.`,
        answers: [{ label: "Send", call: { op: "send", ask: ask.id } }, { label: "Not now", call: { op: "decline", ask: ask.id } }],
      };
    }

    case "lend": {
      return {
        said: `${firstName(ask.from)} asked you to lend ${ask.fn} again, after ${firstName(ask.editor)} changed it.`,
        answers: [{ label: "Lend again", call: { op: "approve", ask: ask.id } }, { label: "Not now", call: { op: "decline", ask: ask.id } }],
      };
    }
  }
}

/** The holder's asks, newest last, as cards at the corner of the page; on a phone, along its foot. */
export function HolderAsks({ asks, slate, onAnswer }: { asks: readonly RoomAsk[]; slate: string; onAnswer: (call: RoomCall) => void }) {
  if (asks.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-40 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px]">
      {asks.map((ask) => {
        const { said, answers } = askWords(ask, slate);
        const [main, ...rest] = answers;

        return (
          <div key={ask.id} role="alertdialog" aria-label={said} data-holder-ask={ask.kind}
            className="pointer-events-auto w-full border p-border p-overlay p-4 animate-fade-in">
            <p className="p-row-text p-text">{said}</p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {rest.map((answer) => (
                <Button key={answer.label} size="sm" variant="secondary" data-holder-answer={answer.call.op} onClick={() => onAnswer(answer.call)}>{answer.label}</Button>
              ))}
              {main !== undefined && <FilledButton data-holder-answer={main.call.op} onClick={() => onAnswer(main.call)}>{main.label}</FilledButton>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The decision a part frame asked for, opened by the page that hosts the slate, with the room's view of that part. */
export function RoomDecisionDialogs({ view, deciding, send, onDone }: {
  view: RoomView;
  deciding: RoomDecision | null;
  send: (call: RoomCall) => void;
  onDone: () => void;
}) {
  if (deciding === null) return null;

  const part = view.parts[deciding.part];
  const members = view.session.members.filter((person) => person.email !== view.session.me?.email).map(firstName);

  if (deciding.kind === "show" && part?.state === "mine") {
    return (
      <ShowChoice source={part.source.label} members={members.length === 0 ? null : members} onClose={onDone}
        onShow={(scope) => { send({ op: "show", part: deciding.part, scope }); onDone(); }} />
    );
  }

  if (deciding.kind === "allow" && (part?.state === "needs-connection" || part?.state === "edited")) {
    return (
      <GrantAsk slate={view.session.title} reach={part.reach} again={part.state === "edited" ? firstName(part.editor) : null} onClose={onDone}
        onAllow={() => { send({ op: "allow", part: deciding.part }); onDone(); }} />
    );
  }

  // The part moved on before its decision opened: there is nothing left to decide.
  return null;
}
