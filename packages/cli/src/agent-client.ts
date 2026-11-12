/** Presentation contract every chat surface drives, one adapter per backend (local session, cloud DO
 * websocket). UIs never branch on backend; backend-only features are capability surfaces. */

import type {
  BroadcastEvent, ChangelogEntry, ChangelogRevertResult, PromptFile, ShellApprovalMode,
  AlternateTakeSet, TakePickOutcome,
  EvolutionConfigView,
  RefinementListing, RefinementRequestView,
  ReasoningEffort, TierId, Usage, RunEvent, JsonObject, ToolOutcome,
  AdmittedInstructionDecision,
  InstructionSourceRow, InstructionSourceView, Page, PageRequest, PositionCursor, PositionPageRequest,
  SendMetadata, WorkMode, FileCheckpointSurface, OwnerQuestionSurface, PlanReviewSurface, WaitingApprovalSurface,
  SubagentInspectionRequest, SubagentInspectionResult, ChatHistoryEntry, WorkspaceSpend, WorkspaceWork,
  ModelTestResult, ContextFill, PendingDeviceConsent,
  KeptUpload,
} from '@kinu.run/core';
import type { ShellApprovalHandler } from '@kinu.run/cli-backend';
import type { CliSession } from './session';
import { rowText, type AgentModelMenu, type CompactOutcome, type FileLinks, type JobOutputTail, type PathPlanes } from '@kinu.run/core';
import type { KinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';


export const STEP_RESTART_NOTICE = '\n\nThe agent restarted; this step continues from the start below.\n\n';

export type AgentClientMode = 'local' | 'cloud';

export type AgentPrompt = string | { text: string; files: ReadonlyArray<PromptFile> };

export function promptText(prompt: AgentPrompt): string {
  return v.is(v.string(), prompt) ? prompt : prompt.text;
}

export function promptFiles(prompt: AgentPrompt): ReadonlyArray<PromptFile> {
  return v.is(v.string(), prompt) ? [] : prompt.files;
}

interface AgentToolCallResult {
  name: string;
  args: JsonObject;
  result?: string;
  outcome?: ToolOutcome;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCallResult[];
  steps: number;
  durationMs: number;
  hadError: boolean;
  /** Absent when the provider reported none. Local only: the cloud protocol carries no per-turn usage. */
  usage?: Usage;
}

export type AgentClientEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
  | { type: 'step-cut'; stepIndex: number }
  | { type: 'step-finish'; stepIndex: number }
  | { type: 'turn-end'; turn: AgentTurnResult }
  | { type: 'evolution'; event: string; message: string }
  | { type: 'background'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** Durable run-event ledger row. Human surfaces ignore it; `--json` emits it verbatim. Local only:
   *  a cloud agent's ledger lives in the DO. */
  | { type: 'run-event'; event: RunEvent }
  | { type: 'error'; message: string };

export interface AgentClientSendOptions {
  cwd?: string;
  tier?: TierId;
  /** Plan turns end in a review decided through {@link PlanReviewSurface}. Defaults to build. */
  mode?: WorkMode;
}

export interface AgentClientStatus {
  name: string;
  purpose: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  scaffoldVersion?: number;
  messageCount?: number;
  searchNodeCount?: number;
  memorySize?: number;
  dbSize?: number;
  toolCount?: number;
  autoEvolve?: boolean;
  roleId?: string;
  tierId?: string;
  context?: ContextFill | null;
}

interface AgentToolDescription {
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
  label?: string | null;
  output?: JobOutputTail;
}

export interface AgentSearchNode {
  depth: number;
  status: string;
  value: number;
  visits: number;
  action: string | null;
}

export interface AgentTranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';
  content: string;
  metadata?: JsonObject;
  toolName?: string;
  /** Results carry the same id; that is what pairs them in the transcript. */
  toolCallId?: string;
  args?: string;
  success?: boolean;
  steered?: boolean;
  branched?: boolean;
}

export type AgentSendResult =
  | { readonly landed: 'mid-turn' }
  | ({ readonly landed: 'turn' } & AgentTurnResult);

/** Identified by verbatim text plus occurrence among same-text user messages, newest first (1 = most
 *  recent), because surface message ids do not align with the backend store. */
export interface ForkPoint {
  text: string;
  occurrenceFromEnd: number;
}

export interface AgentForkResult {
  /** Callers switch and close the old client when a different instance is returned. */
  client: AgentClient;
  label: string;
}

/** The answer turn `turnId` recorded, read from the newest page back; null when it recorded none (a Stop before any
 *  output). */
export async function recordedAnswer(
  page: (request: PositionPageRequest) => Promise<Page<ChatHistoryEntry, PositionCursor>>,
  turnId: string,
): Promise<string | null> {
  let request: PositionPageRequest = {};

  for (;;) {
    const read = await page(request);
    const turn = read.items.filter((entry) => entry.turnId === turnId);
    const answer = turn.filter((entry) => entry.role === 'assistant').at(-1);

    if (answer !== undefined) return rowText(answer);

    // A turn's own entries come before its answer: a page that holds them and no answer means it recorded none.
    if (turn.length > 0 || read.status === 'end') return null;
    request = { cursor: read.next };
  }
}

/** -1 when the point cannot be located (the surface's view drifted from the store). */
export function findForkPivot(
  rows: ReadonlyArray<{ role: string; content: string }>,
  point: ForkPoint,
): number {
  let remaining = point.occurrenceFromEnd;
  const target = point.text.trim();

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];

    if (row.role !== 'user' || row.content.trim() !== target) continue;
    remaining -= 1;

    if (remaining === 0) return i;
  }

  return -1;
}

export function forkCandidates(
  messages: ReadonlyArray<{ role: string; content: string }>,
  limit = 10,
): ForkPoint[] {
  const seen = new Map<string, number>();
  const candidates: ForkPoint[] = [];

  for (let i = messages.length - 1; i >= 0 && candidates.length < limit; i--) {
    const message = messages[i];

    if (message.role !== 'user') continue;
    const text = message.content.trim();

    if (!text) continue;
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    candidates.push({ text, occurrenceFromEnd: occurrence });
  }

  return candidates;
}

/** `unseenCount` is the pre-view value; fetching marks the digest seen. */
export interface AgentChangelogView {
  entries: ChangelogEntry[];
  unseenCount: number;
}

export type DeviceConsentDecision = 'once' | 'always' | 'deny';

export interface DeviceConsentSurface {
  listPending(): Promise<PendingDeviceConsent[]>;
  resolve(consentId: string, decision: DeviceConsentDecision): Promise<{ ok: boolean }>;
}

export interface LocalSessionControls {
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: string[]): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): ShellApprovalMode;
  /** ACP session/request_permission. Local only: a cloud turn has no synchronous path back here. */
  setShellApprovalHandler(handler: ShellApprovalHandler | null): () => void;
  listModelProviders(): Promise<Array<{ id: string; available: boolean; unavailableReason?: string }>>;
  /** Instruction-file trust (KINU-N028). Local only: signed out there is no cloud owner. */
  listInstructionApprovals(request?: PageRequest): Promise<Page<InstructionSourceRow>>;
  readInstructionApproval(path: string): Promise<InstructionSourceView | null>;
  approveInstruction(path: string, digest: string): Promise<AdmittedInstructionDecision>;
  revokeInstruction(path: string): Promise<AdmittedInstructionDecision>;
  /** Resolves with why the emptied request could not be measured, or null once its number is recorded. */
  clearConversation(): Promise<KinuError | null>;
  compact(): Promise<CompactOutcome>;
}

export interface AgentClient {
  readonly mode: AgentClientMode;
  readonly agentName: string;
  readonly cliSession: CliSession;
  readonly consents: DeviceConsentSurface | null;
  readonly localControls: LocalSessionControls | null;
  readonly checkpoints: FileCheckpointSurface | null;
  readonly plans: PlanReviewSurface | null;
  /** Null where the agent's conversation partner is not the owner (a subagent's window). */
  readonly questions: OwnerQuestionSurface | null;
  /** Null where the agent's conversation partner is not the owner (a subagent's window). */
  readonly approvals: WaitingApprovalSurface | null;
  /** Rename this conversation's agent when the backend exposes a complete
   * owner-authoritative path. Root cloud workspaces keep the web sidebar path. */
  readonly rename?: (displayName: string) => Promise<{ name: string; displayName: string }>;
  /** Per-message cap on inlined raw bytes. Cloud and local limits differ by 8x, so surfaces ask. */
  /** A file the person names, uploaded as a chat attachment is (the files route's `uploads=` form): the path it was kept
   *  at under /uploads, which the message names. */
  uploadAttachment(file: { readonly filename: string; readonly mediaType: string; readonly bytes: Uint8Array }): Promise<KeptUpload>;
  /** Where a local workspace's references are on this machine; a cloud workspace's are not here. */
  readonly planes: PathPlanes | null;
  /** Where a file the agent names opens. */
  readonly fileLinks: FileLinks;

  /** Starts client-owned resources (local MCP servers). The daemon owns orphaned-job recovery. */
  connect(): Promise<void>;
  subscribe(listener: (event: AgentClientEvent) => void): () => void;
  /** Idle: runs as a user turn. Mid-turn: reaches the running turn's next step boundary. */
  send(prompt: AgentPrompt, opts?: AgentClientSendOptions): Promise<AgentSendResult>;
  /** Runs the prompt as a parallel head without interrupting the live turn; false when no turn is active. */
  branch(prompt: AgentPrompt, opts?: AgentClientSendOptions): boolean;
  /** Continue from strictly before the given user message; both backends revert the workspace in place. */
  fork(point: ForkPoint): Promise<AgentForkResult>;
  /** Returns steer texts accepted but never delivered, so surfaces hand them back. Cloud always returns []. */
  stop(): string[];
  /** One-shot surfaces call this before exit so backgrounded work is not cut off. Local only. */
  settleBackgroundWork?(): Promise<void>;
  close(): Promise<void>;

  /** Display only: the local durable conversation seeds the model without hydration. */
  history(): Promise<AgentTranscriptMessage[]>;

  status(): Promise<AgentClientStatus>;
  describeTools(): Promise<AgentToolSurface>;
  changelog(): Promise<AgentChangelogView>;
  revertChangelogEntry(id: string): Promise<ChangelogRevertResult>;
  refinements(): Promise<RefinementListing>;
  /** Resolves with the durable request; the agent's behaviour has not moved yet. */
  requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView>;
  readMemory(): Promise<string>;
  searchNodes(): Promise<AgentSearchNode[]>;
  /** `actor` names a hire by its path of names, as the cloud's per-actor listing does; absent, this client's own. */
  listJobs(limit?: number, actor?: string): Promise<AgentJobSummary[]>;
  /** Through the runner that holds it: its work ends, and its owner is woken. */
  cancelJob(jobId: string): Promise<{ ok: boolean }>;
  latestTakes(): Promise<AlternateTakeSet | null>;
  pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome>;
  setRole(roleId: string): Promise<{ role: string }>;
  getModelSpec(): Promise<string | null>;
  setModel(spec: string): Promise<{ spec: string }>;
  getReasoningEffort(): Promise<ReasoningEffort | null>;
  setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }>;
  workspaceSpend(): Promise<WorkspaceSpend>;
  getProviderAccounts(): Promise<Readonly<Record<string, string>>>;
  setProviderAccount(provider: string, account: string | null): Promise<Readonly<Record<string, string>>>;
  getEvolutionConfig(): Promise<EvolutionConfigView>;
  setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView>;
  listModels(): Promise<AgentModelMenu>;
  testModel(spec: string, signal: AbortSignal): Promise<ModelTestResult>;
  inspectSubagent(request: SubagentInspectionRequest): Promise<SubagentInspectionResult>;
  workspaceWork(): Promise<WorkspaceWork>;
}

interface AgentUiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: AgentUiMessagePart[];
  /** What the send carries beside its words, as the web composer writes it too. */
  metadata?: SendMetadata;
}

type AgentUiMessagePart =
  /** A sent file names its upload (`kinu.upload`), the path the workspace answered; `url` is the same path. */
  | { type: 'file'; mediaType: string; filename: string; url: string; providerMetadata: { kinu: { upload: string; digest?: string } } }
  | { type: 'text'; text: string };

export function createUserUiMessage(
  id: string,
  text: string,
  files: ReadonlyArray<PromptFile> = [],
  metadata: SendMetadata = {},
): AgentUiMessage {
  const parts: AgentUiMessagePart[] = files.map((file) => ({
    type: 'file', mediaType: file.mediaType, filename: file.filename, url: file.path,
    providerMetadata: { kinu: { upload: file.path, ...(file.digest !== undefined && { digest: file.digest }) } },
  }));

  if (text || files.length === 0) parts.push({ type: 'text', text });

  return {
    id,
    role: 'user',
    parts,
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
}
