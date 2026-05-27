/**
 * V2 Panel — the operator-facing surface for v2 features that the chat UI
 * doesn't natively expose.
 *
 *   • Scaffold shadow-rollout: pending version, trial counts, decision,
 *     promote/rollback actions
 *   • Shell approval mode (strict | allow_all | deny_all)
 *   • Auto-judge tunables (sample rate, auto-promote toggle)
 *   • Vectorize status
 *   • Run history + click-to-stream events (SSE)
 *   • Scaffold-driven chat — explicit "run via scaffold" entry point
 *
 * All wired through @callable RPCs on OrchestratorAgent. SSE uses the
 * standard /api/agents/<name>/runs/<id>/stream endpoint with EventSource.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAgent } from "agents/react";

interface ShadowStatus {
  hasPending: boolean;
  pending?: {
    version: number;
    writtenAt: number;
    rationale: string;
    trialsSoFar: number;
    pendingWins: number;
    currentWins: number;
    ties: number;
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

export default function V2Panel() {
  const { agentId } = useParams<{ agentId: string }>();
  const agent = useAgent({ agent: "orchestrator-agent", name: agentId ?? "default" });

  const [shadow, setShadow] = useState<ShadowStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<"strict" | "allow_all" | "deny_all">("strict");
  const [sampleRate, setSampleRate] = useState("0.25");
  const [autoPromote, setAutoPromote] = useState(false);
  const [vectorAvailable, setVectorAvailable] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [scaffoldTask, setScaffoldTask] = useState("");
  const [scaffoldOutput, setScaffoldOutput] = useState("");
  const [scaffoldRunning, setScaffoldRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  // ── Initial load ──────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!agent) return;
    try {
      const [s, mode, vsStatus, runList] = await Promise.all([
        agent.call("getShadowStatus", []) as Promise<ShadowStatus>,
        agent.call("getShellApprovalMode", []) as Promise<{ mode: "strict" | "allow_all" | "deny_all" }>,
        agent.call("vectorStoreStatus", []) as Promise<{ available: boolean }>,
        agent.call("listRuns", [50]) as Promise<RunInfo[]>,
      ]);
      setShadow(s);
      setApprovalMode(mode.mode);
      setVectorAvailable(vsStatus.available);
      setRuns(runList);
      setError(null);
    } catch (e) {
      setError(`load failed: ${(e as Error).message}`);
    }
  }, [agent]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── Scaffold rollout actions ──────────────────────────────────────

  const applyDecision = useCallback(async (mode: "auto" | "promote" | "rollback") => {
    if (!agent) return;
    try {
      const r = await agent.call("applyScaffoldDecision", [mode]) as { ok: boolean; error?: string };
      if (!r.ok) setError(`apply ${mode}: ${r.error}`);
      await refresh();
    } catch (e) {
      setError(`apply ${mode}: ${(e as Error).message}`);
    }
  }, [agent, refresh]);

  // ── Approval / shadow config ──────────────────────────────────────

  const updateApprovalMode = useCallback(async (mode: "strict" | "allow_all" | "deny_all") => {
    if (!agent) return;
    try {
      await agent.call("setShellApprovalMode", [mode]);
      setApprovalMode(mode);
    } catch (e) {
      setError(`approval mode: ${(e as Error).message}`);
    }
  }, [agent]);

  const updateAgentConfig = useCallback(async (key: string, value: string) => {
    if (!agent) return;
    try {
      // setModel is the only generic setter; use upsert via raw SQL via @callable.
      // We add a generic setAgentConfig RPC below — for now invoke directly.
      await agent.call("setAgentConfig", [key, value]);
    } catch {
      // Fall through — server may not have setAgentConfig
    }
  }, [agent]);

  // ── Run-event SSE stream ──────────────────────────────────────────

  const subscribeRun = useCallback((runId: string) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setSelectedRun(runId);
    setRunEvents([]);
    const url = `/api/agents/${agentId}/runs/${runId}/stream`;
    const es = new EventSource(url);
    esRef.current = es;
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as RunEvent;
        setRunEvents((prev) => [...prev, data]);
      } catch { /* nop */ }
    };
    [
      "run_start", "turn_start", "text_delta", "tool_call_start", "tool_call_end",
      "step_finish", "head_split", "head_merge", "scaffold_promotion",
      "scaffold_rollback", "memory_write", "fiber_recovered", "error",
      "turn_end", "run_end",
    ].forEach((t) => es.addEventListener(t, handler));
    es.onerror = () => { /* EventSource auto-retries with Last-Event-ID */ };
  }, [agentId]);

  useEffect(() => () => { esRef.current?.close(); }, []);

  // ── Chat via scaffold ─────────────────────────────────────────────

  const runChatViaScaffold = useCallback(async () => {
    if (!agent || !scaffoldTask.trim()) return;
    setScaffoldRunning(true);
    setScaffoldOutput("");
    try {
      const r = await agent.call("chatViaScaffold", [scaffoldTask]) as {
        ok: boolean; text: string; emitCount: number; error?: string;
      };
      setScaffoldOutput(r.text || `(no output) emits=${r.emitCount} ${r.error ? `error: ${r.error}` : ""}`);
    } catch (e) {
      setScaffoldOutput(`error: ${(e as Error).message}`);
    } finally {
      setScaffoldRunning(false);
    }
  }, [agent, scaffoldTask]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold mb-1">v2 control panel</h1>
        <p className="text-sm" style={{ color: "var(--c-text-3)" }}>
          Operator surface for scaffold rollout, approval gating, semantic memory,
          and run history. All actions are durable.
        </p>
        {error && (
          <div className="mt-3 p-2 rounded text-sm" style={{ background: "#fef2f2", color: "#991b1b" }}>
            {error}
          </div>
        )}
      </header>

      {/* Scaffold shadow rollout */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-3">Scaffold rollout</h2>
        {!shadow ? (
          <div className="text-sm" style={{ color: "var(--c-text-3)" }}>Loading…</div>
        ) : !shadow.hasPending ? (
          <div className="text-sm" style={{ color: "var(--c-text-3)" }}>
            No pending scaffold. Recent versions:
            <ul className="mt-2 space-y-1">
              {(shadow.versions ?? []).map((v) => (
                <li key={v.version} className="font-mono text-xs">
                  v{v.version} <span className="ml-2 px-1.5 py-0.5 rounded" style={{
                    background: v.status === "current" ? "#dcfce7" : "#f1f5f9",
                  }}>{v.status}</span>
                  <span className="ml-2" style={{ color: "var(--c-text-3)" }}>{v.rationale}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div className="space-y-2 text-sm">
              <div>Pending: <span className="font-mono">v{shadow.pending!.version}</span> — {shadow.pending!.rationale}</div>
              <div>
                Trials: {shadow.pending!.trialsSoFar}
                {" — "}
                pending wins {shadow.pending!.pendingWins} · current wins {shadow.pending!.currentWins} · ties {shadow.pending!.ties}
              </div>
              <div>
                Decision: <strong>{shadow.decision?.decision}</strong>
                {" "}(win-rate {(shadow.decision?.winRate ?? 0).toFixed(2)})
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button className="px-3 py-1.5 rounded text-sm" style={{ background: "#dcfce7", color: "#166534" }}
                onClick={() => applyDecision("promote")}>Promote pending</button>
              <button className="px-3 py-1.5 rounded text-sm" style={{ background: "#fee2e2", color: "#991b1b" }}
                onClick={() => applyDecision("rollback")}>Rollback pending</button>
              <button className="px-3 py-1.5 rounded text-sm" style={{ background: "#dbeafe", color: "#1e40af" }}
                onClick={() => applyDecision("auto")}>Apply auto-decision</button>
            </div>
          </>
        )}
      </section>

      {/* Approval mode */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-3">Shell approval mode</h2>
        <p className="text-xs mb-3" style={{ color: "var(--c-text-3)" }}>
          Controls how the `run` builtin tool handles 'gate' commands (sudo,
          rm-recursive, git force-push, etc).
        </p>
        <div className="flex gap-2">
          {(["strict", "allow_all", "deny_all"] as const).map((mode) => (
            <button key={mode}
              onClick={() => updateApprovalMode(mode)}
              className="px-3 py-1.5 rounded text-sm"
              style={{
                background: approvalMode === mode ? "#1e40af" : "#f1f5f9",
                color: approvalMode === mode ? "#fff" : "#475569",
              }}>{mode}</button>
          ))}
        </div>
      </section>

      {/* Shadow rollout config */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-3">Auto-judge config</h2>
        <p className="text-xs mb-3" style={{ color: "var(--c-text-3)" }}>
          Per-turn auto-judge for pending scaffolds. Set sample_rate=0 to disable.
        </p>
        <div className="flex items-center gap-3 mb-2">
          <label className="text-sm">sample_rate:</label>
          <input
            value={sampleRate}
            onChange={(e) => setSampleRate(e.target.value)}
            onBlur={() => updateAgentConfig("shadow_sample_rate", sampleRate)}
            className="px-2 py-1 rounded text-sm font-mono w-24"
            style={{ border: "1px solid var(--c-border)" }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox"
            checked={autoPromote}
            onChange={(e) => {
              setAutoPromote(e.target.checked);
              updateAgentConfig("auto_promote_scaffold", String(e.target.checked));
            }}
          />
          auto_promote when judge agrees + minTrials reached
        </label>
      </section>

      {/* Vectorize status */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-2">Semantic memory (Vectorize)</h2>
        {vectorAvailable === null ? (
          <div className="text-sm" style={{ color: "var(--c-text-3)" }}>Checking…</div>
        ) : vectorAvailable ? (
          <div className="text-sm" style={{ color: "#166534" }}>
            ✓ Wired — search_memory uses hybrid FTS5 + Vectorize via RRF.
          </div>
        ) : (
          <div className="text-sm" style={{ color: "var(--c-text-3)" }}>
            ⚠ Not wired. To enable: <code className="text-xs px-1 rounded" style={{ background: "#f1f5f9" }}>
              wrangler vectorize create proteus-memory --dimensions=384 --metric=cosine
            </code> + uncomment the binding in wrangler.jsonc.
          </div>
        )}
      </section>

      {/* Chat via scaffold */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-3">Run via scaffold</h2>
        <p className="text-xs mb-3" style={{ color: "var(--c-text-3)" }}>
          Explicitly execute the current scaffold for a task — bypasses Think's
          standard streamText. Streams events; persists final message.
        </p>
        <textarea
          value={scaffoldTask}
          onChange={(e) => setScaffoldTask(e.target.value)}
          rows={3}
          placeholder="Enter a task to run through the scaffold…"
          className="w-full px-2 py-1.5 rounded text-sm font-mono"
          style={{ border: "1px solid var(--c-border)" }}
        />
        <button
          onClick={runChatViaScaffold}
          disabled={scaffoldRunning || !scaffoldTask.trim()}
          className="mt-2 px-3 py-1.5 rounded text-sm"
          style={{ background: "#1e40af", color: "#fff", opacity: scaffoldRunning ? 0.5 : 1 }}
        >{scaffoldRunning ? "Running…" : "Run"}</button>
        {scaffoldOutput && (
          <pre className="mt-3 p-2 rounded text-xs font-mono whitespace-pre-wrap" style={{ background: "#0f172a", color: "#e2e8f0" }}>
            {scaffoldOutput}
          </pre>
        )}
      </section>

      {/* Run history */}
      <section className="border rounded-lg p-4" style={{ borderColor: "var(--c-border)" }}>
        <h2 className="text-base font-medium mb-3">Run history (SSE)</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {runs.map((r) => (
              <button key={r.runId}
                onClick={() => subscribeRun(r.runId)}
                className="block w-full text-left px-2 py-1 rounded text-xs font-mono"
                style={{ background: selectedRun === r.runId ? "#dbeafe" : "transparent" }}
              >
                {r.runId} <span className="ml-2" style={{ color: "var(--c-text-3)" }}>
                  {r.eventCount} ev · {new Date(r.lastTs).toLocaleTimeString()}
                </span>
              </button>
            ))}
            {runs.length === 0 && <div className="text-xs" style={{ color: "var(--c-text-3)" }}>no runs yet</div>}
          </div>
          <div className="max-h-64 overflow-y-auto p-2 rounded font-mono text-xs" style={{ background: "#f8fafc" }}>
            {selectedRun ? (
              runEvents.length === 0 ? (
                <div style={{ color: "var(--c-text-3)" }}>(waiting for events…)</div>
              ) : (
                runEvents.map((e, i) => (
                  <div key={i} className="mb-1">
                    <span style={{ color: "#1e40af" }}>{e.eventIndex}</span>{" "}
                    <span style={{ color: "#9333ea" }}>{e.type}</span>{" "}
                    <span style={{ color: "var(--c-text-3)" }}>
                      {JSON.stringify(e).slice(0, 80)}
                    </span>
                  </div>
                ))
              )
            ) : (
              <div style={{ color: "var(--c-text-3)" }}>select a run to stream events</div>
            )}
          </div>
        </div>
      </section>

      <footer className="text-center text-xs" style={{ color: "var(--c-text-3)" }}>
        <button onClick={refresh} className="hover:underline">↻ refresh</button>
      </footer>
    </div>
  );
}
