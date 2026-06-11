/**
 * Alternate Takes — the answer-card chip ("Take 1 of 3") and the arrow-cycled
 * comparison it opens. Near-tied MCTS candidates from the turn's think
 * convergence; "Use this take" records the user's pick into the outcome
 * ledger (the preference signal) and, on a changed answer, the agent
 * continues with the chosen approach as its next turn.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, ArrowRightIcon, GitBranchIcon, CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import type { AlternateTakeSet, TakePickOutcome } from "@proteus/core";
import { takeEvidence } from "@proteus/core";
import type { BranchRun } from "@/hooks/use-proteus";
import { Modal } from "@/components/ui/Modal";
import { ScoreBar } from "@/components/ui/score-bar";
import { MarkdownContent } from "@/components/surfaces/shared";
import { currentTakeIndex, cycleTakeIndex, takeChipLabel } from "./alternate-takes-logic";

export function TakesChip({ set, onPick }: {
  set: AlternateTakeSet;
  /** Records the pick server-side; resolves with the updated set. Throws on
   *  RPC failure so the comparison can show it. */
  onPick: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded border p-border hover:p-card-hover transition-colors"
        title="The agent explored near-tied approaches for this answer — compare and pick"
      >
        <GitBranchIcon size={11} />
        {takeChipLabel(set)}
      </button>
      {open && <TakesComparison set={set} onPick={onPick} onClose={() => setOpen(false)} />}
    </>
  );
}

function TakesComparison({ set, onPick, onClose }: {
  set: AlternateTakeSet;
  onPick: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => currentTakeIndex(set));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const count = set.candidates.length;
  const candidate = set.candidates[Math.min(index, count - 1)]!;
  const isCurrent = candidate.nodeId === (set.chosenNodeId ?? set.winnerNodeId);

  const step = useCallback((delta: number) => {
    setNotice(null);
    setIndex((i) => cycleTakeIndex(i, delta, count));
  }, [count]);

  // Arrow keys cycle the comparison (Esc is the Modal's).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  const useTake = useCallback(async () => {
    if (busy || isCurrent) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await onPick(set.id, candidate.nodeId);
      if (result.continuationQueued) {
        setNotice("Preference recorded — the agent will continue with this take.");
      } else {
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, candidate.nodeId, isCurrent, onClose, onPick, set.id]);

  return (
    <Modal
      title="Alternate takes"
      icon={<GitBranchIcon size={18} className="p-accent" />}
      onClose={onClose}
      maxWidthClass="max-w-xl"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Keep current</Button>
        <Button size="sm" variant="primary" onClick={useTake} disabled={busy || isCurrent}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Recording…</span></> : isCurrent ? "Current answer" : "Use this take"}
        </Button>
      </>}
    >
      <p className="text-xs p-text-3 leading-relaxed">
        {set.source === "branch" ? (
          <>You redirected mid-turn with{" "}
            <span className="p-text-2">{set.task.length > 120 ? `${set.task.slice(0, 120)}…` : set.task}</span>{" "}
            and it ran as a parallel branch — compare both answers.</>
        ) : (
          <>The agent explored {count} near-tied approaches for{" "}
            <span className="p-text-2">{set.task.length > 120 ? `${set.task.slice(0, 120)}…` : set.task}</span>.</>
        )}{" "}
        Your pick becomes a real preference signal it learns from.
      </p>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => step(-1)} aria-label="Previous take"
          className="p-1.5 rounded p-text-3 hover:p-text hover:p-card-hover transition-colors cursor-pointer">
          <ArrowLeftIcon size={14} />
        </button>
        <div className="flex items-center gap-2 text-xs p-text-2">
          <span className="font-medium p-text">Take {index + 1} of {count}</span>
          {isCurrent && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
              <CheckCircleIcon size={11} weight="fill" />current answer
            </span>
          )}
        </div>
        <button type="button" onClick={() => step(1)} aria-label="Next take"
          className="p-1.5 rounded p-text-3 hover:p-text hover:p-card-hover transition-colors cursor-pointer">
          <ArrowRightIcon size={14} />
        </button>
      </div>

      <div className="rounded-lg border p-border p-card px-3 py-2.5 max-h-64 overflow-y-auto">
        <div className="prose-chat p-text text-sm">
          <MarkdownContent content={candidate.text} />
        </div>
      </div>

      {candidate.origin ? (
        <div className="text-[10px] p-text-3">{takeEvidence(candidate)}</div>
      ) : (
        <div className="space-y-1">
          <ScoreBar value={candidate.score} />
          <div className="text-[10px] p-text-3">{takeEvidence(candidate)} · execution-grounded branch value</div>
        </div>
      )}

      {notice && (
        <div className="text-xs text-emerald-300 border border-emerald-400/30 rounded-md px-3 py-2" style={{ background: "rgba(52,211,153,0.06)" }}>
          {notice}
        </div>
      )}
      {err && (
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
          {err}
        </div>
      )}
    </Modal>
  );
}

/** Steer-as-Branch progress chip — rendered near the streaming answer while
 *  the branch head runs, becoming the takes affordance (the SAME TakesChip /
 *  comparison) on settle, or an honest one-line reason on failure. */
export function BranchRunChip({ run, takes, onPick, onDismiss }: {
  run: BranchRun;
  /** The settled set (hydrated from listAlternateTakes by the run's turnId). */
  takes?: AlternateTakeSet;
  onPick: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
  onDismiss: () => void;
}) {
  const task = run.task.length > 80 ? `${run.task.slice(0, 80)}…` : run.task;
  return (
    <div className="flex justify-start animate-fade-in py-0.5">
      <div className="inline-flex items-center gap-2 max-w-full px-3 py-1.5 rounded-full p-elevated border p-border text-[11px] p-text-2">
        {run.status === "running" && (
          <>
            <Loader size="sm" />
            <GitBranchIcon size={12} className="p-accent shrink-0" />
            <span className="truncate">Branching: <span className="p-text">{task}</span> — the live turn continues</span>
          </>
        )}
        {run.status === "settled" && (
          <>
            <GitBranchIcon size={12} className="text-emerald-400 shrink-0" weight="fill" />
            <span className="truncate">Branch settled —</span>
            {takes ? <TakesChip set={takes} onPick={onPick} /> : <span className="p-text-3">loading the comparison…</span>}
          </>
        )}
        {run.status === "error" && (
          <>
            <WarningCircleIcon size={12} className="text-amber-400 shrink-0" weight="fill" />
            <span className="truncate">Branch discarded — {run.message ?? "no comparison available"}</span>
          </>
        )}
        {run.status !== "running" && (
          <button onClick={onDismiss} className="p-text-3 hover:p-text cursor-pointer shrink-0" aria-label="Dismiss branch chip">
            <XIcon size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
