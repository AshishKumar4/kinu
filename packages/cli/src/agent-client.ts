/** Presentation contract every chat surface drives, one adapter per backend (local session, cloud DO
 * websocket). UIs never branch on backend; backend-only features are capability surfaces. */

import type {
  BroadcastEvent, ChangelogEntry, ChangelogRevertResult, PromptFile, ShellApprovalMode,
  FileCheckpointListing, FileRestorePlan, FileRestoreResult,
  AlternateTakeSet, TakePickOutcome,
  EvolutionConfigView,
  EvolutionDebt, RefinementDecisionInput, RefinementDecisionResult, RefinementRequestView,
  StagedSkillResult,
  ReasoningEffort, TierId, Usage, RunEvent, JsonObject, ToolOutcome,
  AdmittedInstructionDecision,
  InstructionSourceRow, InstructionSourceView, Page, PageRequest,
  DeferredApproval, DeferredApprovalAnswer,
  PlanReview, PlanReviewAnnotation, PlanReviewDecision, PlanReviewResult, WorkMode,
  SubordinateInspectionRequest, SubordinateInspectionResult,
} from '@kinu.run/core';
import type { ShellApprovalHandler } from '@kinu.run/cli-backend';
import type { CliSession } from './session';
import type { AgentModelMenu } from '@kinu.run/core';
import * as v from 'valibot';

export type AgentClientMode = 'local' | 'cloud';

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
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
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
  craftedToolCount?: number;
  taskCount?: number;
  memorySize?: number;
  dbSize?: number;
  toolCount?: number;
  autoEvolve?: boolean;
  roleId?: string;
  tierId?: string;
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

/** Refinements and evolution debt in one shape, so a debt count never renders against a stale list. */
export interface AgentRefinementView {
  requests: RefinementRequestView[];
  debt: EvolutionDebt;
}

export interface PendingDeviceConsent {
  consentId: string;
  deviceLabel: string;
  method: string;
  command: string;
}

export type DeviceConsentDecision = 'once' | 'always' | 'deny';

export interface DeviceConsentSurface {
  listPending(): Promise<PendingDeviceConsent[]>;
  resolve(consentId: string, decision: DeviceConsentDecision): Promise<{ ok: boolean }>;
}

/** `list` carries reachability so an empty list is not read as a statement about the turn. */
export interface FileCheckpointSurface {
  /** `turnId` narrows in the store: `limit` is global while retention is per directory, so a window can
   *  hold part of a turn. */
  list(limit?: number, turnId?: string): Promise<FileCheckpointListing>;
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  restore(dir: string, id: string): Promise<FileRestoreResult>;
}

export interface LocalSessionControls {
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: string[]): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): ShellApprovalMode;
  /** ACP session/request_permission. Local only: a cloud turn has no synchronous path back here. */
  setShellApprovalHandler(handler: ShellApprovalHandler | null): () => void;
  listDeferredApprovals(): Promise<DeferredApproval[]>;
  decideDeferredApprovals(ids: string[], decision: DeferredApprovalAnswer): Promise<{ decided: string[] }>;
  listModelProviders(): Promise<Array<{ id: string; available: boolean; unavailableReason?: string }>>;
  /** Instruction-file trust (KINU-N028). Local only: signed out there is no cloud owner. */
  listInstructionApprovals(request?: PageRequest): Promise<Page<InstructionSourceRow>>;
  readInstructionApproval(path: string): Promise<InstructionSourceView | null>;
  approveInstruction(path: string, digest: string): Promise<AdmittedInstructionDecision>;
  revokeInstruction(path: string): Promise<AdmittedInstructionDecision>;
}

/** The owner's half of Plan mode; both backends serve core's `PlanReviewStore`. */
export interface PlanReviewSurface {
  active(): Promise<PlanReview | null>;
  saveAnnotations(id: string, revision: number, annotations: PlanReviewAnnotation[]): Promise<PlanReviewResult>;
  /** Approving queues the implementation turn, which streams through `subscribe`. */
  decide(id: string, revision: number, decision: PlanReviewDecision, feedback?: string): Promise<PlanReviewResult>;
}

export interface AgentClient {
  readonly mode: AgentClientMode;
  readonly agentName: string;
  readonly cliSession: CliSession;
  readonly consents: DeviceConsentSurface | null;
  readonly localControls: LocalSessionControls | null;
  readonly checkpoints: FileCheckpointSurface | null;
  readonly plans: PlanReviewSurface | null;
  /** Rename this conversation's agent when the backend exposes a complete
   * owner-authoritative path. Root cloud workspaces keep the web sidebar path. */
  readonly rename?: (displayName: string) => Promise<{ name: string; displayName: string }>;
  /** Per-message cap on inlined raw bytes. Cloud and local limits differ by 8x, so surfaces ask. */
  readonly inlineAttachmentLimitBytes: number;

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
  changelog(limit?: number): Promise<AgentChangelogView>;
  revertChangelogEntry(id: string): Promise<ChangelogRevertResult>;
  refinements(limit?: number): Promise<AgentRefinementView>;
  /** Resolves with the durable request; the agent's behaviour has not moved yet. */
  requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView>;
  /** The only path by which a proposed skill becomes trusted instructions; owner client only. */
  decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult>;
  /** Never truncated: this is what an owner decides on. */
  showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult>;
  readMemory(): Promise<string>;
  searchNodes(): Promise<AgentSearchNode[]>;
  listJobs(limit?: number): Promise<AgentJobSummary[]>;
  latestTakes(): Promise<AlternateTakeSet | null>;
  pickTake(takeId: string, nodeId: string): Promise<TakePickOutcome>;
  setRole(roleId: string): Promise<{ role: string }>;
  getModelSpec(): Promise<string | null>;
  setModel(spec: string): Promise<{ spec: string }>;
  getReasoningEffort(): Promise<ReasoningEffort | null>;
  setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }>;
  getEvolutionConfig(): Promise<EvolutionConfigView>;
  setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView>;
  listModels(): Promise<AgentModelMenu>;
  inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult>;
}

export interface AgentUiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: AgentUiMessagePart[];
  /** The same fact the web composer sets; it is what makes the turn a Plan turn. */
  metadata?: { kinuMode: WorkMode };
}

export type AgentUiMessagePart =
  | { type: 'file'; mediaType: string; filename: string; url: string }
  | { type: 'text'; text: string };

export function createUserUiMessage(
  text: string,
  files: ReadonlyArray<PromptFile> = [],
  mode?: WorkMode,
): AgentUiMessage {
  const parts: AgentUiMessagePart[] = files.map((file) => ({
    type: 'file', mediaType: file.mediaType, filename: file.filename, url: file.url,
  }));

  if (text || files.length === 0) parts.push({ type: 'text', text });

  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts,
    ...(mode !== undefined && { metadata: { kinuMode: mode } }),
  };
}
