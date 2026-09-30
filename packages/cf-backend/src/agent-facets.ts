/** The workspace side of an agent's isolate (D9). */
import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';
import type { UIMessageChunk } from 'ai';
import * as v from 'valibot';
import type { AuthRequest, RelayedProvider, ProgrammaticTurn, ObservedCall, ProviderEnv, WorkMode, Memory, Executor, MissionBudgetPort } from '@kinu.run/core';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import type { AgentWorkspace } from './agent-facet/agent-turn';
import type { AgentReview, AgentToolCall, AgentTrace, AgentTurnEnd } from './agent-facet/protocol';
import { attempt, KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { AgentFacet, AgentFacetEnv } from './agent-facet/agent-facet';

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
  failTurn(turnId: string, failure: string) { return this.answers.failTurn(turnId, failure); }
  getAuthHeaders(key: string, opts?: AuthRequest) { return this.answers.getAuthHeaders(key, opts); }
  getCredentialBaseURL(key: string) { return this.answers.getCredentialBaseURL(key); }
  listCredentials() { return this.answers.listCredentials(); }
  relayDevice(provider: RelayedProvider) { return this.answers.relayDevice(provider); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.answers.relayModelCall(deviceId, callId, request); }
  cancelModelRelay(callId: string) { return this.answers.cancelModelRelay(callId); }
  forwardCodex(callId: string, request: Request) { return this.answers.forwardCodex(callId, request); }
  cancelCodex(callId: string) { return this.answers.cancelCodex(callId); }
}

export class AgentWorkspaceRPC extends WorkerEntrypoint<Env, AgentWorkspaceProps> {
  private host() {
    const namespace = this.env.OrchestratorAgent;

    return namespace.get(namespace.idFromString(this.ctx.props.workspace)).agentWorkspace(this.ctx.props.actorId);
  }

  session() { return this.host().session(); }
  stateSession() { return this.host().stateSession(); }
  memory() { return this.host().memory(); }
  program(turnId: string, ...args: Parameters<Executor['execute']>) { return this.host().program(turnId, ...args); }
  traceTurn(turnId: string, event: AgentTrace) { return this.host().traceTurn(turnId, event); }
  resume(turnId: string) { return this.host().resume(turnId); }
  guard(turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) { return this.host().guard(turnId, ...args); }
  debit(turnId: string, ...args: Parameters<MissionBudgetPort['debit']>) { return this.host().debit(turnId, ...args); }
  prepareTurn(turnId: string) { return this.host().prepareTurn(turnId); }
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode) { return this.host().profile(turnId, availableTools, workMode); }
  advise(review: AgentReview) { return this.host().advise(review); }
  enqueueTurn(input: ProgrammaticTurn) { return this.host().enqueueTurn(input); }
  executeTool(call: AgentToolCall) { return this.host().executeTool(call); }
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall) { return this.host().observe(lines, call); }
  answerMetadata(turnId: string, narration: readonly string[]) { return this.host().answerMetadata(turnId, narration); }
  finishTurn(turnId: string, end: AgentTurnEnd) { return this.host().finishTurn(turnId, end); }
  failTurn(turnId: string, failure: string) { return this.host().failTurn(turnId, failure); }
  getAuthHeaders(key: string, opts?: AuthRequest) { return this.host().getAuthHeaders(key, opts); }
  getCredentialBaseURL(key: string) { return this.host().getCredentialBaseURL(key); }
  listCredentials() { return this.host().listCredentials(); }
  relayDevice(provider: RelayedProvider) { return this.host().relayDevice(provider); }
  relayModelCall(deviceId: string, callId: string, request: Request) { return this.host().relayModelCall(deviceId, callId, request); }
  cancelModelRelay(callId: string) { return this.host().cancelModelRelay(callId); }
  forwardCodex(callId: string, request: Request) { return this.host().forwardCodex(callId, request); }
  cancelCodex(callId: string) { return this.host().cancelCodex(callId); }
}

const UIChunkSchema = v.custom<UIMessageChunk>((value) => v.is(v.looseObject({ type: v.string() }), value), 'a UI message chunk');

export function uiChunks(lines: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let partial = '';

  return lines.pipeThrough(new TransformStream<Uint8Array, UIMessageChunk>({
    transform: (bytes, controller) => {
      const complete = (partial + decoder.decode(bytes, { stream: true })).split('\n');

      partial = complete.pop() ?? '';

      for (const line of complete) if (line !== '') controller.enqueue(v.parse(UIChunkSchema, JSON.parse(line)));
    },
  }));
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
          'unavailable', `The agent bundle is missing from this deployment (${AGENT_BUNDLE_PATH} answered ${response.status} ${type}).`,
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
