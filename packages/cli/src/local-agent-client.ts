import { existsSync, statSync } from 'node:fs';
import { localFileLinks, type BranchStatusEvent, type FileLinks, type PathPlanes, type SessionEvent } from '@kinu.run/core';
import type { AgentConfigStore, EvolutionConfigView, InvocationSurface, ShellApprovalMode, ReasoningEffort, JsonObject, RefinementDecisionInput, RefinementDecisionResult, RefinementListing, RefinementRequestView, StagedSkillResult, SubordinateInspectionRequest, SubordinateInspectionResult, WorkspaceSpend, WorkspaceWork, ModelTestResult } from '@kinu.run/core';
import { getChatHistoryPage, getToolList, canonicalConversationId, getEvolutionConfig, initAgentConfigTable, readLatestSearchTree, setEvolutionConfig, ToolOutcomeSchema, usageReported, type ProposerOutcome } from '@kinu.run/core';
import * as v from 'valibot';
import { attempt, KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  LOCAL_MAX_INLINE_ATTACHMENT_BYTES,
  readWorkspaceInfo,
  type CLIRuntime,
  type LocalAgentHost,
  type LocalAgentSession,
} from '@kinu.run/cli-backend';
import { agentDbPath } from './config';
import { renameLocalAgent } from './agent-create';
import { inspectLocalSubordinate, localJobRunning, readLocalWorkspaceWork } from './local-inspection';
import { createLocalHost } from './local-host';
import type { LocalModelResolverOptions } from './local-model-resolver';
import {
  createCliSession,
  type CliSession,
  type CliSessionOptions,
} from './session';
import { SessionRecorder } from './session-recorder';
import { MEMORY_PATH, normalizeModelMenu, type AgentModelMenu } from '@kinu.run/core';
import {
  findForkPivot,
  readConversation,
  promptFiles,
  promptText,
} from './agent-client';
import type {
  AgentChangelogView,
  AgentClient,
  AgentClientEvent,
  AgentClientSendOptions,
  AgentClientStatus,
  AgentForkResult,
  AgentPrompt,
  AgentJobSummary,
  AgentSearchNode,
  AgentToolSurface,
  AgentTranscriptMessage,
  AgentSendResult,
  AgentTurnResult,
  FileCheckpointSurface,
  ForkPoint,
  LocalSessionControls,
  PlanReviewSurface,
  OwnerQuestionSurface,
  WaitingApprovalSurface,
} from './agent-client';


interface LocalAgentClientOptions extends LocalModelResolverOptions {
  transcript?: CliSessionOptions;
  surface?: InvocationSurface;
  /** The folder it works in; absent, the ref's recorded one. */
  cwd?: string;
}

/** A client over `name` as this machine hosts it (`createLocalHost`): the daemon's composition, its team included. */
export async function openLocalAgentClient(name: string, opts: LocalAgentClientOptions = {}): Promise<LocalAgentClient> {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) {
    throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
  }

  const { transcript, surface, ...root } = opts;
  const host = createLocalHost({ driverKind: 'interactive', surface: surface ?? 'interactive', root: { ...root, name } });

  return await settle(hostedLocalAgentClient({ agentName: name, host, dbPath, transcript: transcript ?? {} }));
}

/** A client over the agent `host` opens at `agentName`; the client owns the host and closes it. */
function hostedLocalAgentClient(deps: Omit<LocalAgentClientDeps, 'session' | 'rt'>): Effect.Effect<LocalAgentClient> {
  return Effect.gen(function* () {
    const session = yield* Effect.promise(() => deps.host.acquire(deps.agentName));
    const rt = yield* Effect.promise(() => deps.host.runtime(deps.agentName));

    return new LocalAgentClient({ ...deps, session, rt });
  }).pipe(Effect.onError(() => Effect.promise(() => deps.host.close())));
}

/** Only the process running a job can end it, so another live driver's job is refused, naming that process. */
export function cancelLocalJob(name: string, id: string, daemonPid: number | null): Promise<{ ok: boolean }> {
  return settle(Effect.gen(function* () {
    if (daemonPid !== null && localJobRunning(name, id)) {
      return yield* Effect.fail(new KinuError('unavailable', `${id} may be running in the local daemon (pid ${String(daemonPid)}); \`kinu daemon stop\` ends it`));
    }

    const client = yield* Effect.promise(() => openLocalAgentClient(name, { surface: 'one-shot' }));

    return yield* attempt({ doing: `cancelling job ${id}`, otherwise: 'unavailable' }, async () => {
      await client.connect();

      return await client.cancelJob(id);
    }).pipe(Effect.ensuring(Effect.promise(() => client.close())));
  }));
}

/** Core's proposer, the same one the cloud backend drives: one search on `target` (default the scaffold). */
export async function runLocalOptimization(name: string, target?: string): Promise<ProposerOutcome> {
  const client = await openLocalAgentClient(name, { surface: 'one-shot' });

  try {
    return await client.runOptimization(target);
  } finally {
    await client.close();
  }
}

export interface LocalAgentClientDeps {
  agentName: string;
  /** Opens the agent, its team and its peers, holds its driver lease, and owns its database and sessions. */
  host: LocalAgentHost;
  /** The agent's session, as its host built it. */
  session: LocalAgentSession;
  /** The runtime its host opened it over. */
  rt: CLIRuntime;
  dbPath: string;
  transcript: CliSessionOptions;
}

interface PendingLocalTurn {
  /** Appended when the running turn opens, or marked steered when the running turn read it. */
  readonly entry: JsonObject;
  /** Its turn's own `turn-end`: a send that landed as a turn opened one, and every turn it opens ends. */
  readonly ended: ReturnType<typeof Promise.withResolvers<AgentTurnResult>>;
}

export class LocalAgentClient implements AgentClient {
  readonly mode = 'local' as const;
  readonly agentName: string;
  readonly consents = null;
  readonly localControls: LocalSessionControls;
  readonly checkpoints: FileCheckpointSurface;
  readonly plans: PlanReviewSurface;
  readonly questions: OwnerQuestionSurface;
  readonly approvals: WaitingApprovalSurface;
  private readonly deps: LocalAgentClientDeps;
  readonly inlineAttachmentLimitBytes = LOCAL_MAX_INLINE_ATTACHMENT_BYTES;
  readonly planes: PathPlanes;
  readonly fileLinks: FileLinks;
  readonly rename = async (displayName: string) => renameLocalAgent(this.agentName, displayName);

  /** Outlives the session, so a walk-back fork does not invalidate it. */
  private readonly config: AgentConfigStore;
  /** JSONL transcripts carry this id so an export ties back to its conversation. */
  private readonly canonicalConversation: string;
  private readonly listeners = new Set<(event: AgentClientEvent) => void>();
  private readonly session: LocalAgentSession;
  private readonly unsubscribe: () => void;
  private activeCliSession: CliSession;
  /** The turn opening under a send's id answers it; a send the running turn read leaves at that landing. */
  private readonly awaiting = new Map<string, PendingLocalTurn>();
  private live: readonly PendingLocalTurn[] = [];
  /** The running turn's calls as its own events showed them; its turn record keeps only what evolution reads. */
  private turnCalls = new TurnCalls();
  private closed = false;
  private readonly recorder = new SessionRecorder('local');

  constructor(deps: LocalAgentClientDeps) {
    this.deps = deps;
    this.agentName = deps.agentName;
    this.planes = deps.rt.planes;
    this.fileLinks = localFileLinks(deps.rt.planes);
    initAgentConfigTable(deps.rt.storage.execRaw);
    this.config = deps.rt.actor.config;
    this.canonicalConversation = canonicalConversationId(this.config);
    this.activeCliSession = createCliSession(deps.agentName, {
      ...deps.transcript,
      conversationId: deps.transcript.conversationId ?? this.canonicalConversation,
    });
    this.session = deps.session;
    this.unsubscribe = deps.host.subscribe((agent, event) => {
      if (agent === this.agentName) this.handleSessionEvent(event);
    });
    this.localControls = {
      getAlwaysActiveSkills: () => this.session.getAlwaysActiveSkills(),
      setAlwaysActiveSkills: (names) => this.session.setAlwaysActiveSkills(names),
      getShellApprovalMode: () => this.session.getShellApprovalMode().mode,
      setShellApprovalMode: (mode: ShellApprovalMode) => this.session.setShellApprovalMode(mode).mode,
      setShellApprovalHandler: (handler) => this.session.setShellApprovalHandler(handler),
      listInstructionApprovals: (request) => this.session.listInstructionApprovals(request),
      readInstructionApproval: (path) => this.session.readInstructionApproval(path),
      approveInstruction: (path, digest) => this.session.approveInstruction(path, digest),
      revokeInstruction: (path) => this.session.revokeInstruction(path),
      clearConversation: () => this.session.clearConversation(),
      compact: () => this.session.compact(),
      listModelProviders: async () => (await this.session.listModelProviders()).map((provider) => ({
        id: provider.id,
        available: provider.available,
        unavailableReason: provider.unavailableReason,
      })),
    };
    // Closures read this.session so the surface survives walk-back forks.
    this.checkpoints = {
      list: (limit, turnId) => this.session.listFileCheckpoints(limit, turnId),
      plan: (dir, id) => this.session.planFileRestore(dir, id),
      restore: (dir, id) => this.session.restoreFileCheckpoint(dir, id),
    };
    this.approvals = {
      list: () => this.session.listDeferredApprovals(),
      decide: (ids, decision) => this.session.decideDeferredApprovals(ids, decision),
    };
    this.questions = {
      list: () => this.session.listOwnerQuestions(),
      // In this process: nothing crosses, so nothing is owed.
      answer: async (id, answers) => {
        await this.session.answerOwnerQuestions(id, answers);

        return null;
      },
    };
    this.plans = {
      active: () => this.session.getActivePlanReview(),
      saveAnnotations: (id, revision, annotations) => this.session.savePlanReviewAnnotations(id, revision, annotations),
      decide: (id, revision, decision, feedback) => this.session.decidePlanReview(id, revision, decision, feedback),
      dismiss: (id, revision) => this.session.dismissPlanReview(id, revision),
    };
  }

  get cliSession(): CliSession {
    return this.activeCliSession;
  }

  /**
   * The lease is taken before any pump, so the person learns the conversation is taken before typing: the auto-started
   * daemon drives the same durable work over one SQLite file, and two drivers would turn one event into two turns.
   * Interactive, so it takes the conversation from the daemon; the host holds it until close.
   */
  async connect(): Promise<void> {
    const refusal = await this.deps.host.takeDriver(this.agentName);

    if (refusal) {
      throw new KinuError(
        refusal.refused.reason,
        `${refusal.refused.error}. Close that session, or continue the conversation there.`,
      );
    }
  }

  subscribe(listener: (event: AgentClientEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  async send(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): Promise<AgentSendResult> {
    const text = promptText(prompt);
    const files = promptFiles(prompt);
    const payload = files.length > 0 ? { text, files } : text;

    // The JSONL log records attachment names, never the data-URL payloads.
    const sessionEntry: JsonObject = {
      text,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    };

    if (files.length > 0) sessionEntry.attachments = files.map((file) => file.filename);

    // The session decides where the words land; the minted id is the id that turn opens under.
    const id = crypto.randomUUID();
    const pending: PendingLocalTurn = { entry: sessionEntry, ended: Promise.withResolvers() };
    this.awaiting.set(id, pending);

    try {
      const landed = await this.session.send(payload, { tier: opts.tier, id, mode: opts.mode });

      if (landed === 'mid-turn') {
        this.activeCliSession.append('user', { ...sessionEntry, steered: true });

        return { landed };
      }

      return { landed, ...await pending.ended.promise };
    } finally {
      this.awaiting.delete(id);
      this.live = this.live.filter((open) => open !== pending);
    }
  }

  /** Text-only: the head task is a string. A refused branch is said as the cloud client says it. */
  branch(prompt: AgentPrompt, opts: AgentClientSendOptions = {}): boolean {
    const text = promptText(prompt).trim();

    if (!text || !this.session.turnInFlight()) return false;
    const outcome = this.session.branchTurn(text);

    if (!outcome.accepted) {
      this.emit({ type: 'broadcast', event: { type: 'branch_status', status: 'error', branchId: '', task: text, message: outcome.reason } satisfies BranchStatusEvent });

      return true;
    }

    this.activeCliSession.append('user', {
      text,
      branched: true,
      cwd: opts.cwd ?? process.cwd(),
      backend: 'local',
    });

    return true;
  }

  /** A fresh transcript artifact takes the entries recorded after the walk-back. */
  async fork(point: ForkPoint): Promise<AgentForkResult> {
    if (this.awaiting.size > 0) throw new Error('Cannot fork while a turn is running.');
    const rows = await this.history();
    const pivotRow = rows[findForkPivot(rows, point)];

    if (pivotRow === undefined) throw new Error('Could not locate that message in the durable conversation.');
    await this.session.revertConversation(pivotRow.id);
    this.activeCliSession = createCliSession(this.agentName, {
      ...this.deps.transcript,
      conversationId: this.canonicalConversation,
    });

    return { client: this, label: `branch ${this.activeCliSession.id}` };
  }

  stop(): string[] {
    return this.session.interrupt();
  }

  /** Runs queued wake turns and the one-shot completion gate before the caller closes. */
  async settleBackgroundWork(): Promise<void> {
    if (this.closed) return;
    await this.session.settleBackgroundWork();
  }

  runOptimization(target?: string): Promise<ProposerOutcome> {
    return this.session.runOptimization(target);
  }

  /** Ends its sessions, releases the lease so the daemon can drive again at once, and gives the handle back. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.deps.host.close();
  }

  async history(): Promise<AgentTranscriptMessage[]> {
    const transcript = this.deps.rt.stores.history.transcript(this.canonicalConversation);

    return readConversation((request) => getChatHistoryPage(transcript, request));
  }

  async status(): Promise<AgentClientStatus> {
    const info = await readWorkspaceInfo(this.deps.rt);
    const tier = await this.session.nextTurnTier();

    return {
      name: info.name,
      purpose: info.purpose,
      model: tier.model,
      reasoningEffort: tier.reasoningEffort,
      roleId: this.session.getActiveRoleId(),
      tierId: tier.id,
      scaffoldVersion: info.scaffoldVersion,
      searchNodeCount: info.searchNodeCount,
      memorySize: info.memorySize,
      dbSize: statSync(this.deps.dbPath).size,
      toolCount: this.session.toolNames().length,
      autoEvolve: this.deps.rt.actor.config.getLearning(),
      context: this.session.contextFill(),
    };
  }

  async describeTools(): Promise<AgentToolSurface> {
    return {
      builtIn: this.session.describeTools(),
      crafted: getToolList(this.deps.rt.storage.sql).crafted.map(({ name, description }) => ({ name, description })),
    };
  }

  async changelog(): Promise<AgentChangelogView> {
    const view = this.session.getEvolutionChangelog();
    this.session.markChangelogSeen();

    return { entries: view.entries, unseenCount: view.unseenCount };
  }

  async revertChangelogEntry(id: string) {
    return this.session.revertChangelogEntry(id);
  }

  async refinements(): Promise<RefinementListing> {
    return this.session.listRefinements();
  }

  async requestRefinement(opts?: { turnIds?: readonly string[] }): Promise<RefinementRequestView> {
    return this.session.requestRefinement(opts);
  }

  async decideRefinement(input: RefinementDecisionInput): Promise<RefinementDecisionResult> {
    return this.session.decideRefinement(input);
  }

  async showRefinement(requestId: string, routeIndex: number): Promise<StagedSkillResult> {
    return this.session.showRefinement(requestId, routeIndex);
  }

  async latestTakes() {
    return this.session.latestAlternateTakes();
  }

  async pickTake(takeId: string, nodeId: string) {
    return this.session.pickAlternateTake(takeId, nodeId);
  }

  async setRole(roleId: string): Promise<{ role: string }> {
    return this.session.setRole(roleId);
  }

  async inspectSubordinate(request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
    return inspectLocalSubordinate(this.agentName, request);
  }

  async workspaceWork(): Promise<WorkspaceWork> {
    return readLocalWorkspaceWork(this.agentName);
  }

  async readMemory(): Promise<string> {
    return await this.deps.rt.memory.read(MEMORY_PATH) ?? '';
  }

  async searchNodes(): Promise<AgentSearchNode[]> {
    // The latest search only — the same projection the cloud getMctsTree serves.
    const nodes = readLatestSearchTree(this.deps.rt.storage.sql, this.deps.rt.actor);

    return nodes.map((node) => ({
      depth: node.depth,
      status: node.status,
      value: node.value,
      visits: node.visits,
      action: node.action,
    }));
  }

  async listJobs(limit = 20, actor?: string): Promise<AgentJobSummary[]> {
    const jobs = await this.session.listBackgroundJobs(limit, actor);

    return jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, label: job.label, ...(job.output !== undefined && { output: job.output }) }));
  }

  cancelJob(jobId: string): Promise<{ ok: boolean }> {
    return this.session.cancelBackgroundJob(jobId);
  }

  async getModelSpec(): Promise<string | null> {
    return this.session.getEffectiveModelSpec();
  }

  async setModel(spec: string): Promise<{ spec: string }> {
    return { spec: this.session.setModel(spec).spec };
  }

  async getReasoningEffort(): Promise<ReasoningEffort | null> {
    return this.session.getReasoningEffort().effort;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
    return { effort: this.session.setReasoningEffort(effort).effort };
  }

  async workspaceSpend(): Promise<WorkspaceSpend> {
    return this.session.workspaceSpend();
  }

  async getProviderAccounts(): Promise<Readonly<Record<string, string>>> {
    return this.session.getProviderAccounts().accounts;
  }

  async setProviderAccount(provider: string, account: string | null): Promise<Readonly<Record<string, string>>> {
    return this.session.setProviderAccount(provider, account).accounts;
  }

  async getEvolutionConfig(): Promise<EvolutionConfigView> {
    return getEvolutionConfig(this.config);
  }

  async setEvolutionConfig(view: Partial<EvolutionConfigView>): Promise<EvolutionConfigView> {
    return setEvolutionConfig(this.config, view);
  }

  async listModels(): Promise<AgentModelMenu> {
    return normalizeModelMenu({ payload: await this.session.listAvailableModels() });
  }

  async testModel(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
    return this.session.testModel(spec, signal);
  }

  private handleSessionEvent(event: SessionEvent): void {
    if (event.type === 'turn-start') this.turnCalls = new TurnCalls();
    const mapped = mapSessionEvent(event, this.turnCalls.calls);

    if (!mapped) return;
    this.turnCalls.observe(mapped);

    if (event.type === 'turn-start') {
      // Turns under an awaited send's id (or carried by it) belong to that send; wakes and delegations to nobody.
      this.live = [event.turnId, ...event.carried].flatMap((id) => this.awaiting.get(id) ?? []);

      for (const pending of this.live) this.activeCliSession.append('user', pending.entry);
    }

    if (mapped.type === 'turn-end') for (const pending of this.live) pending.ended.resolve(mapped.turn);
    this.emit(mapped);
  }

  private emit(event: AgentClientEvent): void {
    this.recorder.record(this.activeCliSession, event);

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class TurnCalls {
  readonly calls: AgentTurnResult['toolCalls'] = [];
  private readonly byId = new Map<string, AgentTurnResult['toolCalls'][number]>();

  observe(event: AgentClientEvent): void {
    if (event.type === 'tool-call') {
      const call = { name: event.toolName, args: event.args };
      this.calls.push(call);
      this.byId.set(event.toolCallId, call);
    } else if (event.type === 'tool-result') {
      const call = this.byId.get(event.toolCallId);

      if (call === undefined) return;
      call.result = event.result;
      call.outcome = v.parse(ToolOutcomeSchema, event);
    }
  }
}

function mapSessionEvent(event: SessionEvent, toolCalls: AgentTurnResult['toolCalls']): AgentClientEvent | null {
  switch (event.type) {
    case 'turn-start':
      return { type: 'turn-start', kind: event.kind, text: event.text, event: event.event };
    case 'text-delta':
    case 'reasoning-delta':
      return { type: event.type, delta: event.delta };
    case 'step-cut':
      return event;
    case 'tool-call':
      return { type: 'tool-call', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
    case 'tool-result':
      return event;
    case 'turn-end':
      const turn: AgentTurnResult = {
        text: event.turn.assistantResponse,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
        toolCalls,
      };

      // An all-absent report is truthy; gate on `usageReported` so an unmetered turn does not look measured.
      if (event.turn.usage && usageReported(event.turn.usage)) turn.usage = event.turn.usage;

      return {
        type: 'turn-end',
        turn,
      };
    case 'evolution':
      return { type: 'evolution', event: event.event, message: event.message };
    case 'background':
      return { type: 'background', event: event.event, message: event.message };
    case 'broadcast':
      return { type: 'broadcast', event: event.event };
    case 'run-event':
      return { type: 'run-event', event: event.event };
    case 'error':
      return { type: 'error', message: event.message };
    // This client rebuilds the session on fork and reprints from the store; nothing to redraw.
    case 'history-reverted':
      return null;
  }
}
