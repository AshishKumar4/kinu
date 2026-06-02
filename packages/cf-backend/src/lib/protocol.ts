/**
 * Proteus WebSocket protocol — shared types for client <-> server communication.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AgentInfo {
	id: string;
	name: string;
	status: "running" | "idle" | "evolving" | "error";
	task: string;
	scaffoldVersion: number;
	mctsIterations: number;
	toolCount: number;
	uptime: string;
	createdAt: string;
	model: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool_call" | "evolution";
	content: string;
	timestamp: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	evolutionType?: string;
	/** Inline parts for assistant messages that include tool calls */
	parts?: StreamPart[];
}

/** A segment of a streaming assistant response — rendered chronologically */
export type StreamPart =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolName: string; args: Record<string, unknown> }
	| { type: "tool-result"; toolName: string; result: string };

export interface MCTSNode {
	id: string;
	parentId: string | null;
	depth: number;
	value: number;
	visits: number;
	status: "open" | "pruned" | "terminal" | "failed";
	action: string;
	children: MCTSNode[];
	task?: string;
	observation?: string;
	createdAt?: number;
}

export interface ToolInfo {
	name: string;
	description: string;
	scope: "local" | "global";
	qualityScore: number;
	usageCount: number;
	lastUsed: string;
}

export interface MemoryEntry {
	path: string;
	content: string;
	matchScore: number;
	updatedAt: string;
}

/** One directory entry in the per-executor file manager (getExecutorFiles).
 *  Normalized across executors (each provider's readdir has its own format). */
export interface DirEntry {
	name: string;
	type: "file" | "dir";
	size?: number;
}

/** Typed agent RPC. The single boundary cast (unknown → T) lives in the hook's
 *  wrapper, so call sites read `rpc<Foo>("getFoo", [])` cast-free. */
export type Rpc = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** One typed span on the unified Run Timeline spine (getRunTimeline). The
 *  server merges run_events + evolution_events + search_nodes into this single
 *  ordered shape so the client never re-merges three sources (no drift). */
export type TimelineKind =
	| "llm-turn" | "tool-call" | "runtime-exec" | "mcts" | "scaffold" | "shadow-eval"
	| "craft" | "reflection" | "head-split" | "head-merge" | "gepa" | "skills"
	| "curriculum" | "trigger" | "event-ingress" | "error" | "abort" | "recovery" | "other";

export interface TimelineSpan {
	ts: number;
	kind: TimelineKind;
	label: string;
	detail?: string;
	/** Latency in ms when known (tool calls, activity timings). */
	elapsedMs?: number;
	/** Preserved structured payload (e.g. evolution_events.data) for drill-in. */
	data?: unknown;
	source: "run" | "evolution" | "mcts";
	/** Id for driving the work surface (node id, run-event id, root id…). */
	refId?: string;
	/** Original backend event type, for finer UI affordances. */
	rawType?: string;
}

export interface EvolutionEvent {
	id: string;
	timestamp: string;
	type: "scaffold_update" | "tool_crafted" | "mcts_converged" | "reflection" | "pruned";
	description: string;
	version?: number;
	score?: number;
}

export interface AgentConfig {
	model: string;
	mctsBudget: number;
	mctsBranches: number;
	explorationWeight: number;
	pruneThreshold: number;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
	| { type: "chat"; content: string }
	| { type: "ping" }
	| { type: "rpc"; rpcId: string; method: string; args: unknown[] };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
	// State synchronization
	| { type: "state"; agents: AgentInfo[] }
	| { type: "agent-state"; agent: AgentInfo }

	// Chat streaming — chronological events within a single response
	| { type: "history"; agentId: string; messages: ChatMessage[] }
	| { type: "message-saved"; agentId: string; message: ChatMessage }
	| { type: "stream-start"; agentId: string; messageId: string }
	| { type: "text-delta"; agentId: string; messageId: string; delta: string }
	| { type: "tool-call-delta"; agentId: string; messageId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool-result-delta"; agentId: string; messageId: string; toolName: string; result: string }
	| { type: "stream-finish"; agentId: string; messageId: string; parts: StreamPart[] }

	// MCTS updates
	| { type: "mcts-update"; agentId: string; tree: MCTSNode }
	| { type: "mcts-node-added"; agentId: string; node: MCTSNode; parentId: string }
	| { type: "mcts-node-pruned"; agentId: string; nodeId: string }
	| { type: "mcts-converged"; agentId: string; winnerId: string; score: number }

	// Evolution events
	| { type: "evolution-event"; agentId: string; event: EvolutionEvent }

	// Tool updates
	| { type: "tool-crafted"; agentId: string; tool: ToolInfo }
	| { type: "tool-updated"; agentId: string; tool: ToolInfo }

	// RPC response
	| { type: "rpc-response"; rpcId: string; result: unknown }
	| { type: "rpc-error"; rpcId: string; error: string }

	// Errors
	| { type: "error"; error: string };
