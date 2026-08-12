/**
 * Self-changes — the "what I changed about myself" entries, with their evidence
 * and their per-line actions: ✓ keep (default, no-op) · ✕ revert (the REAL
 * rollback paths) · diff (scaffold entries, reusing DiffLines).
 *
 * This is the transparency surface behind the autonomy-ON defaults, and it now
 * renders as entries in the Work surface's journal rather than as a block
 * inside the agent's own description: a self-change is something that HAPPENED,
 * on the same time axis as a settled job or a closed task, and "what happened
 * while I was away" is not a question anybody opens a CV to answer.
 *
 * The load and the seen-marking are a hook so the journal can interleave these
 * with the rest of the feed by timestamp; each card owns its own kept / busy /
 * diff state, which is per-entry anyway.
 */
import { useState, useEffect, useCallback } from "react";
import type { ComponentType } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import {
  GitBranchIcon, PackageIcon, BrainIcon,
  SparkleIcon, TimerIcon, ChecksIcon, CheckIcon, XIcon, GitDiffIcon, SquaresFourIcon,
  CaretDownIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import type { ChangelogEntry, ChangelogEntryKind, DiffLine } from "@proteus/core";
import type { Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines, timeAgo } from "./shared";

export interface ChangelogView { entries: ChangelogEntry[]; unseenCount: number; seenAt: number }
interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: DiffLine[] }

const KIND_ICON: Record<ChangelogEntryKind, ComponentType<{ size?: number; className?: string }>> = {
  scaffold: GitBranchIcon,
  tool: PackageIcon,
  view: SquaresFourIcon,
  fact: BrainIcon,
  gepa: SparkleIcon,
  replay: TimerIcon,
  outcomes: ChecksIcon,
};

/**
 * The changelog, loaded once for the surface that shows it, and marked seen by
 * the act of showing it — seeing the digest IS the acknowledgement, never a
 * blocking modal. `onSeen` zeroes the tab badge upstream.
 */
export function useChangelog(rpc: Rpc, onSeen?: () => void) {
  const load = useCallback(() => rpc<ChangelogView>("getEvolutionChangelog", [{ limit: 30 }]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const view = lastValue(resource);

  useEffect(() => {
    if (!view || view.unseenCount === 0) return;
    rpc("markChangelogSeen", []).then(() => onSeen?.()).catch(() => {});
  }, [view, rpc, onSeen]);

  return { view, resource, reload };
}

/** The failure state, so a broken read is never indistinguishable from a build
 *  that never had a changelog — on the very surface that justifies autonomy. */
export function ChangelogFailure(
  { resource, reload }: { resource: AsyncResource<ChangelogView>; reload: () => void },
) {
  if (resource.status === "error") {
    return <LoadFailure what="the changelog" message={resource.message} onRetry={reload} />;
  }
  return <div className="flex justify-center py-4"><Loader size="sm" /></div>;
}

export interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  /** Entries newer than this were unseen when the surface opened. */
  seenAt: number;
  rpc: Rpc;
  onReverted: () => void;
}

export function ChangelogEntryCard({ entry, seenAt, rpc, onReverted }: ChangelogEntryCardProps) {
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [diff, setDiff] = useState<AsyncResource<ScaffoldDiff> | null>(null);
  const [expanded, setExpanded] = useState(false);

  const revert = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entry.id]);
      setNotice({ text: r.ok ? `Reverted — ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });
      if (r.ok) onReverted();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, entry.id, onReverted]);

  const toggleDiff = useCallback(() => {
    if (diff !== null) { setDiff(null); return; }
    if (entry.scaffoldVersion == null) return;
    setDiff({ status: "loading" });
    rpc<ScaffoldDiff>("getScaffoldDiff", [entry.scaffoldVersion]).then(
      (d) => setDiff(loadSucceeded(d)),
      // Collapsing the panel made the click look like it did nothing.
      (err) => setDiff(loadFailed({ status: "loading" }, err)),
    );
  }, [rpc, entry.scaffoldVersion, diff]);

  const actions = entry.revert && !kept ? (
    <>
      <Button size="sm" variant="ghost" shape="square" aria-label={`Keep: ${entry.summary}`}
        onClick={() => setKept(true)} icon={<CheckIcon size={12} />} />
      <Button size="sm" variant="ghost" shape="square" aria-label={`Revert: ${entry.summary}`}
        disabled={busy} onClick={() => { void revert(); }}
        icon={busy ? <Loader size="sm" /> : <XIcon size={12} />} />
    </>
  ) : null;

  const Icon = KIND_ICON[entry.kind];
  const fresh = entry.at > seenAt;
  const hasDetails = Boolean(entry.evidence || entry.items?.length);
  const detailsId = `changelog-details-${encodeURIComponent(entry.id)}`;

  const headline = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-xs p-text leading-relaxed flex-1" title={entry.summary}>{entry.summary}</span>
        {fresh && !kept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
      </div>
      <div className="mt-1 text-[10px] p-text-3">{timeAgo(entry.at)}</div>
    </div>
  );

  return (
    <div className={`p-card rounded-lg p-3 ${kept ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-2">
        <Icon size={14} className={`mt-0.5 shrink-0 ${fresh ? "p-accent" : "p-text-3"}`} />
        {hasDetails ? (
          <button type="button" className="min-w-0 flex-1 flex items-start gap-2 text-left rounded-md"
            aria-expanded={expanded} aria-controls={detailsId}
            onClick={() => setExpanded((prev) => !prev)}>
            {headline}
            {expanded
              ? <CaretDownIcon size={11} className="mt-0.5 shrink-0 p-text-3" />
              : <CaretRightIcon size={11} className="mt-0.5 shrink-0 p-text-3" />}
          </button>
        ) : headline}
        <div className="flex items-center gap-1 shrink-0">
          {entry.scaffoldVersion != null && (
            <Button size="sm" variant="ghost" shape="square" onClick={toggleDiff}
              icon={<GitDiffIcon size={12} />} aria-label="Show diff" />
          )}
          {actions}
        </div>
      </div>

      {notice && (
        <div className={`mt-1.5 text-[11px] ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
      )}

      {hasDetails && (
        <div id={detailsId} role="region" aria-label={`Details for ${entry.summary}`} hidden={!expanded}
          className="mt-2 ml-6 border-t p-border pt-2">
          {entry.evidence && (
            <div className="text-[10px] p-text-3 font-mono leading-relaxed whitespace-pre-wrap break-words">
              {entry.evidence}
            </div>
          )}
          {entry.items && entry.items.length > 0 && (
            <ul className={`${entry.evidence ? "mt-2" : ""} space-y-1.5`}>
              {entry.items.map((item) => (
                <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />
              ))}
            </ul>
          )}
        </div>
      )}

      {diff !== null && (
        diff.status === "ready" ? (
          <div className="mt-2 rounded-md border p-border overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border text-[11px] p-text-3">
              <span>v{diff.value.previousVersion ?? "∅"} → v{diff.value.version}</span>
              <span className="p-success">+{diff.value.added}</span>
              <span className="p-danger">−{diff.value.removed}</span>
            </div>
            <DiffLines lines={diff.value.lines} />
          </div>
        ) : diff.status === "error" ? (
          <LoadFailure className="mt-2" what="this diff" message={diff.message} onRetry={toggleDiff} />
        ) : <div className="flex justify-center py-3"><Loader size="sm" /></div>
      )}
    </div>
  );
}

/** A grouped entry's members — same actions, no icon or diff of their own. */
function SubEntry({ entry, rpc, onReverted }: { entry: ChangelogEntry; rpc: Rpc; onReverted: () => void }) {
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const revert = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entry.id]);
      setNotice({ text: r.ok ? `Reverted — ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });
      if (r.ok) onReverted();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }, [rpc, entry.id, onReverted]);

  return (
    <li className={`rounded-md border p-border px-2.5 py-2 ${kept ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text-2 leading-relaxed">{entry.summary}</div>
          {entry.evidence && (
            <div className="mt-1 text-[10px] p-text-3 font-mono leading-relaxed whitespace-pre-wrap break-words">
              {entry.evidence}
            </div>
          )}
          {notice && (
            <div className={`mt-1.5 text-[11px] ${notice.ok ? "p-success" : "p-danger"}`}>{notice.text}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {entry.revert && !kept && (
            <>
              <Button size="sm" variant="ghost" shape="square" aria-label={`Keep: ${entry.summary}`}
                onClick={() => setKept(true)} icon={<CheckIcon size={12} />} />
              <Button size="sm" variant="ghost" shape="square" aria-label={`Revert: ${entry.summary}`}
                disabled={busy} onClick={() => { void revert(); }}
                icon={busy ? <Loader size="sm" /> : <XIcon size={12} />} />
            </>
          )}
        </div>
      </div>
      {entry.items && entry.items.length > 0 && (
        <ul className="mt-2 space-y-1.5 pl-2 border-l p-border">
          {entry.items.map((item) => (
            <SubEntry key={item.id} entry={item} rpc={rpc} onReverted={onReverted} />
          ))}
        </ul>
      )}
    </li>
  );
}
