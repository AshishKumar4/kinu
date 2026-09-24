/**
 * The backend a shared behaviour suite runs against is configuration: `KINU_TEST_BACKEND=cf` or `cli`
 * runs one, unset runs both. Each adapter maps a shared operation onto that backend's public method
 * and does nothing else, so a behaviour one backend changes on its own fails in that backend, by name.
 */
import { Database } from 'bun:sqlite';
import {
  initWorkspaceSchema, type ActorHandle, type EvolutionChangelogView, type LLMProviderConfig,
  type RefinementRequestView, type SessionHistory, type SqlExecutor, type VFS,
} from '@kinu.run/core';
import { scratchPath, scriptedTurnModel, sqlOver } from '@kinu.run/test-utils';
import {
  historyOver, orchestratorHarness, workspaceFiles, workspaceMainActor,
} from '../helpers/actor-harness';
import type { OrchestratorAgent } from '../../src/orchestrator';
import { LocalAgentSession } from '../../../cli-backend/src/local-session';
import { createLocalModelResolver, type LocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../../../cli-backend/src/runtime';

export const TEST_BACKEND_ENV = 'KINU_TEST_BACKEND';

export type BackendName = 'cf' | 'cli';

/** The backends this run covers; an unrecognised name throws rather than silently running neither. */
export function testBackends(raw: string | undefined = process.env.KINU_TEST_BACKEND): readonly BackendName[] {
  const named = raw?.trim();

  if (named === undefined || named === '') return ['cf', 'cli'];

  if (named === 'cf' || named === 'cli') return [named];

  throw new Error(`${TEST_BACKEND_ENV}=${named} names no backend: set cf or cli, or unset it to run both.`);
}

/** The public methods both backends answer to under one name and one argument list. */
type SameCall =
  | 'getReasoningEffort' | 'setReasoningEffort' | 'getStoredModelSpec' | 'setModel' | 'setRole'
  | 'getProviderAccounts' | 'setProviderAccount'
  | 'getShellApprovalMode' | 'setShellApprovalMode' | 'getShellApprovalGrants' | 'revokeShellApprovalGrants'
  | 'getAlwaysActiveSkills'
  | 'approveInstruction' | 'revokeInstruction' | 'listInstructionApprovals' | 'readInstructionApproval'
  | 'listDeferredApprovals' | 'decideDeferredApprovals'
  | 'listBackgroundJobs' | 'jobResult' | 'cancelBackgroundJob'
  | 'createTimerTrigger' | 'cancelTrigger'
  | 'listRuns' | 'getRunEvents'
  | 'markChangelogSeen' | 'revertChangelogEntry' | 'getShadowStatus' | 'applyScaffoldDecision'
  | 'latestAlternateTakes' | 'pickAlternateTake'
  | 'getActivePlanReview' | 'savePlanReviewAnnotations' | 'decidePlanReview'
  | 'checkpointStatus' | 'listFileCheckpoints' | 'planFileRestore' | 'restoreFileCheckpoint'
  | 'listRefinements' | 'showRefinement' | 'decideRefinement'
  | 'revertConversation' | 'runScaffoldGepaOptimization';

/** The cf signature, answered asynchronously: the CLI's synchronous answers are awaited the same way. */
type Answer<K extends SameCall> = OrchestratorAgent[K] extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** What both backends answer to, in one shape. Each member is a public method of both. */
export type SharedSurface = { readonly [K in SameCall]: Answer<K> } & {
  /** The CLI answers nothing; the stored list is read back through `getAlwaysActiveSkills`. */
  setAlwaysActiveSkills(names: string[]): Promise<void>;
  /** cf takes an options object where the CLI takes the limit alone. */
  getEvolutionChangelog(limit: number): Promise<EvolutionChangelogView>;
  /** The durable request the owner opened; the lane that runs it is each backend's own cadence. */
  requestRefinement(opts?: { turnIds?: string[] }): Promise<RefinementRequestView>;
  /** The owner's words under the caller's id, or a fresh one. */
  send(text: string, id?: string): Promise<void>;
};

export interface SharedBackend {
  readonly name: BackendName;
  readonly surface: SharedSurface;
  /** The main actor's durable rows, addressed the way core's stores address them. */
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  /** The workspace file plane, as the owner and the agent reach it. */
  readonly files: VFS;
  /** The main actor's conversation store, as each backend records its turns. */
  readonly history: SessionHistory;
}

/** The cf Durable Object, in process over bun:sqlite. */
function cloudflare(): SharedBackend {
  const harness = orchestratorHarness();
  const { agent, db } = harness;

  return {
    name: 'cf',
    sql: sqlOver(db),
    actor: workspaceMainActor(db),
    files: workspaceFiles(agent),
    history: historyOver(harness),
    surface: {
      getReasoningEffort: () => agent.getReasoningEffort(),
      setReasoningEffort: (effort) => agent.setReasoningEffort(effort),
      getStoredModelSpec: () => agent.getStoredModelSpec(),
      setModel: (spec) => agent.setModel(spec),
      getProviderAccounts: () => agent.getProviderAccounts(),
      setProviderAccount: (provider, account) => agent.setProviderAccount(provider, account),
      setRole: (roleId) => agent.setRole(roleId),
      getShellApprovalMode: () => agent.getShellApprovalMode(),
      setShellApprovalMode: (mode) => agent.setShellApprovalMode(mode),
      getShellApprovalGrants: () => agent.getShellApprovalGrants(),
      revokeShellApprovalGrants: (grants) => agent.revokeShellApprovalGrants(grants),
      getAlwaysActiveSkills: () => agent.getAlwaysActiveSkills(),
      setAlwaysActiveSkills: async (names) => { await agent.setAlwaysActiveSkills(names); },
      approveInstruction: (path, digest) => agent.approveInstruction(path, digest),
      revokeInstruction: (path) => agent.revokeInstruction(path),
      listInstructionApprovals: (request) => agent.listInstructionApprovals(request),
      readInstructionApproval: (path) => agent.readInstructionApproval(path),
      listDeferredApprovals: () => agent.listDeferredApprovals(),
      decideDeferredApprovals: (ids, decision) => agent.decideDeferredApprovals(ids, decision),
      listBackgroundJobs: (limit) => agent.listBackgroundJobs(limit),
      jobResult: (jobId) => agent.jobResult(jobId),
      cancelBackgroundJob: (jobId) => agent.cancelBackgroundJob(jobId),
      createTimerTrigger: (opts) => agent.createTimerTrigger(opts),
      cancelTrigger: (id, caller) => agent.cancelTrigger(id, caller),
      listRuns: (request) => agent.listRuns(request),
      getRunEvents: (runId, opts) => agent.getRunEvents(runId, opts),
      getEvolutionChangelog: (limit) => agent.getEvolutionChangelog({ limit }),
      markChangelogSeen: () => agent.markChangelogSeen(),
      revertChangelogEntry: (id) => agent.revertChangelogEntry(id),
      getShadowStatus: () => agent.getShadowStatus(),
      applyScaffoldDecision: (mode) => agent.applyScaffoldDecision(mode),
      latestAlternateTakes: () => agent.latestAlternateTakes(),
      pickAlternateTake: (takeId, nodeId) => agent.pickAlternateTake(takeId, nodeId),
      getActivePlanReview: () => agent.getActivePlanReview(),
      savePlanReviewAnnotations: (id, revision, annotations) => agent.savePlanReviewAnnotations(id, revision, annotations),
      decidePlanReview: (id, revision, decision, feedback) => agent.decidePlanReview(id, revision, decision, feedback),
      checkpointStatus: () => agent.checkpointStatus(),
      listFileCheckpoints: (limit, turnId) => agent.listFileCheckpoints(limit, turnId),
      planFileRestore: (dir, id) => agent.planFileRestore(dir, id),
      restoreFileCheckpoint: (dir, id) => agent.restoreFileCheckpoint(dir, id),
      listRefinements: (limit) => agent.listRefinements(limit),
      showRefinement: (requestId, routeIndex) => agent.showRefinement(requestId, routeIndex),
      requestRefinement: (opts) => agent.requestRefinement(opts),
      decideRefinement: (input) => agent.decideRefinement(input),
      revertConversation: (entryId) => agent.revertConversation(entryId),
      runScaffoldGepaOptimization: (opts) => agent.runScaffoldGepaOptimization(opts),
      send: (text, id) => agent.send(text, id ?? crypto.randomUUID()),
    },
  };
}

/** A Workers AI endpoint nothing listens on: resolution needs one, and no case here calls it. */
const NO_ENDPOINT: LLMProviderConfig = {
  name: 'workers-ai', baseURL: 'http://127.0.0.1:9/v1', headers: {}, model: '@cf/zai-org/glm-5.3',
};

/** The session's own model; a case that reaches a model scripts its answer. */
const DONE_MODEL = scriptedTurnModel({ doGenerate: () => ({
  content: [{ type: 'text', text: 'done' }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
}) });

/** The real resolver, so specs normalise as they do for an owner, answering every call with the
 *  scripted model: a turn a case causes runs offline. */
function scriptedResolver(): LocalModelResolver {
  const real = createLocalModelResolver({ llm: NO_ENDPOINT, credentials: {} });

  return {
    normalizeSpecSync: (spec) => real.normalizeSpecSync(spec),
    resolveModel: () => DONE_MODEL,
    listProviders: () => real.listProviders(),
    listModels: () => real.listModels(),
    modelInfo: () => Promise.resolve(null),
    judgeCandidates: () => real.judgeCandidates(),
    countInputTokens: () => Promise.resolve({ kind: 'unsupported', provider: 'fake', reason: 'a scripted model has no count endpoint' }),
    getAuth: real.getAuth,
  };
}

/** The CLI session over its own workspace database. */
function cli(): SharedBackend {
  const db = new Database(scratchPath('shared-backend', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: NO_ENDPOINT });
  const modelResolver = scriptedResolver();

  const session = new LocalAgentSession({
    rt, db, model: DONE_MODEL, modelResolver, noAutoEvolve: true, onEvent: () => {},
  });

  return {
    name: 'cli',
    sql: rt.storage.sql,
    actor: rt.actor,
    files: rt.storage.vfs,
    history: rt.stores.history,
    surface: {
      getReasoningEffort: async () => session.getReasoningEffort(),
      setReasoningEffort: async (effort) => session.setReasoningEffort(effort),
      getStoredModelSpec: async () => session.getStoredModelSpec(),
      setModel: async (spec) => session.setModel(spec),
      getProviderAccounts: async () => session.getProviderAccounts(),
      setProviderAccount: async (provider, account) => session.setProviderAccount(provider, account),
      setRole: (roleId) => session.setRole(roleId),
      getShellApprovalMode: async () => session.getShellApprovalMode(),
      setShellApprovalMode: async (mode) => session.setShellApprovalMode(mode),
      getShellApprovalGrants: async () => session.getShellApprovalGrants(),
      revokeShellApprovalGrants: async (grants) => session.revokeShellApprovalGrants(grants),
      getAlwaysActiveSkills: async () => ({ names: session.getAlwaysActiveSkills() }),
      setAlwaysActiveSkills: async (names) => { session.setAlwaysActiveSkills(names); },
      approveInstruction: (path, digest) => session.approveInstruction(path, digest),
      revokeInstruction: (path) => session.revokeInstruction(path),
      listInstructionApprovals: (request) => session.listInstructionApprovals(request),
      readInstructionApproval: (path) => session.readInstructionApproval(path),
      listDeferredApprovals: () => session.listDeferredApprovals(),
      decideDeferredApprovals: (ids, decision) => session.decideDeferredApprovals(ids, decision),
      listBackgroundJobs: (limit) => session.listBackgroundJobs(limit),
      jobResult: (jobId) => session.jobResult(jobId),
      cancelBackgroundJob: (jobId) => session.cancelBackgroundJob(jobId),
      createTimerTrigger: (opts) => session.createTimerTrigger(opts),
      cancelTrigger: async (id, caller) => session.cancelTrigger(id, caller),
      listRuns: async (request) => session.listRuns(request),
      getRunEvents: async (runId, opts) => session.getRunEvents(runId, opts),
      getEvolutionChangelog: async (limit) => session.getEvolutionChangelog(limit),
      markChangelogSeen: async () => session.markChangelogSeen(),
      revertChangelogEntry: (id) => session.revertChangelogEntry(id),
      getShadowStatus: async () => session.getShadowStatus(),
      applyScaffoldDecision: (mode) => session.applyScaffoldDecision(mode),
      latestAlternateTakes: async () => session.latestAlternateTakes(),
      pickAlternateTake: (takeId, nodeId) => session.pickAlternateTake(takeId, nodeId),
      getActivePlanReview: () => session.getActivePlanReview(),
      savePlanReviewAnnotations: (id, revision, annotations) => session.savePlanReviewAnnotations(id, revision, annotations),
      decidePlanReview: (id, revision, decision, feedback) => session.decidePlanReview(id, revision, decision, feedback),
      checkpointStatus: () => session.checkpointStatus(),
      listFileCheckpoints: (limit, turnId) => session.listFileCheckpoints(limit, turnId),
      planFileRestore: (dir, id) => session.planFileRestore(dir, id),
      restoreFileCheckpoint: (dir, id) => session.restoreFileCheckpoint(dir, id),
      listRefinements: async (limit) => session.listRefinements(limit),
      showRefinement: (requestId, routeIndex) => session.showRefinement(requestId, routeIndex),
      requestRefinement: (opts) => session.requestRefinement(opts),
      decideRefinement: (input) => session.decideRefinement(input),
      revertConversation: (entryId) => session.revertConversation(entryId),
      runScaffoldGepaOptimization: (opts) => session.runScaffoldGepaOptimization(opts),
      send: async (text, id) => { await session.send(text, { id: id ?? crypto.randomUUID() }); },
    },
  };
}

export function openBackend(name: BackendName): SharedBackend {
  return name === 'cf' ? cloudflare() : cli();
}
