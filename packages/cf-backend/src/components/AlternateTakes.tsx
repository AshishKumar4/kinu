import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  ArrowLeftIcon, ArrowRightIcon, CaretDownIcon, CaretRightIcon, GitBranchIcon,
  CheckCircleIcon, WarningCircleIcon, XIcon,
} from "@phosphor-icons/react";
import type { AlternateTakeSet, TakePickOutcome } from "@kinu.run/core";
import { branchHeadId, takeEvidence } from "@kinu.run/core";
import type { BranchRun } from "@/hooks/use-kinu";
import type { Rpc } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
import { ScoreBar } from "@/components/ui/score-bar";
import { MarkdownContent } from "@/components/surfaces/shared";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { TranscriptBody, useNodeTranscript } from "@/components/NodeTranscript";
import { NO_HEAD_DELTAS, type HeadDeltas } from "@kinu.run/core";
import { currentTakeIndex, cycleTakeIndex, takeChipLabel } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";

export function TakesChip({ set, onPick }: {
  set: AlternateTakeSet;
  /** Throws on RPC failure so the comparison can show it. */
  onPick: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 p-t-control p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm border p-border p-card-hover transition-colors"
        title="The agent explored near-tied approaches. Compare and pick one."
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
  const candidate = set.candidates[Math.min(index, count - 1)];
  const isCurrent = candidate.nodeId === (set.chosenNodeId ?? set.winnerNodeId);

  const step = useCallback((delta: number) => {
    setNotice(null);
    setIndex((i) => cycleTakeIndex(i, delta, count));
  }, [count]);

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
        setNotice("Saved. The agent continues with this take.");
      } else {
        onClose();
      }
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  }, [busy, candidate.nodeId, isCurrent, onClose, onPick, set.id]);

  const pickWord = isCurrent ? "Current answer" : "Use this take";

  return (
    <Modal
      title="Alternate takes"
      icon={<GitBranchIcon size={18} className="p-accent" />}
      onClose={onClose}
      maxWidthClass="max-w-xl"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Keep current</Button>
        <FilledButton onClick={useTake} disabled={busy || isCurrent}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Recording…</span></> : pickWord}
        </FilledButton>
      </>}
    >
      <p className="text-xs p-text-3 leading-relaxed">
        {set.source === "branch" ? (
          <>You redirected mid-turn with{" "}
            <span className="p-text-2">{set.task.length > 120 ? `${set.task.slice(0, 120)}…` : set.task}</span>{" "}
            and it ran as a parallel branch. Compare both answers.</>
        ) : (
          <>The agent explored {count} near-tied approaches for{" "}
            <span className="p-text-2">{set.task.length > 120 ? `${set.task.slice(0, 120)}…` : set.task}</span>.</>
        )}{" "}
        Your pick becomes a preference signal the agent learns from.
      </p>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => step(-1)} aria-label="Previous take"
          className="p-1.5 rounded-sm p-text-3 hover:p-text p-card-hover transition-colors cursor-pointer">
          <ArrowLeftIcon size={14} />
        </button>
        <div className="flex items-center gap-2 text-xs p-text-2">
          <span className="font-medium p-text">Take {index + 1} of {count}</span>
          {isCurrent && (
            <span className="inline-flex items-center gap-1 p-t-status p-success">
              <CheckCircleIcon size={11} weight="fill" />current answer
            </span>
          )}
        </div>
        <button type="button" onClick={() => step(1)} aria-label="Next take"
          className="p-1.5 rounded-sm p-text-3 hover:p-text p-card-hover transition-colors cursor-pointer">
          <ArrowRightIcon size={14} />
        </button>
      </div>

      <div className="border p-border p-card px-3 py-2.5 max-h-64 overflow-y-auto">
        <div className="prose-chat p-text text-sm">
          <MarkdownContent content={candidate.text} />
        </div>
      </div>

      {candidate.origin ? (
        <div className="p-meta p-text-3">{takeEvidence(candidate)}</div>
      ) : (
        <div className="space-y-1">
          <ScoreBar value={candidate.score} />
          <div className="p-meta p-text-3">{takeEvidence(candidate)} · execution-grounded branch value</div>
        </div>
      )}

      {notice && (
        <div className="text-xs rounded-md px-3 py-2 p-notice-success">
          {notice}
        </div>
      )}
      {err && (
        <div className="text-xs rounded-md px-3 py-2 p-notice-danger">
          {err}
        </div>
      )}
    </Modal>
  );
}

/** The branch head id is derived from the run id ({@link branchHeadId}), so the chip fetches its transcript without listing the run. */
export function BranchRunChip({ run, takes, rpc, headActivity, headDeltas = NO_HEAD_DELTAS, onPick, onDismiss }: {
  run: BranchRun;
  takes?: AlternateTakeSet;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  headDeltas?: HeadDeltas;
  onPick: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const task = run.task.length > 80 ? `${run.task.slice(0, 80)}…` : run.task;
  const headId = branchHeadId(run.branchId);

  const { view, resource, reload, pending } = useNodeTranscript({
    runId: open ? run.branchId : null,
    nodeId: open ? headId : null,
    rpc,
    headActivity,
    headDeltas,
    // Arm the fallback poll: a chip has no other node to click to recover a missed socket frame.
    running: run.status === "running",
  });

  let branchBody: ReactNode = (
    // The head id derives from the run id, so "nothing recorded" means the branch died before its first write.
    <div className="px-4 py-6 text-center p-meta p-text-3">
      Nothing is recorded for this branch yet.
    </div>
  );

  if (view) {
    branchBody = <TranscriptBody view={view} pending={pending} />;
  } else if (resource.status === "loading") {
    branchBody = (
      <div className="flex items-center justify-center gap-2 py-6 p-t-status p-text-2">
        <Loader size="sm" />Reading the branch…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1 animate-fade-in py-0.5">
      <div className="inline-flex items-center gap-2 max-w-full px-3 py-1.5 rounded-full p-elevated border p-border p-row-text p-text-2">
        {run.status === "running" && (
          <>
            <Loader size="sm" />
            <GitBranchIcon size={12} className="p-accent shrink-0" />
            <span className="truncate">Branching: <span className="p-text">{task}</span> · the live turn continues</span>
          </>
        )}
        {run.status === "settled" && (
          <>
            <GitBranchIcon size={12} className="p-success shrink-0" weight="fill" />
            <span className="truncate">Branch settled</span>
            {takes ? <TakesChip set={takes} onPick={onPick} /> : <span className="p-text-3">loading the comparison…</span>}
          </>
        )}
        {run.status === "error" && (
          <>
            <WarningCircleIcon size={12} className="p-warning shrink-0" weight="fill" />
            <span className="truncate">Branch discarded: {run.message ?? "no comparison available"}</span>
          </>
        )}
        <button type="button" onClick={() => setOpen(!open)}
          className="p-text-3 hover:p-text cursor-pointer shrink-0 inline-flex items-center gap-1"
          aria-expanded={open} title="Read every step this branch took">
          {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
          {open ? "Hide" : "Show what it did"}
        </button>
        {run.status !== "running" && (
          <button onClick={onDismiss} className="p-text-3 hover:p-text cursor-pointer shrink-0" aria-label="Dismiss branch chip">
            <XIcon size={11} />
          </button>
        )}
      </div>
      {open && (
        <div className="w-full max-h-96 flex flex-col rounded-lg border p-border p-surface overflow-hidden">
          {resource.status === "error" && (
            <LoadFailure what="this branch's transcript" message={resource.message} onRetry={reload}
              className="shrink-0 border-b p-border px-4 py-2" />
          )}
          {branchBody}
        </div>
      )}
    </div>
  );
}
