/**
 * The app page's side of a slate's personal parts (lib/part-bridge.ts): every page that shows a slate, the share's page
 * and the owner's own previews alike, runs its parts as the signed-in viewer and opens the decisions they lead to here,
 * at the top, where the slate's script cannot cover them.
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { Effect } from "effect";
import { detach, renderThrownChain, settle } from "@kinu.run/core/obs";
import type { PartRunAnswer } from "@kinu.run/core";
import { ApprovalDecision, ConsentDecision, ShowDecision } from "@/components/sharing/PartDecisions";
import { hostPartFrames, type Decided, type DecisionKind, type PartAddress } from "@/lib/part-bridge";
import { decideEffect, giveConsent, readConsents, releasePart, runPart, showPart } from "@/lib/parts-api";
import { signInAndReturn } from "@/lib/sign-in";
import { Surface } from "@/components/ui/Surface";

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
    title,
    slateWindow: () => slateFrame.current?.contentWindow ?? null,
    run: (address, asked) => runPart({ ...address, title }, asked),
    decide: (address, kind, answer) => {
      if (!asks(kind, answer)) return Promise.resolve<Decided>({ kind: "declined" });

      // A re-consent says so: the viewer allowed this grant for an earlier revision of the slate's code.
      const changedSince = answer.kind === "needs-consent"
        ? Effect.map(Effect.promise(() => readConsents(address.workspace, address.slate)), (consents) => consents.some((given) => given.server === answer.ask.server && given.revision !== answer.ask.revision))
        : Effect.succeed(false);

      // Settles when the viewer decides, in the dialog it opens.
      return settle(Effect.flatMap(changedSince, (changed) => Effect.promise(() => new Promise<Decided>((decided) => setOpen({ address, kind, answer, changed, settle: decided })))));
    },
    signIn: () => signInAndReturn(),
  }), [workspace, slate, title, slateFrame]);

  if (open === null) return failure === null ? null : <Surface look="clip" as="p" className="t-meta fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md p-overlay px-3 py-2 p-danger" role="alert">{failure}</Surface>;

  const close = (decided: Decided) => {
    open.settle(decided);
    setOpen(null);
  };

  // Each decision's call, then its settling; a refusal is said at the top, and the frame hears it declined.
  const after = (call: () => Promise<void>, decided: Decided) => Effect.match(Effect.tryPromise(call), {
    onSuccess: () => close(decided),
    onFailure: (refused) => { setFailure(renderThrownChain({ cause: refused })); close({ kind: "declined" }); },
  });

  const { address, answer } = open;

  if (open.kind === "consent" && answer.kind === "needs-consent") {
    const { ask } = answer;

    return (
      <ConsentDecision slate={title} ask={ask} changed={open.changed}
        onClose={() => detach(after(() => releasePart(address.workspace, address.slate, address.part, answer.continuation), { kind: "declined" }))}
        onAllow={() => detach(after(() => giveConsent({ workspace: address.workspace, slate: address.slate, ...ask }), { kind: "consented" }))} />
    );
  }

  if (open.kind === "approval" && answer.kind === "needs-approval") {
    const { ask } = answer;

    return (
      <ApprovalDecision slate={title} ask={ask}
        onApprove={() => detach(after(() => decideEffect(address.workspace, address.slate, ask.id, "approve"), { kind: "approved" }))}
        onDecline={() => detach(after(async () => {
          await decideEffect(address.workspace, address.slate, ask.id, "decline");
          // Declined, the run it stopped is let go on the server: it is never resumed.
          await releasePart(address.workspace, address.slate, address.part, answer.continuation);
        }, { kind: "declined" }))} />
    );
  }

  if (open.kind === "show" && answer.kind === "shown" && answer.show !== null) {
    const { show, revision } = answer;

    return (
      <ShowDecision label={show.label} value={show.value} onClose={() => close({ kind: "declined" })}
        onShow={() => detach(after(() => showPart(address.workspace, address.slate, address.part, { revision, label: show.label, value: show.value }), { kind: "shown" }))} />
    );
  }

  // Unreachable: a decision opens only on an answer that asks it (`asks`).
  return null;
}

/**
 * The parts of a slate the owner's own workspace page shows in `slateFrame`: its workspace is the page's own. Its
 * decisions open over the whole page, as the preview may sit in an answer's text.
 */
export function WorkspacePartHost({ slate, titled, slateFrame }: {
  slate: string;
  /** The slate's preview once read, which names its title. */
  titled: { readonly title?: string } | null;
  slateFrame: RefObject<HTMLIFrameElement | null>;
}) {
  const { agentId = null } = useParams();
  const decision = usePartHost({ workspace: agentId, slate, title: titled?.title ?? slate, slateFrame });

  return decision === null ? null : createPortal(decision, document.body);
}
