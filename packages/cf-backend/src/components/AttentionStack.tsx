/**
 * What waits on the owner's answer, docked to the composer: the newest on top and open with its answers, the rest
 * behind it as a stack, each opening as the one before is answered. It reads `ownerAsks` over the same reads the Work
 * tab shows, so the two never disagree; Work keeps the full list, and the chat keeps only events that ask nothing.
 */
import { Cause, Effect } from "effect";
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { BrainIcon, ChatCircleTextIcon, CheckIcon, DesktopTowerIcon, NotePencilIcon, ShieldWarningIcon, SparkleIcon, XIcon, type Icon } from "@phosphor-icons/react";
import { revealMisrepresenting, timeAgo, type AccountMemoryProposal, type OwedIntent, type OwedOwnerIntent, type OwnerAsk, type PendingAction, type PendingActionKind, type PendingConsent, type PlanPageRef } from "@kinu.run/core";
import { detach, renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { ParkedCommands, ParkedDecisionFlow, ParkedWriteChange } from "@/components/ParkedCommands";
import { QuestionCard } from "@/components/QuestionCard";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

type ConsentChoice = "once" | "always" | "deny";

export interface AttentionStackProps {
  readonly asks: readonly OwnerAsk[];
  readonly rpc: WorkspaceRpc;
  readonly owedIntents?: readonly OwedOwnerIntent[];
  /** The hook's own resolution: it drops the consent from its read once the answer lands. */
  readonly resolveConsent: (consentId: string, choice: ConsentChoice) => Promise<void>;
  /** Re-read the queue so an answered row leaves the read too, not only the stack; it reports its own failure. */
  readonly onDecided: () => Promise<void>;
  /** A plan is decided on its own page. */
  readonly onReview: (plan: PlanPageRef) => void;
  /** The owner's answer to an account-memory proposal; the user object then sends what still waits. */
  readonly decideMemory: (id: string, decision: "accept" | "decline") => Promise<void>;
  /** The card shown first, when the page chooses it (a Work row opens its ask here); else the stack's own choice. */
  readonly focus?: { readonly chosen: string | null; readonly choose: (key: string | null) => void };
}

function isParked(ask: OwnerAsk): ask is OwnerAsk & { kind: "action" } {
  return ask.kind === "action" && ask.action.kind === "deferred_action";
}

/** Collapsed cards drawn behind the open one; the rest are counted on the last. */
const SHOWN_BEHIND = 2;

type AskKind = PendingActionKind | "consent" | "memory" | "question";

/** Only the kinds that hold the owner are stacked; the others are named so the map is whole. */
const KIND_ICON = {
  deferred_action: ShieldWarningIcon, workspace_proposal: SparkleIcon, plan_review: NotePencilIcon, consent: DesktopTowerIcon, memory: BrainIcon,
  question: ChatCircleTextIcon,
  scaffold_version: ShieldWarningIcon, change_approval: ShieldWarningIcon,
} satisfies Record<AskKind, Icon>;

function kindOf(ask: OwnerAsk): AskKind {
  return ask.kind === "action" ? ask.action.kind : ask.kind;
}

/** What an account-memory proposal would keep, in words: a fact's key and value, or a note's text. */
function remembered(memory: AccountMemoryProposal): string {
  const { proposal } = memory;

  return proposal.kind === "fact" ? `${proposal.key}: ${JSON.stringify(proposal.value)}` : proposal.content;
}

/** One line, for a card waiting behind the open one. */
function headline(ask: OwnerAsk): string {
  if (ask.kind === "consent") return `Use ${ask.consent.deviceLabel}: ${ask.consent.command || "(command)"}`;

  if (ask.kind === "memory") return `Remember for every workspace: ${remembered(ask.memory)}`;

  if (ask.kind === "question") {
    const first = ask.question.asked.questions[0]?.question ?? "";

    return ask.question.actor === null ? first : `${ask.question.agent} asks: ${first}`;
  }

  const { action } = ask;

  return action.kind === "deferred_action" && action.detail !== null ? action.detail : action.title;
}

interface Answer {
  readonly label: string;
  readonly icon?: Icon;
  readonly weight: "primary" | "secondary" | "quiet";
  readonly title?: string;
  readonly run: () => Promise<void | OwedIntent | null>;
}

function AnswerButton({ answer, busy, onAnswer }: { answer: Answer; busy: boolean; onAnswer: (answer: Answer) => Effect.Effect<void> }) {
  const Mark = answer.icon;
  const label = <>{Mark && <Mark size={12} weight="bold" aria-hidden />}{answer.label}</>;

  if (answer.weight === "primary") return <FilledButton disabled={busy} onClick={() => detach(onAnswer(answer))}>{label}</FilledButton>;

  return (
    <Button size="sm" variant={answer.weight === "secondary" ? "secondary" : "ghost"} disabled={busy} title={answer.title} onClick={() => detach(onAnswer(answer))}>
      {label}
    </Button>
  );
}

function ActionBody({ action, rpc }: { action: PendingAction; rpc: WorkspaceRpc }) {
  const [soul, setSoul] = useState(false);

  if (action.kind === "deferred_action") {
    return (
      <>
        <div className="p-row-text p-text">{action.write ? action.title : "Run this command?"}</div>
        {action.detail !== null && <code className="mt-1 block max-h-28 overflow-auto rounded-sm px-2 py-1 p-t-code p-text-2 break-all whitespace-pre-wrap p-fill">{revealMisrepresenting(action.detail)}</code>}
        {action.where !== undefined && <div className="mt-1 p-meta p-text-2 break-all">Runs {revealMisrepresenting(action.where)}</div>}
        {action.write && <div className="mt-1.5"><ParkedWriteChange id={action.id} rpc={rpc} /></div>}
        <div className="mt-1 p-meta p-text-3">
          {action.write ? "Approving writes exactly these bytes." : action.title.replace(/^Approve: /u, "")} · asked {timeAgo(action.at)}
        </div>
      </>
    );
  }

  if (action.kind === "workspace_proposal") {
    return (
      <>
        <div className="p-row-text p-text">{action.title}</div>
        {action.detail && <div className="mt-0.5 break-words p-meta p-text-2">{action.detail}</div>}
        {action.proposal !== undefined && (
          <div className="mt-1.5">
            <button type="button" className="p-meta p-accent-fg hover:underline" onClick={() => setSoul((was) => !was)} aria-expanded={soul}>
              {soul ? "Hide its soul" : "Show its soul"}
            </button>
            {soul && <pre className="mt-1 max-h-40 overflow-auto p-t-code p-text whitespace-pre-wrap break-words" data-workspace-proposal-soul>{action.proposal.soul}</pre>}
          </div>
        )}
        <div className="mt-1 p-meta p-text-3">The agent asked {timeAgo(action.at)}. Nothing is created until you approve it.</div>
      </>
    );
  }

  return (
    <>
      <div className="p-row-text p-text">{action.title}</div>
      <div className="mt-0.5 p-meta p-text-3">{action.detail ?? "Your agent"} · {timeAgo(action.at)} · read it in its review</div>
    </>
  );
}

function ConsentBody({ consent }: { consent: PendingConsent }) {
  const forWhom = consent.workspaceName ? `“${consent.workspaceName}”` : "this workspace";

  return (
    <>
      <div className="p-row-text p-text">Use <span className="font-medium">{consent.deviceLabel}</span> for {forWhom}?</div>
      <code className="mt-1 block rounded-sm px-2 py-1 p-t-code p-text-2 break-all p-fill">{revealMisrepresenting(consent.command || "(command)")}</code>
      <div className="mt-1 p-meta p-text-3">Commands use {consent.deviceLabel}'s Sandbox setting. Revoke access on the Devices page.</div>
    </>
  );
}

function MemoryBody({ memory }: { memory: AccountMemoryProposal }) {
  const { origin } = memory;
  const by = origin.by === "background" ? "Kinu, from what you said" : origin.agent;
  const where = origin.workspace === undefined ? "" : ` in ${origin.workspace}`;

  return (
    <>
      <div className="p-row-text p-text">Remember this for every workspace?</div>
      <code className="mt-1 block max-h-28 overflow-auto rounded-sm px-2 py-1 p-t-code p-text-2 break-all whitespace-pre-wrap p-fill">{remembered(memory)}</code>
      <div className="mt-1 p-meta p-text-3">{by}{where} asked {timeAgo(memory.createdAt)}. Forget it any time under Settings → Memory.</div>
    </>
  );
}

/** Each kind's answers, the agreeing one first; each is the same call the Work tab, or Settings, makes. */
function answersOf(ask: OwnerAsk, props: AttentionStackProps): readonly Answer[] {
  if (ask.kind === "memory") {
    const { id } = ask.memory;

    return [
      { label: "Keep for every workspace", icon: CheckIcon, weight: "primary", run: () => props.decideMemory(id, "accept") },
      { label: "Decline", icon: XIcon, weight: "quiet", run: () => props.decideMemory(id, "decline") },
    ];
  }

  // A question card carries its own answer and dismissal.
  if (ask.kind === "question") return [];

  if (ask.kind === "consent") {
    const { consentId, deviceLabel } = ask.consent;

    return [
      { label: `Use ${deviceLabel}`, icon: CheckIcon, weight: "primary", run: () => props.resolveConsent(consentId, "always") },
      { label: "Not now", icon: XIcon, weight: "quiet", run: () => props.resolveConsent(consentId, "deny") },
    ];
  }

  const { action } = ask;
  const deferred = (decision: "approved" | "always" | "denied") => async () => { await props.rpc("decideDeferredApprovals", [[action.id], decision]); };

  if (action.kind === "deferred_action") {
    return [
      { label: "Approve", icon: CheckIcon, weight: "primary", run: deferred("approved") },
      { label: "Always allow", weight: "secondary", title: "Approve these checks for this environment. Revoke under Settings → Standing approvals.", run: deferred("always") },
      { label: "Deny", icon: XIcon, weight: "quiet", run: deferred("denied") },
    ];
  }

  if (action.kind === "workspace_proposal") {
    return [
      { label: "Create workspace", icon: CheckIcon, weight: "primary", run: async () => { await props.rpc("decideWorkspaceProposal", [action.id, "approve"]); } },
      { label: "Decline", icon: XIcon, weight: "quiet", run: async () => { await props.rpc("decideWorkspaceProposal", [action.id, "decline"]); } },
    ];
  }

  return [{ label: "Review plan", weight: "primary", run: async () => { if (action.planRef !== undefined) props.onReview(action.planRef); } }];
}

/** Answered here, so the next card opens on the click; dropped once the read no longer holds it. */
function useAnswered(asks: readonly OwnerAsk[]) {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const present = new Set(asks.map((ask) => ask.key));

    setAnswered((was) => ([...was].every((key) => present.has(key)) ? was : new Set([...was].filter((key) => present.has(key)))));
  }, [asks]);

  return { answered, mark: (key: string) => setAnswered((was) => new Set([...was, key])) };
}

/**
 * The open card: the one chosen, else, while the pointer or focus is on the stack, the one the owner is on, else the
 * newest. Held, a card that arrives meanwhile waits behind, so a press is never taken by a card that slid in under it;
 * answered, the next held is the one that opens. `holding` goes on the stack.
 */
function useOpenCard(waiting: readonly OwnerAsk[], chosen: string | null) {
  const [held, setHeld] = useState<string | null>(null);
  const front = waiting.find((ask) => ask.key === chosen) ?? waiting.find((ask) => ask.key === held) ?? waiting[0];

  if (held !== null && front !== undefined && held !== front.key) setHeld(front.key);
  const hold = (): void => setHeld(front?.key ?? null);

  return {
    front,
    holding: {
      onPointerEnter: hold, onPointerLeave: () => setHeld(null), onFocus: hold,
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setHeld(null);
      },
    },
  };
}

/** The parked commands' decision flow, the stack's own, so their boxes stand while another card is answered first. */
function useParkedFlow(rpc: WorkspaceRpc, decided: (ids: readonly string[]) => Promise<void>): ParkedDecisionFlow {
  const calls = useRef({ rpc, decided });

  useEffect(() => { calls.current = { rpc, decided }; });

  const [flow] = useState(() => new ParkedDecisionFlow({
    decide: (ids, decision) => calls.current.rpc("decideDeferredApprovals", [ids, decision]),
    onDecided: (ids) => calls.current.decided(ids),
  }));

  return flow;
}

export function AttentionStack(props: AttentionStackProps): ReactNode {
  const { asks, rpc, onDecided, owedIntents = [] } = props;
  const { answered, mark } = useAnswered(asks);
  const [ownChoice, setOwnChoice] = useState<string | null>(null);
  const chosen = props.focus?.chosen ?? ownChoice;
  const setChosen = props.focus?.choose ?? setOwnChoice;

  const parkedFlow = useParkedFlow(rpc, async (ids) => {
    for (const id of ids) mark(`action:${id}`);
    setChosen(null);
    await onDecided();
  });

  // The card whose answer is in flight: its buttons wait for it, and the next card's are live as soon as it opens.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  const waiting = asks.filter((ask) => !answered.has(ask.key));
  const { front, holding } = useOpenCard(waiting, chosen);

  if (front === undefined) return null;

  // Two or more parked commands are one card: chosen by their boxes and decided together.
  const parked = isParked(front) ? waiting.filter(isParked) : [];
  const batched = parked.length > 1;
  const behind = waiting.filter((ask) => ask !== front && !(batched && isParked(ask)));
  // The cards there are: the open one and those behind it.
  const cards = behind.length + 1;
  const shown = behind.slice(0, SHOWN_BEHIND).reverse();
  const unshown = behind.length - shown.length;

  const answering = front.key;

  const answerOwed = front.kind === "question" && owedIntents.some((intent) => intent.kind === "answers"
    && intent.target === front.question.asked.id && intent.actor === front.question.actor);

  // A plan is not answered here: opening its review leaves it waiting until it is decided.
  const answer = (choice: Answer): Effect.Effect<void> => Effect.catchCause(Effect.gen(function* () {
    if (answerOwed) return;
    setBusy(answering);
    setError(null);
    const result = yield* Effect.promise(() => choice.run());

    if (result != null && "owed" in result) return;

    if (front.kind === "memory" || front.kind === "question") {
      mark(front.key);
      setChosen(null);
    }

    if (front.kind === "action" && front.action.kind !== "plan_review") {
      mark(front.key);
      setChosen(null);
      yield* Effect.promise(() => onDecided());
    }
  }), (failed) => Effect.sync(() => {
    setError({ key: front.key, message: `Could not record the answer: ${renderThrownChain({ cause: Cause.squash(failed) })}` });
  })).pipe(Effect.ensuring(Effect.sync(() => { setBusy((was) => (was === answering ? null : was)); })));

  const FrontIcon = KIND_ICON[kindOf(front)];

  return (
    <section aria-label="Waiting on you" data-attention-stack data-attention-count={waiting.length} className="p-attention"
      {...holding}>
      {shown.map((ask, depth) => {
        const BehindIcon = KIND_ICON[kindOf(ask)];

        return (
          <button key={ask.key} type="button" data-attention-behind={ask.key} onClick={() => { setError(null); setChosen(ask.key); }}
            className="p-attention-behind" title="Answer this one first">
            <BehindIcon size={11} className="shrink-0 p-text-3" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{headline(ask)}</span>
            {depth === 0 && unshown > 0 && <span className="shrink-0 tabular-nums p-text-3">+{unshown}</span>}
          </button>
        );
      })}
      <div key={front.key} className="p-attention-card animate-fade-in" data-attention-card={front.key} data-attention-kind={kindOf(front)}
        {...(front.kind === "consent" ? { "data-device-bind": front.consent.consentId } : {})}
        {...(front.kind === "action" && front.action.kind === "workspace_proposal" ? { "data-workspace-proposal": front.action.id } : {})}
        aria-live="polite">
        <div className="mb-1 flex items-center gap-1.5 p-meta p-text-3">
          <FrontIcon size={12} className="shrink-0 p-warning" weight="fill" aria-hidden />
          <span>{answerOwed ? "Answer sent" : "Waiting on you"}</span>
          {cards > 1 && <span className="tabular-nums" data-attention-position>· 1 of {cards}</span>}
        </div>
        {front.kind === "consent" && <ConsentBody consent={front.consent} />}
        {front.kind === "memory" && <MemoryBody memory={front.memory} />}
        {front.kind === "action" && (batched
          ? <ParkedCommands actions={parked.map((ask) => ask.action)} rpc={rpc} flow={parkedFlow} />
          : <ActionBody action={front.action} rpc={rpc} />)}
        {front.kind === "question" && (
          <QuestionCard asking={front.question} busy={busy === front.key || answerOwed} owed={answerOwed}
            onAnswer={(answers) => detach(answer({ label: "Answer", weight: "primary", run: async () => rpc("answerOwnerQuestions", [front.question.asked.id, answers, front.question.actor]) }))}
            onDismiss={() => detach(answer({ label: "Dismiss", weight: "quiet", run: async () => { await rpc("dismissOwnerQuestions", [front.question.asked.id, front.question.actor]); } }))} />
        )}
        {error?.key === front.key && <div className="mt-1.5 p-t-status p-danger" role="alert">{error.message}</div>}
        {!batched && (
          <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
            {[...answersOf(front, props)].reverse().map((choice) => <AnswerButton key={choice.label} answer={choice} busy={busy === front.key} onAnswer={answer} />)}
          </div>
        )}
      </div>
    </section>
  );
}
