/**
 * The app page's side of a slate's personal parts (lib/part-bridge.ts): every page that shows a slate, the share's page
 * and the owner's own previews alike, runs its parts as the signed-in viewer and opens the decisions they lead to here,
 * at the top, where the slate's script cannot cover them.
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { useParams } from "react-router-dom";
import { Effect } from "effect";
import { detach, renderThrownChain } from "@kinu.run/core/obs";
import type { PartRunAnswer } from "@kinu.run/core";
import { ApprovalDecision, ConsentDecision, ShowDecision } from "@/components/sharing/PartDecisions";
import { hostPartFrames, type Decided, type DecisionKind, type PartAddress } from "@/lib/part-bridge";
import { decideEffect, giveConsent, readConsents, runPart, showPart } from "@/lib/parts-api";
import { signInAndReturn } from "@/lib/sign-in";

/** A decision open at the top: what it rests on, and how to tell the frame what came of it. */
interface Open {
  readonly address: PartAddress;
  readonly kind: DecisionKind;
  readonly answer: PartRunAnswer;
  /** Whether the viewer allowed an earlier revision of this slate for this grant. */
  readonly changed: boolean;
  readonly settle: (decided: Decided) => void;
}

/** Whether the frame's last answer has a decision of this kind to open. */
function asks(kind: DecisionKind, answer: PartRunAnswer): boolean {
  switch (kind) {
    case "consent": return answer.kind === "needs-consent";
    case "approval": return answer.kind === "needs-approval";
    case "show": return answer.kind === "shown" && answer.show !== null;
  }
}

/**
 * Hosts the part frames inside `slateFrame`, the frame that shows `workspace`/`slate`'s page, named `title` in what it
 * says; none while `workspace` is unknown. Returns the decision open now, to render anywhere on the page.
 */
export function usePartHost({ workspace, slate, title, slateFrame }: {
  workspace: string | null;
  slate: string;
  title: string;
  slateFrame: RefObject<HTMLIFrameElement | null>;
}): ReactNode {
  const [open, setOpen] = useState<Open | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => workspace === null ? undefined : hostPartFrames({
    workspace,
    slate,
    slateWindow: () => slateFrame.current?.contentWindow ?? null,
    run: (address, asked) => runPart(address.workspace, address.slate, address.part, asked),
    decide: (address, kind, answer) => new Promise<Decided>((settle) => {
      if (!asks(kind, answer)) {
        settle({ kind: "declined" });

        return;
      }

      // A re-consent says so: the viewer allowed this grant for an earlier revision of the slate's code.
      const changedSince = answer.kind === "needs-consent"
        ? Effect.map(Effect.promise(() => readConsents(address.workspace, address.slate)), (consents) => consents.some((given) => given.server === answer.ask.server && given.revision !== answer.ask.revision))
        : Effect.succeed(false);

      detach(Effect.map(changedSince, (changed) => setOpen({ address, kind, answer, changed, settle })));
    }),
    signIn: () => signInAndReturn(),
  }), [workspace, slate, slateFrame]);

  if (open === null) return failure === null ? null : <p role="alert" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-lg p-overlay px-3 py-2 p-meta p-danger">{failure}</p>;

  const close = (decided: Decided) => {
    open.settle(decided);
    setOpen(null);
  };

  // Each decision's call, then its settling; a refusal is said at the top, and the frame hears it declined.
  const after = (call: () => Promise<void>, decided: Decided) => {
    setFailure(null);
    detach(Effect.match(Effect.tryPromise(call), {
      onSuccess: () => close(decided),
      onFailure: (refused) => { setFailure(renderThrownChain({ cause: refused })); close({ kind: "declined" }); },
    }));
  };

  const { address, answer } = open;

  if (open.kind === "consent" && answer.kind === "needs-consent") {
    const { ask } = answer;

    return (
      <ConsentDecision slate={title} ask={ask} changed={open.changed} onClose={() => close({ kind: "declined" })}
        onAllow={() => after(() => giveConsent({ workspace: address.workspace, slate: address.slate, ...ask }), { kind: "consented" })} />
    );
  }

  if (open.kind === "approval" && answer.kind === "needs-approval") {
    const { ask } = answer;

    return (
      <ApprovalDecision slate={title} ask={ask}
        onApprove={() => after(() => decideEffect(address.workspace, address.slate, ask.id, "approve"), { kind: "approved", approval: ask.id })}
        onDecline={() => after(() => decideEffect(address.workspace, address.slate, ask.id, "decline"), { kind: "declined" })} />
    );
  }

  if (open.kind === "show" && answer.kind === "shown" && answer.show !== null) {
    const { show, revision } = answer;

    return (
      <ShowDecision label={show.label} value={show.value} onClose={() => close({ kind: "declined" })}
        onShow={() => after(() => showPart(address.workspace, address.slate, address.part, { revision, label: show.label, value: show.value }), { kind: "shown" })} />
    );
  }

  // Unreachable: a decision opens only on an answer that asks it (`asks`).
  return null;
}

/** The parts of a slate the owner's own workspace page shows in `slateFrame`: its workspace is the page's own. */
export function WorkspacePartHost({ slate, titled, slateFrame }: {
  slate: string;
  /** The slate's preview once read, which names its title. */
  titled: { readonly title?: string } | null;
  slateFrame: RefObject<HTMLIFrameElement | null>;
}) {
  const { agentId = null } = useParams();

  return usePartHost({ workspace: agentId, slate, title: titled?.title ?? slate, slateFrame });
}
