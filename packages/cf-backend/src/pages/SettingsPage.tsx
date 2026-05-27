import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, TreeStructureIcon, CheckIcon, ArrowLeftIcon,
  PencilSimpleIcon, WarningIcon, EraserIcon, GitBranchIcon,
  PlugIcon, ShieldIcon, ClockCounterClockwiseIcon, DatabaseIcon, ListChecksIcon,
} from "@phosphor-icons/react";
import { useProteus } from "@/hooks/use-proteus";

// ── Shared building blocks (kept inline — single-purpose, no need to extract) ──

function Card({ title, icon: Icon, children, variant }: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
  variant?: "danger";
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs p-text-2 block font-medium">{label}</label>
      {children}
      {hint && <p className="text-[11px] p-text-3">{hint}</p>}
    </div>
  );
}

const inputCls = "w-full rounded-lg px-3 py-2 text-sm p-text focus:outline-none transition-all" +
  " border border-[var(--c-input-border)] bg-[var(--c-surface)]" +
  " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]" +
  " placeholder:p-text-3";

// ── Server-shape interfaces (mirror RPC return values) ─────────────────────────

interface ProviderInfo {
  id: string;
  label?: string;
  available: boolean;
  unavailableReason?: string;
}

interface ModelEntry {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  capabilities: string[];
  contextWindow?: number;
}

interface AvailableModels {
  current: string | null;
  currentNormalized: string;
  models: ModelEntry[];
  providers: ProviderInfo[];
}

interface CodexStatus {
  connected: boolean;
  accountId?: string | null;
  expiresAt?: number;
}

interface CodexDeviceStart {
  userCode: string;
  deviceAuthId: string;
  pollIntervalSec: number;
  portalURL: string;
}

interface ShadowStatus {
  hasPending: boolean;
  pending?: {
    version: number; writtenAt: number; rationale: string;
    trialsSoFar: number; pendingWins: number; currentWins: number; ties: number;
  };
  decision?: { decision: "promote" | "rollback" | "continue"; winRate: number };
  versions?: Array<{ version: number; status: string; rationale: string; written_at: number }>;
}

interface RunInfo {
  runId: string;
  lastTs: string;
  eventCount: number;
}

interface RunEvent {
  type: string;
  eventIndex: number;
  timestamp: string;
  [k: string]: unknown;
}

type ApprovalMode = "strict" | "allow_all" | "deny_all";

// ──────────────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);

  // Identity
  const [displayName, setDisplayName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);

  // Model / providers
  const [models, setModels] = useState<AvailableModels | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");

  // Codex OAuth
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexDevice, setCodexDevice] = useState<CodexDeviceStart | null>(null);
  const [codexConnecting, setCodexConnecting] = useState(false);
  const codexPollRef = useRef<number | null>(null);

  // BYO credentials
  const [openaiKey, setOpenaiKey] = useState("");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [compatBaseURL, setCompatBaseURL] = useState("");
  const [compatKey, setCompatKey] = useState("");

  // MCTS
  const [mctsC, setMctsC] = useState(1.414);
  const [mctsIter, setMctsIter] = useState(50);
  const [mctsDepth, setMctsDepth] = useState(5);
  const [mctsBranches, setMctsBranches] = useState(3);

  // Scaffold / rollout / approval / auto-judge / vector
  const [shadow, setShadow] = useState<ShadowStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("strict");
  const [sampleRate, setSampleRate] = useState("0.25");
  const [autoPromote, setAutoPromote] = useState(false);
  const [vectorAvailable, setVectorAvailable] = useState<boolean | null>(null);

  // Run history
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  // ── Initial + ongoing data load ─────────────────────────────────────────────

  useEffect(() => {
    if (state.agentStatus) {
      setDisplayName(state.agentStatus.displayName || state.agentStatus.name || "");
      setPurpose(state.agentStatus.purpose || "");
    }
  }, [state.agentStatus]);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOps = useCallback(async () => {
    if (state.connectionStatus !== "connected") return;
    setLoading(true);
    setLoadError(null);
    try {
      const [m, c, sh, mode, vs, runList, mcts] = await Promise.all([
        state.rpc("getAvailableModels", []) as Promise<AvailableModels>,
        state.rpc("getCodexStatus", []) as Promise<CodexStatus>,
        state.rpc("getShadowStatus", []) as Promise<ShadowStatus>,
        state.rpc("getShellApprovalMode", []) as Promise<{ mode: ApprovalMode }>,
        state.rpc("vectorStoreStatus", []) as Promise<{ available: boolean }>,
        state.rpc("listRuns", [50]) as Promise<RunInfo[]>,
        state.rpc("getMctsConfig", []) as Promise<{
          explorationConstant: number; maxIterations: number;
          maxDepth: number; branchBudget: number;
        }>,
      ]);
      setModels(m);
      setSelectedModel(m.currentNormalized);
      setCodexStatus(c);
      setShadow(sh);
      setApprovalMode(mode.mode);
      setVectorAvailable(vs.available);
      setRuns(runList);
      setMctsC(mcts.explorationConstant);
      setMctsIter(mcts.maxIterations);
      setMctsDepth(mcts.maxDepth);
      setMctsBranches(mcts.branchBudget);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => { void loadOps(); }, [loadOps]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await Promise.all([
        state.rpc("setDisplayName", [displayName]),
        state.rpc("setSoul", [purpose]),
        selectedModel ? state.setModel(selectedModel) : Promise.resolve(),
        state.rpc("setMctsConfig", [{
          explorationConstant: mctsC, maxIterations: mctsIter,
          maxDepth: mctsDepth, branchBudget: mctsBranches,
        }]),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await loadOps();
    } finally { setSaving(false); }
  }, [state, displayName, purpose, selectedModel, mctsC, mctsIter, mctsDepth, mctsBranches, loadOps]);

  const handleDangerAction = useCallback(async (action: string) => {
    setConfirmAction(null);
    try {
      if (action === "clearMemory") await state.rpc("clearMemory", []);
      if (action === "resetMcts") await state.rpc("resetMctsTree", []);
    } catch (err) {
      console.error("Action failed:", err);
    }
  }, [state]);

  // Codex device-code flow
  const stopCodexPolling = useCallback(() => {
    if (codexPollRef.current !== null) {
      window.clearInterval(codexPollRef.current);
      codexPollRef.current = null;
    }
  }, []);

  const connectCodex = useCallback(async () => {
    if (!agentId) return;
    // Idempotent: if a poll is already running, stop it first so back-to-back
    // calls (double-click, rapid retry) don't stack timers.
    stopCodexPolling();
    setCodexConnecting(true);
    try {
      const start = await fetch(`/api/agents/${agentId}/auth/codex/start`, { method: "POST" })
        .then(r => r.json() as Promise<CodexDeviceStart>);
      setCodexDevice(start);
      const timer = window.setInterval(async () => {
        // Guard: if a newer poll started after this one, bail. Without this,
        // an in-flight poll callback can race with stopCodexPolling.
        if (codexPollRef.current !== timer) return;
        try {
          const r = await fetch(`/api/agents/${agentId}/auth/codex/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }),
          }).then(r => r.json() as Promise<{ connected: boolean }>);
          if (r.connected) {
            stopCodexPolling();
            setCodexDevice(null);
            setCodexConnecting(false);
            await loadOps();
          }
        } catch (err) {
          stopCodexPolling();
          setCodexConnecting(false);
          setLoadError(`Codex polling failed: ${(err as Error).message}`);
        }
      }, Math.max(3, start.pollIntervalSec) * 1000);
      codexPollRef.current = timer;
    } catch (err) {
      setCodexConnecting(false);
      setLoadError(`Codex connect failed: ${(err as Error).message}`);
    }
  }, [agentId, loadOps, stopCodexPolling]);

  const cancelCodex = useCallback(() => {
    stopCodexPolling();
    setCodexDevice(null);
    setCodexConnecting(false);
  }, [stopCodexPolling]);

  const disconnectCodex = useCallback(async () => {
    await state.rpc("disconnectCodex", []);
    await loadOps();
  }, [state, loadOps]);

  useEffect(() => () => stopCodexPolling(), [stopCodexPolling]);

  // BYO API keys — save then reload Settings so the new provider shows
  // up immediately in the picker.
  const saveCredential = useCallback(async (key: string, payload: unknown) => {
    if (!agentId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetch(`/api/agents/${agentId}/auth/credentials/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText })) as { error?: string };
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      await loadOps();
    } catch (err) {
      setLoadError(`Save ${key}: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [agentId, loadOps]);

  const saveOpenAIKey = useCallback(() => {
    if (!openaiKey.trim()) return;
    void saveCredential("openai", { kind: "bearer", token: openaiKey.trim() }).then(() => setOpenaiKey(""));
  }, [openaiKey, saveCredential]);

  const saveOpenRouterKey = useCallback(() => {
    if (!openrouterKey.trim()) return;
    void saveCredential("openrouter", { kind: "bearer", token: openrouterKey.trim() }).then(() => setOpenrouterKey(""));
  }, [openrouterKey, saveCredential]);

  const saveOpenAICompat = useCallback(() => {
    if (!compatBaseURL.trim() || !compatKey.trim()) return;
    void saveCredential("openai-compat", {
      kind: "openai-compat",
      baseURL: compatBaseURL.trim(),
      apiKey: compatKey.trim(),
    }).then(() => { setCompatBaseURL(""); setCompatKey(""); });
  }, [compatBaseURL, compatKey, saveCredential]);

  // Scaffold rollout
  const applyDecision = useCallback(async (mode: "auto" | "promote" | "rollback") => {
    await state.rpc("applyScaffoldDecision", [mode]);
    await loadOps();
  }, [state, loadOps]);

  // Approval mode
  const updateApprovalMode = useCallback(async (mode: ApprovalMode) => {
    await state.rpc("setShellApprovalMode", [mode]);
    setApprovalMode(mode);
  }, [state]);

  // Auto-judge config (generic agent_config setter)
  const updateAgentConfig = useCallback(async (key: string, value: string) => {
    await state.rpc("setAgentConfig", [key, value]).catch(() => {});
  }, [state]);

  // Run-event SSE
  const [streamError, setStreamError] = useState<string | null>(null);
  const subscribeRun = useCallback((runId: string) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setSelectedRun(runId);
    setRunEvents([]);
    setStreamError(null);
    const es = new EventSource(`/api/agents/${agentId}/runs/${runId}/stream`);
    esRef.current = es;
    let parseErrors = 0;
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as RunEvent;
        setRunEvents((prev) => [...prev, data]);
      } catch {
        parseErrors++;
        // After 3 parse errors, surface — usually means stream wire shape changed.
        if (parseErrors === 3) setStreamError('Stream contains malformed events (3+).');
      }
    };
    [
      "run_start", "turn_start", "text_delta", "tool_call_start", "tool_call_end",
      "step_finish", "head_split", "head_merge", "scaffold_promotion",
      "scaffold_rollback", "memory_write", "fiber_recovered", "error",
      "turn_end", "run_end",
    ].forEach((t) => es.addEventListener(t, handler));
    es.onerror = () => {
      // EventSource auto-reconnects; show a transient state, not a hard error.
      setStreamError('Stream disconnected — reconnecting…');
    };
  }, [agentId]);

  // Close + null-out on agentId change AND on unmount. Without the agentId
  // dependency, switching agents in the same browser tab would leak an
  // EventSource pointed at the previous agent's stream.
  useEffect(() => () => {
    esRef.current?.close();
    esRef.current = null;
    setSelectedRun(null);
    setRunEvents([]);
  }, [agentId]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const isConnected = state.connectionStatus === "connected";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to={`/agent/${agentId}`}>
            <Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-tight p-text">Settings</h1>
            <p className="text-xs p-text-3 font-mono">{agentId}</p>
          </div>
          {loading && <Loader size="sm" />}
          {!isConnected && (
            <span className="text-xs px-2 py-1 rounded"
              style={{ background: "rgba(234,179,8,0.15)", color: "rgb(250,204,21)" }}>
              disconnected — values may be stale
            </span>
          )}
        </div>

        {loadError && (
          <div className="p-card rounded-xl p-3 text-sm" style={{ borderColor: "rgba(239,68,68,0.4)" }}>
            <span className="text-red-400">Load failed:</span>{" "}
            <span className="p-text-2">{loadError}</span>
            <button onClick={() => void loadOps()}
              className="ml-2 underline p-accent">Retry</button>
          </div>
        )}

        {/* Identity */}
        <Card title="Identity" icon={PencilSimpleIcon}>
          <div className="space-y-4">
            <Field label="Display Name">
              <input value={displayName} onChange={e => setDisplayName(e.target.value)}
                placeholder="My Agent" className={inputCls} />
            </Field>
            <Field label="Purpose / Soul">
              <textarea value={purpose} onChange={e => setPurpose(e.target.value)}
                rows={3} placeholder="What is this agent's purpose?"
                className={`${inputCls} resize-none`} />
            </Field>
          </div>
        </Card>

        {/* Model & Providers */}
        <Card title="Model" icon={BrainIcon}>
          {!models ? (
            <div className="flex justify-center py-4"><Loader size="sm" /></div>
          ) : (
            <div className="space-y-4">
              <Field label="Language Model" hint={`Currently active: ${models.currentNormalized}`}>
                <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className={inputCls}>
                  {models.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      [{m.provider}] {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Providers">
                <ul className="space-y-1 text-xs">
                  {models.providers.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span className="font-mono w-32 p-text">{p.id}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                        background: p.available ? "rgba(34,197,94,0.15)" : "var(--c-surface)",
                        color: p.available ? "rgb(74,222,128)" : "var(--c-text-3)",
                      }}>{p.available ? "ready" : "unavailable"}</span>
                      {!p.available && p.unavailableReason && (
                        <span className="p-text-3 text-[11px]">— {p.unavailableReason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Field>
            </div>
          )}
        </Card>

        {/* ChatGPT Codex subscription */}
        <Card title="ChatGPT Subscription" icon={PlugIcon}>
          <p className="text-xs p-text-3 mb-3">
            Connect a ChatGPT account via OAuth device-code flow. Inference then bills
            against your ChatGPT Plus/Pro/Business subscription rather than API credits.
            May fail from CF Worker egress IPs if Cloudflare's WAF on chatgpt.com
            challenges non-residential clients.
          </p>
          {codexStatus?.connected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{ background: "rgba(34,197,94,0.15)", color: "rgb(74,222,128)" }}>
                  connected
                </span>
                {codexStatus.accountId && (
                  <span className="font-mono text-xs p-text-3">{codexStatus.accountId}</span>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={disconnectCodex}>Disconnect</Button>
            </div>
          ) : codexDevice ? (
            <div className="space-y-3 text-sm">
              <Field label="1. Open this URL">
                <a href={codexDevice.portalURL} target="_blank" rel="noreferrer"
                  className="font-mono text-xs underline p-accent">{codexDevice.portalURL}</a>
              </Field>
              <Field label="2. Enter this code">
                <div className="font-mono text-lg tracking-widest px-3 py-1.5 rounded inline-block"
                  style={{ background: "var(--c-surface)", border: "1px solid var(--c-border)" }}>
                  {codexDevice.userCode}
                </div>
              </Field>
              <div className="flex items-center gap-2 text-xs p-text-3">
                <Loader size="sm" /> Waiting for sign-in…
                <Button variant="ghost" size="sm" onClick={cancelCodex}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="primary" size="sm" onClick={connectCodex} disabled={codexConnecting}>
              {codexConnecting ? "Starting…" : "Connect ChatGPT"}
            </Button>
          )}
        </Card>

        {/* BYO API keys */}
        <Card title="API Keys" icon={ShieldIcon}>
          <div className="space-y-4">
            <Field label="OpenAI API key" hint="Stored per-agent in Durable Object SQL. Never sent to the browser after save.">
              <div className="flex gap-2">
                <input type="password" value={openaiKey} onChange={e => setOpenaiKey(e.target.value)}
                  placeholder="sk-…" className={inputCls} />
                <Button variant="secondary" size="sm" onClick={saveOpenAIKey} disabled={!openaiKey.trim()}>
                  Save
                </Button>
              </div>
            </Field>
            <Field label="OpenRouter API key">
              <div className="flex gap-2">
                <input type="password" value={openrouterKey} onChange={e => setOpenrouterKey(e.target.value)}
                  placeholder="sk-or-…" className={inputCls} />
                <Button variant="secondary" size="sm" onClick={saveOpenRouterKey} disabled={!openrouterKey.trim()}>
                  Save
                </Button>
              </div>
            </Field>
            <Field label="OpenAI-compatible (BYO)" hint="Covers Groq, Together, Fireworks, DeepInfra, xAI, etc.">
              <div className="space-y-2">
                <input value={compatBaseURL} onChange={e => setCompatBaseURL(e.target.value)}
                  placeholder="https://api.groq.com/openai/v1" className={inputCls} />
                <div className="flex gap-2">
                  <input type="password" value={compatKey} onChange={e => setCompatKey(e.target.value)}
                    placeholder="API key" className={inputCls} />
                  <Button variant="secondary" size="sm" onClick={saveOpenAICompat}
                    disabled={!compatBaseURL.trim() || !compatKey.trim()}>
                    Save
                  </Button>
                </div>
              </div>
            </Field>
          </div>
        </Card>

        {/* MCTS Parameters */}
        <Card title="MCTS Exploration" icon={TreeStructureIcon}>
          <div className="space-y-4">
            <Field label={`Exploration constant (C) — ${mctsC.toFixed(3)}`}>
              <input type="range" min="0.1" max="3" step="0.01" value={mctsC}
                onChange={e => setMctsC(parseFloat(e.target.value))}
                className="w-full accent-[var(--c-accent)]" />
              <div className="flex justify-between text-[10px] p-text-3 mt-0.5">
                <span>0.1 (exploit)</span><span>3.0 (explore)</span>
              </div>
            </Field>
            <Field label="Max iterations">
              <input type="number" min={1} max={500} value={mctsIter}
                onChange={e => setMctsIter(parseInt(e.target.value) || 50)} className={inputCls} />
            </Field>
            <Field label="Max depth">
              <input type="number" min={1} max={20} value={mctsDepth}
                onChange={e => setMctsDepth(parseInt(e.target.value) || 5)} className={inputCls} />
            </Field>
            <Field label="Branch budget">
              <input type="number" min={1} max={10} value={mctsBranches}
                onChange={e => setMctsBranches(parseInt(e.target.value) || 3)} className={inputCls} />
            </Field>
          </div>
        </Card>

        {/* Scaffold rollout */}
        <Card title="Scaffold Rollout" icon={GitBranchIcon}>
          {!shadow ? (
            <div className="flex justify-center py-4"><Loader size="sm" /></div>
          ) : !shadow.hasPending ? (
            <div className="space-y-2">
              <p className="text-xs p-text-3">No pending scaffold version. Recent versions:</p>
              <ul className="space-y-1">
                {(shadow.versions ?? []).map((v) => (
                  <li key={v.version} className="text-xs flex items-center gap-2">
                    <span className="font-mono p-text">v{v.version}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                      background: v.status === "current" ? "rgba(34,197,94,0.15)" : "var(--c-surface)",
                      color: v.status === "current" ? "rgb(74,222,128)" : "var(--c-text-3)",
                    }}>{v.status}</span>
                    <span className="p-text-3">{v.rationale}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <div>
                  Pending: <span className="font-mono p-text">v{shadow.pending!.version}</span>
                  <span className="ml-2 p-text-3">{shadow.pending!.rationale}</span>
                </div>
                <div className="text-xs p-text-3">
                  Trials: {shadow.pending!.trialsSoFar} ·
                  pending wins {shadow.pending!.pendingWins} ·
                  current wins {shadow.pending!.currentWins} ·
                  ties {shadow.pending!.ties}
                </div>
                <div className="text-xs">
                  Auto-decision: <strong>{shadow.decision?.decision}</strong>
                  <span className="ml-1 p-text-3">(win-rate {(shadow.decision?.winRate ?? 0).toFixed(2)})</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => applyDecision("promote")}>Promote</Button>
                <Button variant="secondary" size="sm" onClick={() => applyDecision("rollback")}>Rollback</Button>
                <Button variant="primary" size="sm" onClick={() => applyDecision("auto")}>Apply auto</Button>
              </div>
            </div>
          )}
          <div className="border-t p-border mt-4 pt-4 space-y-3">
            <Field label="Auto-judge sample rate" hint="Per-turn shadow evaluation sampling. Set to 0 to disable.">
              <input value={sampleRate} onChange={e => setSampleRate(e.target.value)}
                onBlur={() => updateAgentConfig("shadow_sample_rate", sampleRate)}
                className={inputCls + " w-32"} />
            </Field>
            <label className="flex items-center gap-2 text-sm p-text">
              <input type="checkbox" checked={autoPromote}
                onChange={e => {
                  setAutoPromote(e.target.checked);
                  updateAgentConfig("auto_promote_scaffold", String(e.target.checked));
                }} />
              Auto-promote when judge agrees + minTrials reached
            </label>
          </div>
        </Card>

        {/* Shell approval */}
        <Card title="Shell Approval" icon={ShieldIcon}>
          <p className="text-xs p-text-3 mb-3">
            How the `run` builtin tool handles 'gate' commands (sudo, rm -r, git push --force).
          </p>
          <div className="flex gap-2">
            {(["strict", "allow_all", "deny_all"] as const).map((mode) => (
              <Button key={mode}
                variant={approvalMode === mode ? "primary" : "secondary"}
                size="sm"
                onClick={() => updateApprovalMode(mode)}>
                {mode}
              </Button>
            ))}
          </div>
        </Card>

        {/* Semantic memory */}
        <Card title="Semantic Memory" icon={DatabaseIcon}>
          <p className="text-xs p-text-3 mb-2">
            Vectorize-backed semantic search over MEMORY.md. Hybrid: FTS5 + cosine via RRF.
          </p>
          <div className="text-sm flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
              background: vectorAvailable ? "rgba(34,197,94,0.15)" : "var(--c-surface)",
              color: vectorAvailable ? "rgb(74,222,128)" : "var(--c-text-3)",
            }}>
              {vectorAvailable === null ? "checking…" : vectorAvailable ? "ready" : "fts-only fallback"}
            </span>
            {!vectorAvailable && vectorAvailable !== null && (
              <span className="text-xs p-text-3">— add a Vectorize binding to enable</span>
            )}
          </div>
        </Card>

        {/* Run history */}
        <Card title="Run History" icon={ClockCounterClockwiseIcon}>
          {runs.length === 0 ? (
            <p className="text-xs p-text-3">No runs yet — start a chat turn.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <ul className="space-y-1 text-xs max-h-64 overflow-y-auto">
                {runs.map((r) => (
                  <li key={r.runId}>
                    <button
                      onClick={() => subscribeRun(r.runId)}
                      className={`w-full text-left px-2 py-1 rounded font-mono ${
                        selectedRun === r.runId ? "bg-[var(--c-surface)] p-text" : "p-text-2 hover:p-text"
                      }`}>
                      {r.runId.slice(-12)} · {r.eventCount} events
                    </button>
                  </li>
                ))}
              </ul>
              <div className="max-h-64 overflow-y-auto">
                {streamError && (
                  <div className="text-[10px] p-text-3 mb-1" style={{ color: "rgb(250,204,21)" }}>
                    {streamError}
                  </div>
                )}
                {selectedRun ? (
                  runEvents.length === 0 ? (
                    <p className="text-xs p-text-3">Waiting for events…</p>
                  ) : (
                    <ul className="space-y-1 text-[10px] font-mono">
                      {runEvents.map((ev, i) => (
                        <li key={i} className="p-text-2">
                          <span className="p-accent">{ev.type}</span>
                          {ev.type === 'text_delta' && (ev as { delta?: string }).delta
                            ? <span className="p-text-3"> {((ev as { delta?: string }).delta ?? '').slice(0, 60)}</span>
                            : null}
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <p className="text-xs p-text-3">Click a run to stream events.</p>
                )}
              </div>
            </div>
          )}
        </Card>

        {/* Agent Info */}
        <Card title="Agent Info" icon={ListChecksIcon}>
          <div className="space-y-0 text-sm">
            {state.agentStatus ? (
              [
                ["Name", state.agentStatus.name],
                ["Scaffold", `v${state.agentStatus.scaffoldVersion}`],
                ["MCTS Nodes", state.agentStatus.searchNodeCount],
                ["Crafted Tools", state.agentStatus.craftedToolCount],
                ["Messages", state.agentStatus.messageCount],
              ].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between py-2 border-b p-border last:border-0">
                  <span className="p-text-2">{String(l)}</span>
                  <span className="p-text font-medium">{String(v)}</span>
                </div>
              ))
            ) : <div className="flex justify-center py-4"><Loader size="sm" /></div>}
          </div>
        </Card>

        {/* Save */}
        <button onClick={handleSave} disabled={saving || !isConnected}
          className="p-btn rounded-lg px-5 py-2.5 text-sm font-medium flex items-center gap-2 cursor-pointer">
          {saving ? <Loader size="sm" /> : saved ? <CheckIcon size={16} /> : <FloppyDiskIcon size={16} />}
          {saving ? "Saving…" : saved ? "Saved" : "Save Changes"}
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
                  <button onClick={() => handleDangerAction("clearMemory")}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors cursor-pointer">
                    Confirm
                  </button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmAction("clearMemory")}
                  icon={<EraserIcon size={12} />}>Clear</Button>
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
                  <button onClick={() => handleDangerAction("resetMcts")}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors cursor-pointer">
                    Confirm
                  </button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmAction("resetMcts")}
                  icon={<GitBranchIcon size={12} />}>Reset</Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
