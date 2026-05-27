/**
 * Per-agent settings page. Credentials + defaults live in /user/settings;
 * this page covers concerns scoped to ONE agent: identity, model choice,
 * MCTS knobs, scaffold/shadow status, shell-approval mode.
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, GearSixIcon, CheckIcon, ArrowLeftIcon,
  ShieldIcon, TreeStructureIcon, GitBranchIcon, KeyIcon,
} from "@phosphor-icons/react";
import { useProteus } from "@/hooks/use-proteus";
import { listAvailableModels, type ModelMenuEntry } from "../lib/user-api";

const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

function Card({ title, icon: Icon, children }: {
  title: string; icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="p-card rounded-xl p-5 space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={16} className="p-accent" />
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}

type ApprovalMode = "strict" | "allow_all" | "deny_all";

interface ShadowStatus {
  hasPending: boolean;
  pending?: {
    version: number; writtenAt: number; rationale: string;
    trialsSoFar: number; pendingWins: number; currentWins: number; ties: number;
  };
  decision?: { decision: "promote" | "rollback" | "continue"; winRate: number };
  versions?: Array<{ version: number; status: string; rationale: string; written_at: number }>;
}

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);

  const [displayName, setDisplayName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [models, setModels] = useState<ModelMenuEntry[]>([]);
  const [currentSpec, setCurrentSpec] = useState<string>("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("strict");
  const [shadow, setShadow] = useState<ShadowStatus | null>(null);
  const [mcts, setMcts] = useState({ explorationConstant: 1.414, maxIterations: 50, maxDepth: 5, branchBudget: 3 });

  useEffect(() => {
    if (state.agentStatus) {
      setDisplayName(state.agentStatus.displayName || state.agentStatus.name || "");
      setPurpose(state.agentStatus.purpose || "");
    }
  }, [state.agentStatus]);

  const load = useCallback(async () => {
    if (state.connectionStatus !== "connected") return;
    setErr(null);
    try {
      const [m, current, mode, sh, mc] = await Promise.all([
        listAvailableModels(),
        state.rpc("getStoredModelSpec", []) as Promise<{ spec: string | null }>,
        state.rpc("getShellApprovalMode", []) as Promise<{ mode: ApprovalMode }>,
        state.rpc("getShadowStatus", []) as Promise<ShadowStatus>,
        state.rpc("getMctsConfig", []) as Promise<typeof mcts>,
      ]);
      setModels(m);
      setCurrentSpec(current.spec ?? "");
      setApprovalMode(mode.mode);
      setShadow(sh);
      setMcts(mc);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [state]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      await Promise.all([
        state.rpc("setDisplayName", [displayName]),
        state.rpc("setSoul", [purpose]),
        currentSpec ? state.setModel(currentSpec) : Promise.resolve(),
        state.rpc("setShellApprovalMode", [approvalMode]),
        state.rpc("setMctsConfig", [mcts]),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [state, displayName, purpose, currentSpec, approvalMode, mcts]);

  if (state.connectionStatus !== "connected") {
    return <div className="h-full flex items-center justify-center"><Loader size="md" /></div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <Link to={`/agent/${agentId}`} className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
              <ArrowLeftIcon size={12} /> Back to chat
            </Link>
            <h1 className="text-2xl font-semibold">Agent settings</h1>
            <p className="text-xs p-text-3 mt-1 flex items-center gap-1.5">
              <span className="font-mono">{agentId}</span>
              <span>·</span>
              <Link to="/user/settings" className="hover:p-text inline-flex items-center gap-1">
                <KeyIcon size={11} /> User settings & credentials
              </Link>
            </p>
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            {saved ? <CheckIcon size={14} /> : <FloppyDiskIcon size={14} />}
            <span>{saving ? "Saving…" : saved ? "Saved" : "Save"}</span>
          </button>
        </header>

        {err && <div className="p-card rounded-lg p-3 text-xs text-red-400">{err}</div>}

        {/* Identity */}
        <Card title="Identity" icon={BrainIcon}>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">Display name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">Mission / purpose</label>
            <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3}
              className={`${inputCls} font-mono`} placeholder="What is this agent for?" />
          </div>
        </Card>

        {/* Model */}
        <Card title="Model" icon={GearSixIcon}>
          {models.length === 0 ? (
            <p className="text-xs p-text-3">
              No models available. <Link to="/user/settings" className="p-accent underline">Connect a provider</Link> in user settings.
            </p>
          ) : (
            <select value={currentSpec} onChange={(e) => setCurrentSpec(e.target.value)} className={inputCls}>
              <option value="">(default)</option>
              {models.map((m) => (
                <option key={m.spec} value={m.spec}>{m.label}</option>
              ))}
            </select>
          )}
          <p className="text-[11px] p-text-3">
            Changes take effect on the next turn. Provider availability is driven by which credentials you've connected.
          </p>
        </Card>

        {/* Approval */}
        <Card title="Shell-command approval" icon={ShieldIcon}>
          <div className="grid grid-cols-3 gap-2">
            {(['strict', 'allow_all', 'deny_all'] as ApprovalMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setApprovalMode(m)}
                className={`p-2 rounded-md text-xs ${approvalMode === m ? 'p-accent-bg p-accent' : 'p-card hover:p-card-hover'}`}
              >{m === 'strict' ? 'Strict (review)' : m === 'allow_all' ? 'Allow all' : 'Deny all'}</button>
            ))}
          </div>
        </Card>

        {/* MCTS knobs */}
        <Card title="MCTS tunables" icon={TreeStructureIcon}>
          <div className="grid grid-cols-2 gap-3">
            <NumField label="Exploration constant" value={mcts.explorationConstant} step={0.1} onChange={(v) => setMcts({ ...mcts, explorationConstant: v })} />
            <NumField label="Max iterations" value={mcts.maxIterations} step={1} onChange={(v) => setMcts({ ...mcts, maxIterations: v })} />
            <NumField label="Max depth" value={mcts.maxDepth} step={1} onChange={(v) => setMcts({ ...mcts, maxDepth: v })} />
            <NumField label="Branch budget" value={mcts.branchBudget} step={1} onChange={(v) => setMcts({ ...mcts, branchBudget: v })} />
          </div>
        </Card>

        {/* Shadow */}
        {shadow && (
          <Card title="Scaffold shadow rollout" icon={GitBranchIcon}>
            {shadow.hasPending ? (
              <div className="text-xs space-y-2">
                <div>Pending v{shadow.pending?.version} — {shadow.pending?.trialsSoFar} trials so far</div>
                <div className="text-[11px] p-text-3">{shadow.pending?.rationale}</div>
              </div>
            ) : (
              <p className="text-xs p-text-3">No pending scaffold.</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function NumField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] p-text-2">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputCls}
      />
    </div>
  );
}
