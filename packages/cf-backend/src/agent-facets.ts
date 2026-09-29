/** The workspace object's side of an agent in its own loader isolate (D9). */
import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';
import type { UIMessageChunk } from 'ai';
import * as v from 'valibot';
import type { AuthRequest, EnqueueTurnResult, JsonObject, ProgrammaticTurn, ObservedCall, ProviderEnv, WorkMode } from '@kinu.run/core';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';
import type { CredentialSummary } from './user/user-do';
import type { AgentReview, AgentToolAnswer, AgentToolCall, AgentTurnEnd, AgentTurnProfile, PreparedAgentTurn } from './agent-facet/protocol';
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

export interface AgentWorkspaceAnswers {
  session(): Promise<HostedSession>;
  stateSession(): Promise<HostedSession>;
  prepareTurn(turnId: string): Promise<PreparedAgentTurn>;
  profile(turnId: string, availableTools: readonly string[], workMode: WorkMode): Promise<AgentTurnProfile>;
  advise(review: AgentReview): Promise<void>;
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  executeTool(call: AgentToolCall): Promise<AgentToolAnswer>;
  observe(lines: ReadableStream<Uint8Array>, call: ObservedCall): Promise<void>;
  answerMetadata(turnId: string, narration: readonly string[]): Promise<JsonObject | null>;
  finishTurn(turnId: string, end: AgentTurnEnd): Promise<void>;
  failTurn(turnId: string, failure: string): Promise<void>;
  getAuthHeaders(key: string, opts?: AuthRequest): Promise<Record<string, string> | null>;
  getCredentialBaseURL(key: string): Promise<string | null>;
  listCredentials(): Promise<CredentialSummary[]>;
  codexRelayDevice(): Promise<{ readonly id: string; readonly label: string } | null>;
  relayCodex(deviceId: string, callId: string, request: Request): Promise<Response>;
  cancelCodexRelay(callId: string): Promise<void>;
}

export class AgentWorkspaceHost extends RpcTarget implements AgentWorkspaceAnswers {
  constructor(private readonly answers: AgentWorkspaceAnswers) {
    super();
  }

  session() { return this.answers.session(); }
  stateSession() { return this.answers.stateSession(); }
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
  codexRelayDevice() { return this.answers.codexRelayDevice(); }
  relayCodex(deviceId: string, callId: string, request: Request) { return this.answers.relayCodex(deviceId, callId, request); }
  cancelCodexRelay(callId: string) { return this.answers.cancelCodexRelay(callId); }
}

export class AgentWorkspaceRPC extends WorkerEntrypoint<Env, AgentWorkspaceProps> {
  private host() {
    const namespace = this.env.OrchestratorAgent;

    return namespace.get(namespace.idFromString(this.ctx.props.workspace)).agentWorkspace(this.ctx.props.actorId);
  }

  session() { return this.host().session(); }
  stateSession() { return this.host().stateSession(); }
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
  codexRelayDevice() { return this.host().codexRelayDevice(); }
  relayCodex(deviceId: string, callId: string, request: Request) { return this.host().relayCodex(deviceId, callId, request); }
  cancelCodexRelay(callId: string) { return this.host().cancelCodexRelay(callId); }
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
    const worker = env.LOADER.get(`kinu-agent:${tag}:${workspace}:${placement.storageKey}`, () => settle(agentBundle(env.ASSETS).pipe(
        Effect.flatMap((response) => attempt({ doing: 'reading the agent bundle', otherwise: 'unavailable' }, () => response.text())),
        Effect.map((source) => ({
          compatibilityDate: '2025-12-01',
          compatibilityFlags: ['nodejs_compat'],
          mainModule: 'agent.js',
          modules: { 'agent.js': source },
          env: facetEnv,
        })),
      )));

    return ctx.facets.get<Facet>(placement.storageKey, () => ({ class: worker.getDurableObjectClass<Facet>(AGENT_FACET_CLASS) }));
  })));
}
