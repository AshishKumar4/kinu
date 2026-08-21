/**
 * Releases — the decision surface over the release lane.
 *
 * The agent drives the lane end to end through `release.*`: it binds sources,
 * opens changes, writes the patch, applies and checks it in its sandbox,
 * exposes the preview, requests approval, deploys. What only the owner can do
 * is DECIDE — `decideReleaseApproval` is deliberately absent from the agent's
 * tool surface, so the approve/reject controls here are that decision's one
 * home. Everything else on this surface is the evidence a decision needs:
 * the diff, the checks with their real output, the exact command an approval
 * lets run, the preview, the deploy history.
 *
 * There are no forms. The manual source-binding and change-creation forms
 * duplicated `release.bind_source` / `release.create` — work the agent
 * already does when asked in chat — and led the surface with data entry
 * instead of decisions.
 *
 * The substrate banner is the other honesty rule: the engine runs in the
 * sandbox container, and when that is unavailable this surface says so up
 * front instead of presenting a pipeline that cannot run.
 */
import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon, CheckIcon, GitBranchIcon, GitDiffIcon,
  ShieldCheckIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import type {
  ReleaseApproval,
  ReleaseBoard,
  ReleaseCheck,
  ReleaseChange,
  ReleaseStatus,
  ReleaseDeployment,
  ReleaseSource,
  Rpc,
} from "@/lib/protocol";
import { deployTargetAsCommand } from "@kinu.run/core";
import { isPreviewUrl } from "@/lib/preview-origin";
import { releaseSubstrate, type ExecutorInfo } from "@/lib/executors";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState } from "./shared";
import { renderThrownChain } from "@kinu.run/core/obs";

/**
 * How many changes the board carries.
 *
 * A DELIBERATE cap, not a paging window. The release lane is a decision queue:
 * what matters is every change still waiting on the owner, and a change that
 * has deployed or been rejected is closed. Thirty is far past the depth at
 * which the lane needs draining, and an unbounded lane would put settled
 * history in front of the one decision this surface exists to take.
 */
const RELEASE_BOARD_LIMIT = 30;

const STATUS_META = {
  draft: { label: "Draft", tone: "p-card p-text-2" },
  planning: { label: "Planning", tone: "p-badge-info" },
  patching: { label: "Patching", tone: "p-badge-danger" },
  validating: { label: "Validating", tone: "p-badge-warning" },
  preview_ready: { label: "Preview ready", tone: "p-badge-success" },
  awaiting_approval: { label: "Awaiting approval", tone: "p-accent-subtle p-accent" },
  applying: { label: "Applying", tone: "p-badge-info" },
  deployed: { label: "Deployed", tone: "p-badge-success" },
  rejected: { label: "Rejected", tone: "p-badge-danger" },
  rolled_back: { label: "Rolled back", tone: "p-badge-warning" },
  failed: { label: "Failed", tone: "p-badge-danger" },
} satisfies Record<ReleaseStatus, { label: string; tone: string }>;

const CHECK_TONE = {
  pending: "p-card p-text-3",
  running: "p-badge-warning",
  passed: "p-badge-success",
  failed: "p-badge-danger",
  skipped: "p-card p-text-3",
} satisfies Record<ReleaseCheck["status"], string>;

function timeShort(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sourceLabel(binding: ReleaseSource | undefined): string {
  if (!binding) return "Unknown source";
  return binding.kind === "github"
    ? `${binding.label} · ${binding.repoUrl ?? "GitHub"}`
    : `${binding.label} · ${binding.localRoot ?? "local"}`;
}

function statusBadge(status: ReleaseStatus) {
  const meta = STATUS_META[status];
  return <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${meta.tone}`}>{meta.label}</span>;
}

function SectionTitle({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="p-text-2">{icon}</span>
      <span className="text-sm font-medium p-text">{title}</span>
      {count !== undefined && <Badge variant="secondary">{count}</Badge>}
    </div>
  );
}

/** The substrate's honest word, before any change is selected: a pipeline
 *  whose engine cannot run must say so here rather than render as if it
 *  could. Ready-with-note is the milder case (previews off). */
function SubstrateNotice({ executors }: { executors: ExecutorInfo[] }) {
  const substrate = releaseSubstrate(executors);
  if (substrate.state === "unknown") return null;
  if (substrate.state === "unavailable") {
    return (
      <div className="p-card p-3 flex items-start gap-2.5">
        <WarningIcon size={15} className="p-danger shrink-0 mt-0.5" />
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium p-text">The release pipeline cannot run here</div>
          <div className="text-[11px] p-text-3 leading-relaxed">{substrate.reason}</div>
          <div className="text-[11px] p-text-3 leading-relaxed">
            The agent can still draft changes and you can still decide approvals; apply, checks, previews and
            deploys will fail until the sandbox is configured.
          </div>
        </div>
      </div>
    );
  }
  if (substrate.note === null) return null;
  return (
    <div className="text-[11px] p-text-3 rounded-lg border p-border px-3 py-2 leading-relaxed">
      {substrate.note}
    </div>
  );
}

function ChangeList({
  changes, selectedId, onSelect, bindings,
}: { changes: ReleaseChange[]; selectedId: string | null; onSelect: (id: string) => void; bindings: Map<string, ReleaseSource> }) {
  return (
    <div className="space-y-2">
      {changes.map((change) => (
        <button key={change.id} onClick={() => onSelect(change.id)}
          className={`w-full text-left rounded-lg p-3 transition-colors border ${selectedId === change.id ? "p-fill p-border" : "border-transparent p-card-hover"}`}>
          <div className="flex items-start gap-2">
            <GitDiffIcon size={15} className="p-accent mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium p-text truncate">{change.userPrompt}</span>
                {statusBadge(change.status)}
              </div>
              <div className="text-[10px] p-text-3 truncate mt-1">{sourceLabel(bindings.get(change.bindingId))}</div>
              <div className="text-[10px] p-text-3 mt-0.5">{timeShort(change.updatedAt)}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

/** The sources the agent has bound (`release.bind_source`), read-only. Shown
 *  because the deploy target is the command an approval authorizes — worth a
 *  glance before the pipeline asks for one. */
function SourceList({ bindings }: { bindings: ReleaseSource[] }) {
  return (
    <section>
      <SectionTitle icon={<GitBranchIcon size={14} />} title="Sources" count={bindings.length} />
      <div className="space-y-1.5">
        {bindings.map((binding) => (
          <div key={binding.id} className="rounded-md border p-border px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium p-text truncate">{binding.label}</span>
              <span className="rounded-sm px-1.5 py-0.5 text-[10px] p-card p-text-3">{binding.kind}</span>
            </div>
            <div className="text-[10px] p-text-3 truncate mt-0.5">{binding.repoUrl ?? binding.localRoot}</div>
            {binding.deployTarget && (
              <div className="text-[10px] p-text-3 truncate mt-0.5">
                deploys via <span className="font-mono p-text-2">{binding.deployTarget}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ApprovalRow({ approval, binding, rpc, onRefresh }: {
  approval: ReleaseApproval; binding: ReleaseSource | undefined; rpc: Rpc; onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setErr(null);
    try { await rpc("decideReleaseApproval", [approval.id, decision]); onRefresh(); }
    catch (e) { setErr(renderThrownChain({ cause: e })); }
    finally { setBusy(null); }
  };

  // The digest an approval signs binds {approvalType, patch, command}, and the
  // command is the binding's own deployTarget — agent-supplied, and until now
  // displayed nowhere. Approving a shell string you were never shown is not an
  // approval, however well the digest pins it afterwards.
  const command = deployTargetAsCommand(binding?.deployTarget ?? null);

  return (
    <div className="py-2 border-b p-border last:border-0 space-y-1.5">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon size={14} className="p-text-2 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text">{approval.approvalType.replace(/_/g, " ")}</div>
          <div className="text-[10px] p-text-3">{approval.decision} · {timeShort(approval.decidedAt ?? approval.createdAt)}</div>
        </div>
        {approval.decision === "pending" && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => decide("approved")} icon={busy === "approved" ? <Loader size="sm" /> : <CheckIcon size={12} />}>Approve</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => decide("rejected")} icon={busy === "rejected" ? <Loader size="sm" /> : <XIcon size={12} />}>Reject</Button>
          </div>
        )}
      </div>
      {approval.decision === "pending" && (
        <div className="p-recessed rounded-md px-2 py-1.5">
          <div className="p-eyebrow p-text-3 mb-0.5">Runs on approval</div>
          {command
            ? <code className="text-[11px] font-mono p-text break-all">{command}</code>
            : (
              <span className="text-[11px] p-text-3">
                Nothing. This approval promotes the reviewed patch; the source declares
                {" "}<span className="font-mono">{binding?.deployTarget || "no deploy target"}</span>, which is an
                environment label rather than a command.
              </span>
            )}
        </div>
      )}
      {err && <div className="text-[11px] p-danger">{err}</div>}
    </div>
  );
}

function CheckRow({ check }: { check: ReleaseCheck }) {
  return (
    <div className="py-2 border-b p-border last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-xs p-text font-mono truncate">{check.name}</span>
        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${CHECK_TONE[check.status]}`}>{check.status}</span>
        {check.durationMs != null && <span className="ml-auto text-[10px] p-text-3">{check.durationMs}ms</span>}
      </div>
      {(check.stdout || check.stderr) && (
        <pre className="mt-1 text-[10px] p-text-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
          {[check.stdout, check.stderr].filter(Boolean).join("\n")}
        </pre>
      )}
    </div>
  );
}

function DeploymentRow({ deployment }: { deployment: ReleaseDeployment }) {
  return (
    <div className="py-2 border-b p-border last:border-0">
      <div className="flex items-center gap-2">
        <GitBranchIcon size={13} className="p-text-2" />
        <span className="text-xs p-text capitalize">{deployment.environment}</span>
        <span className="ml-auto text-[10px] p-text-3">{timeShort(deployment.deployedAt)}</span>
      </div>
      <div className="text-[10px] p-text-3 font-mono mt-1 space-y-0.5">
        {deployment.workerVersionId && <div className="truncate">version {deployment.workerVersionId}</div>}
        {deployment.deploymentId && <div className="truncate">deployment {deployment.deploymentId}</div>}
        {deployment.rollbackTarget && <div className="truncate">rollback target {deployment.rollbackTarget}</div>}
      </div>
    </div>
  );
}

function ChangeDetail({
  change, binding, checks, approvals, deployments, rpc, onRefresh,
}: {
  change: ReleaseChange | null;
  binding: ReleaseSource | undefined;
  checks: ReleaseCheck[];
  approvals: ReleaseApproval[];
  deployments: ReleaseDeployment[];
  rpc: Rpc;
  onRefresh: () => void;
}) {
  if (!change) return <EmptyState icon={<GitDiffIcon size={28} />} title="Select a change" />;

  // The one thing on this surface only the owner can do comes first; the
  // decided history reads below with the rest of the record. A section with
  // nothing in it does not render — the record grows as the pipeline earns it.
  const pending = approvals.filter((a) => a.decision === "pending");
  const decided = approvals.filter((a) => a.decision !== "pending");

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-lg flex items-center justify-center p-fill border p-border shrink-0">
            <GitDiffIcon size={18} className="p-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium p-text">{change.userPrompt}</span>
              {statusBadge(change.status)}
            </div>
            <div className="text-[11px] p-text-3 mt-1">{sourceLabel(binding)}</div>
          </div>
        </div>
      </section>

      {pending.length > 0 && (
        <section className="rounded-lg border p-border p-3">
          <SectionTitle icon={<ShieldCheckIcon size={14} className="p-accent" />} title="Needs you" count={pending.length} />
          {pending.map((approval) => (
            <ApprovalRow key={approval.id} approval={approval} binding={binding} rpc={rpc} onRefresh={onRefresh} />
          ))}
        </section>
      )}

      {change.previewUrl && (
        <section>
          <div className="text-[11px] p-text-3 mb-1">Preview</div>
          {/* The URL comes from an agent-written change record, so it is a link
              only when it really is a preview route. */}
          {isPreviewUrl(change.previewUrl)
            ? <a href={change.previewUrl} target="_blank" rel="noopener noreferrer" className="text-xs p-accent hover:underline break-all">{change.previewUrl}</a>
            : <span className="text-xs p-text-3 break-all">{change.previewUrl}</span>}
        </section>
      )}

      <section className="space-y-3">
        {change.plan && (
          <div>
            <div className="text-[11px] p-text-3 mb-1">Plan</div>
            <p className="text-xs p-text-2 whitespace-pre-wrap leading-relaxed">{change.plan}</p>
          </div>
        )}
        {change.summary && (
          <div>
            <div className="text-[11px] p-text-3 mb-1">Summary</div>
            <p className="text-xs p-text-2 whitespace-pre-wrap leading-relaxed">{change.summary}</p>
          </div>
        )}
        {change.patch && (
          <div>
            <div className="text-[11px] p-text-3 mb-1">Patch</div>
            <pre className="rounded-lg border p-border p-fill p-3 max-h-[360px] overflow-auto text-[10px] font-mono leading-relaxed whitespace-pre-wrap">
              {change.patch}
            </pre>
          </div>
        )}
      </section>

      {checks.length > 0 && (
        <section>
          <SectionTitle icon={<WarningIcon size={14} />} title="Checks" count={checks.length} />
          {checks.map((check) => <CheckRow key={check.id} check={check} />)}
        </section>
      )}

      {decided.length > 0 && (
        <section>
          <SectionTitle icon={<ShieldCheckIcon size={14} />} title="Approvals" count={decided.length} />
          {decided.map((approval) => (
            <ApprovalRow key={approval.id} approval={approval} binding={binding} rpc={rpc} onRefresh={onRefresh} />
          ))}
        </section>
      )}

      {deployments.length > 0 && (
        <section>
          <SectionTitle icon={<GitBranchIcon size={14} />} title="Deployments" count={deployments.length} />
          {deployments.map((deployment) => (
            <DeploymentRow key={deployment.id} deployment={deployment} />
          ))}
        </section>
      )}
    </div>
  );
}

export function ReleasesSurface({ rpc, executors }: { rpc: Rpc; executors: ExecutorInfo[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => rpc<ReleaseBoard>("getReleaseBoard", [RELEASE_BOARD_LIMIT]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const board = lastValue(resource);

  const bindings = board?.bindings ?? [];
  const changes = board?.changes ?? [];
  const bindingMap = useMemo(() => new Map((board?.bindings ?? []).map((b) => [b.id, b])), [board?.bindings]);
  // Derived, never written by the loader: a refresh that no longer carries the
  // selected change falls back to the newest one, without a second state write
  // racing the fetch that caused it.
  const selected = changes.find((c) => c.id === selectedId) ?? changes[0] ?? null;
  const checks = (board?.checks ?? []).filter((c) => c.changeId === selected?.id);
  const approvals = (board?.approvals ?? []).filter((a) => a.changeId === selected?.id);
  const deployments = (board?.deployments ?? []).filter((d) => d.changeId === selected?.id);

  // Nothing has loaded yet, and "the read broke" is not "the lane is empty".
  // Rendering the empty state for a failed read is how intact data gets
  // reported as absent, so the two answers never share a branch.
  if (board === null) {
    return resource.status === "error"
      ? <LoadFailure what="the release lane" message={resource.message} onRetry={reload} className="p-card p-3" />
      : <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <GitDiffIcon size={15} className="p-text-2" />
        <span className="text-sm font-medium p-text">Releases</span>
        <Badge variant="secondary">{changes.length}</Badge>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={reload} icon={<ArrowClockwiseIcon size={12} />}>Refresh</Button>
      </div>

      {/* A refresh that failed over a board already on screen. Without this the
          view goes stale in silence and reads as current. */}
      {resource.status === "error" && (
        <LoadFailure what="a fresher release lane" message={resource.message} onRetry={reload} className="p-card p-3" />
      )}

      <SubstrateNotice executors={executors} />

      {changes.length === 0 ? (
        <>
          <EmptyState icon={<GitDiffIcon size={28} />} title="No release changes"
            hint="The agent drives this lane: it binds a source, drafts the change, applies and checks the patch in its sandbox, then brings the approval here. Ask it in chat to ship something." />
          {bindings.length > 0 && <SourceList bindings={bindings} />}
        </>
      ) : (
        // DOM order is the single-column (mobile) order: the selected change's
        // decision content reads before the sources footnote. On xl the
        // detail spans the right column and sources tuck under the list.
        <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.5fr)] xl:grid-rows-[auto_1fr]">
          <section className="xl:col-start-1 xl:row-start-1">
            <SectionTitle icon={<GitDiffIcon size={14} />} title="Changes" count={changes.length} />
            <ChangeList changes={changes} selectedId={selected?.id ?? null} onSelect={setSelectedId} bindings={bindingMap} />
          </section>
          <section className="min-w-0 xl:col-start-2 xl:row-start-1 xl:row-span-2">
            <ChangeDetail
              change={selected}
              binding={selected ? bindingMap.get(selected.bindingId) : undefined}
              checks={checks}
              approvals={approvals}
              deployments={deployments}
              rpc={rpc}
              onRefresh={reload}
            />
          </section>
          {bindings.length > 0 && (
            <div className="xl:col-start-1 xl:row-start-2 self-start">
              <SourceList bindings={bindings} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
