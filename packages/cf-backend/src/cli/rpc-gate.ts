/**
 * The remote-RPC policy for the OrchestratorAgent — ONE table naming every
 * remotely invokable agent method and the credential it requires, enforced by
 * BOTH transports:
 *
 *   • HTTP — POST /api/cli/workspaces/:name/rpc (cli/routes.ts) dispatches a
 *     `{ method, args }` body to the DO. Table membership IS the dispatch
 *     allowlist: an off-table method name is never invoked, so the DO's
 *     internal surface (ownership claims, device relays, destroy) stays
 *     unreachable no matter what string a client sends.
 *   • WebSocket — scoped `pta_…` access tokens with `workspace.exec` may mint
 *     a connect ticket, and the resulting socket reaches the agent's full
 *     @callable surface; rejectOutOfScopeRpc pins those connections to the
 *     scope-carrying rows of this same table. Interactive `ptc_…` session
 *     sockets carry no scope header/tag and stay unrestricted, exactly like
 *     session tokens on the HTTP endpoint.
 *
 * Access classes:
 *   • an AccessTokenScope — a scoped `pta_…` token needs that scope
 *     (interactive session tokens always pass);
 *   • 'interactive'      — session tokens only, scoped tokens denied;
 *   • 'never'            — not remotely invokable on any transport.
 * Methods added in the future are not remotely invokable over HTTP and stay
 * interactive-session-only over WebSocket until listed here.
 *
 * The edge worker verifies the connect ticket, resolves the bearer's scopes,
 * and forwards them on a worker-set header (never trusted from the client).
 * The DO persists them as a connection tag — tags ride the WebSocket
 * attachment, so the restriction survives DO hibernation
 * (`websocket.hibernation_state`, which is why an in-memory allowlist would
 * silently widen to full access on wake) — and rejects
 * out-of-scope `{type:'rpc'}` frames before the agents-SDK dispatcher sees
 * them.
 */
import { JsonValueSchema } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import type { OrchestratorAgent } from '../orchestrator';
import {
  ACCESS_TOKEN_SCOPES, type AccessTokenScope, normalizeAccessTokenScopes,
} from './access-token-store';
import * as v from 'valibot';

/** Worker→DO header carrying the verified connect-ticket scopes. Always
 *  rewritten by the edge after authentication so clients cannot smuggle it. */
export const CLI_SCOPES_HEADER = 'x-kinu-cli-scopes';

/** Connection tag persisting the scope restriction across hibernation. */
const CLI_SCOPES_TAG_PREFIX = 'cli-scopes:';

export type AgentRpcAccess = AccessTokenScope | 'interactive' | 'never';

/**
 * Every remotely invokable OrchestratorAgent method → its access class,
 * preserving the pre-unification per-token-shape reachability:
 *   • workspace.read — the reads the REST router served under
 *     GET /workspaces/:name/*, reachable by a read-only scoped token before;
 *   • workspace.exec — the two run-a-task surfaces (POST /stop, executor
 *     exec), reachable by an exec scoped token before;
 *   • interactive — session-only, incl. the methods that were reachable by a
 *     scoped token on NO transport before (see the note below).
 *
 * The seven methods that used to live in the old websocket read allowlist
 * (checkpointStatus, getEvolutionChangelog, getWorkspaceAgents,
 * latestAlternateTakes, listFileCheckpoints, listMounts, planFileRestore)
 * are 'interactive', NOT workspace.read. In the old system their only
 * transport was the agent websocket, and opening that socket required a
 * connect-ticket — which requires workspace.exec. So a read-only scoped
 * token could reach them on no transport at all; classing them
 * workspace.read here would newly expose them to read-only tokens. No single
 * scope reproduces the old "needs read (allowlist) AND exec (to open the
 * socket)" requirement, so we take the strict, non-widening approximation:
 * scoped tokens are denied them on every transport (session tokens, which
 * carry no scope tag, are unaffected — the interactive CLI and the browser
 * keep full access). The interactive WS session and browser are the only
 * real callers of these, so nothing ships broken.
 */
export const AGENT_RPC_ACCESS = {
  // ── Reads a workspace.read token may perform (old GET /workspaces/:name/*) ──
  getAgentStatus: 'workspace.read',
  getAgentView: 'workspace.read',
  getAlignmentConvergence: 'workspace.read',
  getChatHistoryPage: 'workspace.read',
  getExecutors: 'workspace.read',
  getGepaRun: 'workspace.read',
  getGepaRuns: 'workspace.read',
  getForkRun: 'workspace.read',
  getExplorationCanvas: 'workspace.read',
  getHeadRun: 'workspace.read',
  getHeadRuns: 'workspace.read',
  getMctsNodeDetail: 'workspace.read',
  getNodeTranscript: 'workspace.read',
  getMctsSearchRuns: 'workspace.read',
  getMctsTree: 'workspace.read',
  getMemoryContent: 'workspace.read',
  getOutcomeCalibration: 'workspace.read',
  getOutcomeEnsemble: 'workspace.read',
  getReleaseBoard: 'workspace.read',
  getRunTimeline: 'workspace.read',
  getSearchTree: 'workspace.read',
  getActivePlanReview: 'workspace.read',
  getStoredModelSpec: 'workspace.read',
  getReasoningEffort: 'workspace.read',
  getToolDescriptions: 'workspace.read',
  getWorkspaceSnapshot: 'workspace.read',
  listAgentTasks: 'workspace.read',
  listAgentViews: 'workspace.read',
  listBackgroundJobs: 'workspace.read',
  listForkRuns: 'workspace.read',
  listPendingConsents: 'workspace.read',
  listRecentEvents: 'workspace.read',
  listRecordCells: 'workspace.read',
  listRecordObjectives: 'workspace.read',
  readRecordCell: 'workspace.read',
  listTriggers: 'workspace.read',
  sampleOutcomeLabeling: 'workspace.read',
  searchMemoryHybrid: 'workspace.read',

  // ── Run-a-task surfaces a workspace.exec token may perform ──
  cancelCurrentWork: 'workspace.exec',
  executeInExecutor: 'workspace.exec',

  // ── Interactive-session-only (scoped tokens denied on every transport) ──
  applyScaffoldDecision: 'interactive',
  branchTurn: 'interactive',
  cancelBackgroundJob: 'interactive',
  cancelTrigger: 'interactive',
  // The seven old-websocket-read-allowlist methods — 'interactive', not
  // workspace.read: reachable only over an exec-gated socket before (see the
  // block comment above).
  checkpointStatus: 'interactive',
  getEvolutionChangelog: 'interactive',
  getWorkspaceAgents: 'interactive',
  listSubordinates: 'interactive',
  latestAlternateTakes: 'interactive',
  listFileCheckpoints: 'interactive',
  listMounts: 'interactive',
  planFileRestore: 'interactive',
  clearBackgroundJobs: 'interactive',
  createReleaseChange: 'interactive',
  createTimerTrigger: 'interactive',
  decideReleaseApproval: 'interactive',
  // Approving a command the gate stopped IS the approval — a scoped token that
  // could call it would be a way around the gate, not a read of it. The
  // listing is interactive for the same reason `listPendingActions` is: it is
  // the surface an owner reads immediately before authorising something.
  decideDeferredApprovals: 'interactive',
  decidePlanReview: 'interactive',
  listDeferredApprovals: 'interactive',
  savePlanReviewAnnotations: 'interactive',
  dismissBackgroundJob: 'interactive',
  dismissSubordinate: 'interactive',
  // The owner's backup of their own workspace. Interactive-only: a CI token
  // that can run a task must not be able to walk off with the whole database.
  exportWorkspaceArchive: 'interactive',
  // Publishing this workspace's proven work to the owner's library, and
  // importing from it, is the owner's call — interactive for the same reason.
  experienceAction: 'interactive',
  forkAgent: 'interactive',
  getActivitySnapshot: 'interactive',
  getAlwaysActiveSkills: 'interactive',
  getExecutorDiff: 'interactive',
  getExecutorFiles: 'interactive',
  getExposedPorts: 'interactive',
  getFacts: 'interactive',
  getEvolutionConfig: 'interactive',
  getMctsConfig: 'interactive',
  getReplayEvals: 'interactive',
  // Raw per-run events: full tool-call arguments/results and every turn's
  // context-budget/steering/file-edit telemetry. Same sensitivity class as
  // exportWorkspaceArchive — a workspace.read token gets the read MODELS
  // (getRunTimeline's merged spans, getRunSummaries' cost folds), not the
  // unredacted event payloads themselves.
  getRunEvents: 'interactive',
  getRunSummaries: 'interactive',
  listRuns: 'interactive',
  getScaffoldDiff: 'interactive',
  getShadowVerdict: 'interactive',
  getShellApprovalMode: 'interactive',
  getShellApprovalGrants: 'interactive',
  listAlternateTakes: 'interactive',
  listCurriculumTasks: 'interactive',
  // The needs-you queue. Interactive because it is an aggregate, and an
  // aggregate is only as open as its strictest input: it folds the changelog,
  // the scaffold archive and the curriculum, all of which are interactive.
  listPendingActions: 'interactive',
  listScaffoldVersions: 'interactive',
  listTurnFeedback: 'interactive',
  markChangelogSeen: 'interactive',
  pickAlternateTake: 'interactive',
  previewScaffoldLive: 'interactive',
  proposeCurriculumTasks: 'interactive',
  readExecutorFile: 'interactive',
  recordOutcomeLabeling: 'interactive',
  resetWorkspaceBaseline: 'interactive',
  resolveDeviceConsent: 'interactive',
  restoreFileCheckpoint: 'interactive',
  retryBackgroundJob: 'interactive',
  revertChangelogEntry: 'interactive',
  revokeShellApprovalGrants: 'interactive',
  runOutcomeEnsemble: 'interactive',
  runScaffoldGepaOptimization: 'interactive',
  setAlwaysActiveSkills: 'interactive',
  setCurriculumTaskStatus: 'interactive',
  setDisplayName: 'interactive',
  setEvolutionConfig: 'interactive',
  setMctsConfig: 'interactive',
  setModel: 'interactive',
  setReasoningEffort: 'interactive',
  setShellApprovalMode: 'interactive',
  setSoul: 'interactive',
  setTurnFeedback: 'interactive',
  spawnSubordinate: 'interactive',
  steerTurn: 'interactive',

  // ── Never remotely invokable (documented denial, same as off-table) ──
  destroyAgent: 'never',
} as const satisfies Record<string, AgentRpcAccess>;

export type AgentRpcMethod = keyof typeof AGENT_RPC_ACCESS;

export function isAgentRpcMethod(method: string): method is AgentRpcMethod {
  return Object.hasOwn(AGENT_RPC_ACCESS, method);
}

/** Compile-time proof that every table key is a real public method on the
 *  agent — renaming or deleting an orchestrator method breaks the build here
 *  instead of surfacing as a runtime dispatch failure. */
type AgentRpcMethodsExist = {
  [Method in AgentRpcMethod]: OrchestratorAgent[Method] extends (...args: never[]) => infer _Result
    ? true
    : false;
}[AgentRpcMethod];
const agentRpcMethodsExist: AgentRpcMethodsExist = true;
void agentRpcMethodsExist;

/** The access class for a client-supplied method name; null when the method
 *  is off-table (never dispatch it). */
export function requiredRpcAccess(method: string): AgentRpcAccess | null {
  return isAgentRpcMethod(method)
    ? AGENT_RPC_ACCESS[method]
    : null;
}

/** Narrow an access class to the scope it names; null for the
 *  interactive/never classes. */
export function rpcAccessScope(access: AgentRpcAccess | null): AccessTokenScope | null {
  return v.is(v.picklist(ACCESS_TOKEN_SCOPES), access) ? access : null;
}

/** Build the connection tag for a verified scopes header value; null when the
 *  connection is unrestricted (interactive session or browser). */
export function cliScopesConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const normalized = normalizeAccessTokenScopes(headerValue.split(','));
  // A scoped header that fails to parse must fail closed, not fall open to
  // an unrestricted connection: an empty scope set denies every RPC.
  return `${CLI_SCOPES_TAG_PREFIX}${normalized.ok ? normalized.scopes.join(',') : ''}`;
}

/** Scopes persisted on a connection's tags; null when unrestricted. */
export function cliScopesFromTags(tags: Iterable<string>): AccessTokenScope[] | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_SCOPES_TAG_PREFIX)) continue;
    const parsed = normalizeAccessTokenScopes(tag.slice(CLI_SCOPES_TAG_PREFIX.length).split(','));
    return parsed.ok ? parsed.scopes : [];
  }
  return null;
}

/** Gate one inbound websocket frame. Returns a serialized rpc-error frame to
 *  send back when the frame is an out-of-scope `{type:'rpc'}` request from an
 *  access-token connection; null when the frame may proceed (chat frames,
 *  scope-granted RPCs, and everything on unrestricted connections). */
const RpcFrameSchema = v.object({
  type: v.literal('rpc'),
  id: v.string(),
  method: v.string(),
  args: v.array(JsonValueSchema),
});

export function rejectOutOfScopeRpc<Message>(tags: Iterable<string>, message: Message): string | null {
  if (!v.is(v.string(), message)) return null;
  const scopes = cliScopesFromTags(tags);
  if (scopes === null) return null;

  const parsed = v.safeParse(RpcFrameSchema, tolerate(() => JSON.parse(message), 'malformed-input'));
  if (!parsed.success) return null;
  const { id, method } = parsed.output;

  const access = requiredRpcAccess(method);
  const required = rpcAccessScope(access);
  if (required && scopes.includes(required)) return null;
  const error = access === 'never'
    ? `${method} is not remotely invokable.`
    : required
      ? `This access token does not have the ${required} scope required by ${method}.`
      : `${method} requires an interactive CLI session token. Sign in with: kinu auth`;
  return JSON.stringify({ type: 'rpc', id, success: false, error });
}
