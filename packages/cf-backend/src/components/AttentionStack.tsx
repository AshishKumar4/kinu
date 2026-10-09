/**
 * What waits on the owner's answer, docked to the composer: the newest on top and open with its answers, the rest
 * behind it as a stack, each opening as the one before is answered. It reads `ownerAsks` over the same reads the Work
 * tab shows, so the two never disagree; Work keeps the full list, and the chat keeps only events that ask nothing.
 */
import { Cause, Effect } from "effect";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { BrainIcon, CheckIcon, DesktopTowerIcon, NotePencilIcon, ShieldWarningIcon, SparkleIcon, XIcon, type Icon } from "@phosphor-icons/react";
import {
  revealMisrepresenting, timeAgo, type AccountMemoryProposal, type OwnerAsk, type PendingAction, type PendingActionKind, type PendingConsent, type PlanPageRef, type Rpc,
} from "@kinu.run/core";
import { detach, renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { ParkedWriteChange } from "@/components/surfaces/WorkTab";

type ConsentChoice = "once" | "always" | "deny";

export interface AttentionStackProps {
  readonly asks: readonly OwnerAsk[];
  readonly rpc: Rpc;
  /** The hook's own resolution: it drops the consent from its read once the answer lands. */
  readonly resolveConsent: (consentId: string, choice: ConsentChoice) => Promise<void>;
  /** Re-read the queue so an answered row leaves the read too, not only the stack; it reports its own failure. */
  readonly onDecided: () => Promise<void>;
  /** A plan is decided on its own page. */
  readonly onReview: (plan: PlanPageRef) => void;
  /** The owner's answer to an account-memory proposal; the user object then sends what still waits. */
  readonly decideMemory: (id: string, decision: "accept" | "decline") => Promise<void>;
}

/** Collapsed cards drawn behind the open one; the rest are counted on the last. */
const SHOWN_BEHIND = 2;

type AskKind = PendingActionKind | "consent" | "memory";

/** Only the kinds that hold the owner are stacked; the others are named so the map is whole. */
const KIND_ICON = {
  deferred_action: ShieldWarningIcon, workspace_proposal: SparkleIcon, plan_review: NotePencilIcon, consent: DesktopTowerIcon, memory: BrainIcon,
  scaffold_version: ShieldWarningIcon, unseen_changes: ShieldWarningIcon, curriculum_task: ShieldWarningIcon,
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

  const { action } = ask;

  return action.kind === "deferred_action" && action.detail !== null ? action.detail : action.title;
}

interface Answer {
  readonly label: string;
  readonly icon?: Icon;
  readonly weight: "primary" | "secondary" | "quiet";
  readonly title?: string;
  readonly run: () => Promise<void>;
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

function ActionBody({ action, rpc }: { action: PendingAction; rpc: Rpc }) {
  const [soul, setSoul] = useState(false);

  if (action.kind === "deferred_action") {
    return (
      <>
        <div className="p-row-text p-text">{action.write ? action.title : "Run this command?"}</div>
        {action.detail !== null && <code className="mt-1 block max-h-28 overflow-auto rounded-sm px-2 py-1 p-t-code p-text-2 break-all whitespace-pre-wrap p-fill">{revealMisrepresenting(action.detail)}</code>}
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
  const by = origin.agent ?? (origin.by === "background" ? "Kinu, from what you said" : "An agent");
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

export function AttentionStack(props: AttentionStackProps): ReactNode {
  const { asks, rpc, onDecided } = props;
  const { answered, mark } = useAnswered(asks);
  const [chosen, setChosen] = useState<string | null>(null);
  // The card whose answer is in flight: its buttons wait for it, and the next card's are live as soon as it opens.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  const waiting = asks.filter((ask) => !answered.has(ask.key));
  const front = waiting.find((ask) => ask.key === chosen) ?? waiting[0];

  if (front === undefined) return null;
  const behind = waiting.filter((ask) => ask !== front);
  const shown = behind.slice(0, SHOWN_BEHIND).reverse();
  const unshown = behind.length - shown.length;

  const answering = front.key;

  // A plan is not answered here: opening its review leaves it waiting until it is decided.
  const answer = (choice: Answer): Effect.Effect<void> => Effect.catchCause(Effect.gen(function* () {
    setBusy(answering);
    setError(null);
    yield* Effect.promise(() => choice.run());

    if (front.kind === "memory") {
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
    <section aria-label="Waiting on you" data-attention-stack data-attention-count={waiting.length} className="p-attention">
      {shown.map((ask, depth) => {
        const BehindIcon = KIND_ICON[kindOf(ask)];

        return (
          <button key={ask.key} type="button" data-attention-behind={ask.key} onClick={() => { setError(null); setChosen(ask.key); }}
            className="p-attention-behind" style={{ marginInline: `${String((shown.length - depth) * 10 + 14)}px` }}
            title="Answer this one first">
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
          <span>Waiting on you</span>
          {waiting.length > 1 && <span className="tabular-nums" data-attention-position>· 1 of {waiting.length}</span>}
        </div>
        {front.kind === "consent" && <ConsentBody consent={front.consent} />}
        {front.kind === "memory" && <MemoryBody memory={front.memory} />}
        {front.kind === "action" && <ActionBody action={front.action} rpc={rpc} />}
        {error?.key === front.key && <div className="mt-1.5 p-t-status p-danger" role="alert">{error.message}</div>}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
          {[...answersOf(front, props)].reverse().map((choice) => <AnswerButton key={choice.label} answer={choice} busy={busy === front.key} onAnswer={answer} />)}
        </div>
      </div>
    </section>
  );
}
