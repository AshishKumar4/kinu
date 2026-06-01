/**
 * Scaffold lineage — the moat surface (inside Brain). The agent rewrites its
 * own inference loop; this makes that legible + tryable: a git-style version
 * lineage, the line diff of what changed, the shadow-eval per-trial verdict
 * grid that drives promotion, and Preview-live / Promote / Rollback actions.
 *
 * Binds to wired RPCs: listScaffoldVersions, getScaffoldDiff, getShadowStatus,
 * getShadowVerdict, applyScaffoldDecision, previewScaffoldLive.
 */
import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { GitBranchIcon, ScalesIcon, PlayIcon, CheckCircleIcon, ArrowUUpLeftIcon } from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import { DiffLines } from "./shared";

interface ScaffoldVersion { version: number; written_at: number; rationale: string; status: string }
interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string }> }
interface ShadowTrial { id: string; task: string; currentScore: number | null; pendingScore: number | null; winner: "current" | "pending" | "tie" | null; rationale: string | null; evaluatedAt: number }
interface ShadowVerdict { version: number | null; trials: ShadowTrial[]; summary: { trials: number; pendingWins: number; currentWins: number; ties: number; winRate: number } }

const STATUS_TONE: Record<string, string> = {
  current: "bg-emerald-500/20 text-emerald-300",
  pending: "bg-amber-500/20 text-amber-300",
  rolled_back: "bg-red-500/15 text-red-300",
  historical: "p-elevated p-text-3",
};

function DiffView({ diff }: { diff: ScaffoldDiff }) {
  return (
    <div className="rounded-md border p-border overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border text-[11px] p-text-3">
        <span>v{diff.previousVersion ?? "∅"} → v{diff.version}</span>
        <span className="text-emerald-400">+{diff.added}</span>
        <span className="text-red-400">−{diff.removed}</span>
      </div>
      <DiffLines lines={diff.lines} />
    </div>
  );
}

function VerdictGrid({ verdict }: { verdict: ShadowVerdict }) {
  if (verdict.trials.length === 0) return null;
  const s = verdict.summary;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <ScalesIcon size={13} className="p-text-2" />
        <span className="p-text-2">Shadow eval</span>
        <span className="text-emerald-400">{s.pendingWins} pending</span>
        <span className="text-red-400">{s.currentWins} regressions</span>
        <span className="p-text-3">{s.ties} ties · win-rate {(s.winRate * 100).toFixed(0)}%</span>
      </div>
      <div className="rounded-md border p-border overflow-hidden text-[11px]">
        {verdict.trials.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
            <span className={`shrink-0 size-1.5 rounded-full ${t.winner === "pending" ? "bg-emerald-500" : t.winner === "current" ? "bg-red-500" : "bg-zinc-500"}`} />
            <span className="p-text-2 truncate flex-1" title={t.task}>{t.task}</span>
            <span className="font-mono p-text-3 tabular-nums">{t.currentScore?.toFixed(2) ?? "—"}</span>
            <span className="p-text-3">vs</span>
            <span className={`font-mono tabular-nums ${t.winner === "pending" ? "text-emerald-300" : "p-text-3"}`}>{t.pendingScore?.toFixed(2) ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ScaffoldLineageProps {
  rpc: Rpc;
  currentVersion: number;
}

export function ScaffoldLineage({ rpc, currentVersion }: ScaffoldLineageProps) {
  const [versions, setVersions] = useState<ScaffoldVersion[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<ScaffoldDiff | null>(null);
  const [verdict, setVerdict] = useState<ShadowVerdict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewTask, setPreviewTask] = useState("");
  const [previewOut, setPreviewOut] = useState<string | null>(null);

  const loadVersions = useCallback(() => {
    rpc<ScaffoldVersion[]>("listScaffoldVersions", [20]).then(setVersions).catch(() => {});
  }, [rpc]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  const select = useCallback((version: number) => {
    setSelected(version); setDiff(null); setVerdict(null); setPreviewOut(null);
    rpc<ScaffoldDiff>("getScaffoldDiff", [version]).then(setDiff).catch(() => {});
    rpc<ShadowVerdict>("getShadowVerdict", [version]).then(setVerdict).catch(() => {});
  }, [rpc]);

  const decide = useCallback(async (mode: "promote" | "rollback") => {
    setBusy(mode);
    try { await rpc("applyScaffoldDecision", [mode]); loadVersions(); if (selected != null) select(selected); }
    finally { setBusy(null); }
  }, [rpc, loadVersions, select, selected]);

  const runPreview = useCallback(async () => {
    if (selected == null || !previewTask.trim()) return;
    setBusy("preview"); setPreviewOut(null);
    try {
      const r = await rpc<{ ok?: boolean; error?: string; events?: Array<{ type: string; text?: string }> }>("previewScaffoldLive", [selected, previewTask.trim()]);
      const text = (r.events ?? []).filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
      setPreviewOut(r.error ? `Error: ${r.error}` : (text || "(no text output)"));
    } catch (e) {
      setPreviewOut(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(null); }
  }, [rpc, selected, previewTask]);

  const selectedV = versions.find((v) => v.version === selected);
  const isPending = selectedV?.status === "pending";

  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <GitBranchIcon size={14} className="p-text-2" />
        <span className="text-sm font-medium p-text">Scaffold evolution</span>
        <Badge variant="secondary">v{currentVersion}</Badge>
      </div>

      {versions.length === 0 ? (
        <p className="text-xs p-text-3">Only the bootstrap scaffold (v0) so far — no rewrites yet.</p>
      ) : (
        <div className="space-y-2">
          {/* Version lineage */}
          <div className="space-y-1">
            {versions.map((v) => (
              <button key={v.version} onClick={() => select(v.version)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${selected === v.version ? "p-elevated" : "hover:p-card"}`}>
                <span className="font-mono text-xs p-text shrink-0">v{v.version}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_TONE[v.status] ?? "p-elevated p-text-3"}`}>{v.status}</span>
                <span className="text-[11px] p-text-2 truncate flex-1" title={v.rationale}>{v.rationale}</span>
                <span className="text-[10px] p-text-3 shrink-0">{new Date(v.written_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>

          {/* Selected version detail */}
          {selected != null && (
            <div className="space-y-3 pt-1">
              {verdict && verdict.trials.length > 0 && <VerdictGrid verdict={verdict} />}
              {diff ? <DiffView diff={diff} /> : <div className="flex justify-center py-4"><Loader size="sm" /></div>}

              {/* Preview-live a candidate before promoting */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input value={previewTask} onChange={(e) => setPreviewTask(e.target.value)}
                    placeholder={`Run a task under v${selected} to preview it…`}
                    className="flex-1 rounded-md border p-border p-elevated px-2.5 py-1.5 text-xs p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]" />
                  <Button size="sm" variant="secondary" disabled={!previewTask.trim() || busy === "preview"}
                    onClick={runPreview} icon={busy === "preview" ? <Loader size="sm" /> : <PlayIcon size={12} />}>
                    Preview
                  </Button>
                </div>
                {previewOut && (
                  <pre className="text-[11px] font-mono p-elevated border p-border rounded-md p-2.5 max-h-40 overflow-auto whitespace-pre-wrap p-text-2">{previewOut}</pre>
                )}
              </div>

              {/* Promote / Rollback — only meaningful while this version is pending */}
              {isPending && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" disabled={!!busy} onClick={() => decide("promote")}
                    icon={busy === "promote" ? <Loader size="sm" /> : <CheckCircleIcon size={13} />}>
                    Promote v{selected}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => decide("rollback")}
                    icon={busy === "rollback" ? <Loader size="sm" /> : <ArrowUUpLeftIcon size={13} />}>
                    Roll back
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
