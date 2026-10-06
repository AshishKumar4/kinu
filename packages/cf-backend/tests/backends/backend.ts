import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The backend a shared behaviour suite runs against is configuration: `KINU_TEST_BACKEND=cf` or `cli`
 * runs one, unset runs both. Each adapter maps a shared operation onto that backend's public method
 * and does nothing else, so a behaviour one backend changes on its own fails in that backend, by name.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import { type ActorHandle, type SleepTimeUpdate, type CheckpointTurnMeta, type EvolutionChangelogView, type LLMProviderConfig, type RefinementRequestView, type SessionHistory, type SqlExecutor, type WorkMode } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { scratchDir, scratchPath, scriptedTurnModel, sqlOver, type ScriptedTurnResult } from '@kinu.run/test-utils';
import {
  historyOver, orchestratorHarness, scriptedSleepTime, sentTurn, workspaceFiles, workspaceMainActor,
} from '../helpers/actor-harness';
import { deviceHarness, WORKSPACE } from '../helpers/device-harness';
import { pcAgentDaemon } from '../helpers/pc-agent-daemon';
import { testOwner } from '../helpers/user-do';
import { joinHarnessFibers } from '../helpers/agents-sdk';
import type { OrchestratorAgent } from '../../src/orchestrator';
import { LocalAgentSession } from '../../../cli-backend/src/local-session';
import { createHostCheckpoints } from '../../../cli-backend/src/checkpoints';
import { createLocalModelResolver, type LocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { openWorkspaceCLI } from '../../../cli-backend/src/open';

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
  | 'markChangelogSeen' | 'revertChangelogEntry' | 'getEvolutionStatus' | 'applyScaffoldDecision'
  | 'latestAlternateTakes' | 'pickAlternateTake'
  | 'getActivePlanReview' | 'savePlanReviewAnnotations' | 'decidePlanReview' | 'dismissPlanReview'
  | 'checkpointStatus' | 'listFileCheckpoints' | 'planFileRestore' | 'restoreFileCheckpoint'
  | 'listRefinements' | 'showRefinement' | 'decideRefinement'
  | 'revertConversation' | 'clearConversation' | 'runOptimization' | 'branchTurn';

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
  /** Snapshot `dir` into the store this backend's checkpoint methods read, as a turn's first
   *  mutation there does: the owner's device for cf, this machine for the CLI. */
  readonly snapshot: (dir: string, turn: CheckpointTurnMeta) => Promise<void>;
  /** Turns the main actor's sleep-time lane on or off behind a fast model answering `answer`; the prompts it
   *  is asked land in the returned list. */
  readonly sleepTime: (answer: SleepTimeUpdate, enabled: boolean) => string[];
  /** Resolves once every detached lane a settled turn started has finished. */
  readonly settled: () => Promise<void>;
  /** Opens a turn of `mode` on the main actor and holds it at its model call until released, so a case
   *  acts while a turn runs. */
  readonly holdTurn: (text: string, mode: WorkMode) => Promise<HeldTurn>;
  /** Ends what opening the backend started, so no work it tracks outlives the case. */
  readonly end?: () => Promise<void>;
}

export interface HeldTurn {
  /** Lets the turn answer and resolves once it has ended. */
  release(): Promise<void>;
}

/** The answer every turn gives, unless a case holds it first. */
const DONE_ANSWER = {
  content: [{ type: 'text', text: 'done' }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
} satisfies ScriptedTurnResult;

/** The main actor's model on both backends: it answers 'done', or parks a held turn's call until release. */
function turnGate() {
  let held: { readonly arrived: ReturnType<typeof Promise.withResolvers<void>>; readonly released: ReturnType<typeof Promise.withResolvers<void>> } | null = null;

  const model = scriptedTurnModel({ doGenerate: async () => {
    const hold = held;

    if (hold !== null) {
      held = null;
      hold.arrived.resolve();
      await hold.released.promise;
    }

    return DONE_ANSWER;
  } });

  return {
    model,
    /** Starts `open`, a turn that resolves once it has ended, and resolves once that turn reaches the model. */
    async hold(open: () => Promise<void>): Promise<HeldTurn> {
      const hold = { arrived: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
      held = hold;
      const opened = open();
      // A refused open rejects here instead of waiting on a call that never comes.
      await Promise.race([hold.arrived.promise, opened.then(async () => hold.arrived.promise)]);

      return {
        release: async () => {
          hold.released.resolve();
          await opened;
        },
      };
    },
  };
}

/** The cf Durable Object, in process over bun:sqlite, owned by a real UserDO whose one device is the
 *  real daemon with Sandbox off, so a checkpoint call crosses the hub and its consent gate. */
async function cloudflare(): Promise<SharedBackend> {
  const daemon = pcAgentDaemon();
  const device = await deviceHarness('ashish@studio', async (frame) => await daemon.answer(frame) ?? null);
  await device.userDO.setDeviceTier(await testOwner(), device.deviceId, 'raw');
  device.consentDecision = 'always';
  const harness = orchestratorHarness(undefined, { userDO: device.userDO, workspace: WORKSPACE, ownerUserId: 'test-user-do' });
  harness.agent.harnessHoldsCapability(device.workspace.workspaceToken);
  const { agent, db } = harness;
  const gate = turnGate();
  agent.harnessSupplyTurnModel(gate.model);

  return {
    name: 'cf',
    sql: sqlOver(db),
    actor: workspaceMainActor(db),
    files: workspaceFiles(agent),
    history: historyOver(harness),
    snapshot: (dir, turn) => daemon.snapshot({ agent: WORKSPACE, dir, ...turn }),
    holdTurn: (text, mode) => gate.hold(() => sentTurn(agent, text, crypto.randomUUID(), mode)),
    sleepTime: (answer, enabled) => {
      const prompts = scriptedSleepTime(agent, answer);
      workspaceMainActor(db).config.setSleepTimeComputeEnabled(enabled);

      return prompts;
    },
    settled: () => joinHarnessFibers(),
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
      getEvolutionStatus: () => agent.getEvolutionStatus(),
      applyScaffoldDecision: (mode) => agent.applyScaffoldDecision(mode),
      latestAlternateTakes: () => agent.latestAlternateTakes(),
      pickAlternateTake: (takeId, nodeId) => agent.pickAlternateTake(takeId, nodeId),
      getActivePlanReview: () => agent.getActivePlanReview(),
      savePlanReviewAnnotations: (id, revision, annotations) => agent.savePlanReviewAnnotations(id, revision, annotations),
      decidePlanReview: (id, revision, decision, feedback) => agent.decidePlanReview(id, revision, decision, feedback),
      dismissPlanReview: (id, revision) => agent.dismissPlanReview(id, revision),
      checkpointStatus: () => agent.checkpointStatus(),
      listFileCheckpoints: (limit, turnId) => agent.listFileCheckpoints(limit, turnId),
      planFileRestore: (dir, id) => agent.planFileRestore(dir, id),
      restoreFileCheckpoint: (dir, id) => agent.restoreFileCheckpoint(dir, id),
      listRefinements: (limit) => agent.listRefinements(limit),
      showRefinement: (requestId, routeIndex) => agent.showRefinement(requestId, routeIndex),
      requestRefinement: (opts) => agent.requestRefinement(opts),
      decideRefinement: (input) => agent.decideRefinement(input),
      revertConversation: (entryId) => agent.revertConversation(entryId),
      clearConversation: () => agent.clearConversation(),
      runOptimization: (target) => agent.runOptimization(target),
      send: (text, id) => sentTurn(agent, text, id ?? crypto.randomUUID()),
      branchTurn: (text) => agent.branchTurn(text),
    },
  };
}

/** A Workers AI endpoint nothing listens on: resolution needs one, and no case here calls it. */
const NO_ENDPOINT: LLMProviderConfig = {
  name: 'workers-ai', baseURL: 'http://127.0.0.1:9/v1', headers: {}, model: '@cf/zai-org/glm-5.3',
};

/** The real resolver, so specs normalise as they do for an owner, answering every call with the
 *  backend's turn model: a turn a case causes runs offline. */
function scriptedResolver(model: LanguageModel): LocalModelResolver {
  const real = createLocalModelResolver({ llm: NO_ENDPOINT, credentials: {} });

  return {
    normalizeSpecSync: (spec) => real.normalizeSpecSync(spec),
    resolveModel: () => model,
    credentialFor: (spec) => real.credentialFor(spec),
    listProviders: () => real.listProviders(),
    // The menu is the scripted model alone: a provider installed on the host (an `opencode` on PATH) never reaches a case.
    listModels: () => Promise.resolve({ models: [{ provider: NO_ENDPOINT.name, id: NO_ENDPOINT.model }], failures: [] }),
    modelInfo: () => Promise.resolve(null),
    countInputTokens: () => Promise.resolve({ kind: 'unsupported', provider: 'fake', reason: 'a scripted model has no count endpoint' }),
    getAuth: real.getAuth,
  };
}

let born: Promise<string> | null = null;

/** One workspace born and published as `kinu create` does it (WAL, checkpointed, closed), once per run. */
function bornWorkspace(): Promise<string> {
  born ??= (async () => {
    const path = scratchPath('shared-backend-born', 'agent.db');
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    await createWorkspace(db, { name: WORKSPACE, purpose: 'shared behaviour cases', llm: NO_ENDPOINT });
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.close();

    return path;
  })();

  return born;
}

/** The CLI session over a copy of the born workspace, opened as `kinu` opens one, with its checkpoint store under scratch. */
async function cli(): Promise<SharedBackend> {
  const dbPath = scratchPath('shared-backend', 'agent.db');
  copyFileSync(await bornWorkspace(), dbPath);
  const db = new Database(dbPath);
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: NO_ENDPOINT, cwd: scratchDir('shared-backend-folder') });
  const checkpoints = createHostCheckpoints({ agent: WORKSPACE, base: scratchPath('shared-backend-checkpoints', 'store') });
  rt.checkpoints = checkpoints;
  const gate = turnGate();
  const modelResolver = scriptedResolver(gate.model);

  rt.actor.config.setLearning(false);
  // Off unless a case scripts it, as the cf harness leaves it.
  rt.actor.config.setSleepTimeComputeEnabled(false);

  const session = new LocalAgentSession({
    rt, db, model: gate.model, modelResolver, onEvent: () => {},
  });

  return {
    name: 'cli',
    end: () => session.end(),
    sql: rt.storage.sql,
    actor: rt.actor,
    files: rt.storage.vfs,
    history: rt.stores.history,
    snapshot: async (dir, turn) => {
      checkpoints.beginTurn(turn);
      await checkpoints.ensureCheckpoint(dir);
    },
    holdTurn: (text, mode) => gate.hold(async () => { await session.send(text, { id: crypto.randomUUID(), mode }); }),
    sleepTime: (answer, enabled) => {
      const prompts: string[] = [];

      rt.fastLlm = {
        stream: async function* () { yield ''; },
        complete: async (prompt) => {
          prompts.push(prompt);

          return JSON.stringify(answer);
        },
      };
      rt.actor.config.setSleepTimeComputeEnabled(enabled);

      return prompts;
    },
    settled: () => session.settleBackgroundWork(),
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
      getEvolutionStatus: async () => session.getEvolutionStatus(),
      applyScaffoldDecision: (mode) => session.applyScaffoldDecision(mode),
      latestAlternateTakes: async () => session.latestAlternateTakes(),
      pickAlternateTake: (takeId, nodeId) => session.pickAlternateTake(takeId, nodeId),
      getActivePlanReview: () => session.getActivePlanReview(),
      savePlanReviewAnnotations: (id, revision, annotations) => session.savePlanReviewAnnotations(id, revision, annotations),
      decidePlanReview: (id, revision, decision, feedback) => session.decidePlanReview(id, revision, decision, feedback),
      dismissPlanReview: (id, revision) => session.dismissPlanReview(id, revision),
      checkpointStatus: () => session.checkpointStatus(),
      listFileCheckpoints: (limit, turnId) => session.listFileCheckpoints(limit, turnId),
      planFileRestore: (dir, id) => session.planFileRestore(dir, id),
      restoreFileCheckpoint: (dir, id) => session.restoreFileCheckpoint(dir, id),
      listRefinements: async (limit) => session.listRefinements(limit),
      showRefinement: (requestId, routeIndex) => session.showRefinement(requestId, routeIndex),
      requestRefinement: (opts) => session.requestRefinement(opts),
      decideRefinement: (input) => session.decideRefinement(input),
      revertConversation: (entryId) => session.revertConversation(entryId),
      // The clear's answer is the emptied request's measure, which cf records instead of returning.
      clearConversation: async () => { await session.clearConversation(); },
      runOptimization: (target) => session.runOptimization(target),
      send: async (text, id) => { await session.send(text, { id: id ?? crypto.randomUUID() }); },
      branchTurn: async (text) => session.branchTurn(text),
    },
  };
}

export function openBackend(name: BackendName): Promise<SharedBackend> {
  return name === 'cf' ? cloudflare() : cli();
}
