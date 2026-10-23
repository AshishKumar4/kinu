/** The workspace side of an agent's isolate (D9). */
import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';
import type { UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { decodeModelMessageValues, forkConversationRowSchema, relayedAnswer, remoteContextTree } from '@kinu.run/core';
import type { ChatWindow, ForkConversationPlan, ForkConversationSection, ForkConversationSource, ForkConversationTarget, ForkRows } from '@kinu.run/core';
import type { CacheWarmArm, ContextEditor, ContextTree, ConversationRecall, AgentSignal, AuthRequest, RelayedProvider, ProgrammaticTurn, ProviderEnv, Memory, Executor, MissionBudgetPort } from '@kinu.run/core';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import type { AgentWorkspace, TurnBound, TurnCapabilityOf } from './agent-facet/agent-turn';
import type { AgentFigures, AgentReport, AgentTurnActivity, HandedOffTurn, ResolvedTurnProfile, SettledRun, AgentHeadDelta, AgentSnapshot, AgentToolCall, AgentAdvisorRead, AgentTrace, SessionEvent, TurnEndEvent, ModelCallReport } from '@kinu.run/core';
import type { ChatTurnRequest } from './agent-turns';
import { attempt, diagnostics, KinuError, relayedLine, settle, toKinuError } from '@kinu.run/core/obs';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { Effect } from 'effect';
import type { AgentFacet, AgentFacetCalls, AgentFacetEnv } from './agent-facet/agent-facet';
import { disposeRpc } from './agent-facet/workspace-rpc';
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

/** Whose isolate a tail hears: the workspace by name and the agent, as its relayed lines name them, and the workspace's
 *  object by id, which a tail's own rows lack: a reader matches a relayed line to its workspace's rows by it (a deletion,
 *  for one). */
export interface AgentIsolateTailProps {
  readonly workspace: string;
  readonly actor: string;
  readonly object: string;
}

/** A console call's arguments as its tail delivers them, each as text: a string itself, anything else its JSON. */
const ConsoleArgumentsSchema = v.array(v.pipe(v.unknown(), v.transform((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part)))));

/**
 * One invocation of an agent's isolate, as its tail hears it, written as this workspace's lines with the agent named:
 * each line it logged through the diagnostics envelope again under its own event, any other console call and each
 * exception under the isolate's, then the invocation's own outcome, CPU and wall time.
 */
function relayIsolateTrace(item: TraceItem, named: AgentIsolateTailProps): void {
  for (const log of item.logs) {
    const parts = v.parse(ConsoleArgumentsSchema, Array.isArray(log.message) ? log.message : [log.message]);
    // The isolate's diagnostics write one string per call.
    const line = parts.length === 1 && parts[0] !== undefined ? relayedLine(parts[0]) : null;

    if (line !== null) diagnostics.relay({ ...line, fields: { ...line.fields, ...named } });
    else diagnostics.event('agent.isolate_console', { ...named, level: log.level, text: parts.join(' ').slice(0, 2000) });
  }

  for (const exception of item.exceptions) {
    const thrown = new Error(exception.message);

    thrown.name = exception.name;
    diagnostics.failure('agent.isolate_exception', toKinuError({ doing: "running the agent's isolate", cause: thrown, otherwise: 'unavailable' }), named);
  }

  diagnostics.event('agent.isolate_invocation', {
    ...named, entrypoint: item.entrypoint ?? '', ...invoked(item.event), outcome: item.outcome,
    startedAt: item.eventTimestamp ?? 0, cpuMs: item.cpuTime, wallMs: item.wallTime, truncated: item.truncated,
  });
}

/** What started an invocation of an agent's isolate: a call into it by name, or an event (its alarm, a fetch). */
function invoked(event: TraceItem['event']) {
  if (event === null) return { kind: '', method: '' };

  if ('rpcMethod' in event) return { kind: 'jsrpc', method: event.rpcMethod };

  if ('scheduledTime' in event) return { kind: 'alarm', method: '' };

  return { kind: 'request' in event ? 'fetch' : 'other', method: '' };
}

/** When an invocation's isolate ran out of memory, as the platform says it: the invocation's outcome, or an exception it
 *  threw that names the memory limit. Null for any other end. */
function outOfMemoryAt(item: TraceItem): number | null {
  const named = item.exceptions.some((exception) => {
    const thrown = new Error(exception.message);

    thrown.name = exception.name;

    return toKinuError({ doing: "running the agent's isolate", cause: thrown, otherwise: 'unavailable' }).code === 'oom';
  });

  if (item.outcome !== 'exceededMemory' && !named) return null;

  // It died as the invocation ended.
  return (item.eventTimestamp ?? Date.now()) + item.wallTime;
}

/**
 * Where an agent's isolate is heard (#65): a Dynamic Worker's console, exceptions and invocations reach no log store of
 * their own, so its loader names this tail, which writes each invocation's as this workspace's lines. An isolate that ran
 * out of memory is told to its workspace too, which marks the execution it killed.
 */
export class AgentIsolateTail extends WorkerEntrypoint<Env, AgentIsolateTailProps> {
  override tail(events: TraceItem[]): Promise<void> {
    installAnalyticsDiagnostics(this.env, { workspace: this.ctx.props.workspace });

    for (const item of events) relayIsolateTrace(item, this.ctx.props);
    const deaths = events.map(outOfMemoryAt).filter((diedAt) => diedAt !== null);

    // Told within this invocation, so a tail that ends cannot drop it.
    return settle(Effect.forEach(deaths, (diedAt) => this.outOfMemory(diedAt), { discard: true }));
  }

  private outOfMemory(diedAt: number): Effect.Effect<void> {
    const workspaces = this.env.OrchestratorAgent;
    const { actor, object } = this.ctx.props;

    return Effect.catch(
      attempt({ doing: "telling the workspace its agent's isolate ran out of memory", otherwise: 'unavailable' }, () => workspaces.get(workspaces.idFromString(object)).isolateOutOfMemory(actor, diedAt)),
      (failure) => Effect.sync(() => { diagnostics.failure('agent.isolate_oom_report_failed', failure, this.ctx.props); }),
    );
  }
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

/** What a turn-bound call does: opens an execution under its capability (a run's preparation), runs something of it,
 *  or settles what it did. */
export type TurnCall = 'opens' | 'executes' | 'settles';

export class AgentWorkspaceHost extends RpcTarget implements AgentWorkspaceAnswers {
  /**
   * `closed` aborts as the workspace is deleted: every call still open is refused then, so its relay hears an end.
   * `fenced` answers whether a call bound to a turn is the agent's current one: a turn a later opening superseded, or a
   * Stop cancelled, is refused before anything runs (design v2 §3).
   */
  constructor(
    private readonly answers: AgentWorkspaceAnswers,
    private readonly closed: AbortSignal,
    private readonly fenced: (bound: TurnBound, call: TurnCall) => boolean = () => true,
    private readonly cutOff: (turnId: string) => AbortSignal | null = () => null,
  ) {
    super();
  }

  /** `call`: what a turn-bound call does. One that executes is refused for a turn a Stop cut off; one that settles what the
   *  turn already did (its answer, its trace, its charges) is not, so the stopped turn closes. */
  private open<T>(answer: () => T | Promise<T>, bound?: TurnBound, call: TurnCall = 'settles'): Promise<T> {
    const refused = Promise.withResolvers<never>();

    if (bound !== undefined && !this.fenced(bound, call)) {
      refused.reject(call === 'settles'
        ? new KinuError('denied', `stale_close: the close of turn ${bound.turnId} names an execution this agent never opened as such.`)
        : new KinuError('cancelled', `stale_epoch: turn ${bound.turnId} is no longer this agent's current turn.`));

      return refused.promise;
    }

    // A call that runs more of its turn ends as the turn is cut off, as every call does as the workspace is deleted.
    const cut = bound !== undefined && call !== 'settles' ? this.cutOff(bound.turnId) : null;
    const ends = cut === null ? this.closed : AbortSignal.any([this.closed, cut]);
    const refuse = (): void => { refused.reject(ends.reason); };

    if (ends.aborted) refuse();
    else ends.addEventListener('abort', refuse, { once: true });

    return Promise.race([answer(), refused.promise]).finally(() => { ends.removeEventListener('abort', refuse); });
  }

  session() { return this.open(() => this.answers.session()); }
  stateSession() { return this.open(() => this.answers.stateSession()); }
  memory() { return this.answers.memory(); }
  program(bound: TurnBound, ...args: Parameters<Executor['execute']>) { return this.open(() => this.answers.program(bound, ...args), bound, 'executes'); }
  traceTurn(close: TurnBound, event: AgentTrace) { return this.open(() => this.answers.traceTurn(close, event), close); }
  traceStream(close: TurnBound, lines: ReadableStream<Uint8Array>) { return this.open(() => this.answers.traceStream(close, lines), close); }
  resume(bound: TurnBound) { return this.open(() => this.answers.resume(bound), bound, 'executes'); }
  guard(bound: TurnBound, ...args: Parameters<MissionBudgetPort['guard']>) { return this.open(() => this.answers.guard(bound, ...args), bound, 'executes'); }
  debit(close: TurnBound, ...args: Parameters<MissionBudgetPort['debit']>) { return this.open(() => this.answers.debit(close, ...args), close); }
  /** A run's preparation, which only that run's own cut ends. */
  prepareTurn(bound: TurnCapabilityOf) { return this.open(() => this.answers.prepareTurn(bound), bound, 'opens'); }
  enqueueTurn(input: ProgrammaticTurn) { return this.open(() => this.answers.enqueueTurn(input)); }
  executeTool(call: AgentToolCall) { return this.open(() => this.answers.executeTool(call), call, 'executes'); }
  advisorRead(call: AgentAdvisorRead) { return this.open(() => this.answers.advisorRead(call), call, 'executes'); }
  receipts(turnId: string, runId: string, callIds: readonly string[]) { return this.open(() => this.answers.receipts(turnId, runId, callIds)); }
  observe(lines: ReadableStream<Uint8Array>) { return this.open(() => this.answers.observe(lines)); }
  paceStep(bound: TurnBound, profile: ResolvedTurnProfile | null) { return this.open(() => this.answers.paceStep(bound, profile), bound, 'executes'); }
  answerMetadata(close: TurnBound, narration: readonly string[] | null) { return this.open(() => this.answers.answerMetadata(close, narration), close); }
  reportModelCall(report: ModelCallReport) { return this.open(() => this.answers.reportModelCall(report)); }
  prepareChat(request: ChatTurnRequest) { return this.open(() => this.answers.prepareChat(request)); }
  scaffold() { return this.open(() => this.answers.scaffold()); }
  chatEvent(event: SessionEvent) { return this.open(() => this.answers.chatEvent(event)); }
  turnEnded(ended: TurnEndEvent, figures: AgentFigures, activity: readonly AgentTurnActivity[], window: ChatWindow) { return this.open(() => this.answers.turnEnded(ended, figures, activity, window), ended); }
  answerAmended(window: ChatWindow) { return this.open(() => this.answers.answerAmended(window)); }
  turnReport(...args: Parameters<AgentWorkspace['turnReport']>) { return this.open(() => this.answers.turnReport(...args)); }
  parentReport(report: Parameters<AgentWorkspace['parentReport']>[0]) { return this.open(() => this.answers.parentReport(report)); }
  autoTitle(subject: string, title: string | null) { return this.open(() => this.answers.autoTitle(subject, title)); }
  turnSettled(settled: HandedOffTurn) { return this.open(() => this.answers.turnSettled(settled), settled); }
  runSettled(run: SettledRun) { return this.open(() => this.answers.runSettled(run), run); }
  owes(seq: number, next: number | null, holds: boolean, report: AgentReport) { return this.open(() => this.answers.owes(seq, next, holds, report)); }
  birthContext(drainTurnId: string) { return this.open(() => this.answers.birthContext(drainTurnId)); }
  steerSkills(text: string, alreadyActive: readonly string[]) { return this.open(() => this.answers.steerSkills(text, alreadyActive)); }
  releaseForeground(executing: number) { return this.open(() => this.answers.releaseForeground(executing)); }
  openWork() { return this.open(() => this.answers.openWork()); }
  armCacheWarm(input: CacheWarmArm) { return this.open(() => this.answers.armCacheWarm(input)); }
  getAuth(key: string, opts?: AuthRequest) { return this.open(() => this.answers.getAuth(key, opts)); }
  listCredentials() { return this.open(() => this.answers.listCredentials()); }
  relayDevice(provider: RelayedProvider) { return this.open(() => this.answers.relayDevice(provider)); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.open(() => this.answers.relayModelCall(deviceId, callId, request)); }
  cancelModelRelay(callId: string) { return this.open(() => this.answers.cancelModelRelay(callId)); }
  sayToParent(signal: AgentSignal) { return this.open(() => this.answers.sayToParent(signal)); }
  logActivity(lines: readonly AgentTurnActivity[]) { return this.open(() => this.answers.logActivity(lines)); }
}

/** A call into one agent's isolate, bound to the agent's snapshot. */
export type AgentCall = <A>(call: (isolate: AgentFacetCalls, snapshot: AgentSnapshot) => Promise<A>) => Promise<A>;

/** One agent's own stores, in its isolate (D9), as core's ports read them. */
export class AgentStoreBroker {
  constructor(private readonly call: AgentCall) {}

  async workingContext() { return decodeModelMessageValues(await this.call((isolate, snapshot) => isolate.workingContext(snapshot))); }

  /** Each call opens the agent's served tree and lets it go once answered: one left open kept the agent's isolate, and
   *  its workspace with it, from hibernating (#69's rule; a Files listing of /context, cmp-kinu-ux4, 2026-10-13). */
  contextTree(editor: ContextEditor): ContextTree {
    return remoteContextTree(async (call) => {
      const served = await this.call((isolate, snapshot) => isolate.context(snapshot, editor));

      try {
        return await call(served);
      } finally {
        disposeRpc(served);
      }
    });
  }

  conversations(): ConversationRecall {
    return {
      search: (query, limit) => this.call((isolate, snapshot) => isolate.searchConversations(snapshot, query, limit)),
      scroll: (around, window, maxChars) => this.call((isolate, snapshot) => isolate.scrollConversation(snapshot, around, window, maxChars)),
      browse: (limit) => this.call((isolate, snapshot) => isolate.browseConversations(snapshot, limit)),
    };
  }

  /** Its conversation as a fork of its workspace reads it: a section's rows are pulled from its isolate as the fork's
   *  frames go out. */
  forkSource(): ForkConversationSource {
    const { call } = this;

    return {
      has: (messageId) => call((isolate, snapshot) => isolate.forkHas(snapshot, messageId)),
      plan: (untilMessageId, artifactDirectory) => call((isolate, snapshot) => isolate.forkPlan(snapshot, untilMessageId, artifactDirectory)),
      count: (kind, plan, artifactDirectory) => call((isolate, snapshot) => isolate.forkCount(snapshot, kind, plan, artifactDirectory)),
      rows: async function* <K extends ForkConversationSection>(kind: K, plan: ForkConversationPlan, artifactDirectory: string): AsyncIterable<ForkRows[K]> {
        const lines = await call((isolate, snapshot) => isolate.forkRows(snapshot, kind, plan, artifactDirectory));

        yield* jsonLines(lines, forkConversationRowSchema(kind));
      },
    };
  }

  /** A fork of its workspace landing its conversation in its isolate, carried payloads re-rooted under `artifactDirectory`. */
  forkTarget(artifactDirectory: string): ForkConversationTarget {
    return {
      clear: async () => { await this.call((isolate, snapshot) => isolate.forkClear(snapshot, artifactDirectory)); },
      stage: async (kind, rows) => { await this.call((isolate, snapshot) => isolate.forkStage(snapshot, artifactDirectory, kind, rows)); },
      publish: async (cutMessageId) => { await this.call((isolate, snapshot) => isolate.forkPublish(snapshot, artifactDirectory, cutMessageId)); },
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
   * A call bound to a turn is fenced there; one that fails lets the port go, and the next call opens it again. Only the
   * calls whose answers own live capabilities (a session, memory, a program's callbacks) open a host each, below.
   */
  async port() { return await this.host(); }

  session() { return this.owned((host) => host.session()); }
  stateSession() { return this.owned((host) => host.stateSession()); }
  memory() { return this.owned((host) => host.memory()); }
  program(bound: TurnBound, ...args: Parameters<Executor['execute']>) { return this.owned((host) => host.program(bound, ...args)); }
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
    HOME: placement.home,
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
          tails: [exports.AgentIsolateTail({ props: { workspace: placement.workspaceName, actor: placement.actorId, object: workspace } })],
        })),
      )),
    )));

    return ctx.facets.get<Facet>(placement.storageKey, () => ({ class: worker.getDurableObjectClass<Facet>(AGENT_FACET_CLASS) }));
  })));
}
