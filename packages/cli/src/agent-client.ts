/**
 * AgentClient — the presentation contract every chat surface (TUI, classic
 * REPL, one-shot run, rpc) drives, with one adapter per backend:
 * LocalAgentClient over LocalAgentSession and CloudAgentClient over the
 * OrchestratorAgent DO websocket. UIs never branch on backend; anything only
 * one backend supports is exposed through the capability surfaces below
 * (`consents`, `localControls`) and is null elsewhere.
 */

import type { BroadcastEvent, ShellApprovalMode } from '@proteus/core';
import type { CliSession, CliSessionInfo } from './session.js';
import type { AgentModelEntry } from './model-catalog.js';

export type AgentClientMode = 'local' | 'cloud';

export interface AgentToolCallResult {
  name: string;
  args: unknown;
  result?: string;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCallResult[];
  steps: number;
  durationMs: number;
  hadError: boolean;
}

export type AgentClientEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'step-finish'; stepIndex: number }
  | { type: 'turn-end'; turn: AgentTurnResult }
  | { type: 'evolution'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  | { type: 'error'; message: string };

export interface AgentClientSendOptions {
  cwd?: string;
}

export interface AgentClientStatus {
  name: string;
  purpose: string;
  model: string | null;
  scaffoldVersion?: number;
  messageCount?: number;
  searchNodeCount?: number;
  craftedToolCount?: number;
  taskCount?: number;
  memorySize?: number;
  dbSize?: number;
  toolCount?: number;
  /** Local-only: whether turn/session auto-evolution is enabled. */
  autoEvolve?: boolean;
}

export interface AgentToolDescription {
  name: string;
  description: string;
}

export interface AgentToolSurface {
  builtIn: AgentToolDescription[];
  crafted: AgentToolDescription[];
}

export interface AgentJobSummary {
  id: string;
  kind: string;
  status: string;
}

/** The MCTS-tree projection both backends serve from their search_nodes table. */
export interface AgentSearchNode {
  depth: number;
  status: string;
  value: number;
  visits: number;
  action: string | null;
}

/** A rendered transcript/history message. Structurally a subset of the TUI's
 *  DisplayMessage so surfaces can show it directly. */
export interface AgentTranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';
  content: string;
  toolName?: string;
  args?: string;
}

export interface PendingDeviceConsent {
  consentId: string;
  deviceLabel: string;
  method: string;
  command: string;
}

export type DeviceConsentDecision = 'once' | 'always' | 'deny';

/** Capability surface: device-tunnel consent requests (cloud agents). */
export interface DeviceConsentSurface {
  listPending(): Promise<PendingDeviceConsent[]>;
  resolve(consentId: string, decision: DeviceConsentDecision): Promise<{ ok: boolean }>;
}

/** Capability surface: knobs that only exist on an in-process local session. */
export interface LocalSessionControls {
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: string[]): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): ShellApprovalMode;
  listModelProviders(): Promise<Array<{ id: string; available: boolean; unavailableReason?: string }>>;
}

export interface AgentClient {
  readonly mode: AgentClientMode;
  readonly agentName: string;
  /** The JSONL terminal log this client records to (never cloud chat state). */
  readonly cliSession: CliSession;
  readonly consents: DeviceConsentSurface | null;
  readonly localControls: LocalSessionControls | null;

  /** Bring up startup resources (MCP servers, orphaned-job recovery). Input
   *  should not be accepted before this resolves. */
  connect(): Promise<void>;
  /** Observe the full event stream: user turns, programmatic/reactor turns,
   *  evolution markers, and errors. */
  subscribe(listener: (event: AgentClientEvent) => void): () => void;
  /** Run one user turn. Events stream through subscribe(); the JSONL log is
   *  appended internally. */
  send(prompt: string, opts?: AgentClientSendOptions): Promise<AgentTurnResult>;
  /** Interrupt the in-flight turn (Esc / Ctrl+C / /stop). */
  stop(): void;
  close(): Promise<void>;

  /** Canonical conversation history: the DO chat projection for cloud, the
   *  recorded terminal transcript for local. */
  history(): Promise<AgentTranscriptMessage[]>;
  /** Recorded terminal sessions for this agent (local JSONL logs). */
  listSessions(): CliSessionInfo[];
  /** Re-point the client at a recorded session: swaps the JSONL log and, for
   *  local agents, the durable conversation. */
  resumeConversation(sessionRef: string): Promise<void>;

  status(): Promise<AgentClientStatus>;
  describeTools(): Promise<AgentToolSurface>;
  readMemory(): Promise<string>;
  searchNodes(): Promise<AgentSearchNode[]>;
  listJobs(limit?: number): Promise<AgentJobSummary[]>;
  getModelSpec(): Promise<string | null>;
  /** Set the agent's model. Local: the session/agent_config spec; cloud: the
   *  durable agent model (same semantics as the web UI). */
  setModel(spec: string): Promise<{ spec: string }>;
  listModels(): Promise<AgentModelEntry[]>;
}

export interface AgentUiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: Array<Record<string, unknown>>;
}

export function createUserUiMessage(text: string): AgentUiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { input: value };
}
