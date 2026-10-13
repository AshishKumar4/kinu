/** An agent's isolate for bun suites: the shipped AgentFacet in this process over its own database. */
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { MAIN_AGENT, WORKSPACE_ROOT } from '@kinu.run/core';
import type { AgentProviderDeps, AgentProviderRegistry } from '../../src/providers/agent-registry';
import type { AgentContext } from 'agents';
import { AgentFacet, type AgentFacetCalls, type AgentFacetEnv } from '../../src/agent-facet/agent-facet';
import type { AgentWorkspacePort } from '../../src/agent-facet/workspace-rpc';
import { agentCallsThrough } from '../../src/dynamic-worker-slots';
import { attemptInItsWords } from '@kinu.run/core/obs';
import { AgentDatabase } from '../../src/agent-facet/agent-database';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import { type AgentFacetPlacement, type AgentWorkspaceHost } from '../../src/agent-facets';
import { joinedOnlyByItself } from './agents-sdk';

/**
 * Each workspace object's agents' databases, by storage key. A facet's storage is its object's, so an activation
 * over the same storage finds them, and another workspace, which may key an agent alike, never does.
 */
const databases = new WeakMap<Database, Map<string, Database>>();

/** The agents' isolates of each workspace object, for a later activation over its storage that keeps them. */
const isolates = new WeakMap<Database, InProcessAgentFacets>();

/** The workspace objects whose next activation keeps the agents' isolates the last one opened. */
const kept = new WeakSet<Database>();

/**
 * The next activation over `workspace`'s storage keeps the agents' isolates this one opened, as a reset of the workspace
 * object leaves them running in their own: each one's calls reach the activation that opened it last.
 */
export function keepAgentIsolatesAcrossReset(workspace: Database): void {
  kept.add(workspace);
}

/** A run's preparation, held at its isolate's call to the workspace once its own claim is durable. */
export interface HeldPreparation {
  readonly actorId: string;
  readonly bound: Parameters<AgentWorkspaceHost['prepareTurn']>[0];
  release(): void;
}

const preparationHolds: Array<(held: HeldPreparation) => void> = [];

/** The next run an agent's isolate prepares waits at its call to the workspace until released. */
export function holdNextRunPreparation(): Promise<HeldPreparation> {
  const held = Promise.withResolvers<HeldPreparation>();

  preparationHolds.push(held.resolve);

  return held.promise;
}

/** Models a suite scripts, by the session (`actorAffinity`'s) their calls are routed under. */
const scriptedModels = new Map<string, () => LanguageModel>();

/** The shipped isolate, whose turns resolve a model a suite scripts for their conversation first. */
class ScriptedModelFacet extends AgentFacet {
  protected override models(deps: Omit<AgentProviderDeps, 'env'>): AgentProviderRegistry {
    const registry = super.models(deps);

    return { ...registry, resolveModel: (spec, conversation) => scriptedModels.get(conversation.sessionAffinity)?.() ?? registry.resolveModel(spec, conversation) };
  }
}

/** Isolates whose next answer row fails to write, as a failed commit does. */
const undurableAnswers = new Set<string>();

/** Isolates whose next turn's end never reaches the workspace, as one whose isolate died after its commit. */
const lostTurnEnds = new Set<string>();

/** The isolate under `storageKey` commits its next turn, and the end it tells the workspace is lost on the way. */
export function loseNextTurnEnd(storageKey: string): void {
  lostTurnEnds.add(storageKey);
}

/** A call held on its way to the workspace: `reached` once it is held, and it goes on once released. */
export interface HeldCall {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

const delayedTurnEnds = new Map<string, { readonly reached: () => void; readonly released: Promise<void> }>();

/** The isolate under `storageKey` commits its next turn, and the end it tells the workspace waits on the way until
 *  released. */
export function delayNextTurnEnd(storageKey: string): HeldCall {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  delayedTurnEnds.set(storageKey, { reached: reached.resolve, released: released.promise });

  return { reached: reached.promise, release: released.resolve };
}

const lostInterrupts = new Set<string>();

/** The next Stop pushed to the isolate under `storageKey` is lost on the way, as a dropped RPC is: the turn's own signal
 *  never hears it, and only the workspace's cut of the turn stands. */
export function loseNextInterrupt(storageKey: string): void {
  lostInterrupts.add(storageKey);
}

const delayedToolAnswers = new Map<string, { readonly reached: () => void; readonly released: Promise<void> }>();

/** The isolate under `storageKey` makes its next tool call, and the workspace's answer, given, waits on its way back
 *  until released: the step after it has not started. */
export function delayNextToolAnswer(storageKey: string): HeldCall {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  delayedToolAnswers.set(storageKey, { reached: reached.resolve, released: released.promise });

  return { reached: reached.promise, release: released.resolve };
}

let delayedSlateStamp: { readonly of: (storageKey: string) => boolean; readonly reached: () => void; readonly released: Promise<void> } | null = null;

/** The next isolate `of` names (its storage key) commits an answer, and once the workspace gave it that answer's slates,
 *  the answer to that take waits on the way until released: taken there, not yet stamped here. */
export function delayNextSlateStamp(of: (storageKey: string) => boolean): HeldCall {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  delayedSlateStamp = { of, reached: reached.resolve, released: released.promise };

  return { reached: reached.promise, release: released.resolve };
}

const delayedHandoffs = new Map<string, { readonly reached: () => void; readonly released: Promise<void> }>();

/** The isolate under `storageKey` commits its next turn's answer, and the handoff of that settled turn to the workspace
 *  waits on the way until released: the answer is durable, and the roster it committed still owed. */
export function delayNextHandoff(storageKey: string): HeldCall {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  delayedHandoffs.set(storageKey, { reached: reached.resolve, released: released.promise });

  return { reached: reached.promise, release: released.resolve };
}

let delayedRunEnd: { readonly reached: () => void; readonly released: Promise<void> } | null = null;

/** The next report any isolate sends that carries a delivered run's end waits on the way until released; released
 *  before any such report is sent, it holds none. */
export function delayNextRunEnd(): HeldCall {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const held = { reached: reached.resolve, released: released.promise };

  delayedRunEnd = held;

  return {
    reached: reached.promise,
    release: () => {
      if (delayedRunEnd === held) delayedRunEnd = null;
      released.resolve();
    },
  };
}

let delayedTurnReport: { readonly reached: (storageKey: string) => void; readonly released: Promise<void> } | null = null;

/** A call held on its way: `reached` answers the storage key of the isolate that made it; `release` lets it arrive. */
export interface HeldIsolateCall {
  readonly reached: Promise<string>;
  release(): void;
}

let delayedRunReview: { readonly reached: (storageKey: string) => void; readonly released: Promise<void> } | null = null;

/** The next crossing that carries a delivered run's round reviews to its workspace (its end's report) waits on the way
 *  until released. */
export function delayNextRunReview(): HeldIsolateCall {
  const reached = Promise.withResolvers<string>();
  const released = Promise.withResolvers<void>();

  delayedRunReview = { reached: reached.resolve, released: released.promise };

  return { reached: reached.promise, release: released.resolve };
}

let delayedModelReport: { readonly from: (storageKey: string) => boolean; readonly reached: (storageKey: string) => void; readonly released: Promise<void> } | null = null;

/** The next model call an isolate `from` reports to its workspace on its own waits on the way until released. */
export function delayNextModelReport(from: (storageKey: string) => boolean): HeldIsolateCall {
  const reached = Promise.withResolvers<string>();
  const released = Promise.withResolvers<void>();

  delayedModelReport = { from, reached: reached.resolve, released: released.promise };

  return { reached: reached.promise, release: released.resolve };
}

let delayedOpenWork: { readonly reached: (storageKey: string) => void; readonly released: Promise<void> } | null = null;

/** The next read of an agent's open work any isolate asks its workspace for waits on the way until released; released
 *  before any is asked, it holds none. */
export function delayNextOpenWork(): HeldIsolateCall {
  const reached = Promise.withResolvers<string>();
  const released = Promise.withResolvers<void>();
  const held = { reached: reached.resolve, released: released.promise };

  delayedOpenWork = held;

  return {
    reached: reached.promise,
    release: () => {
      if (delayedOpenWork === held) delayedOpenWork = null;
      released.resolve();
    },
  };
}

/** The next report any hire's settled turn owes its hirer waits on the way to the workspace until released. */
export function delayNextTurnReport(): HeldIsolateCall {
  const reached = Promise.withResolvers<string>();
  const released = Promise.withResolvers<void>();

  delayedTurnReport = { reached: reached.resolve, released: released.promise };

  return { reached: reached.promise, release: released.resolve };
}

export type TurnOpeningRequest = Parameters<AgentWorkspaceHost['prepareChat']>[0];

const copiedOpenings = new Map<string, (opening: TurnOpeningRequest) => void>();

/** The next opening of a turn the isolate under `storageKey` sends, as it sent it: a test delivers it again, late. */
export async function copyNextOpening(storageKey: string): Promise<TurnOpeningRequest> {
  const copied = Promise.withResolvers<TurnOpeningRequest>();

  copiedOpenings.set(storageKey, copied.resolve);

  return await copied.promise;
}

type TurnEndArgs = Parameters<AgentWorkspaceHost['turnEnded']>;

const copiedTurnEnds = new Map<string, (args: TurnEndArgs) => void>();

/** The next turn end the isolate under `storageKey` tells its workspace, as it told it, once it was told: a test
 *  delivers it again, late. */
export async function copyNextTurnEnd(storageKey: string): Promise<TurnEndArgs> {
  const copied = Promise.withResolvers<TurnEndArgs>();

  copiedTurnEnds.set(storageKey, copied.resolve);

  return await copied.promise;
}

const lostOpeningAnswers = new Map<string, () => void>();

/** The isolate under `storageKey` dies once the workspace has answered its next opening of a turn, before it reads the
 *  answer: the promise settles then. */
export async function loseNextOpeningAnswer(storageKey: string): Promise<void> {
  const answered = Promise.withResolvers<void>();

  lostOpeningAnswers.set(storageKey, answered.resolve);

  await answered.promise;
}

/** How the next delivery to an isolate is cut: before it reaches the isolate, or after the isolate took it and before
 *  its answer reaches the workspace. */
type DeliveryCut = 'before-admit' | 'after-admit';

const deliveryCuts = new Map<string, DeliveryCut>();

/** The next delivery the workspace crosses into the isolate under `storageKey` is cut at `at`, as a death there would. */
export function cutNextDelivery(storageKey: string, at: DeliveryCut): void {
  deliveryCuts.set(storageKey, at);
}

const heldDeliveries = new Map<string, (release: () => Promise<void>) => void>();

/** The next delivery the workspace crosses into the isolate under `storageKey` is held on its way, as a slow crossing
 *  would be: the promise settles with `release`, which lets it arrive, and settles once the isolate answered or failed. */
export async function holdNextDelivery(storageKey: string): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<() => Promise<void>>();

  heldDeliveries.set(storageKey, held.resolve);

  return await held.promise;
}

const heldRuns: ((held: { readonly actorId: string; readonly release: () => void }) => void)[] = [];

/** The next run the workspace delivers to any agent is held on its way: the promise settles with the agent it is for and
 *  `release`, which lets it arrive. */
export async function holdNextRunDelivery(): Promise<{ readonly actorId: string; readonly release: () => void }> {
  const held = Promise.withResolvers<{ readonly actorId: string; readonly release: () => void }>();

  heldRuns.push(held.resolve);

  return await held.promise;
}

const heldReports = new Map<string, (deliver: () => Promise<void>) => void>();

/**
 * The next report the isolate under `storageKey` sends that it owes anything is caught in flight: the isolate goes on as
 * if it was told, as one that died after sending would, and the report reaches the workspace only once `deliver`ed.
 */
export async function catchNextOwingReport(storageKey: string): Promise<() => Promise<void>> {
  const caught = Promise.withResolvers<() => Promise<void>>();

  heldReports.set(storageKey, caught.resolve);

  return await caught.promise;
}

const failedBroadcasts = new Set<string>();

/** The workspace refuses the next broadcast the isolate under `storageKey` asks it to send. */
export function failNextBroadcast(storageKey: string): void {
  failedBroadcasts.add(storageKey);
}

let failedOpening: ((storageKey: string) => boolean) | null = null;

/** The workspace fails the next turn opening an isolate `from` asks it for, as one resetting does. */
export function failNextOpening(from: (storageKey: string) => boolean): void {
  failedOpening = from;
}

let lostParentReport: ((storageKey: string) => boolean) | null = null;

/** The next report an isolate `from` sends its hirer is lost on the way, as one sent into a reset is. */
export function loseNextParentReport(from: (storageKey: string) => boolean): void {
  lostParentReport = from;
}

const lostHandoffs = new Set<string>();

/** The isolate under `storageKey` hands its next settled turn to a workspace that is gone before it takes it. */
export function loseNextHandoff(storageKey: string): void {
  lostHandoffs.add(storageKey);
}

/** The isolate under `storageKey` fails to write its next answer row; the commit is one transaction, so nothing lands. */
export function failNextAnswerWrite(storageKey: string): void {
  undurableAnswers.add(storageKey);
}

function withUndurableAnswers(ctx: AgentContext, storageKey: string): AgentContext {
  const { sql } = ctx.storage;
  const exec = sql.exec.bind(sql);

  sql.exec = (query, ...bindings) => {
    if (undurableAnswers.has(storageKey) && query.includes('INSERT INTO conversation_entries') && bindings.includes('assistant')) {
      undurableAnswers.delete(storageKey);
      throw new Error(`the answer row ${String(bindings[2])} could not be written`);
    }

    return exec(query, ...bindings);
  };

  return ctx;
}

/** Every model call routed under `conversation`, in any isolate, is answered by `model`; null answers it as shipped. */
export function scriptConversationModel(conversation: string, model: (() => LanguageModel) | null): void {
  if (model === null) scriptedModels.delete(conversation);
  else scriptedModels.set(conversation, model);
}

export interface InProcessAgentFacets {
  open(placement: AgentFacetPlacement, workspace: AgentWorkspaceHost): Promise<AgentFacetCalls>;
  drop(storageKey: string): void;
  /** Every open agent's chat runs nothing, its settled turns' effects have closed, and it told its workspace so. */
  idle(): Promise<void>;
  reset(storageKey: string): void;
  /** Every live-output call an agent's isolate made to the workspace, in order: each is an RPC in production. */
  traceCalls(): readonly string[];
}

function unreachable(): never {
  throw new Error('a schema-only agent database reached the workspace');
}

async function sessionOrFailure(open: Promise<HostedSession>): Promise<() => HostedSession> {
  try {
    const session = await open;

    return () => session;
  } catch (cause) {
    return () => { throw cause; };
  }
}

let contextOver: ((db: Database, id: string) => AgentContext) | null = null;

/** The database of the agent keyed `storageKey` in the workspace whose own storage is `workspace`. */
export function agentDatabase(workspace: Database, storageKey: string): Database {
  const agents = databases.get(workspace) ?? new Map<string, Database>();
  const held = agents.get(storageKey);

  if (held !== undefined) return held;

  if (contextOver === null) throw new Error('no harness has been built, so no agent database can be');
  const db = new Database(':memory:');

  agents.set(storageKey, db);
  databases.set(workspace, agents);
  new AgentDatabase(contextOver(db, storageKey).storage, { agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, admitDelivery: unreachable, broadcast: unreachable, turnInFlight: () => false, memory: unreachable, program: unreachable, sayToParent: unreachable, receipts: unreachable, logActivity: unreachable });

  return db;
}

/** `workspace`: the storage of the object these agents are facets of. */
export function inProcessAgentFacets(makeCtx: (db: Database, id: string) => AgentContext, workspace: () => Database): InProcessAgentFacets {
  const live = new Map<string, OpenFacet>();
  // Two calls that race to open one agent reach one isolate, as a stub's do.
  const opening = new Map<string, Promise<OpenFacet>>();
  const traceCalls: string[] = [];
  // The activation that opened each agent last, which its calls reach.
  const hosts = new Map<string, AgentWorkspaceHost>();

  contextOver = makeCtx;

  const earlier = isolates.get(workspace());

  if (earlier !== undefined && kept.has(workspace())) {
    kept.delete(workspace());

    return earlier;
  }

  // A new workspace answers its model calls as shipped until its suite scripts them.
  scriptedModels.clear();

  const facets: InProcessAgentFacets = {
    open: async (placement, host) => {
      const key = placement.storageKey;

      hosts.set(key, host);

      const held = opening.get(key) ?? openFacet(placement, host).then((opened) => {
        live.set(key, opened);

        return opened;
      });

      opening.set(key, held);

      return (await held).calls;
    },
    reset: (storageKey) => {
      live.get(storageKey)?.lost.abort(new Error("the agent's isolate reset"));
      live.delete(storageKey);
      opening.delete(storageKey);
    },
    traceCalls: () => traceCalls,
    idle: async () => { await Promise.all([...live.values()].map(({ facet }) => facet.idle())); },
    drop: (storageKey) => {
      live.delete(storageKey);
      opening.delete(storageKey);
      databases.get(workspace())?.get(storageKey)?.close();
      databases.get(workspace())?.delete(storageKey);
    },
  };

  isolates.set(workspace(), facets);

  return facets;

  async function openFacet(placement: AgentFacetPlacement, opener: AgentWorkspaceHost) {
      // Each call reaches the activation that opened this agent last, as its stub's would after a reset.
      const host = (): AgentWorkspaceHost => hosts.get(placement.storageKey) ?? opener;

      const db = agentDatabase(workspace(), placement.storageKey);
      // The root agent's own turns relay too; a suite counting a node's calls counts the node's alone.
      const counted = (call: string): void => { if (placement.home !== WORKSPACE_ROOT) traceCalls.push(call); };

      const session = await sessionOrFailure(host().session());
      const stateSession = await sessionOrFailure(host().stateSession());

      // Its port: the workspace's host, held as the shipped client holds it.
      const port: AgentWorkspacePort = {
        traceTurn: (...args) => {
          counted('traceTurn');

          return host().traceTurn(...args);
        },
        traceStream: (...args) => {
          counted('traceStream');

          return host().traceStream(...args);
        },
        resume: (turnId) => host().resume(turnId),
        guard: (...args) => host().guard(...args),
        debit: (...args) => host().debit(...args),
        prepareTurn: async (bound) => {
          const hold = preparationHolds.shift();

          if (hold !== undefined) {
            const released = Promise.withResolvers<void>();

            hold({ actorId: placement.actorId, bound, release: released.resolve });
            await released.promise;
          }

          return await host().prepareTurn(bound);
        },
        scaffold: () => host().scaffold(),
        prepareChat: async (request) => {
          if (request.turnId !== null && failedOpening?.(placement.storageKey) === true) {
            failedOpening = null;

            throw new Error('the workspace reset as the turn opened');
          }

          const copy = copiedOpenings.get(placement.storageKey);

          if (copy !== undefined && request.turnId !== null) {
            copiedOpenings.delete(placement.storageKey);
            copy(request);
          }

          const lost = lostOpeningAnswers.get(placement.storageKey);
          const prepared = await host().prepareChat(request);

          if (lost === undefined || request.turnId === null) return prepared;
          lostOpeningAnswers.delete(placement.storageKey);
          lost();

          return await new Promise<never>(() => {});
        },
        chatEvent: async (event) => {
          if (event.type === 'broadcast' && failedBroadcasts.delete(placement.storageKey)) throw new Error('the workspace refused the broadcast');

          await host().chatEvent(event);
        },
        turnEnded: async (event, figures, activity, window) => {
          if (lostTurnEnds.delete(placement.storageKey)) return;
          const delay = delayedTurnEnds.get(placement.storageKey);

          if (delay !== undefined) {
            delayedTurnEnds.delete(placement.storageKey);
            delay.reached();
            await delay.released;
          }

          await host().turnEnded(event, figures, activity, window);
          const copy = copiedTurnEnds.get(placement.storageKey);

          copiedTurnEnds.delete(placement.storageKey);
          copy?.([event, figures, activity, window]);
        },
        answerAmended: (window) => host().answerAmended(window),
        turnReport: async (turn, ended, relay) => {
          const delayed = delayedTurnReport;

          if (delayed !== null) {
            delayedTurnReport = null;
            delayed.reached(placement.storageKey);
            await delayed.released;
          }

          return await host().turnReport(turn, ended, relay);
        },
        parentReport: async (report) => {
          if (lostParentReport?.(placement.storageKey) === true) {
            lostParentReport = null;

            throw new Error('the workspace reset before it took the report');
          }

          return await host().parentReport(report);
        },
        autoTitle: (subject, title) => host().autoTitle(subject, title),
        turnSettled: async (settled) => {
          if (lostHandoffs.delete(placement.storageKey)) throw new Error('the workspace was reset before it took the handoff');
          const delayed = delayedHandoffs.get(placement.storageKey);

          if (delayed !== undefined) {
            delayedHandoffs.delete(placement.storageKey);
            delayed.reached();
            await delayed.released;
          }

          await host().turnSettled(settled);
        },
        runSettled: (run) => host().runSettled(run),
        hireAdvisor: (advisor) => host().hireAdvisor(advisor),
        owes: async (seq, next, holds, report) => {
          const delayedEnd = report.runEnds.length > 0 ? delayedRunEnd : null;

          if (delayedEnd !== null) {
            delayedRunEnd = null;
            delayedEnd.reached();
            await delayedEnd.released;
          }

          const reviewed = report.runEnds.some(({ outcome }) => 'ended' in outcome && (outcome.ended.reviews?.length ?? 0) > 0);
          const delayedReview = reviewed ? delayedRunReview : null;

          if (delayedReview !== null) {
            delayedRunReview = null;
            delayedReview.reached(placement.storageKey);
            await delayedReview.released;
          }

          const catching = heldReports.get(placement.storageKey);

          if (catching !== undefined && (holds || next !== null)) {
            heldReports.delete(placement.storageKey);
            catching(async () => { await host().owes(seq, next, holds, report); });

            return;
          }

          await host().owes(seq, next, holds, report);
        },
        birthContext: (drainTurnId) => host().birthContext(drainTurnId),
        steerSkills: (text, alreadyActive) => host().steerSkills(text, alreadyActive),
        openWork: async () => {
          const delayed = delayedOpenWork;

          if (delayed !== null) {
            delayedOpenWork = null;
            delayed.reached(placement.storageKey);
            await delayed.released;
          }

          return await host().openWork();
        },
        armCacheWarm: (input) => host().armCacheWarm(input),
        enqueueTurn: (input) => host().enqueueTurn(input),
        executeTool: async (call) => {
          const answer = await host().executeTool(call);
          const delayed = delayedToolAnswers.get(placement.storageKey);

          if (delayed !== undefined) {
            delayedToolAnswers.delete(placement.storageKey);
            delayed.reached();
            await delayed.released;
          }

          return answer;
        },
        receipts: (turnId, runId, callIds) => host().receipts(turnId, runId, callIds),
        observe: (lines) => host().observe(lines),
        paceStep: (bound, profile) => {
          counted('paceStep');

          return host().paceStep(bound, profile);
        },
        answerMetadata: async (close, narration) => {
          counted('answerMetadata');
          const answer = await host().answerMetadata(close, narration);
          const delayed = delayedSlateStamp;

          if (delayed !== null && !answer.owesNarration && delayed.of(placement.storageKey)) {
            delayedSlateStamp = null;
            delayed.reached();
            await delayed.released;
          }

          return answer;
        },
        getAuth: (key, opts) => host().getAuth(key, opts),
        listCredentials: () => host().listCredentials(),
        relayDevice: (provider) => host().relayDevice(provider),
        relayModelCall: (deviceId, callId, request) => host().relayModelCall(deviceId, callId, request),
        cancelModelRelay: (callId) => host().cancelModelRelay(callId),
        sayToParent: (signal) => host().sayToParent(signal),
        logActivity: (lines) => host().logActivity(lines),
        reportModelCall: async (report) => {
          const delayed = delayedModelReport;

          if (delayed?.from(placement.storageKey) === true) {
            delayedModelReport = null;
            delayed.reached(placement.storageKey);
            await delayed.released;
          }

          return await host().reportModelCall(report);
        },
        reportModelOperation: (event) => host().reportModelOperation(event),
      };

      const env: AgentFacetEnv = {
        WORKSPACE: {
          session: async () => session(),
          stateSession: async () => stateSession(),
          memory: async () => host().memory(),
          program: (...args) => host().program(...args),
          port: async () => port,
        },
        WORKSPACE_NAME: placement.workspaceName,
        HOME: placement.home,
        ...placement.providers,
      };

      const facet = new ScriptedModelFacet(withUndurableAnswers(makeCtx(db, placement.storageKey), placement.storageKey), env);

      if (placement.home === MAIN_AGENT) joinedOnlyByItself(facet);
      const lost = new AbortController();

      // A reset isolate fails every call it still held, as a dropped RPC does; a refusal crosses in its own words, as an
      // error thrown across an RPC does.
      const calls = agentCallsThrough((call) => attemptInItsWords('io', () => untilLost(call(facet), lost.signal)));

      const admit: AgentFacetCalls['admit'] = async (snapshot, delivery) => {
        const cut = deliveryCuts.get(placement.storageKey);

        deliveryCuts.delete(placement.storageKey);

        if (cut === 'before-admit') throw new Error('the crossing died before the agent took the delivery');
        const holding = heldDeliveries.get(placement.storageKey);
        const crossed = Promise.withResolvers<void>();

        if (holding !== undefined) {
          heldDeliveries.delete(placement.storageKey);
          const arrives = Promise.withResolvers<void>();

          holding(async () => {
            arrives.resolve();
            await crossed.promise;
          });
          await arrives.promise;
        }

        const holdingRun = delivery.input.kind === 'run' ? heldRuns.shift() : undefined;

        if (holdingRun !== undefined) {
          const arrives = Promise.withResolvers<void>();

          holdingRun({ actorId: placement.actorId, release: arrives.resolve });
          await arrives.promise;
        }

        const answered = await calls.admit(snapshot, delivery).finally(() => { crossed.resolve(); });

        if (cut === 'after-admit') throw new Error("the crossing died after the agent took the delivery, before its answer");

        return answered;
      };

      const interruptChat: AgentFacetCalls['interruptChat'] = async (snapshot, cutoff) => {
        if (lostInterrupts.delete(placement.storageKey)) throw new Error('the Stop was lost on its way to the agent');

        return await calls.interruptChat(snapshot, cutoff);
      };

      return { facet, calls: { ...calls, admit, interruptChat }, lost };
  }
}

interface OpenFacet {
  readonly facet: AgentFacet;
  readonly calls: AgentFacetCalls;
  readonly lost: AbortController;
}

async function untilLost<A>(work: Promise<A>, lost: AbortSignal): Promise<A> {
  const reset = Promise.withResolvers<never>();
  const cut = (): void => { reset.reject(lost.reason); };

  lost.addEventListener('abort', cut, { once: true });

  try {
    return await Promise.race([work, reset.promise]);
  } finally {
    lost.removeEventListener('abort', cut);
  }
}
