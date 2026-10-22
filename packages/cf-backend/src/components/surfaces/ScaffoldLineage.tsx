import { Effect } from 'effect';
import { useState, useCallback, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { PlayIcon } from "@phosphor-icons/react";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines } from "./shared";
import { showing, detach } from "@kinu.run/core/obs";
import { Status, type StatusTone } from "@/components/ui/Status";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import type { OrchestratorAgent } from "@/orchestrator";
import { Pressable } from "@/components/ui/Pressable";
import { TextInput } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";

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
    <Surface look="outlined" className="overflow-hidden">
      <div className="t-meta t-mono flex items-center gap-3 px-3 py-1 border-b p-border p-text-3">
        <span>v{diff.previousVersion ?? "∅"} → v{diff.version}</span>
        <span className="p-success">+{diff.added}</span>
        <span className="p-danger">−{diff.removed}</span>
      </div>
      <DiffLines lines={diff.lines} />
    </Surface>
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
    notice = <p className="t-body p-text-3">No other versions yet.</p>;
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="t-meta p-text-3">Prompt versions</span>
        <Badge>live v{currentVersion}</Badge>
      </div>
      {notice ?? (
        <div className="space-y-2">
          <div className="space-y-1">
            {versions.map((v) => (
              <Pressable selected={selected === v.version} className="flex items-center gap-2 px-2 py-1" key={v.version} onClick={() => select(v.version)}>
                <span className="t-meta t-mono p-text shrink-0">v{v.version}</span>
                <Status tone={versionStatus(v.status).tone}>{versionStatus(v.status).word}</Status>
                <span className="t-body p-text-2 truncate flex-1" title={v.rationale}>{v.rationale}</span>
                <span className="t-meta p-text-3 shrink-0">{new Date(v.written_at).toLocaleDateString()}</span>
              </Pressable>
            ))}
          </div>

          {selected != null && (
            <div className="space-y-3 pt-1">
              <ScaffoldVersionDiff rpc={rpc} version={selected} />

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput size="sm" className="flex-1" value={previewTask} onChange={(e) => setPreviewTask(e.target.value)} placeholder={`Run a task under v${selected} to preview it…`} />
                  <Button size="sm" variant="secondary" disabled={!previewTask.trim() || busy === "preview"}
                    onClick={runPreview} icon={busy === "preview" ? <Loader size="sm" /> : <PlayIcon size={12} />}>
                    Preview
                  </Button>
                </div>
                {previewOut && (
                  <Surface look="tile" as="pre" className="t-code border p-border p-2 max-h-40 overflow-auto whitespace-pre-wrap p-text-2">{previewOut}</Surface>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </section>
  );
}
