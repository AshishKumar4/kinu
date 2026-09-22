/**
 * The one remote-RPC policy table for OrchestratorAgent, enforced by both transports: HTTP
 * `/api/cli/workspaces/:name/rpc` dispatches only listed methods; WebSocket `rejectOutOfScopeRpc`
 * pins scoped `pta_…` sockets to scope rows. Unlisted methods stay unreachable over HTTP and
 * session-only over WebSocket. Scopes persist as a connection tag so the restriction survives
 * DO hibernation (`websocket.hibernation_state`; an in-memory allowlist would widen to full
 * access on wake).
 */
import { JsonValueSchema } from '@kinu.run/core';
import { diagnostics, tolerate } from '@kinu.run/core/obs';
import type { WSMessage } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import {
  ACCESS_TOKEN_SCOPES, type AccessTokenScope, normalizeAccessTokenScopes,
} from '@kinu.run/core';
import * as v from 'valibot';

/** Always rewritten by the edge after authentication so clients cannot smuggle it. */
export const CLI_SCOPES_HEADER = 'x-kinu-cli-scopes';

const CLI_SCOPES_TAG_PREFIX = 'cli-scopes:';

/** Token hash and authorization generation; always rewritten by the edge, like the scopes header. */
export const CLI_BEARER_HEADER = 'x-kinu-cli-bearer';

/** Written by the edge beside the scope and bearer headers. */
export const USER_ID_HEADER = 'x-kinu-user-id';

/** The session auth time the step-up gate compares; same writer and rule as the user id header. */
export const AUTH_TIME_HEADER = 'x-kinu-auth-time';

/** Lets a socket restored from hibernation know whose authority it runs on, so revocation applies. */
const CLI_BEARER_TAG_PREFIX = 'cli-bearer:';

/** `readable: false` must refuse rather than read as "no bearer to check". */
export type CliSocketBearer =
  | { readonly readable: true; readonly tokenHash: string; readonly generation: number }
  | { readonly readable: false };

const CLI_BEARER_RE = /^([a-f0-9]{64}):(\d{1,15})$/;

/** Null when the connection carries no CLI bearer (a browser session). */
export function cliBearerConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;

  // Header presence marks a CLI connection, so a malformed value still gets a tag (unreadable, not unchecked).
  return `${CLI_BEARER_TAG_PREFIX}${CLI_BEARER_RE.test(headerValue) ? headerValue : ''}`;
}

export function cliBearerFromTags(tags: Iterable<string>): CliSocketBearer | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_BEARER_TAG_PREFIX)) continue;
    const match = CLI_BEARER_RE.exec(tag.slice(CLI_BEARER_TAG_PREFIX.length));

    if (!match) return { readable: false };

    return { readable: true, tokenHash: match[1], generation: Number(match[2]) };
  }

  return null;
}

/** Hash of the authenticated cookie; always rewritten by the edge so clients cannot smuggle it. */
export const SESSION_BEARER_HEADER = 'x-kinu-session-bearer';

/** Lets a socket restored from hibernation know whose sign-in it runs on, so logout applies. */
const SESSION_BEARER_TAG_PREFIX = 'session-bearer:';

const SESSION_BEARER_RE = /^[a-f0-9]{64}$/;

/** Null when the connection carries no browser session (a CLI ticket connection). */
export function sessionBearerConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;

  // Same rule as the CLI bearer: an unparseable value still gets a tag and is refused at frame time.
  return `${SESSION_BEARER_TAG_PREFIX}${SESSION_BEARER_RE.test(headerValue) ? headerValue : ''}`;
}

/** A present-but-unparseable tag answers `{ unreadable: true }` so the frame gate refuses it. */
export function sessionBearerFromTags(tags: Iterable<string>): { tokenHash: string } | { unreadable: true } | null {
  for (const tag of tags) {
    if (!tag.startsWith(SESSION_BEARER_TAG_PREFIX)) continue;
    const value = tag.slice(SESSION_BEARER_TAG_PREFIX.length);

    if (!SESSION_BEARER_RE.test(value)) return { unreadable: true };

    return { tokenHash: value };
  }

  return null;
}

export type AgentRpcAccess = AccessTokenScope | 'interactive' | 'never';

/**
 * Methods absent from workspace.read that a read-only token must not reach (checkpoint, changelog,
 * mounts, file restore, ...) are 'interactive' on every transport, never approximated as reads.
 */
export const AGENT_RPC_ACCESS = {
  getAgentStatus: 'workspace.read',
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
  getWorkspaceTabPresence: 'workspace.read',
  listAgentTasks: 'workspace.read',
  listWorkspaceWork: 'workspace.read',
  listSlates: 'workspace.read',
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

  cancelCurrentWork: 'workspace.exec',
  recoverStrandedTurn: 'workspace.exec',
  executeInExecutor: 'workspace.exec',

  applyScaffoldDecision: 'interactive',
  branchTurn: 'interactive',
  cancelBackgroundJob: 'interactive',
  cancelTrigger: 'interactive',
  checkpointStatus: 'interactive',
  getEvolutionChangelog: 'interactive',
  listSubordinates: 'interactive',
  inspectSubordinate: 'interactive',
  latestAlternateTakes: 'interactive',
  listFileCheckpoints: 'interactive',
  listMounts: 'interactive',
  planFileRestore: 'interactive',
  clearBackgroundJobs: 'interactive',
  createReleaseChange: 'interactive',
  createTimerTrigger: 'interactive',
  decideReleaseApproval: 'interactive',
  // Approving a stopped command is the approval; a scoped token calling it would bypass the gate.
  decideDeferredApprovals: 'interactive',
  // Authored code can act through the agent's bindings; interactive callers
    // share the ordinary side-effect gates, not a second binding policy.
  slate: 'interactive',
  previewSlate: 'interactive',
  // Instruction trust (KINU-N028): approval grants bytes system placement, so a scoped token must not
    // let agent-written bytes authorise themselves.
  approveInstruction: 'interactive',
  revokeInstruction: 'interactive',
  listInstructionApprovals: 'interactive',
  readInstructionApproval: 'interactive',
  // Opening spends child-agent inference and writes user preferences into memory: owner's decision.
  requestRefinement: 'interactive',
  listRefinements: 'interactive',
  // Grants staged bytes system placement, like `approveInstruction`.
  decideRefinement: 'interactive',
  showRefinement: 'interactive',
  createSubordinateAgent: 'interactive',
  renameSubordinateAgent: 'interactive',
  decidePlanReview: 'interactive',
  listDeferredApprovals: 'interactive',
  savePlanReviewAnnotations: 'interactive',
  dismissBackgroundJob: 'interactive',
  dismissSubordinate: 'interactive',
  // A CI token that can run a task must not walk off with the whole database.
  exportWorkspaceArchive: 'interactive',
  experienceAction: 'interactive',
  forkAgent: 'interactive',
  revertConversation: 'interactive',
  getActivitySnapshot: 'interactive',
  getAlwaysActiveSkills: 'interactive',
  getExecutorDiff: 'interactive',
  getExecutorFiles: 'interactive',
  getExposedPorts: 'interactive',
  getFacts: 'interactive',
  getEvolutionConfig: 'interactive',
  getMctsConfig: 'interactive',
  getReplayEvals: 'interactive',
  // Raw unredacted event payloads; a workspace.read token gets only the read models.
  getRunEvents: 'interactive',
  getRunSummaries: 'interactive',
  listRuns: 'interactive',
  getScaffoldDiff: 'interactive',
  getShadowVerdict: 'interactive',
  getShellApprovalMode: 'interactive',
  getShellApprovalGrants: 'interactive',
  listAlternateTakes: 'interactive',
  listCurriculumTasks: 'interactive',
  // An aggregate is only as open as its strictest input (changelog, scaffold archive, curriculum).
  listPendingActions: 'interactive',
  // `decisionsWaiting` counts interactive reads, so the aggregate is interactive too.
  getWorkspaceOverview: 'interactive',
  listScaffoldVersions: 'interactive',
  listTurnFeedback: 'interactive',
  markChangelogSeen: 'interactive',
  pickAlternateTake: 'interactive',
  previewScaffoldLive: 'interactive',
  proposeCurriculumTasks: 'interactive',
  readExecutorFile: 'interactive',
  renameExecutorFile: 'interactive',
  deleteExecutorFile: 'interactive',
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
  setActorModel: 'interactive',
  setRole: 'interactive',
  setReasoningEffort: 'interactive',
  setShellApprovalMode: 'interactive',
  setSoul: 'interactive',
  setTurnFeedback: 'interactive',
  send: 'interactive',

  destroyAgent: 'never',
} as const satisfies Record<string, AgentRpcAccess>;

export type AgentRpcMethod = keyof typeof AGENT_RPC_ACCESS;

export function isAgentRpcMethod(method: string): method is AgentRpcMethod {
  return Object.hasOwn(AGENT_RPC_ACCESS, method);
}

/** Compile-time proof every table key is a real public method on the agent. */
type AgentRpcMethodsExist = {
  [Method in AgentRpcMethod]: OrchestratorAgent[Method] extends (...args: never[]) => infer _Result
    ? true
    : false;
}[AgentRpcMethod];

const agentRpcMethodsExist: AgentRpcMethodsExist = true;

void agentRpcMethodsExist;

/**
 * Members are unsigned: restating signatures on the stub hits TS2589 at `server.ts`'s
 * `handleCliRequest` (measured 2026-09-22); the name is checked at the seam via `v.function()`.
 */
export type AgentRpcDispatch = {
  readonly [Method in AgentRpcMethod]?: (...args: never[]) => void;
};

/** Null when the method is off-table (never dispatch it). */
export function requiredRpcAccess(method: string): AgentRpcAccess | null {
  return isAgentRpcMethod(method)
    ? AGENT_RPC_ACCESS[method]
    : null;
}

export function rpcAccessScope(access: AgentRpcAccess | null): AccessTokenScope | null {
  return v.is(v.picklist(ACCESS_TOKEN_SCOPES), access) ? access : null;
}

/** Null when the connection is unrestricted (interactive session or browser). */
export function cliScopesConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const normalized = normalizeAccessTokenScopes(headerValue.split(','));

  // A scoped header that fails to parse must fail closed, not fall open to
    // an unrestricted connection: an empty scope set denies every RPC.
  return `${CLI_SCOPES_TAG_PREFIX}${normalized.ok ? normalized.scopes.join(',') : ''}`;
}

function cliScopesFromTags(tags: Iterable<string>): AccessTokenScope[] | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_SCOPES_TAG_PREFIX)) continue;
    const parsed = normalizeAccessTokenScopes(tag.slice(CLI_SCOPES_TAG_PREFIX.length).split(','));

    return parsed.ok ? parsed.scopes : [];
  }

  return null;
}

/** Returns an rpc-error frame for an out-of-scope `{type:'rpc'}` on an access-token connection; else null. */
const RpcFrameSchema = v.object({
  type: v.literal('rpc'),
  id: v.string(),
  method: v.string(),
  args: v.array(JsonValueSchema),
});

interface RpcDenial {
  error: string;
  reason: 'not_invokable' | 'scope_missing' | 'interactive_only';
}

function rpcDenial(method: string, access: AgentRpcAccess | null, required: AccessTokenScope | null): RpcDenial {
  if (access === 'never') {
    return { error: `${method} is not remotely invokable.`, reason: 'not_invokable' };
  }

  if (required) {
    return {
      error: `This access token does not have the ${required} scope required by ${method}.`,
      reason: 'scope_missing',
    };
  }

  return {
    error: `${method} requires an interactive CLI session token. Sign in with: kinu auth`,
    reason: 'interactive_only',
  };
}

export function rejectOutOfScopeRpc(tags: Iterable<string>, message: WSMessage): string | null {
  if (!v.is(v.string(), message)) return null;
  const scopes = cliScopesFromTags(tags);

  if (scopes === null) return null;

  const parsed = v.safeParse(RpcFrameSchema, tolerate(() => JSON.parse(message), 'malformed-input'));

  if (!parsed.success) return null;
  const { id, method } = parsed.output;

  const access = requiredRpcAccess(method);
  const required = rpcAccessScope(access);

  if (required && scopes.includes(required)) return null;

  const { error, reason } = rpcDenial(method, access, required);

  // Log the refused method and wanted scope, never the token or frame. `outcome` is explicit: the
    // sink reads 'ok' by default, which would count refusals as successes.
  diagnostics.event('rpc_gate.denied', {
    outcome: 'denied',
    reason,
    tool: method,
    source: required ?? 'interactive',
  });

  return JSON.stringify({ type: 'rpc', id, success: false, error });
}
