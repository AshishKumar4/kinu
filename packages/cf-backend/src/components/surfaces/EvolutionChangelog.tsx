/**
 * Evolution Changelog — the "what I changed about myself" digest (Brain).
 * The transparency surface behind the autonomy-ON defaults: every self-change
 * (scaffold promotion, crafted tool, learned fact, GEPA pass, replay loss,
 * outcome grades) renders as a card with its evidence number and per-line
 * actions — ✓ keep (default, no-op) · ✕ revert (the REAL rollback paths) ·
 * diff (scaffold entries, reusing DiffLines). Viewing marks entries seen.
 */
import { useState, useEffect, useCallback } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockCounterClockwiseIcon, GitBranchIcon, PackageIcon, BrainIcon,
  SparkleIcon, TimerIcon, ChecksIcon, CheckIcon, XIcon, GitDiffIcon,
} from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import { DiffLines } from "./shared";
import type { DiffLine } from "@/lib/diff";

type ChangelogKind = "scaffold" | "tool" | "fact" | "gepa" | "replay" | "outcomes";

interface ChangelogEntry {
  id: string;
  kind: ChangelogKind;
  at: number;
  summary: string;
  evidence: string;
  revert?: { type: string; target: string };
  scaffoldVersion?: number;
}

interface ChangelogView { entries: ChangelogEntry[]; unseenCount: number; seenAt: number }
interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: DiffLine[] }

const KIND_ICON: Record<ChangelogKind, React.ComponentType<{ size?: number; className?: string }>> = {
  scaffold: GitBranchIcon,
  tool: PackageIcon,
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
  const [view, setView] = useState<ChangelogView | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [diffFor, setDiffFor] = useState<{ id: string; diff: ScaffoldDiff | null } | null>(null);

  const load = useCallback(() => {
    rpc<ChangelogView>("getEvolutionChangelog", [{ limit: 30 }]).then(setView).catch(() => {});
  }, [rpc]);

  useEffect(() => { load(); }, [load]);

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
      if (r.ok) load();
    } catch (e) {
      setNotice({ id: entry.id, text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }, [rpc, load]);

  const toggleDiff = useCallback((entry: ChangelogEntry) => {
    if (diffFor?.id === entry.id) { setDiffFor(null); return; }
    if (entry.scaffoldVersion == null) return;
    setDiffFor({ id: entry.id, diff: null });
    rpc<ScaffoldDiff>("getScaffoldDiff", [entry.scaffoldVersion])
      .then((diff) => setDiffFor((cur) => cur?.id === entry.id ? { id: entry.id, diff } : cur))
      .catch(() => setDiffFor(null));
  }, [rpc, diffFor]);

  if (!view) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <ClockCounterClockwiseIcon size={14} className="p-text-2" />
        <span className="text-sm font-medium p-text">Changelog</span>
        {view.entries.length > 0 && <Badge variant="secondary">{view.entries.length}</Badge>}
      </div>

      {view.entries.length === 0 ? (
        <p className="text-xs p-text-3">No self-changes recorded yet — they appear here as the agent evolves.</p>
      ) : (
        <div className="space-y-2">
          {view.entries.map((entry) => {
            const Icon = KIND_ICON[entry.kind];
            const fresh = entry.at > view.seenAt;
            const isKept = kept.has(entry.id);
            return (
              <div key={entry.id} className={`p-card rounded-lg p-3 ${isKept ? "opacity-70" : ""}`}>
                <div className="flex items-start gap-2">
                  <Icon size={14} className={`mt-0.5 shrink-0 ${fresh ? "p-accent" : "p-text-3"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs p-text leading-relaxed flex-1" title={entry.summary}>{entry.summary}</span>
                      {fresh && !isKept && <span className="shrink-0 size-1.5 rounded-full bg-[var(--c-accent)]" />}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] p-text-3">
                      <span className="font-mono tabular-nums">{entry.evidence}</span>
                      <span>·</span>
                      <span>{timeAgo(entry.at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {entry.scaffoldVersion != null && (
                      <Button size="sm" variant="ghost" shape="square" onClick={() => toggleDiff(entry)}
                        icon={<GitDiffIcon size={12} />} aria-label="Show diff" />
                    )}
                    {entry.revert && !isKept && (
                      <>
                        <Button size="sm" variant="ghost" shape="square" aria-label="Keep"
                          onClick={() => setKept((prev) => new Set(prev).add(entry.id))}
                          icon={<CheckIcon size={12} />} />
                        <Button size="sm" variant="ghost" shape="square" aria-label="Revert" disabled={busy === entry.id}
                          onClick={() => { void revert(entry); }}
                          icon={busy === entry.id ? <Loader size="sm" /> : <XIcon size={12} />} />
                      </>
                    )}
                  </div>
                </div>
                {notice?.id === entry.id && (
                  <div className={`mt-2 text-[11px] ${notice.ok ? "text-emerald-400" : "text-red-400"}`}>{notice.text}</div>
                )}
                {diffFor?.id === entry.id && (
                  diffFor.diff ? (
                    <div className="mt-2 rounded-md border p-border overflow-hidden">
                      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border text-[11px] p-text-3">
                        <span>v{diffFor.diff.previousVersion ?? "∅"} → v{diffFor.diff.version}</span>
                        <span className="text-emerald-400">+{diffFor.diff.added}</span>
                        <span className="text-red-400">−{diffFor.diff.removed}</span>
                      </div>
                      <DiffLines lines={diffFor.diff.lines} />
                    </div>
                  ) : <div className="flex justify-center py-3"><Loader size="sm" /></div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
