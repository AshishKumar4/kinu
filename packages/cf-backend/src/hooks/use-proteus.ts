/**
 * Proteus agent hooks — useAgent() + useAgentChat() from Agents SDK.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ToolInfo, MemoryEntry, MCTSNode, TimelineSpan } from "../lib/protocol";
import { touchAgent, registerAgent } from "../lib/user-api";

export interface ExecutorOutput {
  id: string; command: string; stdout: string; stderr: string;
  exit_code: number; created_at: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface ForkLineage {
  sourceAgentId: string;
  sourceAgentName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

export interface AgentStatus {
  id: string;
  name: string;
  displayName: string;
  purpose: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
  messageCount: number;
  model: string;
  forkLineage: ForkLineage | null;
}

/**
 * Full agent hook for WorkspacePage — connects to a specific DO instance.
 * Fetches all surface data via @callable RPCs on connect. The unified Run
 * Timeline (getRunTimeline) is the single activity feed — it subsumes the
 * former evolution-events + activity-log streams, so the hook no longer
 * maintains those separately.
 */
export function useProteus(agentId?: string) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [mctsTree, setMctsTree] = useState<MCTSNode | null>(null);
  // The unified Run Timeline spine — one server-merged, ordered span stream
  // (getRunTimeline). Single source; no client-side merge of three RPCs.
  const [runTimeline, setRunTimeline] = useState<TimelineSpan[]>([]);
  const [memoryContent, setMemoryContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [executors, setExecutors] = useState<Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>>([]);
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, ExecutorOutput[]>>(new Map());
  // Pinned (exposed) ports for the sandbox executor — polled hook-level so the
  // Output/Devices port badge updates regardless of the active surface.
  const [pinnedPorts, setPinnedPorts] = useState<Array<{ port: number; url: string; name?: string }>>([]);

  const agent = useAgent({
    agent: "orchestrator-agent",
    name: agentId || "default",
    // onOpen always wins — even if a prior onError pinned the status to
    // "error", a successful reopen must recover the UI. Without this, a
    // single transient error event traps the user on the disconnect
    // banner forever (STABILITY-AUDIT §A1).
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    // Don't clobber a healthy status; partysocket auto-reconnects in the
    // background and the next onOpen recovers. onError is a transient no-op.
    onError: useCallback(() => {}, []),
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    stop,
    isStreaming,
  } = useAgentChat({
    agent,
    // Throttle UI updates during high-frequency token deltas (50ms ≈ 20fps).
    // The chat library forwards this option to @ai-sdk's useChat.
    experimental_throttle: 50,
  } as Parameters<typeof useAgentChat>[0] & { experimental_throttle: number });

  // ── A2: resume the durable stream on EVERY reconnect, not just first mount.
  // The framework's resume effect fires once; partysocket reconnects don't
  // retrigger it. We listen for the agent's "open" event and call
  // resumeStream() — server replays buffered chunks from
  // cf_ai_chat_stream_chunks. (STABILITY-AUDIT §A2.)
  const isFirstOpen = useRef(true);
  useEffect(() => {
    if (!agent) return;
    const onOpen = () => {
      // Skip the very first open — useChat's mount-time resume handles it.
      if (isFirstOpen.current) { isFirstOpen.current = false; return; }
      const chat = (agent as unknown as { _chat?: { resumeStream?: () => unknown } });
      // Resume API surface lives on the useChat-bound chat object exposed
      // by the framework. If it's not present (older Think), this is a no-op.
      const tryResume = (obj: unknown) => {
        if (!obj || typeof obj !== "object") return false;
        const r = (obj as { resumeStream?: () => unknown }).resumeStream;
        if (typeof r === "function") { try { r.call(obj); return true; } catch { /* ignore */ } }
        return false;
      };
      if (tryResume(chat._chat)) return;
      // Fallback: try sending a manual resume request directly. Server
      // recognizes type:"cf_agent_stream_resume_request".
      try {
        (agent as unknown as { send: (m: string) => void }).send(
          JSON.stringify({ type: "cf_agent_stream_resume_request" }),
        );
      } catch { /* ignore */ }
    };
    agent.addEventListener("open", onOpen as EventListener);
    return () => agent.removeEventListener("open", onOpen as EventListener);
  }, [agent]);

  // ── A4: 25s heartbeat keeps the WS warm so Cloudflare's edge doesn't
  // reap idle connections at ~100s. Server no-ops unknown message types.
  // (STABILITY-AUDIT §A4.)
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const id = setInterval(() => {
      try {
        (agent as unknown as { send: (m: string) => void }).send(
          JSON.stringify({ type: "ping" }),
        );
      } catch { /* not yet open */ }
    }, 25_000);
    return () => clearInterval(id);
  }, [agent, connectionStatus]);

  const isConnected = connectionStatus === "connected";

  // Fetch all tab data on connect
  const fetched = useRef(false);
  useEffect(() => {
    if (!isConnected || fetched.current) return;
    fetched.current = true;
    loadAllData();
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh surface data when a turn completes (streaming ends).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreaming.current = true;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      refreshLiveData();
    }
  }, [isStreaming, agent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adaptive polling: 1s during streaming for near-real-time spans, 5s when idle
  useEffect(() => {
    if (!isConnected) return;
    const ms = isStreaming ? 1000 : 5000;
    const interval = setInterval(refreshLiveData, ms);
    return () => clearInterval(interval);
  }, [isConnected, isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for MCTS progress broadcasts from the server. We attach to the
  // outer `agent` EventTarget — NOT the inner `_ws` private field — so the
  // listener survives partysocket auto-reconnects without a close→open gap
  // dropping events. (STABILITY-AUDIT §A3.)
  useEffect(() => {
    if (!agent) return;
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      try {
        const msg = JSON.parse(typeof data === "string" ? data : "");
        if (msg.type === "mcts-progress") {
          if (msg.nodes && msg.nodes.length > 0) {
            setMctsTree(buildTree(msg.nodes));
          }
          // Pull the freshest timeline so the new MCTS spans land promptly.
          agent.call("getRunTimeline", [{ limit: 250 }])
            .then(spans => setRunTimeline(spans as TimelineSpan[]))
            .catch(() => {});
        }
      } catch { /* not JSON or not our message */ }
    };
    agent.addEventListener("message", handler as EventListener);
    return () => agent.removeEventListener("message", handler as EventListener);
  }, [agent]);

  function refreshLiveData() {
    agent.call("getRunTimeline", [{ limit: 250 }])
      .then(spans => setRunTimeline(spans as TimelineSpan[]))
      .catch(() => {});
    agent.call("getMctsTree", [])
      .then((nodes) => {
        const list = nodes as Array<{
          id: string; parent_id: string | null; depth: number;
          visits: number; value: number; status: string; action: string;
          task?: string; observation?: string; created_at?: number;
        }>;
        if (list.length > 0) setMctsTree(buildTree(list));
      })
      .catch(() => {});
    agent.call("getMemoryContent", [])
      .then(c => { setMemoryContent(c as string ?? ""); })
      .catch(() => {});
    // Refresh tools so newly-crafted tools (via workspace.createTool) appear
    // in the Tools pane without reconnecting. Uses the same mapping as loadAllData.
    agent.call("getToolDescriptions", [])
      .then((result) => {
        const r = result as {
          builtIn: Array<{ name: string; description: string }>;
          crafted: Array<{ name: string; description: string; qualityScore?: number; usageCount?: number }>;
        };
        const builtInTools: ToolInfo[] = r.builtIn.map(t => ({
          name: t.name, description: t.description, scope: "local" as const,
          qualityScore: 1, usageCount: 0, lastUsed: "",
        }));
        const craftedTools: ToolInfo[] = r.crafted.map(t => ({
          name: t.name, description: t.description, scope: "global" as const,
          qualityScore: t.qualityScore ?? 0.5, usageCount: t.usageCount ?? 0, lastUsed: "",
        }));
        setTools([...builtInTools, ...craftedTools]);
      })
      .catch(() => {});
  }

  function loadAllData() {
    agent.call("getAgentStatus", [])
      .then((s) => {
        const status = s as AgentStatus;
        setAgentStatus(status);
        if (agentId) {
          // Fire-and-forget: record in UserDO (new agent → register; existing → touch).
          registerAgent(agentId, status.displayName || status.name, status.purpose).catch(() => {
            touchAgent(agentId).catch(() => {});
          });
        }
      })
      .catch(() => {});

    // Tools — use real descriptions
    agent.call("getToolDescriptions", [])
      .then((result) => {
        const r = result as { builtIn: Array<{ name: string; description: string }>; crafted: Array<{ name: string; description: string; isLearned?: boolean; qualityScore?: number; usageCount?: number }> };
        const builtInTools: ToolInfo[] = r.builtIn.map(t => ({
          name: t.name, description: t.description, scope: "local" as const,
          qualityScore: 1, usageCount: 0, lastUsed: "",
        }));
        const craftedTools: ToolInfo[] = r.crafted.map(t => ({
          name: t.name, description: t.description, scope: "global" as const,
          qualityScore: t.qualityScore ?? 0.5, usageCount: t.usageCount ?? 0, lastUsed: "",
        }));
        setTools([...builtInTools, ...craftedTools]);
      })
      .catch(() => {
        // Fallback to getToolList — note that crafted tools from getToolList come
        // with scope: 'local' from CraftStore, but the Tools pane uses scope
        // === 'global' to render the "Learned" badge, so we re-tag them here.
        agent.call("getToolList", [])
          .then((result) => {
            const r = result as {
              builtIn: string[];
              crafted: Array<{ name: string; description: string; scope: string; qualityScore: number; usageCount: number }>;
            };
            const builtInTools: ToolInfo[] = r.builtIn.map(name => ({
              name, description: "Built-in tool", scope: "local" as const,
              qualityScore: 1, usageCount: 0, lastUsed: "",
            }));
            const craftedTools: ToolInfo[] = r.crafted.map(t => ({
              name: t.name, description: t.description, scope: "global" as const,
              qualityScore: t.qualityScore ?? 0.5, usageCount: t.usageCount ?? 0, lastUsed: "",
            }));
            setTools([...builtInTools, ...craftedTools]);
          })
          .catch(() => {});
      });

    // Memory — load the actual MEMORY.md content
    agent.call("getMemoryContent", [])
      .then((content) => {
        const text = content as string;
        setMemoryContent(text);
        if (text) {
          // Parse into MemoryEntry[] for the UI
          const entries = parseMemoryContent(text);
          setMemory(entries);
        }
      })
      .catch(() => {});

    // MCTS tree
    agent.call("getMctsTree", [])
      .then((nodes) => {
        const list = nodes as Array<{
          id: string; parent_id: string | null; depth: number;
          visits: number; value: number; status: string; action: string;
        }>;
        if (list.length > 0) setMctsTree(buildTree(list));
      })
      .catch(() => {});

    // Unified run timeline spine.
    agent.call("getRunTimeline", [{ limit: 250 }])
      .then(spans => setRunTimeline(spans as TimelineSpan[]))
      .catch(() => {});

    // Executors
    agent.call("getExecutors", [])
      .then((list) => {
        setExecutors(list as Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>);
        // Load output history for each executor
        for (const exec of list as Array<{ name: string }>) {
          agent.call("getExecutorOutput", [exec.name, 50])
            .then((rows) => {
              setExecutorOutputs(prev => {
                const next = new Map(prev);
                next.set(exec.name, (rows as Array<{ id: string; command: string; stdout: string; stderr: string; exit_code: number; created_at: number }>).reverse());
                return next;
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    fetched.current = false;
    setAgentStatus(null);
    setTools([]);
    setMemory([]);
    setMemoryContent("");
    setMctsTree(null);
    setRunTimeline([]);
    setError(null);
  }, [agentId]);

  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(null), 10_000);
      return () => clearTimeout(t);
    }
  }, [error]);

  const sendChat = useCallback((content: string) => {
    sendMessage({ role: "user", parts: [{ type: "text", text: content }] });
  }, [sendMessage]);

  const searchMemory = useCallback((q: string) => {
    if (!q.trim()) {
      // Empty search — re-parse full content
      if (memoryContent) setMemory(parseMemoryContent(memoryContent));
      return;
    }
    agent.call("doSearchMemory", [q])
      .then((results) => {
        // Map MemorySearchResult (snippet, score) → MemoryEntry (content, updatedAt)
        const mapped = ((results ?? []) as Array<{
          path: string; startLine?: number; endLine?: number; snippet: string; score: number;
        }>).map(r => ({
          path: r.path,
          content: r.snippet,
          matchScore: r.score,
          updatedAt: r.startLine ? `lines ${r.startLine}-${r.endLine}` : "",
        }));
        setMemory(mapped);
      })
      .catch(() => {});
  }, [agent, memoryContent]);

  const setModel = useCallback((modelId: string) => {
    // Optimistically reflect in the UI so the dropdown doesn't snap back
    // while the RPC is in flight.
    setAgentStatus(prev => prev ? { ...prev, model: modelId } : prev);
    agent.call("setModel", [modelId]).then((result) => {
      // Server may have normalized the spec — sync the UI to authoritative value.
      const r = result as { ok?: boolean; spec?: string };
      if (r?.spec) setAgentStatus(prev => prev ? { ...prev, model: r.spec! } : prev);
    }).catch((err) => {
      // Surface to the user, never swallow. Roll the UI back so the select
      // reflects the actually-stored value.
      console.error('[setModel] failed:', err);
      // Re-fetch the authoritative stored spec.
      agent.call("getStoredModelSpec", []).then((r) => {
        const stored = (r as { spec?: string | null }).spec ?? '';
        setAgentStatus(prev => prev ? { ...prev, model: stored } : prev);
      }).catch(() => {});
    });
  }, [agent]);

  // Single source of truth: the server-side broadcast. executeInExecutor ONLY
  // fires the RPC; the broadcast handler below renders the row. This prevents
  // the double-output bug where the optimistic append AND the broadcast both
  // fired for one invocation (race-ordering made dedup windows unreliable).
  const executeInExecutor = useCallback((executorId: string, command: string) => {
    return agent.call("executeInExecutor", [executorId, command]).then(r =>
      r as { stdout?: string; stderr?: string; exitCode?: number; error?: string });
  }, [agent]);

  // Listen for executor-output broadcasts — emitted by the orchestrator on
  // every exec completion (user- or agent-triggered). Attach to the outer
  // `agent` EventTarget so the listener survives reconnects (STABILITY-AUDIT
  // §A3, D5).
  useEffect(() => {
    if (!agent) return;
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      try {
        const msg = JSON.parse(typeof data === "string" ? data : "");
        if (msg.type === "executor-output") {
          setExecutorOutputs(prev => {
            const next = new Map(prev);
            const existing = next.get(msg.executor) ?? [];
            next.set(msg.executor, [...existing, {
              id: crypto.randomUUID(), command: msg.command,
              stdout: msg.stdout ?? "", stderr: msg.stderr ?? "",
              exit_code: msg.exitCode ?? 0, created_at: msg.timestamp,
            }]);
            return next;
          });
        }
      } catch { /* ignore non-JSON */ }
    };
    agent.addEventListener("message", handler as EventListener);
    return () => agent.removeEventListener("message", handler as EventListener);
  }, [agent]);

  // Poll the sandbox executor's exposed ports every 4s while connected, so
  // the Executors-tab badge + inline preview cards see new ports promptly
  // even when the user is on a different tab. We hard-code "sandbox" here
  // because that's the only executor that returns non-empty rows (others
  // return [] cheaply). (STABILITY-AUDIT §C4.)
  useEffect(() => {
    if (connectionStatus !== "connected") { setPinnedPorts([]); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await agent.call("getExposedPorts", ["sandbox"]) as {
          ports?: Array<{ port: number; url?: string; name?: string }>;
        };
        if (cancelled) return;
        setPinnedPorts((r.ports ?? [])
          .filter(p => typeof p.port === "number" && p.url)
          .map(p => ({ port: p.port, url: p.url!, name: p.name })));
      } catch { /* ignore transient */ }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [agent, connectionStatus]);

  return {
    messages,
    isStreaming,
    connectionStatus,
    error,
    agentStatus,
    tools,
    memory,
    memoryContent,
    mctsTree,
    runTimeline,
    sendChat,
    abortChat: stop,
    searchMemory,
    refreshTools: () => loadAllData(),
    clearHistory,
    setModel,
    executors,
    executorOutputs,
    executeInExecutor,
    /** Exposed ports across all sandbox-capable executors (currently just sandbox). */
    pinnedPorts,
    /**
     * Fork this agent at a message. Returns the new agent's navigation URL
     * on success, or throws on error ('agent busy', 'fork point not found',
     * 'agent name already exists', etc.).
     */
    forkAgent: (untilMessageId: string, opts?: { name?: string }) =>
      agent.call("forkAgent", [untilMessageId, opts ?? {}]) as Promise<{
        id: string; name: string; url: string; forkPointMs: number;
      }>,
    rpc: agent.call.bind(agent),
    rawAgent: agent,
  };
}

/**
 * Lightweight connection-only hook for HomePage (no chat needed).
 */
export function useHomeConnection() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  const agent = useAgent({
    agent: "orchestrator-agent",
    name: "home",
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
    onError: useCallback(() => setStatus("error"), []),
  });

  return { status, agent };
}

// ── Helpers ──────────────────────────────────────────────────────

function buildTree(nodes: Array<{
  id: string; parent_id: string | null; depth: number;
  visits: number; value: number; status: string; action: string;
  task?: string; observation?: string; created_at?: number;
}>): MCTSNode {
  const map = new Map<string, MCTSNode>();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id, parentId: n.parent_id, depth: n.depth, visits: n.visits,
      value: n.value, status: n.status as MCTSNode["status"], action: n.action,
      task: n.task, observation: n.observation, createdAt: n.created_at,
      children: [],
    });
  }
  let root: MCTSNode | null = null;
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else if (!root || node.depth < root.depth) {
      root = node;
    }
  }
  return root ?? { id: "root", parentId: null, depth: 0, visits: 0, value: 0, status: "open", action: "root", children: [] };
}

/** Parse MEMORY.md sections into MemoryEntry[] for the UI */
function parseMemoryContent(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const sections = content.split(/\n(?=###|##)/);
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0] ?? "";
    const body = lines.slice(1).join("\n").trim();
    if (!body || !header) continue;
    entries.push({
      path: "memory/MEMORY.md",
      content: body,
      matchScore: 1,
      updatedAt: header.replace(/^#+\s*/, ""),
    });
  }
  return entries;
}
