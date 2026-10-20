import { Effect } from 'effect';
import { useState, useCallback, type ReactNode } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import { PlayIcon } from "@phosphor-icons/react";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines } from "./shared";
import { showing, detach } from "@kinu.run/core/obs";
import { Status, type StatusTone } from "@/components/ui/Status";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import type { OrchestratorAgent } from "@/orchestrator";

type ScaffoldDiff = Awaited<ReturnType<OrchestratorAgent["getScaffoldDiff"]>>;

/** A version's state in words, and its ink. */
interface VersionStatus { readonly tone: StatusTone; readonly word: string }

function versionStatus(status: string): VersionStatus {
  switch (status) {
    case "current": return { tone: "success", word: "current" };
    case "pending": return { tone: "warning", word: "pending" };
    case "rolled_back": return { tone: "danger", word: "rolled back" };
    default: return { tone: "neutral", word: status.replaceAll("_", " ") };
  }
}

function DiffView({ diff }: { diff: ScaffoldDiff }) {
  return (
    <div className="rounded-md border p-border overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b p-border p-annotation p-text-3">
        <span>v{diff.previousVersion ?? "∅"} → v{diff.version}</span>
        <span className="p-success">+{diff.added}</span>
        <span className="p-danger">−{diff.removed}</span>
      </div>
      <DiffLines lines={diff.lines} />
    </div>
  );
}

/** A scaffold version's diff, read for that version: a slower answer for a version no longer shown is never drawn. */
export function ScaffoldVersionDiff({ rpc, version }: { rpc: WorkspaceRpc; version: number }) {
  const load = useCallback(() => rpc("getScaffoldDiff", [version]), [rpc, version]);
  const { resource: detail, reload } = useAsyncResource(load, undefined, String(version));

  if (detail.status === "ready") return <DiffView diff={detail.value} />;

  if (detail.status === "error") {
    return <LoadFailure what={`the v${version} diff`} message={detail.message} onRetry={reload} />;
  }

  return <div className="flex justify-center py-4"><Loader size="sm" /></div>;
}

interface ScaffoldLineageProps {
  rpc: WorkspaceRpc;
  currentVersion: number;
}

export function ScaffoldLineage({ rpc, currentVersion }: ScaffoldLineageProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewTask, setPreviewTask] = useState("");
  const [previewOut, setPreviewOut] = useState<string | null>(null);

  // "no rewrites yet" may only be claimed about a listing that came back.
  const loadVersions = useCallback(() => rpc("listScaffoldVersions", [20]), [rpc]);
  const { resource: lineage, reload } = useAsyncResource(loadVersions);
  const versions = lastValue(lineage) ?? [];

  const select = useCallback((version: number) => {
    setSelected(version); setPreviewOut(null);
  }, []);

  const runPreview = useCallback(() => detach(Effect.gen(function* () {
    if (selected == null || !previewTask.trim()) return;
    setBusy("preview"); setPreviewOut(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const r = yield* Effect.promise(async () => rpc("previewScaffoldLive", [selected, previewTask.trim()]));
      const text = (r.events ?? []).filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
      setPreviewOut(r.error ? `Error: ${r.error}` : (text || "(no text output)"));
    }), showing((chain) => {
      setPreviewOut(`Error: ${chain}`);
    })), Effect.sync(() => { setBusy(null); }));
  })), [rpc, selected, previewTask]);

  let notice: ReactNode = null;

  if (lineage.status === "error" && versions.length === 0) {
    notice = <LoadFailure what="the scaffold lineage" message={lineage.message} onRetry={reload} />;
  } else if (lineage.status === "loading") {
    notice = <div className="flex justify-center py-4"><Loader size="sm" /></div>;
  } else if (versions.length === 0) {
    notice = <p className="p-row-text p-text-3">No other versions yet.</p>;
  }

  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="p-meta p-text-3">Prompt versions</span>
        <Badge variant="secondary">live v{currentVersion}</Badge>
      </div>
      {notice ?? (
        <div className="space-y-2">
          <div className="space-y-1">
            {versions.map((v) => (
              <button key={v.version} onClick={() => select(v.version)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${selected === v.version ? "p-fill" : "p-card-hover"}`}>
                <span className="font-mono text-xs p-text shrink-0">v{v.version}</span>
                <Status tone={versionStatus(v.status).tone}>{versionStatus(v.status).word}</Status>
                <span className="p-row-text p-text-2 truncate flex-1" title={v.rationale}>{v.rationale}</span>
                <span className="p-meta p-text-3 shrink-0">{new Date(v.written_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>

          {selected != null && (
            <div className="space-y-3 pt-1">
              <ScaffoldVersionDiff rpc={rpc} version={selected} />

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
                  <pre className="p-t-code p-fill border p-border rounded-md p-2.5 max-h-40 overflow-auto whitespace-pre-wrap p-text-2">{previewOut}</pre>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </section>
  );
}
