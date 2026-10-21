/**
 * The run the page follows (`GET /api/deploy/runs/current`): where it stands in plain words while it goes, what it waits
 * on or refused with its one action, and, once live, the address, the one-time setup link and the CLI line.
 */
import type { CSSProperties, ReactNode } from "react";
import { ArrowSquareOutIcon, CheckIcon, CircleIcon, TerminalWindowIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { DeployPhase, DeployRunView } from "@kinu.run/core/deploy";
import { Button, buttonClass } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Loader } from "@/components/ui/Loader";
import { CloudflareButton, CloudflareSaid, DeployShell, Disclosure, HandOff, KinuFace, NeedBox, Refused, type RefusalActions } from "@/components/deploy/DeployParts";
import type { DeployRefused } from "@/lib/deploy-page-api";

/** What this page asked the run for, when it asked in this tab: the words it ends on follow. Null for a run found again. */
export type RunAsked = "new" | "update" | "change" | null;

function PhaseMark({ state }: { state: DeployPhase["state"] }) {
  if (state === "done") return <CheckIcon size={13} weight="bold" className="p-success" />;

  if (state === "waiting") return <CircleIcon size={13} className="p-text-3" />;

  return state === "refused" ? <WarningCircleIcon size={14} className="p-accent" /> : <Loader size="sm" />;
}

function Phases({ phases }: { phases: readonly DeployPhase[] }) {
  return (
    <ol className="space-y-2">
      {phases.map((phase) => (
        <li key={phase.id} data-deploy-phase={phase.id} data-state={phase.state} className={`flex items-start gap-2.5 t-meta ${phase.state === "waiting" ? "" : "p-text-2"}`}>
          <span className="flex size-4 shrink-0 items-center justify-center pt-0.5"><PhaseMark state={phase.state} /></span>
          <span>{phase.words}{phase.note !== undefined && <span className="block p-text-3">{phase.note}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

/** Where the run stands, drawn as one bar. */
function Progress({ index, of }: { index: number; of: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-[var(--r-pill)] p-fill" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={index}>
      <div className="h-full rounded-[var(--r-pill)] bg-[var(--c-accent)] transition-[width] duration-[var(--dur-fold)]" style={{ width: `${String(Math.max(6, (index / Math.max(1, of)) * 100))}%` }} />
    </div>
  );
}

function titleOf(asked: RunAsked): string {
  if (asked === "update") return "Updating your Kinu";

  return asked === "change" ? "Changing your Kinu" : "Deploying your Kinu";
}

export function DeployRunning({ run, asked, handedOff, retrying, refusal, actions, onRetry }: {
  run: DeployRunView;
  asked: RunAsked;
  /** The need a hand-off was opened for: its box waits on Cloudflare rather than offering the hand-off again. */
  handedOff: string | null;
  retrying: boolean;
  /** What the door answered the last carry-on or read, when it refused. */
  refusal: DeployRefused | null;
  actions: RefusalActions;
  onRetry: () => void;
}) {
  let title = titleOf(asked);
  let said: ReactNode = <span className="p-shimmer-text">{run.phase.words}…</span>;
  let action: ReactNode = null;

  if (run.state === "paused" && run.paused !== undefined) {
    title = run.paused.id === "signin-again" ? "Sign in to carry on" : "Waiting on Cloudflare";
    said = null;
    const need = run.paused;

    action = <div className="w-full text-left"><NeedBox need={need} waiting={handedOff === need.id} onHandedOff={() => actions.onHandedOff(need.id)} onSignIn={actions.onSignIn} signingIn={actions.signingIn} /></div>;
  }

  if (run.state === "refused" && run.refused !== undefined) {
    const { href } = run.refused.action;

    title = "One thing to change";
    said = `${run.refused.sentence} The steps before this one are done and won't run again.`;
    action = href === undefined
      ? <Button variant="primary" busy={retrying} data-deploy-retry onClick={onRetry}>{run.refused.action.label}</Button>
      : (
        <span className="flex flex-wrap items-center justify-center gap-2">
          <HandOff action={{ label: run.refused.action.label, href }} />
          <Button busy={retrying} data-deploy-retry onClick={onRetry}>It's done, carry on</Button>
        </span>
      );
  }

  const going = run.state === "running";

  return (
    <DeployShell dot={2} screen="deploying">
      <div className="flex flex-col items-center text-center" data-deploy-run={run.state}>
        <KinuFace activity={going ? "working" : "waiting"} />
        <h2 className="mt-4 t-page-title">{title}</h2>
        {said !== null && <p data-deploy-now className="mt-1.5 max-w-md t-body">{said}</p>}
        {going && <div className="mt-5 w-full max-w-sm"><Progress index={run.phase.index} of={run.phase.of} /></div>}
        {action !== null && <div className="mt-5 w-full max-w-md">{action}</div>}
        {refusal !== null && (refusal.need === null || refusal.need.id !== run.paused?.id) && <div className="mt-4 w-full max-w-md text-left"><Refused refusal={refusal} actions={actions} /></div>}
        {going && <p className="mt-5 t-meta">A few minutes. You can close this page; it carries on, and opening it again shows where it is.</p>}
        {run.state === "paused" && run.paused?.id !== "signin-again" && <p className="mt-3 t-meta">Once it's done, Kinu carries on by itself.</p>}
      </div>
      <div className="mt-6 space-y-3 border-t p-border pt-4">
        {run.state === "refused" && run.refused !== undefined && <CloudflareSaid words={run.refused.details} />}
        <Disclosure summary="Every step"><Phases phases={run.phases} /></Disclosure>
      </div>
    </DeployShell>
  );
}

const CELEBRATION = `
@keyframes kinu-live-ring { from { transform: scale(0.7); opacity: 0.5; } to { transform: scale(1.45); opacity: 0; } }
@keyframes kinu-live-spark { 0% { transform: translate(0, 0) scale(0.4); opacity: 0; } 20% { opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; } }
[data-deploy-live] .kinu-live-ring { animation: kinu-live-ring 1.6s ease-out 0.2s 2 both; }
[data-deploy-live] .kinu-live-spark { animation: kinu-live-spark 1.2s ease-out 0.35s 1 both; }
@media (prefers-reduced-motion: reduce) { [data-deploy-live] .kinu-live-ring, [data-deploy-live] .kinu-live-spark { animation: none; opacity: 0; } }
`;

/** Eight small sparks, once, around the mark: celebrated, and over. */
const SPARKS = Array.from({ length: 8 }, (_, at) => {
  const angle = ((at + 0.5) / 8) * Math.PI * 2;

  const style: CSSProperties & { readonly "--dx": string; readonly "--dy": string } = {
    "--dx": `${String(Math.round(Math.cos(angle) * 46))}px`, "--dy": `${String(Math.round(Math.sin(angle) * 46))}px`,
  };

  return { at, style };
});

function LiveMark() {
  return (
    <div className="relative flex size-24 items-center justify-center">
      <style>{CELEBRATION}</style>
      <span aria-hidden className="kinu-live-ring absolute inset-2 rounded-[var(--r-pill)] border-2 border-[var(--c-accent)]" />
      {SPARKS.map(({ at, style }) => (
        <span key={at} aria-hidden className="kinu-live-spark absolute size-1.5 rounded-[var(--r-pill)] bg-[var(--c-accent)]" style={style} />
      ))}
      <KinuFace activity="done" live />
    </div>
  );
}

/** A day as a person says it ("28 October"). */
function dayOf(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function liveTitle(asked: RunAsked, setupLink: string): string {
  if (asked === "update") return "Your Kinu is up to date";

  if (asked === "change") return setupLink === "" ? "Your Kinu is changed" : "A new setup link";

  return "Your Kinu is live";
}

export function DeployLive({ run, asked, refusal, actions, onAddDomain }: {
  run: DeployRunView & { readonly live: NonNullable<DeployRunView["live"]> };
  asked: RunAsked;
  refusal: DeployRefused | null;
  actions: RefusalActions;
  onAddDomain: () => void;
}) {
  const { url, setupLink, setupLinkExpiresAt, cli, pending } = run.live;
  const host = URL.canParse(url) ? new URL(url).hostname : url;
  const fresh = asked === "new" || asked === null;

  return (
    <DeployShell dot={3} screen="live">
      <div data-deploy-live className="flex flex-col items-center pt-1 text-center">
        {fresh && setupLink !== "" ? <LiveMark /> : <KinuFace activity="idle" />}
        <h2 className="mt-3 t-page-title">{liveTitle(asked, setupLink)}</h2>
        <div className="mt-2 inline-flex max-w-full items-center gap-1.5">
          <a href={url} target="_blank" rel="noopener noreferrer" data-deploy-live-address className="truncate t-title hover:underline">{host}</a>
          <CopyButton value={url} what="the address" />
        </div>
        <div className="mt-6 w-full max-w-xs">
          <a href={setupLink === "" ? url : setupLink} target="_blank" rel="noopener noreferrer" data-deploy-open className={`${buttonClass({ variant: "primary" })} w-full`}>
            {setupLink === "" ? "Open your Kinu" : "Open and set up"}<ArrowSquareOutIcon size={15} />
          </a>
        </div>
        {setupLink !== "" && (
          <p className="mt-2.5 max-w-sm t-meta">This link makes you the owner, once, and works until {dayOf(setupLinkExpiresAt)}. If you lose it, come back here for a new one.</p>
        )}
      </div>

      {pending !== undefined && (
        <div data-deploy-pending={pending.ready ? "ready" : "waiting"} className="mt-6 rounded-[var(--r-row)] bg-[var(--c-selected)] px-4 py-3.5">
          {pending.ready
            ? (
              <>
                <p className="t-item">{pending.domain} points at Cloudflare now</p>
                <p className="mt-1 t-meta p-text-2">Sign in once more and Kinu moves onto it; {host} keeps working.</p>
                <div className="mt-3"><CloudflareButton busy={actions.signingIn} onClick={actions.onSignIn}>Sign in again</CloudflareButton></div>
              </>
            )
            : (
              <>
                <p className="t-item">One more step for {pending.domain}</p>
                <p className="mt-1 t-meta p-text-2">Where you registered it, change its nameservers to these. Kinu sees the change by itself, usually within a few hours.</p>
                <ul className="mt-2.5 space-y-1">
                  {pending.nameservers.map((server) => (
                    <li key={server} className="flex items-center gap-2 rounded-[var(--r-control)] p-surface px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate t-code p-text">{server}</span>
                      <CopyButton value={server} what="the nameserver" className="p-text-3 hover:p-text" />
                    </li>
                  ))}
                </ul>
              </>
            )}
        </div>
      )}

      {/* A domain ready to move onto already offers its sign-in: a carry-on refused for want of one says nothing more. */}
      {refusal !== null && !(pending?.ready === true && refusal.need?.id === "signin-again") && <div className="mt-4"><Refused refusal={refusal} actions={actions} /></div>}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t p-border pt-4">
        <Disclosure summary="Use Kinu from your terminal">
          <div className="flex items-center gap-2 rounded-[var(--r-control)] p-sunken px-3 py-2">
            <TerminalWindowIcon size={14} className="shrink-0 p-text-3" />
            <code className="min-w-0 flex-1 truncate t-code p-text-2">{cli}</code>
            <CopyButton value={cli} what="the install command" className="p-text-3 hover:p-text" />
          </div>
        </Disclosure>
        {pending === undefined && host.endsWith(".workers.dev") && <Button variant="ghost" size="sm" data-deploy-add-domain onClick={onAddDomain}>Add a domain</Button>}
      </div>
    </DeployShell>
  );
}
