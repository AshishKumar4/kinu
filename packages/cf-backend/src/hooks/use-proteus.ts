/**
 * Proteus agent hooks — useAgent() + useAgentChat() from Agents SDK.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ToolInfo, MemoryEntry, MCTSNode } from "../lib/protocol";
import { registerAgent } from "../lib/agent-registry";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

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
}

export interface EvolutionEventRow {
  id: string;
  type: string;
  message: string;
  data: string | null;
  created_at: number;
}

/**
 * Full agent hook for WorkspacePage — connects to a specific DO instance.
 * Fetches all tab data via @callable RPCs on connect.
 */
export interface LogEntry {
  id: string;
  time: number;
  type: "connection" | "tool" | "evolution" | "error" | "info";
  message: string;
  detail?: string;
}

export function useProteus(agentId?: string) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [mctsTree, setMctsTree] = useState<MCTSNode | null>(null);
  const [evolutionEvents, setEvolutionEvents] = useState<EvolutionEventRow[]>([]);
  const [memoryContent, setMemoryContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [executors, setExecutors] = useState<Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>>([]);
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, Array<{ id: string; command: string; stdout: string; stderr: string; exit_code: number; created_at: number }>>>(new Map());

  const addLog = useCallback((type: LogEntry["type"], message: string, detail?: string) => {
    setLogs(prev => [...prev.slice(-99), { id: crypto.randomUUID(), time: Date.now(), type, message, detail }]);
  }, []);

  const agent = useAgent({
    agent: "orchestrator-agent",
    name: agentId || "default",
    onOpen: useCallback(() => {
      setConnectionStatus("connected");
      addLog("connection", "WebSocket connected");
    }, [addLog]),
    onClose: useCallback(() => {
      setConnectionStatus("disconnected");
      addLog("connection", "WebSocket disconnected");
    }, [addLog]),
    onError: useCallback(() => {
      setConnectionStatus("error");
      addLog("error", "WebSocket error");
    }, [addLog]),
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    stop,
    isStreaming,
  } = useAgentChat({ agent });

  const isConnected = connectionStatus === "connected";

  // Fetch all tab data on connect
  const fetched = useRef(false);
  useEffect(() => {
    if (!isConnected || fetched.current) return;
    fetched.current = true;
    loadAllData();
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh evolution events + logs when streaming ends (a turn completed)
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreaming.current = true;
      addLog("info", "Streaming started");
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      addLog("info", "Streaming ended — refreshing data");
      refreshLiveData();
    }
  }, [isStreaming, agent, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adaptive polling: 1s during streaming for near-real-time logs, 5s when idle
  useEffect(() => {
    if (!isConnected) return;
    const ms = isStreaming ? 1000 : 5000;
    const interval = setInterval(refreshLiveData, ms);
    return () => clearInterval(interval);
  }, [isConnected, isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for MCTS progress broadcasts from the server
  useEffect(() => {
    if (!isConnected) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "mcts-progress") {
          addLog("evolution", `MCTS ${msg.phase}: ${msg.nodeCount ?? 0} nodes (iter ${msg.iteration ?? "?"})`);
          if (msg.nodes && msg.nodes.length > 0) {
            setMctsTree(buildTree(msg.nodes));
          }
          agent.call("getEvolutionEvents", [200])
            .then(events => setEvolutionEvents((events as EvolutionEventRow[]).reverse()))
            .catch(() => {});
        }
        // activity-log events are NOT handled here — getLogs() polling is the
        // single source of truth for activity entries. Handling them via both
        // WS and polling caused triple-counting (WS IDs are UUIDs, SQL IDs are
        // hex strings — the dedup logic could never match them).
      } catch { /* not JSON or not our message */ }
    };
    const ws = (agent as unknown as { _ws?: WebSocket })._ws;
    ws?.addEventListener("message", handler);
    return () => ws?.removeEventListener("message", handler);
  }, [isConnected, agent, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  function refreshLiveData() {
    agent.call("getEvolutionEvents", [200])
      .then(events => setEvolutionEvents((events as EvolutionEventRow[]).reverse()))
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
    // Server is the single source of truth for activity + evolution logs.
    // Only client-generated entries (connection lifecycle) are preserved.
    agent.call("getLogs", [100])
      .then((serverLogs) => {
        const sl = serverLogs as Array<{ id: string; time: number; type: string; message: string; detail?: string }>;
        setLogs(prev => {
          const clientOnly = prev.filter(l => l.type === "connection");
          const merged = [...clientOnly, ...sl.map(s => ({ ...s, type: s.type as LogEntry["type"] }))];
          merged.sort((a, b) => a.time - b.time);
          return merged.slice(-100);
        });
      })
      .catch(() => {});
  }

  // Log tool calls as they appear in messages
  const seenToolCalls = useRef(new Set<string>());
  useEffect(() => {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if ("toolCallId" in part) {
          const tcId = (part as { toolCallId: string }).toolCallId;
          const toolName = (part as { toolName?: string }).toolName ?? "tool";
          const state = (part as { state?: string }).state;
          if (!seenToolCalls.current.has(tcId)) {
            seenToolCalls.current.add(tcId);
            addLog("tool", `Tool called: ${toolName}`, `state: ${state}`);
          } else if (state === "output-available" || state === "output-error") {
            addLog("tool", `Tool ${state === "output-available" ? "completed" : "failed"}: ${toolName}`);
          }
        }
      }
    }
  }, [messages, addLog]);

  function loadAllData() {
    agent.call("getAgentStatus", [])
      .then((s) => {
        const status = s as AgentStatus;
        setAgentStatus(status);
        if (agentId) registerAgent(agentId, status.displayName || status.name, status.purpose);
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

    // Evolution events
    agent.call("getEvolutionEvents", [50])
      .then((events) => {
        setEvolutionEvents((events as EvolutionEventRow[]).reverse()); // oldest first for timeline
      })
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
    setEvolutionEvents([]);
    setError(null);
    setLogs([]);
    seenToolCalls.current.clear();
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

  const refreshEvolution = useCallback(() => {
    agent.call("getEvolutionEvents", [50])
      .then((events) => setEvolutionEvents((events as EvolutionEventRow[]).reverse()))
      .catch(() => {});
  }, [agent]);

  const setModel = useCallback((modelId: string) => {
    agent.call("setModel", [modelId]).then(() => {
      setAgentStatus(prev => prev ? { ...prev, model: modelId } : prev);
    }).catch(() => {});
  }, [agent]);

  // Single source of truth: the server-side broadcast. executeInExecutor ONLY
  // fires the RPC; the broadcast handler below renders the row. This prevents
  // the double-output bug where the optimistic append AND the broadcast both
  // fired for one invocation (race-ordering made dedup windows unreliable).
  const executeInExecutor = useCallback((executorId: string, command: string) => {
    return agent.call("executeInExecutor", [executorId, command]).then(r =>
      r as { stdout?: string; stderr?: string; exitCode?: number; error?: string });
  }, [agent]);

  // Listen for executor-output broadcasts — the orchestrator broadcasts
  // whenever an exec completes (user-triggered OR agent-triggered via a
  // `run` tool). Render one row per broadcast.
  useEffect(() => {
    if (!isConnected) return;
    const ws = (agent as unknown as { _ws?: WebSocket })._ws;
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.type === 'executor-output') {
          setExecutorOutputs(prev => {
            const next = new Map(prev);
            const existing = next.get(msg.executor) ?? [];
            next.set(msg.executor, [...existing, {
              id: crypto.randomUUID(), command: msg.command,
              stdout: msg.stdout ?? '', stderr: msg.stderr ?? '',
              exit_code: msg.exitCode ?? 0, created_at: msg.timestamp,
            }]);
            return next;
          });
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [isConnected, agent]);

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
    evolutionEvents,
    logs,
    sendChat,
    abortChat: stop,
    searchMemory,
    refreshEvolution,
    refreshTools: () => loadAllData(),
    clearHistory,
    setModel,
    executors,
    executorOutputs,
    executeInExecutor,
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
