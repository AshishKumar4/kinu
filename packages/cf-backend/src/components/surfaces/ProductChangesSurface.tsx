import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon, CheckIcon, GitBranchIcon, GitDiffIcon, PlusIcon,
  ShieldCheckIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import type {
  ProductChangeApproval,
  ProductChangeBoard,
  ProductChangeCheck,
  ProductChangeRequest,
  ProductChangeStatus,
  ProductDeploymentRecord,
  ProductSourceBinding,
  Rpc,
} from "@/lib/protocol";
import { EmptyState } from "./shared";

const STATUS_META: Record<ProductChangeStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "p-card p-text-2" },
  planning: { label: "Planning", tone: "bg-sky-500/15 text-sky-300" },
  patching: { label: "Patching", tone: "bg-indigo-500/15 text-indigo-300" },
  validating: { label: "Validating", tone: "bg-amber-500/15 text-amber-300" },
  preview_ready: { label: "Preview ready", tone: "bg-emerald-500/15 text-emerald-300" },
  awaiting_approval: { label: "Awaiting approval", tone: "bg-violet-500/15 text-violet-300" },
  applying: { label: "Applying", tone: "bg-cyan-500/15 text-cyan-300" },
  deployed: { label: "Deployed", tone: "bg-green-500/15 text-green-300" },
  rejected: { label: "Rejected", tone: "bg-red-500/15 text-red-300" },
  rolled_back: { label: "Rolled back", tone: "bg-orange-500/15 text-orange-300" },
  failed: { label: "Failed", tone: "bg-red-500/15 text-red-300" },
};

const CHECK_TONE: Record<ProductChangeCheck["status"], string> = {
  pending: "p-card p-text-3",
  running: "bg-amber-500/15 text-amber-300",
  passed: "bg-green-500/15 text-green-300",
  failed: "bg-red-500/15 text-red-300",
  skipped: "p-card p-text-3",
};

function timeShort(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sourceLabel(binding: ProductSourceBinding | undefined): string {
  if (!binding) return "Unknown source";
  return binding.kind === "github"
    ? `${binding.label} · ${binding.repoUrl ?? "GitHub"}`
    : `${binding.label} · ${binding.localRoot ?? "local"}`;
}

function statusBadge(status: ProductChangeStatus) {
  const meta = STATUS_META[status];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.tone}`}>{meta.label}</span>;
}

function SectionTitle({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="p-text-2">{icon}</span>
      <span className="text-sm font-medium p-text">{title}</span>
      {typeof count === "number" && <Badge variant="secondary">{count}</Badge>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] p-text-3">{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border p-border p-elevated px-2.5 py-1.5 text-xs p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 ${props.className ?? ""}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border p-border p-elevated px-2.5 py-1.5 text-xs p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 resize-y ${props.className ?? ""}`}
    />
  );
}

function SourceBindingForm({ rpc, onSaved }: { rpc: Rpc; onSaved: () => void }) {
  const [kind, setKind] = useState<ProductSourceBinding["kind"]>("local");
  const [label, setLabel] = useState("Proteus checkout");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [localRoot, setLocalRoot] = useState("");
  const [deployTarget, setDeployTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = label.trim() && (kind === "github" ? repoUrl.trim() : localRoot.trim());

  const save = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      await rpc("upsertProductSourceBinding", [{
        kind, label,
        repoUrl: kind === "github" ? repoUrl : null,
        defaultBranch: kind === "github" ? defaultBranch : null,
        localRoot: kind === "local" ? localRoot : null,
        deployTarget: deployTarget || null,
      }]);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [defaultBranch, deployTarget, kind, label, localRoot, onSaved, repoUrl, rpc]);

  return (
    <div className="p-card rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-1 p-elevated rounded-md p-0.5 w-fit">
        {(["local", "github"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)}
            className={`px-2.5 py-1 rounded text-[11px] capitalize ${kind === k ? "p-card p-text" : "p-text-3 hover:p-text-2"}`}>
            {k}
          </button>
        ))}
      </div>
      <div className="grid gap-2">
        <Field label="Label"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        {kind === "github" ? (
          <>
            <Field label="Repository URL"><TextInput value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" /></Field>
            <Field label="Default branch"><TextInput value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="Local root"><TextInput value={localRoot} onChange={(e) => setLocalRoot(e.target.value)} placeholder="~/path/to/proteus" /></Field>
        )}
        <Field label="Deploy target"><TextInput value={deployTarget} onChange={(e) => setDeployTarget(e.target.value)} placeholder="production / staging / custom" /></Field>
      </div>
      {err && <div className="text-[11px] text-red-400">{err}</div>}
      <Button size="sm" variant="secondary" disabled={busy || !ready} onClick={save} icon={busy ? <Loader size="sm" /> : <PlusIcon size={12} />}>
        Save source
      </Button>
    </div>
  );
}

function CreateChangeForm({
  bindings, rpc, onCreated,
}: { bindings: ProductSourceBinding[]; rpc: Rpc; onCreated: (id: string) => void }) {
  const [bindingId, setBindingId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!bindingId && bindings[0]) setBindingId(bindings[0].id);
  }, [bindingId, bindings]);

  const create = useCallback(async () => {
    if (!bindingId || !prompt.trim()) return;
    setBusy(true); setErr(null);
    try {
      const change = await rpc<ProductChangeRequest>("createProductChange", [{ bindingId, userPrompt: prompt, plan: plan || null }]);
      setPrompt(""); setPlan("");
      onCreated(change.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [bindingId, onCreated, plan, prompt, rpc]);

  return (
    <div className="p-card rounded-lg p-3 space-y-3">
      <div className="grid gap-2">
        <Field label="Source">
          <select value={bindingId} onChange={(e) => setBindingId(e.target.value)}
            className="w-full rounded-md border p-border p-elevated px-2.5 py-1.5 text-xs p-text focus:outline-none">
            {bindings.map((b) => <option key={b.id} value={b.id}>{sourceLabel(b)}</option>)}
          </select>
        </Field>
        <Field label="Request"><TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} /></Field>
        <Field label="Plan"><TextArea value={plan} onChange={(e) => setPlan(e.target.value)} rows={2} /></Field>
      </div>
      {err && <div className="text-[11px] text-red-400">{err}</div>}
      <Button size="sm" variant="primary" disabled={busy || !bindingId || !prompt.trim()} onClick={create}
        icon={busy ? <Loader size="sm" /> : <PlusIcon size={12} />}>
        Create change
      </Button>
    </div>
  );
}

function ChangeList({
  changes, selectedId, onSelect, bindings,
}: { changes: ProductChangeRequest[]; selectedId: string | null; onSelect: (id: string) => void; bindings: Map<string, ProductSourceBinding> }) {
  if (changes.length === 0) {
    return <EmptyState icon={<GitDiffIcon size={28} />} title="No product changes" />;
  }
  return (
    <div className="space-y-2">
      {changes.map((change) => (
        <button key={change.id} onClick={() => onSelect(change.id)}
          className={`w-full text-left rounded-lg p-3 transition-colors border ${selectedId === change.id ? "p-elevated p-border" : "border-transparent hover:p-card"}`}>
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

function ApprovalRow({ approval, rpc, onRefresh }: { approval: ProductChangeApproval; rpc: Rpc; onRefresh: () => void }) {
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    try { await rpc("decideProductChangeApproval", [approval.id, decision]); onRefresh(); }
    finally { setBusy(null); }
  };

  return (
    <div className="flex items-center gap-2 py-2 border-b p-border last:border-0">
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
  );
}

function CheckRow({ check }: { check: ProductChangeCheck }) {
  return (
    <div className="py-2 border-b p-border last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-xs p-text font-mono truncate">{check.name}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${CHECK_TONE[check.status]}`}>{check.status}</span>
        {check.durationMs != null && <span className="ml-auto text-[10px] p-text-3">{check.durationMs}ms</span>}
      </div>
      {(check.stdout || check.stderr) && (
        <pre className="mt-1 text-[10px] p-text-3 whitespace-pre-wrap break-words line-clamp-4 font-mono">
          {[check.stdout, check.stderr].filter(Boolean).join("\n")}
        </pre>
      )}
    </div>
  );
}

function DeploymentRow({ deployment }: { deployment: ProductDeploymentRecord }) {
  return (
    <div className="py-2 border-b p-border last:border-0">
      <div className="flex items-center gap-2">
        <GitBranchIcon size={13} className="p-text-2" />
        <span className="text-xs p-text capitalize">{deployment.environment}</span>
        <span className="ml-auto text-[10px] p-text-3">{timeShort(deployment.deployedAt)}</span>
      </div>
      {(deployment.deploymentId || deployment.workerVersionId || deployment.rollbackTarget) && (
        <div className="text-[10px] p-text-3 font-mono truncate mt-1">
          {deployment.deploymentId ?? deployment.workerVersionId ?? deployment.rollbackTarget}
        </div>
      )}
    </div>
  );
}

function ChangeDetail({
  change, binding, checks, approvals, deployments, rpc, onRefresh,
}: {
  change: ProductChangeRequest | null;
  binding: ProductSourceBinding | undefined;
  checks: ProductChangeCheck[];
  approvals: ProductChangeApproval[];
  deployments: ProductDeploymentRecord[];
  rpc: Rpc;
  onRefresh: () => void;
}) {
  const [busyApproval, setBusyApproval] = useState(false);
  if (!change) return <EmptyState icon={<GitDiffIcon size={28} />} title="Select a change" />;

  const pendingApproval = approvals.some((a) => a.decision === "pending");
  const requestApproval = async () => {
    setBusyApproval(true);
    try { await rpc("requestProductChangeApproval", [change.id, "apply"]); onRefresh(); }
    finally { setBusyApproval(false); }
  };

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-lg flex items-center justify-center p-elevated border p-border shrink-0">
            <GitDiffIcon size={18} className="p-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium p-text">{change.userPrompt}</span>
              {statusBadge(change.status)}
            </div>
            <div className="text-[11px] p-text-3 mt-1">{sourceLabel(binding)}</div>
          </div>
          {(change.status === "preview_ready" || change.status === "awaiting_approval") && !pendingApproval && (
            <Button size="sm" variant="secondary" disabled={busyApproval} onClick={requestApproval}
              icon={busyApproval ? <Loader size="sm" /> : <ShieldCheckIcon size={12} />}>
              Request approval
            </Button>
          )}
        </div>
      </section>

      {change.previewUrl && (
        <section>
          <a href={change.previewUrl} target="_blank" rel="noreferrer" className="text-xs p-accent hover:underline break-all">{change.previewUrl}</a>
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
            <pre className="rounded-lg border p-border p-elevated p-3 max-h-[360px] overflow-auto text-[10px] font-mono leading-relaxed whitespace-pre-wrap">
              {change.patch}
            </pre>
          </div>
        )}
      </section>

      <section>
        <SectionTitle icon={<ShieldCheckIcon size={14} />} title="Approvals" count={approvals.length} />
        {approvals.length === 0 ? <div className="text-xs p-text-3">None</div> : approvals.map((approval) => (
          <ApprovalRow key={approval.id} approval={approval} rpc={rpc} onRefresh={onRefresh} />
        ))}
      </section>

      <section>
        <SectionTitle icon={<WarningIcon size={14} />} title="Checks" count={checks.length} />
        {checks.length === 0 ? <div className="text-xs p-text-3">None</div> : checks.map((check) => <CheckRow key={check.id} check={check} />)}
      </section>

      <section>
        <SectionTitle icon={<GitBranchIcon size={14} />} title="Deployments" count={deployments.length} />
        {deployments.length === 0 ? <div className="text-xs p-text-3">None</div> : deployments.map((deployment) => (
          <DeploymentRow key={deployment.id} deployment={deployment} />
        ))}
      </section>
    </div>
  );
}

export function ProductChangesSurface({ rpc }: { rpc: Rpc }) {
  const [board, setBoard] = useState<ProductChangeBoard | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const next = await rpc<ProductChangeBoard>("getProductChangeBoard", [30]);
      setBoard(next);
      setSelectedId((current) => current && next.changes.some((c) => c.id === current) ? current : next.changes[0]?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => { void load(); }, [load]);

  const bindingMap = useMemo(() => new Map((board?.bindings ?? []).map((b) => [b.id, b])), [board?.bindings]);
  const selected = board?.changes.find((c) => c.id === selectedId) ?? null;
  const checks = (board?.checks ?? []).filter((c) => c.changeId === selectedId);
  const approvals = (board?.approvals ?? []).filter((a) => a.changeId === selectedId);
  const deployments = (board?.deployments ?? []).filter((d) => d.changeId === selectedId);

  if (loading) return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <GitDiffIcon size={15} className="p-text-2" />
        <span className="text-sm font-medium p-text">Product Changes</span>
        {board && <Badge variant="secondary">{board.changes.length}</Badge>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={load} icon={<ArrowClockwiseIcon size={12} />}>Refresh</Button>
      </div>

      {err && <div className="text-xs text-red-400 p-card rounded-lg p-3">{err}</div>}

      <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-5">
          <section>
            <SectionTitle icon={<GitBranchIcon size={14} />} title="Sources" count={board?.bindings.length ?? 0} />
            <SourceBindingForm rpc={rpc} onSaved={load} />
            {(board?.bindings.length ?? 0) > 0 && (
              <div className="mt-2 space-y-1.5">
                {board!.bindings.map((binding) => (
                  <div key={binding.id} className="rounded-md border p-border px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium p-text truncate">{binding.label}</span>
                      <span className="rounded px-1.5 py-0.5 text-[10px] p-card p-text-3">{binding.kind}</span>
                    </div>
                    <div className="text-[10px] p-text-3 truncate mt-0.5">{binding.repoUrl ?? binding.localRoot}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle icon={<PlusIcon size={14} />} title="New Change" />
            {(board?.bindings.length ?? 0) === 0 ? (
              <div className="text-xs p-text-3 rounded-lg border p-border p-3">No source saved</div>
            ) : (
              <CreateChangeForm bindings={board!.bindings} rpc={rpc} onCreated={(id) => { setSelectedId(id); void load(); }} />
            )}
          </section>
        </div>

        <div className="grid gap-5 min-[1400px]:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.4fr)]">
          <section>
            <SectionTitle icon={<GitDiffIcon size={14} />} title="Requests" count={board?.changes.length ?? 0} />
            <ChangeList changes={board?.changes ?? []} selectedId={selectedId} onSelect={setSelectedId} bindings={bindingMap} />
          </section>
          <section className="min-w-0">
            <ChangeDetail
              change={selected}
              binding={selected ? bindingMap.get(selected.bindingId) : undefined}
              checks={checks}
              approvals={approvals}
              deployments={deployments}
              rpc={rpc}
              onRefresh={load}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
