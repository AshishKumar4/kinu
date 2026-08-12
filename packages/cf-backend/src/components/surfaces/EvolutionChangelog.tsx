/**
 * Evolution Changelog — the "what I changed about myself" digest (Self).
 * The transparency surface behind the autonomy-ON defaults: every self-change
 * (scaffold promotion, crafted tool, learned fact, GEPA pass, replay loss,
 * outcome grades) renders as a card with its evidence number and per-line
 * actions — ✓ keep (default, no-op) · ✕ revert (the REAL rollback paths) ·
 * diff (scaffold entries, reusing DiffLines). Viewing marks entries seen.
 */
import { useState, useEffect, useCallback } from "react";
import type { ComponentType } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockCounterClockwiseIcon, GitBranchIcon, PackageIcon, BrainIcon,
  SparkleIcon, TimerIcon, ChecksIcon, CheckIcon, XIcon, GitDiffIcon, SquaresFourIcon,
  CaretDownIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import type { ChangelogEntry, ChangelogEntryKind, DiffLine } from "@proteus/core";
import type { Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines, Section } from "./shared";

interface ChangelogView { entries: ChangelogEntry[]; unseenCount: number; seenAt: number }
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

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export interface EvolutionChangelogProps {
  rpc: Rpc;
  /** The viewer saw the digest — zero the unseen badge upstream. */
  onSeen?: () => void;
}

export function EvolutionChangelog({ rpc, onSeen }: EvolutionChangelogProps) {
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [diffFor, setDiffFor] = useState<{ id: string; diff: AsyncResource<ScaffoldDiff> } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => rpc<ChangelogView>("getEvolutionChangelog", [{ limit: 30 }]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const view = lastValue(resource);

  // Seeing the digest IS the acknowledgement — never a blocking modal.
  useEffect(() => {
    if (!view || view.unseenCount === 0) return;
    rpc("markChangelogSeen", []).then(() => onSeen?.()).catch(() => {});
  }, [view, rpc, onSeen]);

  const revert = useCallback(async (entry: ChangelogEntry) => {
    setBusy(entry.id);
    setNotice(null);
    try {
      const r = await rpc<{ ok: boolean; detail?: string; error?: string }>("revertChangelogEntry", [entry.id]);
      setNotice({ id: entry.id, text: r.ok ? `Reverted — ${r.detail ?? "done"}` : (r.error ?? "revert failed"), ok: r.ok });
      if (r.ok) reload();
    } catch (e) {
      setNotice({ id: entry.id, text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }, [rpc, reload]);

  const toggleDiff = useCallback((entry: ChangelogEntry) => {
    if (diffFor?.id === entry.id) { setDiffFor(null); return; }
    if (entry.scaffoldVersion == null) return;
    setDiffFor({ id: entry.id, diff: { status: "loading" } });
    const settle = (diff: AsyncResource<ScaffoldDiff>) =>
      setDiffFor((cur) => cur?.id === entry.id ? { id: entry.id, diff } : cur);
    rpc<ScaffoldDiff>("getScaffoldDiff", [entry.scaffoldVersion]).then(
      (diff) => settle(loadSucceeded(diff)),
      // Collapsing the panel made the click look like it did nothing.
      (err) => settle(loadFailed({ status: "loading" }, err)),
    );
  }, [rpc, diffFor]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const entryActions = (entry: ChangelogEntry) => {
    const isKept = kept.has(entry.id);
    if (!entry.revert || isKept) return null;
    return (
      <>
        <Button size="sm" variant="ghost" shape="square" aria-label={`Keep: ${entry.summary}`}
          onClick={() => setKept((prev) => new Set(prev).add(entry.id))}
          icon={<CheckIcon size={12} />} />
        <Button size="sm" variant="ghost" shape="square" aria-label={`Revert: ${entry.summary}`}
          disabled={busy === entry.id} onClick={() => { void revert(entry); }}
          icon={busy === entry.id ? <Loader size="sm" /> : <XIcon size={12} />} />
      </>
    );
  };

  const entryNotice = (entry: ChangelogEntry) => notice?.id === entry.id ? (
    <div className={`mt-1.5 text-[11px] ${notice.ok ? "p-success" : "p-danger"}`}>
      {notice.text}
    </div>
  ) : null;

  const renderItem = (item: ChangelogEntry) => {
    const isKept = kept.has(item.id);
    return (
      <li key={item.id} className={`rounded-md border p-border px-2.5 py-2 ${isKept ? "opacity-70" : ""}`}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs p-text-2 leading-relaxed">{item.summary}</div>
            {item.evidence && (
              <div className="mt-1 text-[10px] p-text-3 font-mono leading-relaxed whitespace-pre-wrap break-words">
                {item.evidence}
              </div>
            )}
            {entryNotice(item)}
          </div>
          <div className="flex items-center gap-1 shrink-0">{entryActions(item)}</div>
        </div>
        {item.items && item.items.length > 0 && (
          <ul className="mt-2 space-y-1.5 pl-2 border-l p-border">
            {item.items.map(renderItem)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <Section id="changelog" title="Changelog"
      icon={<ClockCounterClockwiseIcon size={14} className="p-text-2" />}
      badge={view && view.entries.length > 0 ? <Badge variant="secondary">{view.entries.length}</Badge> : undefined}>
      {/* The section always renders. Returning null on a failed read made the
          agent's self-change record indistinguishable from a build that never
          had one — on the very surface that justifies autonomy-ON defaults. */}
      {!view ? (
        resource.status === "error"
          ? <LoadFailure what="the changelog" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-4"><Loader size="sm" /></div>
      ) : view.entries.length === 0 ? (
        <p className="text-xs p-text-3">No self-changes recorded yet — they appear here as the agent evolves.</p>
      ) : (
        <div className="space-y-2">
          {view.entries.map((entry) => {
            const Icon = KIND_ICON[entry.kind];
            const fresh = entry.at > view.seenAt;
            const isKept = kept.has(entry.id);
            const isExpanded = expanded.has(entry.id);
            const hasDetails = Boolean(entry.evidence || entry.items?.length);
            const detailsId = `changelog-details-${encodeURIComponent(entry.id)}`;
            return (
              <div key={entry.id} className={`p-card rounded-lg p-3 ${isKept ? "opacity-70" : ""}`}>
                <div className="flex items-start gap-2">
                  <Icon size={14} className={`mt-0.5 shrink-0 ${fresh ? "p-accent" : "p-text-3"}`} />
                  {hasDetails ? (
                    <button type="button" className="min-w-0 flex-1 flex items-start gap-2 text-left rounded-md"
                      aria-expanded={isExpanded} aria-controls={detailsId}
                      onClick={() => toggleExpanded(entry.id)}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs p-text leading-relaxed flex-1" title={entry.summary}>{entry.summary}</span>
                          {fresh && !isKept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
                        </div>
                        <div className="mt-1 text-[10px] p-text-3">{timeAgo(entry.at)}</div>
                      </div>
                      {isExpanded
                        ? <CaretDownIcon size={11} className="mt-0.5 shrink-0 p-text-3" />
                        : <CaretRightIcon size={11} className="mt-0.5 shrink-0 p-text-3" />}
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs p-text leading-relaxed flex-1" title={entry.summary}>{entry.summary}</span>
                        {fresh && !isKept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
                      </div>
                      <div className="mt-1 text-[10px] p-text-3">{timeAgo(entry.at)}</div>
                    </div>
                  )}
                  <div className="flex items-center gap-1 shrink-0">
                    {entry.scaffoldVersion != null && (
                      <Button size="sm" variant="ghost" shape="square" onClick={() => toggleDiff(entry)}
                        icon={<GitDiffIcon size={12} />} aria-label="Show diff" />
                    )}
                    {entryActions(entry)}
                  </div>
                </div>
                {entryNotice(entry)}
                {hasDetails && (
                  <div id={detailsId} role="region" aria-label={`Details for ${entry.summary}`} hidden={!isExpanded}
                    className="mt-2 ml-6 border-t p-border pt-2">
                    {entry.evidence && (
                      <div className="text-[10px] p-text-3 font-mono leading-relaxed whitespace-pre-wrap break-words">
                        {entry.evidence}
                      </div>
                    )}
                    {entry.items && entry.items.length > 0 && (
                      <ul className={`${entry.evidence ? "mt-2" : ""} space-y-1.5`}>
                        {entry.items.map(renderItem)}
                      </ul>
                    )}
                  </div>
                )}
                {diffFor?.id === entry.id && (
                  diffFor.diff.status === "ready" ? (
                    <div className="mt-2 rounded-md border p-border overflow-hidden">
                      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border text-[11px] p-text-3">
                        <span>v{diffFor.diff.value.previousVersion ?? "∅"} → v{diffFor.diff.value.version}</span>
                        <span className="p-success">+{diffFor.diff.value.added}</span>
                        <span className="p-danger">−{diffFor.diff.value.removed}</span>
                      </div>
                      <DiffLines lines={diffFor.diff.value.lines} />
                    </div>
                  ) : diffFor.diff.status === "error" ? (
                    <LoadFailure className="mt-2" what="this diff" message={diffFor.diff.message}
                      onRetry={() => toggleDiff(entry)} />
                  ) : <div className="flex justify-center py-3"><Loader size="sm" /></div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
