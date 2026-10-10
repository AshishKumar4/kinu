import { Effect, Cause } from 'effect';
import { useState, useCallback, type ReactNode } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import { PlayIcon, CheckCircleIcon, ArrowUUpLeftIcon } from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { DiffLines } from "./shared";
import { renderThrownChain, showing, detach } from "@kinu.run/core/obs";

interface ScaffoldVersion { version: number; written_at: number; rationale: string; status: string }

interface ScaffoldDiff { version: number; previousVersion: number | null; added: number; removed: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string }> }

function statusTone(status: string): string {
  switch (status) {
    case "current": return "p-badge-success";
    case "pending": return "p-badge-warning";
    case "rolled_back": return "p-badge-danger";
    default: return "p-fill p-text-3";
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

/** A scaffold version's diff, read for that version and again each time `readAgain` moves: a slower answer for a
 *  version no longer shown is never drawn. */
export function ScaffoldVersionDiff({ rpc, version, readAgain }: { rpc: Rpc; version: number; readAgain: number }) {
  const load = useCallback(() => rpc<ScaffoldDiff>("getScaffoldDiff", [version]), [rpc, version]);
  const { resource: detail, reload } = useAsyncResource(load, undefined, `${String(version)}:${String(readAgain)}`);

  if (detail.status === "ready") return <DiffView diff={detail.value} />;

  if (detail.status === "error") {
    return <LoadFailure what={`the v${version} diff`} message={detail.message} onRetry={reload} />;
  }

  return <div className="flex justify-center py-4"><Loader size="sm" /></div>;
}

export interface ScaffoldLineageProps {
  rpc: Rpc;
  currentVersion: number;
}

export function ScaffoldLineage({ rpc, currentVersion }: ScaffoldLineageProps) {
  const [selected, setSelected] = useState<number | null>(null);
  // Each decision moves the selected diff's base, so it is read again.
  const [decisions, setDecisions] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [decideErr, setDecideErr] = useState<string | null>(null);
  const [previewTask, setPreviewTask] = useState("");
  const [previewOut, setPreviewOut] = useState<string | null>(null);

  // "no rewrites yet" may only be claimed about a listing that came back.
  const loadVersions = useCallback(() => rpc<ScaffoldVersion[]>("listScaffoldVersions", [20]), [rpc]);
  const { resource: lineage, reload } = useAsyncResource(loadVersions);
  const versions = lastValue(lineage) ?? [];

  const select = useCallback((version: number) => {
    setSelected(version); setPreviewOut(null); setDecideErr(null);
  }, []);

  const decide = useCallback((mode: "promote" | "rollback") => detach(Effect.gen(function* () {
    setBusy(mode);
    setDecideErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => rpc("applyScaffoldDecision", [mode]));
      reload();
      setDecisions((made) => made + 1);
    }), (failed) => Effect.sync(() => {
      const e = Cause.squash(failed); setDecideErr(`${mode} failed: ${renderThrownChain({ cause: e })}`); })), Effect.sync(() => { setBusy(null); }));
  })), [rpc, reload]);

  const runPreview = useCallback(() => detach(Effect.gen(function* () {
    if (selected == null || !previewTask.trim()) return;
    setBusy("preview"); setPreviewOut(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const r = yield* Effect.promise(async () => rpc<{ ok?: boolean; error?: string; events?: Array<{ type: string; text?: string }> }>("previewScaffoldLive", [selected, previewTask.trim()]));
      const text = (r.events ?? []).filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
      setPreviewOut(r.error ? `Error: ${r.error}` : (text || "(no text output)"));
    }), showing((chain) => {
      setPreviewOut(`Error: ${chain}`);
    })), Effect.sync(() => { setBusy(null); }));
  })), [rpc, selected, previewTask]);

  const selectedV = versions.find((v) => v.version === selected);
  const isPending = selectedV?.status === "pending";
  let notice: ReactNode = null;

  if (lineage.status === "error" && versions.length === 0) {
    notice = <LoadFailure what="the scaffold lineage" message={lineage.message} onRetry={reload} />;
  } else if (lineage.status === "loading") {
    notice = <div className="flex justify-center py-4"><Loader size="sm" /></div>;
  } else if (versions.length === 0) {
    notice = <p className="text-xs p-text-3">Only the bootstrap scaffold (v0) so far.</p>;
  }

  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="p-eyebrow">Versions</span>
        <Badge variant="secondary">live v{currentVersion}</Badge>
      </div>
      {notice ?? (
        <div className="space-y-2">
          <div className="space-y-1">
            {versions.map((v) => (
              <button key={v.version} onClick={() => select(v.version)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${selected === v.version ? "p-fill" : "p-card-hover"}`}>
                <span className="font-mono text-xs p-text shrink-0">v{v.version}</span>
                <span className={`p-t-status px-1.5 py-0.5 rounded-full shrink-0 ${statusTone(v.status)}`}>{v.status}</span>
                <span className="p-row-text p-text-2 truncate flex-1" title={v.rationale}>{v.rationale}</span>
                <span className="p-meta p-text-3 shrink-0">{new Date(v.written_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>

          {selected != null && (
            <div className="space-y-3 pt-1">
              <ScaffoldVersionDiff rpc={rpc} version={selected} readAgain={decisions} />

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

              {isPending && (
                <div className="flex items-center gap-2">
                  <FilledButton disabled={busy !== null} onClick={() => decide("promote")}>
                    {busy === "promote" ? <Loader size="sm" /> : <CheckCircleIcon size={13} />}
                    Promote v{selected}
                  </FilledButton>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => decide("rollback")}
                    icon={busy === "rollback" ? <Loader size="sm" /> : <ArrowUUpLeftIcon size={13} />}>
                    Roll back
                  </Button>
                </div>
              )}
              {decideErr && <div className="p-t-status p-danger">{decideErr}</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
