/**
 * AgentClient — the presentation contract every chat surface (TUI, classic
 * REPL, one-shot run, rpc) drives, with one adapter per backend:
 * LocalAgentClient over LocalAgentSession and CloudAgentClient over the
 * OrchestratorAgent DO websocket. UIs never branch on backend; anything only
 * one backend supports is exposed through the capability surfaces below
 * (`consents`, `localControls`) and is null elsewhere.
 */

import type { BroadcastEvent, PromptFile, ShellApprovalMode } from '@proteus/core';
import type { CliSession, CliSessionInfo } from './session.js';
import type { AgentModelEntry } from './model-catalog.js';

export type AgentClientMode = 'local' | 'cloud';

/** A user prompt: plain text, or text plus file attachments (data-URL
 *  PromptFiles, built from @path mentions by the chat surfaces). */
export type AgentPrompt = string | { text: string; files: ReadonlyArray<PromptFile> };

export function promptText(prompt: AgentPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.text;
}

export function promptFiles(prompt: AgentPrompt): ReadonlyArray<PromptFile> {
  return typeof prompt === 'string' ? [] : prompt.files;
}

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
  /** User message delivered mid-turn through steer(). */
  steered?: boolean;
}

/** A walk-back fork point: a user message identified by its verbatim text and
 *  its occurrence among same-text user messages counted from the newest (1 =
 *  most recent). Robust across surfaces whose message ids don't align with the
 *  backend's canonical store. */
export interface ForkPoint {
  text: string;
  occurrenceFromEnd: number;
}

export interface AgentForkResult {
  /** The client to continue on: `this` re-pointed (local) or a sibling client
   *  for the forked cloud agent. Callers must switch and close the old client
   *  when a different instance is returned. */
  client: AgentClient;
  /** Human-readable description of what was forked (session id / agent name). */
  label: string;
}

/** Index of the fork-point user message in a canonical row list, or -1 when
 *  the point cannot be located (the surfaces' view drifted from the store). */
export function findForkPivot(
  rows: ReadonlyArray<{ role: string; content: string }>,
  point: ForkPoint,
): number {
  let remaining = point.occurrenceFromEnd;
  const target = point.text.trim();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.role !== 'user' || row.content.trim() !== target) continue;
    remaining -= 1;
    if (remaining === 0) return i;
  }
  return -1;
}

/** Pick the walk-back candidates from a rendered message list: the most recent
 *  user messages (newest first), each with the occurrence index fork() needs. */
export function forkCandidates(
  messages: ReadonlyArray<{ role: string; content: string }>,
  limit = 10,
): ForkPoint[] {
  const seen = new Map<string, number>();
  const candidates: ForkPoint[] = [];
  for (let i = messages.length - 1; i >= 0 && candidates.length < limit; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.content.trim();
    if (!text) continue;
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    candidates.push({ text, occurrenceFromEnd: occurrence });
  }
  return candidates;
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
  send(prompt: AgentPrompt, opts?: AgentClientSendOptions): Promise<AgentTurnResult>;
  /** Deliver a user message while a turn is in flight. Local sessions inject
   *  it into the RUNNING turn at the next role-safe step boundary; cloud
   *  sessions submit it immediately and the DO runs it as the next serialized
   *  turn. Returns false when no turn is active — use send() instead. */
  steer(prompt: AgentPrompt, opts?: AgentClientSendOptions): boolean;
  /** Walk-back fork: start a new conversation containing the history strictly
   *  BEFORE the given user message. Local agents re-point this client to a
   *  forked CLI session + copied conversation; cloud agents fork the agent DO
   *  (forkAgent RPC) and return a sibling client for it. */
  fork(point: ForkPoint): Promise<AgentForkResult>;
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

export function createUserUiMessage(text: string, files: ReadonlyArray<PromptFile> = []): AgentUiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      ...files.map((f) => ({ type: 'file', mediaType: f.mediaType, filename: f.filename, url: f.url })),
      ...(text || files.length === 0 ? [{ type: 'text', text }] : []),
    ],
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { input: value };
}
