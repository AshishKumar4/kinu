/**
 * Re-export protocol types as the "API" surface.
 * All actual communication goes through the WebSocket hooks,
 * not REST fetch calls. This file exists only for type convenience.
 */
export type {
	AgentInfo,
	ChatMessage,
	MCTSNode,
	ToolInfo,
	MemoryEntry,
	EvolutionEvent,
	AgentConfig,
	ClientMessage,
	ServerMessage,
} from "./protocol";
