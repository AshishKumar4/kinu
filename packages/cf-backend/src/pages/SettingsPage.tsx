/**
 * Per-agent settings page. Credentials + defaults live in /user/settings;
 * this page covers concerns scoped to ONE agent: identity, model choice,
 * MCTS knobs, shell-approval mode, GEPA optimisation, pinned skills.
 * (Scaffold promote/rollback + the per-trial verdict live on the Brain surface.)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, GearSixIcon, CheckIcon, ArrowLeftIcon,
  ShieldIcon, TreeStructureIcon, KeyIcon, PlugIcon, SparkleIcon, CopyIcon,
} from "@phosphor-icons/react";
import { useProteus } from "@/hooks/use-proteus";
import { listAvailableModels, type ModelMenuEntry } from "../lib/user-api";
import { ModelPicker } from "@/components/ModelPicker";

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

const DEFAULT_MCTS = { explorationConstant: 1.414, maxIterations: 50, maxDepth: 5, branchBudget: 3 };

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  // Stable pieces only — `state` itself is a fresh object every render, so
  // depending on it from load/save creates a self-sustaining refetch loop
  // that clobbers in-progress edits.
  const { rpc, connectionStatus, agentStatus, setModel } = state;

  const [displayName, setDisplayName] = useState("");
  const [displayNameDirty, setDisplayNameDirty] = useState(false);
  const [soul, setSoul] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [slugCopied, setSlugCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [models, setModels] = useState<ModelMenuEntry[]>([]);
  const [currentSpec, setCurrentSpec] = useState<string>("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("strict");
  const [mcts, setMcts] = useState(DEFAULT_MCTS);

  // Hydrate identity fields once — never re-set form state from the server
  // afterwards (later snapshot refreshes would overwrite what the user types).
  const identityHydrated = useRef(false);
  useEffect(() => {
    if (!agentStatus || identityHydrated.current) return;
    identityHydrated.current = true;
    setSoul(agentStatus.soul || "");
  }, [agentStatus]);

  useEffect(() => {
    if (agentStatus && !displayNameDirty) setDisplayName(agentStatus.displayName || "");
  }, [agentStatus, displayNameDirty]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [m, current, mode, mc] = await Promise.all([
        listAvailableModels().catch(() => []),
        rpc<{ spec: string | null }>("getStoredModelSpec", []).catch(() => ({ spec: null })),
        rpc<{ mode: ApprovalMode }>("getShellApprovalMode", []).catch(() => ({ mode: 'strict' as ApprovalMode })),
        rpc<typeof DEFAULT_MCTS>("getMctsConfig", []).catch(() => DEFAULT_MCTS),
      ]);
      setModels(m ?? []);
      setCurrentSpec(current?.spec ?? "");
      setApprovalMode(mode?.mode ?? "strict");
      if (mc) setMcts(mc);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [rpc]);

  // Fetch once per agent connection — not on every render.
  const loaded = useRef(false);
  useEffect(() => {
    if (connectionStatus !== "connected" || loaded.current) return;
    loaded.current = true;
    void load();
  }, [connectionStatus, load]);

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      await Promise.all([
        displayNameDirty ? rpc("setDisplayName", [displayName]) : Promise.resolve(),
        rpc("setSoul", [soul]),
        currentSpec ? setModel(currentSpec) : Promise.resolve(),
        rpc("setShellApprovalMode", [approvalMode]),
        rpc("setMctsConfig", [mcts]),
      ]);
      setDisplayNameDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [rpc, setModel, displayName, displayNameDirty, soul, currentSpec, approvalMode, mcts]);

  const copySlug = useCallback(async () => {
    if (!agentId) return;
    try {
      await navigator.clipboard.writeText(agentId);
      setSlugCopied(true);
      setTimeout(() => setSlugCopied(false), 2000);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not copy workspace slug");
    }
  }, [agentId]);

  if (connectionStatus !== "connected") {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <Link to={`/workspace/${agentId}`} className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
              <ArrowLeftIcon size={12} /> Back to chat
            </Link>
            <h1 className="text-2xl font-semibold">Workspace settings</h1>
            <p className="text-xs p-text-3 mt-1 flex items-center gap-1.5">
              <span className="font-mono">{agentId}</span>
              <button
                type="button"
                onClick={copySlug}
                className="rounded p-0.5 hover:p-card-hover hover:p-text transition-colors"
                title="Copy workspace slug"
                aria-label={slugCopied ? "Workspace slug copied" : "Copy workspace slug"}
              >{slugCopied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}</button>
              <span className="sr-only" aria-live="polite">{slugCopied ? "Workspace slug copied" : ""}</span>
              <span>·</span>
              <Link to="/user/settings" className="hover:p-text inline-flex items-center gap-1">
                <KeyIcon size={11} /> User settings & credentials
              </Link>
              <span>·</span>
              <Link to={`/triggers/${agentId}`} className="hover:p-text inline-flex items-center gap-1">
                <PlugIcon size={11} /> Triggers (webhooks, timers)
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

        {err && <div className="p-card rounded-lg p-3 text-xs p-danger">{err}</div>}

        {/* Identity */}
        <Card title="Identity" icon={BrainIcon}>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">Display name</label>
            <input value={displayName} onChange={(e) => { setDisplayName(e.target.value); setDisplayNameDirty(true); }} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">SOUL.md</label>
            <textarea value={soul} onChange={(e) => setSoul(e.target.value)} rows={8}
              className={`${inputCls} font-mono`} placeholder={"# Agent name\n\n## Mission\n\nWhat is this agent for?"} />
          </div>
        </Card>

        {/* Model */}
        <Card title="Model" icon={GearSixIcon}>
          {models.length === 0 ? (
            <p className="text-xs p-text-3">
              No models available. <Link to="/user/settings" className="p-accent underline">Connect a provider</Link> in user settings.
            </p>
          ) : (
            <ModelPicker
              models={models}
              value={currentSpec}
              onChange={setCurrentSpec}
              clearable
              placeholder="(default)"
            />
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

        {/* Scaffold shadow rollout — promote/rollback + per-trial verdict now
            live on the agent's Brain surface (single source of truth). */}

        {/* Always-active skills */}
        <AlwaysActiveSkillsCard rpc={rpc} />

        {/* GEPA offline scaffold optimisation */}
        <GepaOptimizationCard rpc={rpc} />
      </div>
    </div>
  );
}

// ── GEPA offline optimisation ────────────────────────────────────

interface GepaRunRow {
  runId: string;
  status: 'running' | 'completed' | 'aborted';
  stopReason: string | null;
  iterations: number;
  metricCalls: number;
  startedAt: number;
}

function GepaOptimizationCard({
  rpc,
}: {
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
}) {
  const [runs, setRuns] = useState<GepaRunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await rpc('getGepaRuns', [10]) as GepaRunRow[];
      setRuns(Array.isArray(r) ? r : []);
    } catch { /* table may be empty */ }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = useCallback(async () => {
    setRunning(true);
    setMsg('Optimising — running candidate scaffolds against recent tasks (this can take a few minutes)…');
    try {
      const r = await rpc('runScaffoldGepaOptimization', [{ maxIterations: 4, evalSize: 5 }]) as {
        ok: boolean; error?: string; proposed?: boolean; pendingVersion?: number | null;
        skipReason?: string; bestScore?: number; seedScore?: number;
      };
      if (!r.ok) setMsg(`No run: ${r.error}`);
      else if (r.proposed) {
        setMsg(`Improved scaffold proposed as v${r.pendingVersion} (best ${r.bestScore?.toFixed(2)} vs seed ${r.seedScore?.toFixed(2)}) — it will shadow-eval, then you can promote it from the agent's Brain surface.`);
      } else {
        setMsg(`No improvement found (${r.skipReason ?? 'seed already best'}; best ${r.bestScore?.toFixed(2)} vs seed ${r.seedScore?.toFixed(2)}).`);
      }
      await refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [rpc, refresh]);

  return (
    <Card title="Scaffold self-tuning" icon={SparkleIcon}>
      <p className="text-[11px] p-text-3">
        Offline genetic-Pareto optimisation: runs candidate inference loops against your
        agent's recent tasks, judges each, and proposes an improved scaffold for shadow eval.
        Costs several LLM calls per run.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="px-3 py-1.5 rounded-md text-xs font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-50"
      >{running ? 'Optimising…' : 'Run optimisation'}</button>
      {msg && <div className="text-[11px] p-text-2 mt-1">{msg}</div>}
      {runs.length > 0 && (
        <div className="mt-2 space-y-1">
          {runs.slice(0, 5).map(r => (
            <div key={r.runId} className="text-[11px] p-text-3 flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${r.status === 'completed' ? 'p-dot-success' : r.status === 'running' ? 'p-dot-warning' : 'p-dot-neutral'}`} />
              <span className="font-mono">{r.iterations} iters</span>
              <span>· {r.metricCalls} evals</span>
              <span className="ml-auto">{r.stopReason ?? r.status}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Scaffold pending detail + promote/rollback controls ──────────

// ── Always-active skills pinning ─────────────────────────────────

function AlwaysActiveSkillsCard({
  rpc,
}: {
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await rpc('getAlwaysActiveSkills', []) as { names: string[] };
      setNames(r?.names ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (next: string[]) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await rpc('setAlwaysActiveSkills', [next]) as { names: string[] };
      setNames(r?.names ?? []);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [rpc]);

  const add = useCallback(() => {
    const n = input.trim();
    if (!n) return;
    if (names.includes(n)) { setInput(''); return; }
    setInput('');
    void save([...names, n]);
  }, [input, names, save]);

  const remove = useCallback((n: string) => {
    void save(names.filter(x => x !== n));
  }, [names, save]);

  return (
    <Card title="Always-active skills" icon={KeyIcon}>
      <p className="text-[11px] p-text-3">
        Skills pinned here are activated every turn for this agent. Use to lock-in
        workflow conventions (e.g., <code className="font-mono">audit-implementation</code>) without typing /name.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0
          ? <span className="text-[11px] p-text-3 italic">(none pinned)</span>
          : names.map(n => (
            <span key={n} className="inline-flex items-center gap-1 px-2 py-0.5 rounded p-card text-[11px] font-mono">
              {n}
              <button type="button" onClick={() => remove(n)} className="p-text-3 hover:p-text">×</button>
            </span>
          ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          value={input}
          placeholder="skill-name"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          className={inputCls + " text-xs"}
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !input.trim()}
          className="px-3 py-1.5 rounded-md text-xs font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-50 shrink-0"
        >Pin</button>
      </div>
      {err && <div className="text-[11px] p-danger mt-1">{err}</div>}
    </Card>
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
