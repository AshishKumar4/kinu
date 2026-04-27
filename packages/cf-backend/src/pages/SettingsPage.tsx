import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { Button, Loader, Badge } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, TreeStructureIcon, CheckIcon,
  ArrowLeftIcon, PencilSimpleIcon, WarningIcon, TrashIcon,
  EraserIcon, GitBranchIcon,
} from "@phosphor-icons/react";
import { useProteus } from "@/hooks/use-proteus";

function Card({ title, icon: Icon, children, variant }: {
  title: string; icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode; variant?: "danger";
}) {
  return (
    <div className={`p-card rounded-xl p-5 animate-fade-in ${variant === "danger" ? "!border-red-500/20" : ""}`}>
      <div className="flex items-center gap-2 mb-4">
        <Icon size={16} className={variant === "danger" ? "text-red-400" : "p-accent"} />
        <span className="text-sm font-semibold p-text">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs p-text-2 block font-medium">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full rounded-lg px-3 py-2 text-sm p-text focus:outline-none transition-all" +
  " border border-[var(--c-input-border)] bg-[var(--c-surface)]" +
  " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]" +
  " placeholder:p-text-3";

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  const [modelName, setModelName] = useState("@cf/moonshotai/kimi-k2.6");
  const [displayName, setDisplayName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [mctsC, setMctsC] = useState(1.414);
  const [mctsIter, setMctsIter] = useState(50);
  const [mctsDepth, setMctsDepth] = useState(5);
  const [mctsBranches, setMctsBranches] = useState(3);

  useEffect(() => {
    if (state.agentStatus) {
      setModelName(state.agentStatus.model || "@cf/moonshotai/kimi-k2.6");
      setDisplayName(state.agentStatus.displayName || state.agentStatus.name || "");
      setPurpose(state.agentStatus.purpose || "");
    }
  }, [state.agentStatus]);

  // Load MCTS config
  useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    state.rpc("getMctsConfig", []).then((cfg: unknown) => {
      const c = cfg as { explorationConstant: number; maxIterations: number; maxDepth: number; branchBudget: number };
      setMctsC(c.explorationConstant);
      setMctsIter(c.maxIterations);
      setMctsDepth(c.maxDepth);
      setMctsBranches(c.branchBudget);
    }).catch(() => {});
  }, [state.connectionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await Promise.all([
        state.setModel(modelName),
        state.rpc("setDisplayName", [displayName]),
        state.rpc("setSoul", [purpose]),
        state.rpc("setMctsConfig", [{ explorationConstant: mctsC, maxIterations: mctsIter, maxDepth: mctsDepth, branchBudget: mctsBranches }]),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [state, modelName, displayName, purpose, mctsC, mctsIter, mctsDepth, mctsBranches]);

  const handleDangerAction = useCallback(async (action: string) => {
    setConfirmAction(null);
    try {
      if (action === "clearMemory") await state.rpc("clearMemory", []);
      if (action === "resetMcts") await state.rpc("resetMctsTree", []);
    } catch (err) {
      console.error("Action failed:", err);
    }
  }, [state]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to={`/agent/${agentId}`}>
            <Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold tracking-tight p-text">Settings</h1>
            <p className="text-xs p-text-3 font-mono">{agentId}</p>
          </div>
        </div>

        {/* Identity */}
        <Card title="Agent Identity" icon={PencilSimpleIcon}>
          <div className="space-y-4">
            <Field label="Display Name">
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="My Agent" className={inputCls} />
            </Field>
            <Field label="Purpose / Soul">
              <textarea value={purpose} onChange={e => setPurpose(e.target.value)} rows={3} placeholder="What is this agent's purpose?"
                className={`${inputCls} resize-none`} />
            </Field>
          </div>
        </Card>

        {/* Model */}
        <Card title="Model" icon={BrainIcon}>
          <Field label="Language Model">
            <select value={modelName} onChange={e => setModelName(e.target.value)} className={inputCls}>
              <option value="@cf/moonshotai/kimi-k2.6">Kimi K2.6 (reasoning)</option>
              <option value="@cf/meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout (fast)</option>
              <option value="@cf/meta/llama-4-maverick-17b-128e-instruct">Llama 4 Maverick</option>
              <option value="@cf/qwen/qwen2.5-coder-32b-instruct">Qwen 2.5 Coder 32B</option>
            </select>
          </Field>
        </Card>

        {/* Agent Info */}
        <Card title="Agent Info" icon={TreeStructureIcon}>
          <div className="space-y-0 text-sm">
            {state.agentStatus ? (
              [["Name", state.agentStatus.name], ["Scaffold", `v${state.agentStatus.scaffoldVersion}`], ["MCTS Nodes", state.agentStatus.searchNodeCount], ["Crafted Tools", state.agentStatus.craftedToolCount], ["Messages", state.agentStatus.messageCount]].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between py-2 border-b p-border last:border-0">
                  <span className="p-text-2">{String(l)}</span>
                  <span className="p-text font-medium">{String(v)}</span>
                </div>
              ))
            ) : <div className="flex justify-center py-4"><Loader size="sm" /></div>}
          </div>
        </Card>

        {/* MCTS Parameters */}
        <Card title="MCTS Exploration" icon={TreeStructureIcon}>
          <div className="space-y-4">
            <Field label={`Exploration constant (C) — ${mctsC.toFixed(3)}`}>
              <input type="range" min="0.1" max="3" step="0.01" value={mctsC} onChange={e => setMctsC(parseFloat(e.target.value))}
                className="w-full accent-[var(--c-accent)]" />
              <div className="flex justify-between text-[10px] p-text-3 mt-0.5"><span>0.1 (exploit)</span><span>3.0 (explore)</span></div>
            </Field>
            <Field label="Max iterations">
              <input type="number" min={1} max={500} value={mctsIter} onChange={e => setMctsIter(parseInt(e.target.value) || 50)} className={inputCls} />
            </Field>
            <Field label="Max depth">
              <input type="number" min={1} max={20} value={mctsDepth} onChange={e => setMctsDepth(parseInt(e.target.value) || 5)} className={inputCls} />
            </Field>
            <Field label="Branch budget">
              <input type="number" min={1} max={10} value={mctsBranches} onChange={e => setMctsBranches(parseInt(e.target.value) || 3)} className={inputCls} />
            </Field>
          </div>
        </Card>

        {/* Save */}
        <button onClick={handleSave} disabled={saving || state.connectionStatus !== "connected"}
          className="p-btn rounded-lg px-5 py-2.5 text-sm font-medium flex items-center gap-2 cursor-pointer">
          {saving ? <Loader size="sm" /> : saved ? <CheckIcon size={16} /> : <FloppyDiskIcon size={16} />}
          {saving ? "Saving..." : saved ? "Saved" : "Save All Changes"}
        </button>

        {/* Danger Zone */}
        <Card title="Danger Zone" icon={WarningIcon} variant="danger">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm p-text block">Clear Memory</span>
                <span className="text-xs p-text-3">Delete all memory files and FTS index</span>
              </div>
              {confirmAction === "clearMemory" ? (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
                  <button onClick={() => handleDangerAction("clearMemory")} className="rounded-lg px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors cursor-pointer">Confirm</button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmAction("clearMemory")} icon={<EraserIcon size={12} />}>Clear</Button>
              )}
            </div>
            <div className="border-t p-border" />
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm p-text block">Reset MCTS Tree</span>
                <span className="text-xs p-text-3">Delete all exploration nodes</span>
              </div>
              {confirmAction === "resetMcts" ? (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
                  <button onClick={() => handleDangerAction("resetMcts")} className="rounded-lg px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors cursor-pointer">Confirm</button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmAction("resetMcts")} icon={<GitBranchIcon size={12} />}>Reset</Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
