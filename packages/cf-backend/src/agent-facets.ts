/** The workspace side of an agent's isolate (D9). */
import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';
import type { UIMessageChunk } from 'ai';
import * as v from 'valibot';
import { relayedAnswer, remoteContextTree } from '@kinu.run/core';
import type { AgentOwnInspection, ArchiveSqlCursor, ContextEditor, ContextTree, StepSpendSource, ConversationRecall, PositionPageRequest, AgentSignal, AuthRequest, RelayedProvider, ProgrammaticTurn, ObservedCall, ProviderEnv, WorkMode, Memory, Executor, MissionBudgetPort } from '@kinu.run/core';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import type { AgentWorkspace } from './agent-facet/agent-turn';
import type { AgentFigures, AgentHeadDelta, AgentReview, AgentSnapshot, AgentToolCall, AgentTrace, AgentTurnEnd, TurnRequestAt } from '@kinu.run/core';
import { attempt, KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { AgentFacet, AgentFacetCalls, AgentFacetEnv } from './agent-facet/agent-facet';

export const AGENT_BUNDLE_DIRECTORY = '/_agent';

const AGENT_BUNDLE_PATH = `${AGENT_BUNDLE_DIRECTORY}/agent.js`;

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
  async tail(path: string, bytes: number) { return await (await this.open()).tail(path, bytes); }
}

export class AgentWorkspaceHost extends RpcTarget implements AgentWorkspaceAnswers {
  constructor(private readonly answers: AgentWorkspaceAnswers) {
    super();
  }

  session() { return this.answers.session(); }
  stateSession() { return this.answers.stateSession(); }
  memory() { return this.answers.memory(); }
  program(turnId: string, ...args: Parameters<Executor['execute']>) { return this.answers.program(turnId, ...args); }
  traceTurn(turnId: string, event: AgentTrace) { return this.answers.traceTurn(turnId, event); }
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>) { return this.answers.traceStream(turnId, lines); }
  resume(turnId: string) { return this.answers.resume(turnId); }
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) { return this.answers.guard(turnId, ...args); }
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>) { return this.answers.debit(turnId, ...args); }
  prepareTurn(turnId: string) { return this.answers.prepareTurn(turnId); }
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode) { return this.answers.profile(turnId, availableTools, workMode); }
  advise(review: AgentReview) { return this.answers.advise(review); }
  enqueueTurn(input: ProgrammaticTurn) { return this.answers.enqueueTurn(input); }
  executeTool(call: AgentToolCall) { return this.answers.executeTool(call); }
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall) { return this.answers.observe(lines, call); }
  answerMetadata(turnId: string, narration: readonly string[]) { return this.answers.answerMetadata(turnId, narration); }
  finishTurn(turnId: string, end: AgentTurnEnd) { return this.answers.finishTurn(turnId, end); }
  failTurn(turnId: string, failure: string, figures: AgentFigures) { return this.answers.failTurn(turnId, failure, figures); }
  getAuth(key: string, opts?: AuthRequest) { return this.answers.getAuth(key, opts); }
  listCredentials() { return this.answers.listCredentials(); }
  relayDevice(provider: RelayedProvider) { return this.answers.relayDevice(provider); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.answers.relayModelCall(deviceId, callId, request); }
  cancelModelRelay(callId: string) { return this.answers.cancelModelRelay(callId); }
  forwardCodex(callId: string, request: Request) { return this.answers.forwardCodex(callId, request); }
  sayToParent(signal: AgentSignal) { return this.answers.sayToParent(signal); }
  cancelCodex(callId: string) { return this.answers.cancelCodex(callId); }
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
  async workingContext() { return await (await this.calls()).workingContext(this.snapshot()); }
  async turnRequests(turnId: string) { return await (await this.calls()).turnRequests(this.snapshot(), turnId); }
  async turnRequest(at: TurnRequestAt) { return await (await this.calls()).turnRequest(this.snapshot(), at); }
  async archivePage(cursor: ArchiveSqlCursor | null, maxBytes: number) { return await (await this.calls()).archivePage(this.snapshot(), cursor, maxBytes); }
  async spend(steps: readonly StepSpendSource[]) { return await (await this.calls()).spend(this.snapshot(), steps); }
  async figures() { return await (await this.calls()).figures(this.snapshot()); }

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
}

export class AgentWorkspaceRPC extends WorkerEntrypoint<Env, AgentWorkspaceProps> {
  private host() {
    const namespace = this.env.OrchestratorAgent;

    return namespace.get(namespace.idFromString(this.ctx.props.workspace)).agentWorkspace(this.ctx.props.actorId);
  }

  session() { return relayedAnswer(this.host().session()); }
  stateSession() { return relayedAnswer(this.host().stateSession()); }
  memory() { return relayedAnswer(this.host().memory()); }
  program(turnId: string, ...args: Parameters<Executor['execute']>) { return relayedAnswer(this.host().program(turnId, ...args)); }
  traceTurn(turnId: string, event: AgentTrace) { return relayedAnswer(this.host().traceTurn(turnId, event)); }
  traceStream(turnId: string, lines: ReadableStream<Uint8Array>) { return relayedAnswer(this.host().traceStream(turnId, lines)); }
  resume(turnId: string) { return relayedAnswer(this.host().resume(turnId)); }
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) { return relayedAnswer(this.host().guard(turnId, ...args)); }
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>) { return relayedAnswer(this.host().debit(turnId, ...args)); }
  prepareTurn(turnId: string) { return relayedAnswer(this.host().prepareTurn(turnId)); }
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode) { return relayedAnswer(this.host().profile(turnId, availableTools, workMode)); }
  advise(review: AgentReview) { return relayedAnswer(this.host().advise(review)); }
  enqueueTurn(input: ProgrammaticTurn) { return relayedAnswer(this.host().enqueueTurn(input)); }
  executeTool(call: AgentToolCall) { return relayedAnswer(this.host().executeTool(call)); }
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall) { return relayedAnswer(this.host().observe(lines, call)); }
  answerMetadata(turnId: string, narration: readonly string[]) { return relayedAnswer(this.host().answerMetadata(turnId, narration)); }
  finishTurn(turnId: string, end: AgentTurnEnd) { return relayedAnswer(this.host().finishTurn(turnId, end)); }
  failTurn(turnId: string, failure: string, figures: AgentFigures) { return relayedAnswer(this.host().failTurn(turnId, failure, figures)); }
  getAuth(key: string, opts?: AuthRequest) { return relayedAnswer(this.host().getAuth(key, opts)); }
  listCredentials() { return relayedAnswer(this.host().listCredentials()); }
  relayDevice(provider: RelayedProvider) { return relayedAnswer(this.host().relayDevice(provider)); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return relayedAnswer(this.host().relayModelCall(deviceId, callId, request)); }
  cancelModelRelay(callId: string) { return relayedAnswer(this.host().cancelModelRelay(callId)); }
  forwardCodex(callId: string, request: Request) { return relayedAnswer(this.host().forwardCodex(callId, request)); }
  sayToParent(signal: AgentSignal) { return relayedAnswer(this.host().sayToParent(signal)); }
  cancelCodex(callId: string) { return relayedAnswer(this.host().cancelCodex(callId)); }
}

const UIChunkSchema = v.custom<UIMessageChunk>((value) => v.is(v.looseObject({ type: v.string() }), value), 'a UI message chunk');

function jsonLines<T>(lines: ReadableStream<Uint8Array>, schema: v.GenericSchema<unknown, T>): ReadableStream<T> {
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
  return attempt({ doing: 'fetching the agent bundle', otherwise: 'unavailable' }, () => assets.fetch(new URL(AGENT_BUNDLE_PATH, 'https://assets.invalid')))
    .pipe(Effect.flatMap((response) => {
      const type = response.headers.get('content-type') ?? '';

      return response.ok && type.includes('javascript')
        ? Effect.succeed(response)
        : Effect.fail(new KinuError(
          'unavailable', `The agent bundle is missing from this deployment (${AGENT_BUNDLE_PATH} answered ${response.status} ${type}). `
            + 'Under `vite dev` the ASSETS binding serves only HTML, so agent turns need a deployed Worker.',
        ));
    }));
}

const CompatibilitySchema = v.object({ compatibilityDate: v.string(), compatibilityFlags: v.array(v.string()) });

function agentCompatibility(assets: Fetcher) {
  return attempt({ doing: 'reading deployment compatibility', otherwise: 'unavailable' }, async () => {
    const response = await assets.fetch(new URL(`${AGENT_BUNDLE_DIRECTORY}/compatibility.json`, 'https://assets.invalid'));

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
        Effect.flatMap((response) => attempt({ doing: 'reading the agent bundle', otherwise: 'unavailable' }, () => response.text())),
        Effect.map((source) => ({
          ...compatibility,
          mainModule: 'agent.js',
          modules: { 'agent.js': source },
          env: facetEnv,
        })),
      )),
    )));

    return ctx.facets.get<Facet>(placement.storageKey, () => ({ class: worker.getDurableObjectClass<Facet>(AGENT_FACET_CLASS) }));
  })));
}
