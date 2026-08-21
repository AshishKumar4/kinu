/**
 * AgentClient — the presentation contract every chat surface (TUI, classic
 * REPL, one-shot run, rpc) drives, with one adapter per backend:
 * LocalAgentClient over LocalAgentSession and CloudAgentClient over the
 * OrchestratorAgent DO websocket. UIs never branch on backend; anything only
 * one backend supports is exposed through the capability surfaces below
 * (`consents`, `localControls`, `checkpoints`) and is null elsewhere.
 */

import { JsonObjectSchema } from '@kinu.run/core';
import type {
  BroadcastEvent, ChangelogEntry, ChangelogRevertResult, PromptFile, ShellApprovalMode,
  FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  AlternateTakeSet, TakePickOutcome,
  EvolutionConfigView,
  ReasoningEffort, Usage, RunEvent, JsonObject, JsonValue,
} from '@kinu.run/core';
import type { ShellApprovalHandler } from '@kinu.run/cli-backend';
import type { CliSession, CliSessionInfo } from './session';
import type { AgentModelMenu } from './model-catalog';
import * as v from 'valibot';

export type AgentClientMode = 'local' | 'cloud';

/** A user prompt: plain text, or text plus file attachments (data-URL
 *  PromptFiles, built from @path mentions by the chat surfaces). */
export type AgentPrompt = string | { text: string; files: ReadonlyArray<PromptFile> };
const AgentPromptObjectSchema = v.object({
  text: v.string(),
  files: v.array(v.object({ filename: v.string(), mediaType: v.string(), url: v.string() })),
});

export function promptText(prompt: AgentPrompt): string {
  const text = v.safeParse(v.string(), prompt);
  return text.success ? text.output : v.parse(AgentPromptObjectSchema, prompt).text;
}

export function promptFiles(prompt: AgentPrompt): ReadonlyArray<PromptFile> {
  const text = v.safeParse(v.string(), prompt);
  return text.success ? [] : v.parse(AgentPromptObjectSchema, prompt).files;
}

export interface AgentToolCallResult {
  name: string;
  args: JsonObject;
  result?: string;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCallResult[];
  steps: number;
  durationMs: number;
  hadError: boolean;
  /** Provider-reported token usage for the turn, absent when the provider
   *  reported nothing. Local backend only — the cloud websocket protocol does
   *  not carry per-turn usage. */
  usage?: Usage;
}

export type AgentClientEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: string; success: boolean }
  | { type: 'step-finish'; stepIndex: number }
  | { type: 'turn-end'; turn: AgentTurnResult }
  | { type: 'evolution'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** One row of the durable run-event ledger, forwarded as it is written:
   *  delegation nudges, the context budget, refused mission budgets, and the
   *  run bracket around them. Instrumentation rather than conversation — the
   *  human surfaces ignore it and `--json` emits it verbatim, which is what
   *  makes the ledger readable from outside the agent's own database. Local
   *  backend only: a cloud agent's ledger lives in the DO, which serves it
   *  over /api/runs/<id>/stream and MCP `list_run_events`. */
  | { type: 'run-event'; event: RunEvent }
  | { type: 'error'; message: string };

export interface AgentClientSendOptions {
  cwd?: string;
}

export interface AgentClientStatus {
  name: string;
  purpose: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
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
  /** User redirect run as a parallel branch through branch(). */
  branched?: boolean;
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

/** The Evolution Changelog digest as surfaces consume it. `unseenCount` is
 *  the pre-view value (what the badge showed); fetching marks the digest
 *  seen — viewing IS the acknowledgement. */
export interface AgentChangelogView {
  entries: ChangelogEntry[];
  unseenCount: number;
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

/** Capability surface: shadow-git file checkpoints (/undo). Local agents hit
 *  the host engine directly; cloud agents go through orchestrator RPCs that
 *  forward to the connected device daemon.
 *
 *  `list` carries reachability with the entries so a caller cannot read an empty
 *  list as a statement about the turn — see {@link FileCheckpointListing}. */
export interface FileCheckpointSurface {
  /** `turnId` narrows in the STORE, which is the only way to read one turn
   *  completely: `limit` is global across working directories while retention is
   *  per directory, so a window can hold part of a turn. See
   *  FileCheckpoints.list in @kinu.run/core. */
  list(limit?: number, turnId?: string): Promise<FileCheckpointListing>;
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  restore(dir: string, id: string): Promise<FileRestoreResult>;
}

/** Capability surface: knobs that only exist on an in-process local session. */
export interface LocalSessionControls {
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: string[]): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): ShellApprovalMode;
  /** Install the interactive approval channel for gated shell commands (ACP's
   *  session/request_permission). Returns a disposer. Local only: a cloud turn
   *  runs in the DO, which has no synchronous path back to this process. */
  setShellApprovalHandler(handler: ShellApprovalHandler | null): () => void;
  listModelProviders(): Promise<Array<{ id: string; available: boolean; unavailableReason?: string }>>;
}

export interface AgentClient {
  readonly mode: AgentClientMode;
  readonly agentName: string;
  /** The JSONL terminal log this client records to (never cloud chat state). */
  readonly cliSession: CliSession;
  readonly consents: DeviceConsentSurface | null;
  readonly localControls: LocalSessionControls | null;
  readonly checkpoints: FileCheckpointSurface | null;
  /** Per-message aggregate cap on raw bytes this backend will accept inlined
   *  as data-URL file parts. A storage row limit on the cloud, a provider
   *  request budget locally — the two numbers differ by 8×, so the chat
   *  surfaces ask rather than assume. */
  readonly inlineAttachmentLimitBytes: number;

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
  /** Steer-as-Branch: run the prompt as a parallel budgeted head against the
   *  live turn's input snapshot WITHOUT interrupting it. When both finish the
   *  pair settles into Alternate Takes (progress + settle stream as
   *  'branch_status' broadcast events). Returns false when no turn is active —
   *  use send() instead. */
  branch(prompt: AgentPrompt, opts?: AgentClientSendOptions): boolean;
  /** Walk-back fork: start a new conversation containing the history strictly
   *  BEFORE the given user message. Local agents re-point this client to a
   *  forked CLI session + copied conversation; cloud agents fork the agent DO
   *  (forkAgent RPC) and return a sibling client for it. */
  fork(point: ForkPoint): Promise<AgentForkResult>;
  /** Interrupt the in-flight turn (Esc / Ctrl+C / /stop). Returns steer texts
   *  that were accepted mid-turn but never delivered to the model — surfaces
   *  already rendered them as sent, so they must be handed back to the user,
   *  not dropped silently. Empty when nothing was pending (cloud steers
   *  persist server-side immediately, so the cloud client always returns []). */
  stop(): string[];
  /** Drain in-flight background work (detached jobs + the wake turns they
   *  trigger) to completion. A one-shot surface calls this after its turn and
   *  before it stops listening/closes, so a turn that backgrounded work streams
   *  its second half instead of being cut off at process exit. Local only —
   *  cloud jobs settle server-side in the DO, which outlives the CLI. */
  settleBackgroundWork?(): Promise<void>;
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
  /** The Evolution Changelog digest; fetching marks it seen. */
  changelog(limit?: number): Promise<AgentChangelogView>;
  /** Revert one changelog entry by id through the real rollback paths. */
  revertChangelogEntry(id: string): Promise<ChangelogRevertResult>;
  readMemory(): Promise<string>;
  searchNodes(): Promise<AgentSearchNode[]>;
  listJobs(limit?: number): Promise<AgentJobSummary[]>;
  /** The newest Alternate Takes set — near-tied MCTS candidates from the
   *  last think-mcts convergence, or the live/branch pair from a settled
   *  /branch redirect (AlternateTakeSource) — or null when none exist yet. */
  latestTakes(): Promise<AlternateTakeSet | null>;
  /** Pick one take: records the explicit preference into the outcome ledger,
   *  re-points the convergence record on a sibling pick, and (when the pick
   *  changes the answer) queues the continuation turn. */
  pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome>;
  getModelSpec(): Promise<string | null>;
  /** Set the agent's model. Local: the session/agent_config spec; cloud: the
   *  durable agent model (same semantics as the web UI). */
  setModel(spec: string): Promise<{ spec: string }>;
  getReasoningEffort(): Promise<ReasoningEffort | null>;
  setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }>;
  /** The self-evolution knobs, including the advisor gate (`/advisor`). */
  getEvolutionConfig(): Promise<EvolutionConfigView>;
  /** Set any subset of them; answers with the effective config. */
  setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView>;
  listModels(): Promise<AgentModelMenu>;
}

export interface AgentUiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: AgentUiMessagePart[];
}

export type AgentUiMessagePart =
  | { type: 'file'; mediaType: string; filename: string; url: string }
  | { type: 'text'; text: string };

export function createUserUiMessage(text: string, files: ReadonlyArray<PromptFile> = []): AgentUiMessage {
  const parts: AgentUiMessagePart[] = files.map((file) => ({
    type: 'file', mediaType: file.mediaType, filename: file.filename, url: file.url,
  }));
  if (text || files.length === 0) parts.push({ type: 'text', text });
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts,
  };
}

export function asRecord(input: { value: JsonValue }): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input.value);
  return parsed.success ? parsed.output : { input: input.value };
}
