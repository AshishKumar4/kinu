/**
 * Scaffold lineage — the moat surface (inside Self). The agent rewrites its
 * own inference loop; this makes that legible + tryable: a git-style version
 * lineage, the line diff of what changed, the shadow-eval per-trial verdict
 * grid that drives promotion, and Preview-live / Promote / Rollback actions.
 *
 * Binds to wired RPCs: listScaffoldVersions, getScaffoldDiff, getShadowVerdict,
 * applyScaffoldDecision, previewScaffoldLive.
 */
import { useState, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import { GitBranchIcon, ScalesIcon, PlayIcon, CheckCircleIcon, ArrowUUpLeftIcon } from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines, Section } from "./shared";

interface ScaffoldVersion { version: number; written_at: number; rationale: string; status: string }
interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string }> }
interface ShadowTrial { id: string; task: string; currentScore: number | null; pendingScore: number | null; winner: "current" | "pending" | "tie" | null; rationale: string | null; evaluatedAt: number }
interface ShadowVerdict { version: number | null; trials: ShadowTrial[]; summary: { trials: number; pendingWins: number; currentWins: number; ties: number; winRate: number } }

const STATUS_TONE: Record<string, string> = {
  current: "p-badge-success",
  pending: "p-badge-warning",
  rolled_back: "p-badge-danger",
  historical: "p-fill p-text-3",
};

function DiffView({ diff }: { diff: ScaffoldDiff }) {
  return (
    <div className="rounded-md border p-border overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border text-[11px] p-text-3">
        <span>v{diff.previousVersion ?? "∅"} → v{diff.version}</span>
        <span className="p-success">+{diff.added}</span>
        <span className="p-danger">−{diff.removed}</span>
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
        <span className="p-success">{s.pendingWins} pending</span>
        <span className="p-danger">{s.currentWins} regressions</span>
        <span className="p-text-3">{s.ties} ties · win-rate {(s.winRate * 100).toFixed(0)}%</span>
      </div>
      <div className="rounded-md border p-border overflow-hidden text-[11px]">
        {verdict.trials.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 border-b p-border last:border-0">
            <span className={`shrink-0 size-1.5 rounded-full ${t.winner === "pending" ? "p-dot-success" : t.winner === "current" ? "p-dot-danger" : "p-dot-neutral"}`} />
            <span className="p-text-2 truncate flex-1" title={t.task}>{t.task}</span>
            <span className="font-mono p-text-3 tabular-nums">{t.currentScore?.toFixed(2) ?? "—"}</span>
            <span className="p-text-3">vs</span>
            <span className={`font-mono tabular-nums ${t.winner === "pending" ? "p-success" : "p-text-3"}`}>{t.pendingScore?.toFixed(2) ?? "—"}</span>
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
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AsyncResource<{ diff: ScaffoldDiff; verdict: ShadowVerdict | null }>>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [decideErr, setDecideErr] = useState<string | null>(null);
  const [previewTask, setPreviewTask] = useState("");
  const [previewOut, setPreviewOut] = useState<string | null>(null);

  // "no rewrites yet" is a claim about the agent's own evolution. It may only
  // be made about a listing that actually came back.
  const loadVersions = useCallback(() => rpc<ScaffoldVersion[]>("listScaffoldVersions", [20]), [rpc]);
  const { resource: lineage, reload } = useAsyncResource(loadVersions);
  const versions = lastValue(lineage) ?? [];

  const loadDetail = useCallback((version: number) => {
    setDetail({ status: "loading" });
    // The verdict is absent for a version that never shadow-evalled, so its
    // failure must not withhold the diff; the diff's failure is the surface's.
    Promise.all([
      rpc<ScaffoldDiff>("getScaffoldDiff", [version]),
      rpc<ShadowVerdict>("getShadowVerdict", [version]).catch(() => null),
    ]).then(
      ([diff, verdict]) => setDetail(loadSucceeded({ diff, verdict })),
      (err) => setDetail((prev) => loadFailed(prev, err)),
    );
  }, [rpc]);

  const select = useCallback((version: number) => {
    setSelected(version); setPreviewOut(null); setDecideErr(null);
    loadDetail(version);
  }, [loadDetail]);

  const decide = useCallback(async (mode: "promote" | "rollback") => {
    setBusy(mode);
    setDecideErr(null);
    try { await rpc("applyScaffoldDecision", [mode]); reload(); if (selected != null) loadDetail(selected); }
    catch (e) { setDecideErr(`${mode} failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  }, [rpc, reload, loadDetail, selected]);

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
    <Section id="scaffold" title="Scaffold evolution" defaultOpen={false}
      icon={<GitBranchIcon size={14} className="p-text-2" />}
      badge={<Badge variant="secondary">v{currentVersion}</Badge>}>
      {lineage.status === "error" && versions.length === 0 ? (
        <LoadFailure what="the scaffold lineage" message={lineage.message} onRetry={reload} />
      ) : lineage.status === "loading" ? (
        <div className="flex justify-center py-4"><Loader size="sm" /></div>
      ) : versions.length === 0 ? (
        <p className="text-xs p-text-3">Only the bootstrap scaffold (v0) so far — no rewrites yet.</p>
      ) : (
        <div className="space-y-2">
          {/* Version lineage */}
          <div className="space-y-1">
            {versions.map((v) => (
              <button key={v.version} onClick={() => select(v.version)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${selected === v.version ? "p-fill" : "hover:p-card"}`}>
                <span className="font-mono text-xs p-text shrink-0">v{v.version}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_TONE[v.status] ?? "p-fill p-text-3"}`}>{v.status}</span>
                <span className="text-[11px] p-text-2 truncate flex-1" title={v.rationale}>{v.rationale}</span>
                <span className="text-[10px] p-text-3 shrink-0">{new Date(v.written_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>

          {/* Selected version detail */}
          {selected != null && (
            <div className="space-y-3 pt-1">
              {detail.status === "ready" && detail.value.verdict && detail.value.verdict.trials.length > 0 && (
                <VerdictGrid verdict={detail.value.verdict} />
              )}
              {detail.status === "ready" ? (
                <DiffView diff={detail.value.diff} />
              ) : detail.status === "error" ? (
                <LoadFailure what={`the v${selected} diff`} message={detail.message} onRetry={() => loadDetail(selected)} />
              ) : (
                <div className="flex justify-center py-4"><Loader size="sm" /></div>
              )}

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
                  <pre className="text-[11px] font-mono p-fill border p-border rounded-md p-2.5 max-h-40 overflow-auto whitespace-pre-wrap p-text-2">{previewOut}</pre>
                )}
              </div>

              {/* Promote / Rollback — only meaningful while this version is pending */}
              {isPending && (
                <div className="flex items-center gap-2">
                  <button className={`p-btn ${btnSmCls}`} disabled={!!busy} onClick={() => decide("promote")}>
                    {busy === "promote" ? <Loader size="sm" /> : <CheckCircleIcon size={13} />}
                    Promote v{selected}
                  </button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => decide("rollback")}
                    icon={busy === "rollback" ? <Loader size="sm" /> : <ArrowUUpLeftIcon size={13} />}>
                    Roll back
                  </Button>
                </div>
              )}
              {decideErr && <div className="text-[11px] p-danger">{decideErr}</div>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
