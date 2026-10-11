/** The workspace side of an agent's isolate (D9). */
import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';
import type { UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { decodeModelMessageValues, forkConversationRowSchema, relayedAnswer, remoteContextTree } from '@kinu.run/core';
import type { ForkConversationPlan, ForkConversationSection, ForkConversationSource, ForkConversationTarget, ForkRows } from '@kinu.run/core';
import type { AgentOwnInspection, ArchiveSqlCursor, CacheWarmArm, ContextEditor, ContextTree, StepSpendSource, ConversationRecall, PositionPageRequest, AgentSignal, AuthRequest, RelayedProvider, ProgrammaticTurn, ProviderEnv, Memory, Executor, MissionBudgetPort } from '@kinu.run/core';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import type { AgentRunOutcome, AgentWorkspace } from './agent-facet/agent-turn';
import type { AdvisorRecoverySnapshot, AgentFigures, AgentStandingReport, AgentTurnActivity, HandedOffTurn, ResolvedTurnProfile, AgentHeadDelta, AgentReview, AgentSnapshot, AgentToolCall, AgentTrace, SessionEvent, TurnRequestAt, ModelCallReport, ModelOperationEvent } from '@kinu.run/core';
import type { ChatTurnRequest } from './agent-turns';
import { attempt, KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { AgentFacet, AgentFacetCalls, AgentFacetEnv } from './agent-facet/agent-facet';
import { ASSETS_HOSTS } from './assets-hosts';

export const AGENT_BUNDLE_DIRECTORY = '/_agent';

/** The bundle's modules by name, `agent.js` the main one (vite-agent-bundle.ts). */
const AGENT_BUNDLE_PATH = `${AGENT_BUNDLE_DIRECTORY}/modules.json`;

const AgentModulesSchema = v.record(v.string(), v.string());

const AGENT_FACET_CLASS = 'AgentFacet';

export interface AgentWorkspaceProps {
  readonly workspace: string;
  readonly actorId: string;
}

export interface AgentWorkspaceAnswers extends Omit<AgentWorkspace, 'session' | 'stateSession'> {
  session(): Promise<HostedSession>;
  stateSession(): Promise<HostedSession>;
}

export class AgentMemory extends RpcTarget implements Memory {
  constructor(private readonly open: () => Promise<Memory>) { super(); }

  async write(path: string, content: string) { await (await this.open()).write(path, content); }
  async append(path: string, content: string) { await (await this.open()).append(path, content); }
  async index(path: string) { await (await this.open()).index(path); }
  async search(query: string, limit?: number) { return await (await this.open()).search(query, limit); }
  async read(path: string) { return await (await this.open()).read(path); }
  async chunk(id: string) { return await (await this.open()).chunk(id); }
  async tail(path: string, bytes: number) { return await (await this.open()).tail(path, bytes); }
}

/** What a turn-bound call does: runs something of the turn, or settles what it did. */
export type TurnCall = 'executes' | 'settles';

export class AgentWorkspaceHost extends RpcTarget implements AgentWorkspaceAnswers {
  /**
   * `closed` aborts as the workspace is deleted: every call still open is refused then, so its relay hears an end.
   * `fenced` answers whether a call bound to a turn is the agent's current one: a turn a later opening superseded, or a
   * Stop cancelled, is refused before anything runs (design v2 §3).
   */
  constructor(
    private readonly answers: AgentWorkspaceAnswers,
    private readonly closed: AbortSignal,
    private readonly fenced: (turnId: string, call: TurnCall) => boolean = () => true,
    private readonly cutOff: (turnId: string) => AbortSignal | null = () => null,
  ) {
    super();
  }

  /** `call`: what a turn-bound call does. One that executes is refused for a turn a Stop cut off; one that settles what the
   *  turn already did (its answer, its trace, its charges) is not, so the stopped turn closes. */
  private open<T>(answer: () => T | Promise<T>, turnId?: string, call: TurnCall = 'settles'): Promise<T> {
    const refused = Promise.withResolvers<never>();

    if (turnId !== undefined && !this.fenced(turnId, call)) {
      refused.reject(new KinuError('cancelled', `stale_epoch: turn ${turnId} is no longer this agent's current turn.`));

      return refused.promise;
    }

    // A call that runs more of its turn ends as the turn is cut off, as every call does as the workspace is deleted.
    const cut = turnId !== undefined && call === 'executes' ? this.cutOff(turnId) : null;
    const ends = cut === null ? this.closed : AbortSignal.any([this.closed, cut]);
    const refuse = (): void => { refused.reject(ends.reason); };

    if (ends.aborted) refuse();
    else ends.addEventListener('abort', refuse, { once: true });

    return Promise.race([answer(), refused.promise]).finally(() => { ends.removeEventListener('abort', refuse); });
  }

  session() { return this.open(() => this.answers.session()); }
  stateSession() { return this.open(() => this.answers.stateSession()); }
  memory() { return this.answers.memory(); }
  program(turnId: string, ...args: Parameters<Executor['execute']>) { return this.open(() => this.answers.program(turnId, ...args), turnId, 'executes'); }
  traceTurn(turnId: string, event: AgentTrace) { return this.open(() => this.answers.traceTurn(turnId, event), turnId); }
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>) { return this.open(() => this.answers.traceStream(turnId, lines), turnId); }
  resume(turnId: string) { return this.open(() => this.answers.resume(turnId), turnId, 'executes'); }
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) { return this.open(() => this.answers.guard(turnId, ...args), turnId, 'executes'); }
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>) { return this.open(() => this.answers.debit(turnId, ...args), turnId); }
  prepareTurn(turnId: string) { return this.open(() => this.answers.prepareTurn(turnId), turnId, 'executes'); }
  advise(review: AgentReview) { return this.open(() => this.answers.advise(review)); }
  runEnded(id: string, outcome: AgentRunOutcome) { return this.open(() => this.answers.runEnded(id, outcome)); }
  enqueueTurn(input: ProgrammaticTurn) { return this.open(() => this.answers.enqueueTurn(input)); }
  executeTool(call: AgentToolCall) { return this.open(() => this.answers.executeTool(call), call.turnId, 'executes'); }
  observe(lines: ReadableStream<Uint8Array>) { return this.open(() => this.answers.observe(lines)); }
  paceStep(turnId: string) { return this.open(() => this.answers.paceStep(turnId), turnId, 'executes'); }
  answerMetadata(turnId: string, narration: readonly string[] | null) { return this.open(() => this.answers.answerMetadata(turnId, narration), turnId); }
  reportModelCall(report: ModelCallReport) { return this.open(() => this.answers.reportModelCall(report)); }
  reportModelOperation(event: ModelOperationEvent) { return this.open(() => this.answers.reportModelOperation(event)); }
  prepareChat(request: ChatTurnRequest) { return this.open(() => this.answers.prepareChat(request)); }
  bindProfile(turnId: string, profile: ResolvedTurnProfile) { return this.open(() => this.answers.bindProfile(turnId, profile), turnId); }
  chatEvent(event: SessionEvent) { return this.open(() => this.answers.chatEvent(event)); }
  turnEnded(event: SessionEvent, figures: AgentFigures, activity: readonly AgentTurnActivity[]) { return this.open(() => this.answers.turnEnded(event, figures, activity)); }
  owedReport(...args: Parameters<AgentWorkspace['owedReport']>) { return this.open(() => this.answers.owedReport(...args)); }
  parentReport(report: Parameters<AgentWorkspace['parentReport']>[0]) { return this.open(() => this.answers.parentReport(report)); }
  autoTitle(subject: string, title: string | null) { return this.open(() => this.answers.autoTitle(subject, title)); }
  turnSettled(settled: HandedOffTurn) { return this.open(() => this.answers.turnSettled(settled)); }
  hireAdvisor(advisor: AdvisorRecoverySnapshot) { return this.open(() => this.answers.hireAdvisor(advisor)); }
  owes(seq: number, next: number | null, holds: boolean, standing: AgentStandingReport) { return this.open(() => this.answers.owes(seq, next, holds, standing)); }
  birthContext(drainTurnId: string) { return this.open(() => this.answers.birthContext(drainTurnId)); }
  steerSkills(text: string, alreadyActive: readonly string[]) { return this.open(() => this.answers.steerSkills(text, alreadyActive)); }
  openWork() { return this.open(() => this.answers.openWork()); }
  noteModelRequest(lastRequestAt: number | null) { return this.open(() => this.answers.noteModelRequest(lastRequestAt)); }
  armCacheWarm(input: CacheWarmArm) { return this.open(() => this.answers.armCacheWarm(input)); }
  getAuth(key: string, opts?: AuthRequest) { return this.open(() => this.answers.getAuth(key, opts)); }
  listCredentials() { return this.open(() => this.answers.listCredentials()); }
  relayDevice(provider: RelayedProvider) { return this.open(() => this.answers.relayDevice(provider)); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.open(() => this.answers.relayModelCall(deviceId, callId, request)); }
  cancelModelRelay(callId: string) { return this.open(() => this.answers.cancelModelRelay(callId)); }
  sayToParent(signal: AgentSignal) { return this.open(() => this.answers.sayToParent(signal)); }
  logActivity(lines: readonly AgentTurnActivity[]) { return this.open(() => this.answers.logActivity(lines)); }
}

/** One agent's own stores, in its isolate (D9). */
export class AgentStoreBroker {
  constructor(private readonly calls: () => Promise<AgentFacetCalls>, private readonly snapshot: () => AgentSnapshot) {}

  async history(limit?: number) { return await (await this.calls()).history(this.snapshot(), limit); }
  async historyPage(page: PositionPageRequest) { return await (await this.calls()).historyPage(this.snapshot(), page); }
  async messageCount() { return await (await this.calls()).messageCount(this.snapshot()); }
  async admitted(id: string) { return await (await this.calls()).admitted(this.snapshot(), id); }
  async inspect(request: AgentOwnInspection) { return await (await this.calls()).inspect(this.snapshot(), request); }
  async inheritedContext() { return await (await this.calls()).inheritedContext(this.snapshot()); }
  async workingContext() { return decodeModelMessageValues(await (await this.calls()).workingContext(this.snapshot())); }
  async turnRequests(turnId: string) { return await (await this.calls()).turnRequests(this.snapshot(), turnId); }
  async turnRequest(at: TurnRequestAt) { return await (await this.calls()).turnRequest(this.snapshot(), at); }
  async archivePage(cursor: ArchiveSqlCursor | null, maxBytes: number) { return await (await this.calls()).archivePage(this.snapshot(), cursor, maxBytes); }
  async spend(steps: readonly StepSpendSource[]) { return await (await this.calls()).spend(this.snapshot(), steps); }

  contextTree(editor: ContextEditor): ContextTree {
    return remoteContextTree(async () => await (await this.calls()).context(this.snapshot(), editor));
  }

  conversations(): ConversationRecall {
    return {
      search: async (query, limit) => await (await this.calls()).searchConversations(this.snapshot(), query, limit),
      scroll: async (around, window, maxChars) => await (await this.calls()).scrollConversation(this.snapshot(), around, window, maxChars),
      browse: async (limit) => await (await this.calls()).browseConversations(this.snapshot(), limit),
    };
  }

  /** Its conversation as a fork of its workspace reads it: a section's rows are pulled from its isolate as the fork's
   *  frames go out. */
  forkSource(): ForkConversationSource {
    const { calls, snapshot } = this;

    return {
      has: async (messageId) => await (await calls()).forkHas(snapshot(), messageId),
      plan: async (untilMessageId, artifactDirectory) => await (await calls()).forkPlan(snapshot(), untilMessageId, artifactDirectory),
      count: async (kind, plan, artifactDirectory) => await (await calls()).forkCount(snapshot(), kind, plan, artifactDirectory),
      rows: async function* <K extends ForkConversationSection>(kind: K, plan: ForkConversationPlan, artifactDirectory: string): AsyncIterable<ForkRows[K]> {
        const lines = await (await calls()).forkRows(snapshot(), kind, plan, artifactDirectory);

        yield* jsonLines(lines, forkConversationRowSchema(kind));
      },
    };
  }

  /** A fork of its workspace landing its conversation in its isolate, carried payloads re-rooted under `artifactDirectory`. */
  forkTarget(artifactDirectory: string): ForkConversationTarget {
    return {
      clear: async () => { await (await this.calls()).forkClear(this.snapshot(), artifactDirectory); },
      stage: async (kind, rows) => { await (await this.calls()).forkStage(this.snapshot(), artifactDirectory, kind, rows); },
      publish: async (cutMessageId) => { await (await this.calls()).forkPublish(this.snapshot(), artifactDirectory, cutMessageId); },
    };
  }
}

export class AgentWorkspaceRPC extends WorkerEntrypoint<Env, AgentWorkspaceProps> {
  private host() {
    const namespace = this.env.OrchestratorAgent;

    return namespace.get(namespace.idFromString(this.ctx.props.workspace)).agentWorkspace(this.ctx.props.actorId);
  }

  /** Each call opens the workspace's host for itself and lets it go at its edge, once answered: a stub nobody disposes
   *  keeps whatever capability its call carried (a codemode program's callbacks) until the context ends. A session or a
   *  stream it answers is its caller's, and stays open. */
  private async owned<A>(call: (host: Awaited<ReturnType<typeof this.host>>) => Promise<A>): Promise<A> {
    using host = await this.host();

    return await relayedAnswer(call(host));
  }

  /**
   * The agent's port (design v2 §3): its workspace's host, which the agent holds across its calls so each crosses once.
   * A call bound to a turn is fenced there; one that fails lets the port go, and the next call opens it again. The
   * calls whose answers own live capabilities (a session, memory, a program's callbacks) open a host each, below.
   */
  async port() { return await this.host(); }

  session() { return this.owned((host) => host.session()); }
  stateSession() { return this.owned((host) => host.stateSession()); }
  memory() { return this.owned((host) => host.memory()); }
  program(turnId: string, ...args: Parameters<Executor['execute']>) { return this.owned((host) => host.program(turnId, ...args)); }
  traceTurn(turnId: string, event: AgentTrace) { return this.owned((host) => host.traceTurn(turnId, event)); }
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>) { return this.owned((host) => host.traceStream(turnId, lines)); }
  resume(turnId: string) { return this.owned((host) => host.resume(turnId)); }
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) { return this.owned((host) => host.guard(turnId, ...args)); }
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>) { return this.owned((host) => host.debit(turnId, ...args)); }
  prepareTurn(turnId: string) { return this.owned((host) => host.prepareTurn(turnId)); }
  advise(review: AgentReview) { return this.owned((host) => host.advise(review)); }
  runEnded(id: string, outcome: AgentRunOutcome) { return this.owned((host) => host.runEnded(id, outcome)); }
  enqueueTurn(input: ProgrammaticTurn) { return this.owned((host) => host.enqueueTurn(input)); }
  executeTool(call: AgentToolCall) { return this.owned((host) => host.executeTool(call)); }
  observe(lines: ReadableStream<Uint8Array>) { return this.owned((host) => host.observe(lines)); }
  paceStep(turnId: string) { return this.owned((host) => host.paceStep(turnId)); }
  answerMetadata(turnId: string, narration: readonly string[] | null) { return this.owned((host) => host.answerMetadata(turnId, narration)); }
  reportModelCall(report: ModelCallReport) { return this.owned((host) => host.reportModelCall(report)); }
  reportModelOperation(event: ModelOperationEvent) { return this.owned((host) => host.reportModelOperation(event)); }
  prepareChat(request: ChatTurnRequest) { return this.owned((host) => host.prepareChat(request)); }
  bindProfile(turnId: string, profile: ResolvedTurnProfile) { return this.owned((host) => host.bindProfile(turnId, profile)); }
  chatEvent(event: SessionEvent) { return this.owned((host) => host.chatEvent(event)); }
  turnEnded(event: SessionEvent, figures: AgentFigures, activity: readonly AgentTurnActivity[]) { return this.owned((host) => host.turnEnded(event, figures, activity)); }
  owedReport(...args: Parameters<AgentWorkspace['owedReport']>) { return this.owned((host) => host.owedReport(...args)); }
  parentReport(report: Parameters<AgentWorkspace['parentReport']>[0]) { return this.owned((host) => host.parentReport(report)); }
  autoTitle(subject: string, title: string | null) { return this.owned((host) => host.autoTitle(subject, title)); }
  turnSettled(settled: HandedOffTurn) { return this.owned((host) => host.turnSettled(settled)); }
  hireAdvisor(advisor: AdvisorRecoverySnapshot) { return this.owned((host) => host.hireAdvisor(advisor)); }
  owes(seq: number, next: number | null, holds: boolean, standing: AgentStandingReport) { return this.owned((host) => host.owes(seq, next, holds, standing)); }
  birthContext(drainTurnId: string) { return this.owned((host) => host.birthContext(drainTurnId)); }
  steerSkills(text: string, alreadyActive: readonly string[]) { return this.owned((host) => host.steerSkills(text, alreadyActive)); }
  openWork() { return this.owned((host) => host.openWork()); }
  noteModelRequest(lastRequestAt: number | null) { return this.owned((host) => host.noteModelRequest(lastRequestAt)); }
  armCacheWarm(input: CacheWarmArm) { return this.owned((host) => host.armCacheWarm(input)); }
  getAuth(key: string, opts?: AuthRequest) { return this.owned((host) => host.getAuth(key, opts)); }
  listCredentials() { return this.owned((host) => host.listCredentials()); }
  relayDevice(provider: RelayedProvider) { return this.owned((host) => host.relayDevice(provider)); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.owned((host) => host.relayModelCall(deviceId, callId, request)); }
  cancelModelRelay(callId: string) { return this.owned((host) => host.cancelModelRelay(callId)); }
  sayToParent(signal: AgentSignal) { return this.owned((host) => host.sayToParent(signal)); }
  logActivity(lines: readonly AgentTurnActivity[]) { return this.owned((host) => host.logActivity(lines)); }
}

const UIChunkSchema = v.custom<UIMessageChunk>((value) => v.is(v.looseObject({ type: v.string() }), value), 'a UI message chunk');

export function jsonLines<T>(lines: ReadableStream<Uint8Array>, schema: v.GenericSchema<unknown, T>): ReadableStream<T> {
  const decoder = new TextDecoder();
  let partial = '';

  return lines.pipeThrough(new TransformStream<Uint8Array, T>({
    transform: (bytes, controller) => {
      const complete = (partial + decoder.decode(bytes, { stream: true })).split('\n');

      partial = complete.pop() ?? '';

      for (const line of complete) if (line !== '') controller.enqueue(v.parse(schema, JSON.parse(line)));
    },
  }));
}

export function uiChunks(lines: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  return jsonLines(lines, UIChunkSchema);
}

const HeadDeltaSchema = v.object({ kind: v.picklist(['text', 'reasoning']), delta: v.string() });

export function headDeltas(lines: ReadableStream<Uint8Array>): ReadableStream<AgentHeadDelta> {
  return jsonLines(lines, HeadDeltaSchema);
}

export function agentStateShellId(storageKey: string): string {
  return `state:${storageKey}`;
}

export interface AgentFacetPlacement {
  readonly actorId: string;
  readonly storageKey: string;
  readonly workspaceName: string;
  readonly shellId: string;
  readonly home: string;
  readonly providers: ProviderEnv;
}

function agentBundle(assets: Fetcher): Effect.Effect<Response, KinuError> {
  return attempt({ doing: 'fetching the agent bundle', otherwise: 'unavailable' }, () => assets.fetch(new URL(AGENT_BUNDLE_PATH, `https://${ASSETS_HOSTS.agentBundle}`)))
    .pipe(Effect.flatMap((response) => {
      const type = response.headers.get('content-type') ?? '';

      return response.ok && type.includes('json')
        ? Effect.succeed(response)
        : Effect.fail(new KinuError(
          'unavailable', `The agent bundle is missing from this deployment (${AGENT_BUNDLE_PATH} answered ${response.status} ${type}). `
            + 'Under `vite dev` the dev server refuses a host vite.config.ts does not admit (src/assets-hosts.ts).',
        ));
    }));
}

const CompatibilitySchema = v.object({ compatibilityDate: v.string(), compatibilityFlags: v.array(v.string()) });

function agentCompatibility(assets: Fetcher) {
  return attempt({ doing: 'reading deployment compatibility', otherwise: 'unavailable' }, async () => {
    const response = await assets.fetch(new URL(`${AGENT_BUNDLE_DIRECTORY}/compatibility.json`, `https://${ASSETS_HOSTS.agentBundle}`));

    return v.parse(CompatibilitySchema, await response.json());
  });
}

async function tagOf(response: Response): Promise<string> {
  const etag = response.headers.get('etag');

  if (etag !== null) {
    await response.body?.cancel();

    return etag.replace(/\W/g, '');
  }

  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());

  return Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let bundleTag: string | null = null;

function agentBundleTag(assets: Fetcher): Effect.Effect<string, KinuError> {
  if (bundleTag !== null) return Effect.succeed(bundleTag);

  return agentBundle(assets).pipe(
    Effect.flatMap((response) => attempt({ doing: 'reading the agent bundle tag', otherwise: 'unavailable' }, () => tagOf(response))),
    Effect.tap((tag) => Effect.sync(() => { bundleTag = tag; })),
  );
}

export function agentFacet<Facet extends AgentFacet = AgentFacet>(
  ctx: DurableObjectState,
  env: Pick<Env, 'LOADER' | 'ASSETS'>,
  placement: AgentFacetPlacement,
): Promise<Fetcher<Facet>> {
  const workspace = ctx.id.toString();

  const facetEnv = {
    WORKSPACE: exports.AgentWorkspaceRPC({ props: { workspace, actorId: placement.actorId } }),
    WORKSPACE_NAME: placement.workspaceName,
    SHELL_ID: placement.shellId,
    HOME: placement.home,
    STATE_SHELL_ID: agentStateShellId(placement.storageKey),
    ...placement.providers,
  } satisfies Record<Exclude<keyof AgentFacetEnv, keyof ProviderEnv>, Fetcher | string> & ProviderEnv;

  return settle(agentBundleTag(env.ASSETS).pipe(Effect.map((tag) => {
    const worker = env.LOADER.get(`kinu-agent:${tag}:${workspace}:${placement.storageKey}`, () => settle(agentCompatibility(env.ASSETS).pipe(
      Effect.flatMap((compatibility) => agentBundle(env.ASSETS).pipe(
        Effect.flatMap((response) => attempt({ doing: 'reading the agent bundle', otherwise: 'unavailable' }, async () => v.parse(AgentModulesSchema, await response.json()))),
        Effect.map((modules) => ({
          ...compatibility,
          mainModule: 'agent.js',
          modules,
          env: facetEnv,
        })),
      )),
    )));

    return ctx.facets.get<Facet>(placement.storageKey, () => ({ class: worker.getDurableObjectClass<Facet>(AGENT_FACET_CLASS) }));
  })));
}
