/**
 * Error-model gate: how many of each legacy failure mechanism a product file may still hold, one
 * number per file and mechanism that only goes down.
 *
 * The target (docs/OBSERVABILITY.md) is one failure type, `KinuError`, in the Effect channel, with
 * `settle` in `packages/core/src/obs/effect.ts` as the boundary. The migration slices
 * remove what this counts, so each slice's commit shows its numbers falling and nothing grows while
 * they run:
 *
 *   throw              a `throw` statement
 *   catch              a `catch` clause
 *   promise-rejection  `.catch(…)`, `.then(onValue, onRejection)`, `Promise.reject(…)`
 *   result-literal     `ok: true|false` or `success: true|false` in an object literal
 *   result-type        `ok: true|false` or `success: true|false` in a type
 *   error-class        a class extending `Error`, directly or through another such class
 *
 * `scripts/error-model.lock.json` is keyed `path#mechanism`. A key above its number is red, and a
 * key the lock never held has a number of zero, so a new file starts clean. A key below its number
 * is green and printed stale; `--lock` then writes the lower number through `shrinkOnly`, which
 * never raises one. `DECLARED` names the boundary files and the mechanisms that are their job.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { FAILURE_SURFACES, failureSurface } from '../tools/oxlint/anti-slop/rules/effect-run-in-adapter';

import { assertMeasured, finding, refuseLock, shrinkOnly, type LockRefusal, type LockedNumber } from './gate-ratchet';
import { readSources } from './sources';
import {
  declaredName, functionOwner, identifierCalleeName, isFunctionLike, literalString, memberCalleeName, parse, superClassName, walk,
  type SyntaxNode,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const LOCK = `${root}scripts/error-model.lock.json`;

export const MECHANISMS = ['throw', 'catch', 'promise-rejection', 'result-literal', 'result-type', 'error-class'] as const;

export type Mechanism = (typeof MECHANISMS)[number];

interface Declaration {
  readonly mechanisms: readonly Mechanism[];
  readonly reason: string;
  /** Only sites inside these named functions, methods, types or interfaces; absent, the whole file. */
  readonly within?: readonly string[];
}

/** The declarations by file; a file may hold several, each for its own mechanisms and names. */
function byFile(entries: readonly (readonly [string, Declaration])[]): ReadonlyMap<string, readonly Declaration[]> {
  const files = new Map<string, Declaration[]>();

  for (const [file, declaration] of entries) files.set(file, [...files.get(file) ?? [], declaration]);

  return files;
}

const OUTSIDE_PROVIDER = 'a hook read outside its provider: a render-time programming error, thrown as React\'s own hooks throw so the nearest error boundary catches it';

/** Files whose mechanisms are the target model's boundary, not a legacy site. */
export const DECLARED = byFile([
  ...Object.values(FAILURE_SURFACES).map(surface => [surface.adapter, {
    mechanisms: MECHANISMS, reason: `${surface.type}'s one runner rethrows its typed failure or a defect`,
  }] as const),
  ...['packages/core/src/obs/tracer.ts', 'packages/core/src/obs/agent-tracing.ts'].map(file => [file, {
    mechanisms: ['promise-rejection'],
    reason: 'a span hands its caller\'s promise back unchanged, so a pipelined RPC stub keeps pipelining; '
      + '`then(close, close)` observes it settle without deriving an unhandled rejection',
  }] as const),
  ['packages/core/src/execution/fiber.ts', {
    mechanisms: ['promise-rejection'],
    within: ['heldFiber'],
    reason: 'a held fiber\'s start: nothing awaits a detached fiber, so the host\'s rejection is observed here and handed to `onStartFailed`',
  }],
  ['packages/cf-backend/src/workspace-host.ts', {
    mechanisms: ['catch', 'throw'],
    within: ['compose'],
    reason: 'the hosted runtime\'s start gate, observed as state: its forwarders stay promise chains (settle\'s hops would move '
      + 'readiness), and a failed composition is forgotten so the next operation composes again',
  }],
  ['packages/cf-backend/src/hooks/use-account.tsx', {
    mechanisms: ['throw'],
    within: ['useAccount'],
    reason: OUTSIDE_PROVIDER,
  }],
  ['packages/cf-backend/src/hooks/use-workspace-roster.tsx', {
    mechanisms: ['throw'],
    within: ['useWorkspaceRoster'],
    reason: OUTSIDE_PROVIDER,
  }],
  ['packages/cli/src/tui/tui-shell.tsx', {
    mechanisms: ['throw'],
    within: ['useTuiProduct'],
    reason: OUTSIDE_PROVIDER,
  }],
  ['packages/cf-backend/src/gallery.tsx', {
    mechanisms: ['throw', 'catch', 'promise-rejection'],
    reason: 'the design-system gallery over mock data: each stub rejects as the backend it stands in for does, so a frame '
      + 'can photograph that failure state, and the page\'s own mount failure is rendered as the dev page\'s last word',
  }],
  ['packages/core/src/obs/log.ts', {
    mechanisms: ['promise-rejection'],
    within: ['detach'],
    reason: 'the React edge\'s runner: nothing awaits it, so its one rejection observer turns a defect into a diagnostic',
  }],
  ['packages/test-utils/src/mossaic.ts', {
    mechanisms: ['throw'],
    within: ['fakeMossaic'],
    reason: 'a stand-in for the Mossaic client: it rejects with the errno codes that client rejects with, so the tests '
      + 'exercise the adapter that maps them',
  }],
  ['packages/core/src/slates/content.ts', {
    mechanisms: ['throw'],
    reason: 'a vendored `ContentStore`: its failures are the vendored package\'s `AgentCoreError` codes, its contract',
  }],
  ['packages/core/src/slates/store.ts', {
    mechanisms: ['throw'],
    reason: 'a vendored `SlateStore`: its failures are the vendored package\'s `AgentCoreError` codes, its contract',
  }],
  ['packages/core/src/providers/model-test.ts', {
    mechanisms: ['result-literal', 'result-type'],
    within: ['ModelTestResult', 'ModelTestResultSchema', 'testModel', 'failed'],
    reason: '`ModelTestResult`, the model picker\'s test verdict over HTTP and the CLI; `ok` is its wire field',
  }],
  ['packages/core/src/chat.ts', {
    mechanisms: ['throw', 'catch', 'promise-rejection'],
    within: ['runChat', 'settleModelOperation', 'suppressDeferredRejections'],
    reason: '`runChat` is an async generator: its consumer receives a failure from next(), the iterator protocol; '
      + 'the AI SDK\'s deferred accessors are observed detached, so a rejection there is never unhandled',
  }],
  ['packages/core/src/providers/model-invocation.ts', {
    mechanisms: ['throw', 'catch'],
    within: ['streamTextReported'],
    reason: 'an async generator: its consumer receives the stream\'s failure from next(), the iterator protocol',
  }],
  ['packages/core/src/identity/fork-transfer.ts', {
    mechanisms: ['throw'],
    within: ['forkTransferFrames', 'carriedPayloads'],
    reason: 'the fork-frame stream is an async generator: its receiver learns a refused frame from next()',
  }],
  ['packages/core/src/tools/file-tool.ts', {
    mechanisms: ['result-literal'],
    within: ['createFileDispatcher'],
    reason: 'the `file` tool\'s JSON answer, read by the model and by codemode\'s `workspace.writeFile`; `ok` is its field',
  }],
  ['packages/core/src/tools/inline-executor.ts', {
    mechanisms: ['result-literal'],
    within: ['createTool', 'slateRefusal'],
    reason: 'codemode\'s `workspace.createTool` and `workspace.slates` answers, read by the program the model wrote',
  }],
  ...([
    ['packages/cf-backend/src/cli/auth-store.ts', ['RateLimitError', 'CliAuthCodeError']],
    ['packages/core/src/mission-budget.ts', ['MissionBudgetExhausted']],
    ['packages/core/src/providers/util.ts', ['StaleModelList']],
    ['packages/core/src/state/store-reset.ts', ['StoragePredatesResetError']],
    ['packages/core/src/tools/db-codemode.ts', ['AppBatchError']],
    ['packages/core/src/types/file-edits.ts', ['FileRefusalError']],
  ] as const).map(([file, classes]) => [file, {
    mechanisms: ['error-class'],
    within: classes,
    reason: 'a KinuError refinement: it fails on Effect\'s channel and crosses as a KinuError (code, wire), and callers also read it by class for its extra field',
  }] as const),
  ['packages/core/src/read-models/change-notes.ts', {
    mechanisms: ['result-literal', 'result-type'],
    within: ['ChangeNotesResult', 'saveChangeNotes', 'sendChangeNotes'],
    reason: '`ChangeNotesResult`, the change-set notes\' RPC answer: the Changes surface and the CLI read `ok` and `error` off it',
  }],
  // Wire shapes: each `ok`/`success` here is read by a caller that does not share this process (RPC, HTTP, a
  // model or the program it wrote, stdout) or mirrors one in a fixture; changing it changes that contract.
  ...([
    ['packages/cf-backend/src/actor-agent.ts', ['installWorkspaceCapability', 'recordSubordinateTitle', 'onModelSettingsChanged', 'cancelCurrentWork', 'installClientMessageGate', 'refuseRevokedSocketAuthority'],
      'DO RPC answers (capability install, subordinate title, model-settings fan-out, cancel) and the Agents SDK\'s `{ success: false }` socket denial, read across the isolate'],
    ['packages/cf-backend/src/cli/routes.ts', ['body'],
      'the CLI routes\' HTTP JSON bodies, read by the CLI\'s fetch'],
    ['packages/cf-backend/src/cli/rpc-gate.ts', ['rejectOutOfScopeRpc'],
      'the Agents SDK\'s `{ success: false }` RPC denial sent over the socket'],
    ['packages/cf-backend/src/components/landing/landing-fixtures.ts', ['rpc', 'planRpc', 'superviseRpc'],
      'landing-page fixtures that mirror workspace RPC answers'],
    ['packages/cf-backend/src/components/surfaces/ChangesSurface.tsx', ['Restored'],
      '`Restored`, the restoreWorkspaceBaseline RPC answer the surface reads'],
    ['packages/cf-backend/src/components/surfaces/FilesSurface.tsx', ['WriteResult'],
      '`WriteResult`, the executor file write RPC answer'],
    ['packages/cf-backend/src/components/surfaces/changelog-entries.tsx', ['StagedSkillResult'],
      '`StagedSkillResult`, the showRefinement RPC answer'],
    ['packages/cf-backend/src/drive/routes.ts', ['answered'],
      'the Drive routes\' HTTP JSON body for a void answer'],
    ['packages/cf-backend/src/gallery-diff-design.tsx', ['load', 'save', 'send'],
      'gallery fixtures that mirror the change-notes RPC answers'],
    ['packages/cf-backend/src/gallery-drive.tsx', ['serveDrive'],
      'gallery fixtures that mirror the Drive HTTP bodies'],
    ['packages/cf-backend/src/gallery-preview-tabs.tsx', ['rpc', 'workerRpc'],
      'gallery fixtures that mirror workspace RPC answers'],
    ['packages/cf-backend/src/gallery-slate-fallback.tsx', ['frameRpc'],
      'a gallery fixture that mirrors SlateHost.preview\'s answer'],
    ['packages/cf-backend/src/gallery.tsx', ['accountProfileFixture', 'deviceRowsFixture', 'galleryFetch', 'data', 'savePlanReviewAnnotations', 'previewSlate', 'galleryPlanRpc', 'galleryRosterRpc', 'PICKER_TEST_RESULTS', 'galleryModelTest', 'slateRpc', 'approvalsRpc', 'filesRpc'],
      'gallery fixtures that mirror RPC, HTTP and model-test answers'],
    ['packages/cf-backend/src/hooks/use-kinu.ts', ['dismissSubordinate'],
      'the dismissSubordinate RPC answer as the hook passes it on'],
    ['packages/cf-backend/src/mcp-server.ts', ['McpAgentClient'],
      'the saveNoteFromMcp RPC answer the MCP save_note tool returns'],
    ['packages/cf-backend/src/orchestrator.ts', ['resolveHostedActorRoute', 'announceDeviceUnavailable', 'announceDeviceAvailable', 'setTurnFeedback', 'restoreWorkspaceBaseline', 'recordHeadStep', 'destroyAgent', 'saveNoteFromMcp', 'liveShareBundle', 'renameSubordinateAgent', 'dismissSubordinate', 'prepareTerminal', 'setCurriculumTaskStatus', 'rawCopyFromFork'],
      'workspace DO RPC answers (callable methods and DO-to-DO calls) read by the UI, the CLI and other objects'],
    ['packages/cf-backend/src/slates/host.ts', ['blueprintAnswer', 'readLiveShareRecord', 'unshare', 'operation', 'preview', 'releaseInvocation', 'bindingCall', 'run', 'call', 'remove'],
      '`SlateAnswer`, the slate host\'s refusal-as-value over DO RPC, and the share ledger\'s recorded `ok`'],
    ['packages/cf-backend/src/terminal-route.ts', ['deviceTerminal', 'workspaceTerminal', 'sandboxCommand'],
      'the terminal routes\' HTTP JSON bodies'],
    ['packages/cf-backend/src/user/routes.ts', ['body'],
      'the user routes\' HTTP JSON bodies, read by the browser'],
    ['packages/cf-backend/src/user/user-do.ts', ['verifyCliToken', 'revokeCliTokenHash', 'verifyAccessToken', 'revokeAccessToken', 'issueCliAgentConnectTicket', 'verifyCliAgentConnectTicket', 'renameDevice', 'verifyDeviceToken', 'issueDeviceConnectTicket', 'verifyDeviceConnectTicket', 'setDeviceTier', 'revokeDeviceConsent', 'acknowledgeUnstoppedDevice', 'ProfileCatalogWriteResult', 'putProfileCatalog', 'DriveAnswer', 'driveOp', 'drive_writeChunk', 'sweepAndRevokeDevice', 'deleteAccount', 'userMcp_handleOAuthCallback'],
      'UserDO RPC answers (token, ticket, device, catalog, Drive and MCP verdicts) read across the isolate'],
    ['packages/cf-backend/src/user/workspace-fork.ts', ['ForkFrameAck'],
      '`ForkFrameAck`, the rawCopyFromFork DO RPC answer'],
    ['packages/cli/src/cloud-turn-stream.ts', ['outcome'],
      'a tool outcome the CLI prints as `tool_result` JSON on stdout'],
    ['packages/cli/src/commands/inspect.ts', ['stopCommand'],
      '`--json` stdout, read by scripts'],
    ['packages/cli/src/commands/run.ts', ['respondToRpcCommand', 'runRpc'],
      'the `kinu run --rpc` stdout response protocol, read by the parent process'],
    ['packages/core/src/cli/access-tokens.ts', ['AccessTokenMint', 'AccessTokenVerification', 'normalizeAccessTokenScopes', 'mintAccessToken', 'verifyAccessToken', 'AccessTokenRevocation', 'revokeAccessToken'],
      'access-token verdicts that cross UserDO RPC and map to HTTP statuses'],
    ['packages/core/src/craft/source.ts', ['CraftedSourceAdmission', 'refused', 'admitCraftedSource'],
      'the crafted-source verdict, answered to the model\'s program as codemode\'s createTool result'],
    ['packages/core/src/delegation/agents-codemode.ts', ['execute'],
      '`agents.*` codemode answers, read by the program the model wrote'],
    ['packages/core/src/delegation/agents-tool.ts', ['rename', 'recordTitle', 'assign', 'message', 'dismiss'],
      'the agents tool\'s answers to the model and the TeamToolDeps RPC contract'],
    ['packages/core/src/events/ingress/peer.ts', ['reply'],
      'a peer reply, the msg tool\'s answer to the model'],
    ['packages/core/src/events/ingress/triggers.ts', ['cancelTrigger'],
      'cancelTrigger\'s answer over RPC, HTTP and the CLI schema'],
    ['packages/core/src/evolution/changelog.ts', ['revertScaffoldVersion', 'revertPromptSection', 'executeChangelogRevert', 'revertChangelogEntryById'],
      'the changelog revert answer over RPC to the UI and the CLI'],
    ['packages/core/src/evolution/control.ts', ['applyScaffoldDecision', 'ScaffoldDecisionResult', 'gepaPass', 'output'],
      'scaffold decision and GEPA run answers over RPC to the UI and the CLI'],
    ['packages/core/src/evolution/refinement-skill.ts', ['showRefinementRoute', 'StagedSkillResult', 'decideRefinementRoute', 'patch', 'RefinementDecisionResult'],
      'refinement show/decide answers over RPC to the UI and the CLI'],
    ['packages/core/src/orchestrator/agent-self-host.ts', ['setCurriculumTaskStatus'],
      'agent.acceptCurriculumTask\'s answer to the model'],
    ['packages/core/src/plans/review.ts', ['written', 'submit', 'saveAnnotations', 'decide', 'dismiss', 'markHandoffAccepted', 'decideAndHandOff'],
      '`PlanReviewResult`, the plan tool\'s answer to the model and the plan RPC answers to the UI and the CLI'],
    ['packages/core/src/read-models/background-jobs.ts', ['onSuccess', 'onFailure', 'retryBackgroundJob', 'cancelCurrentWork', 'CancelWorkOutcome'],
      'background-job command answers over RPC to the UI and the CLI'],
    ['packages/core/src/read-models/config-plane.ts', ['setModel', 'setReasoningEffort', 'ReasoningEffortWrite', 'setShellApprovalMode', 'revokeShellApprovalGrants', 'setAlwaysActiveSkills'],
      'config write answers over RPC to the UI'],
    ['packages/core/src/read-models/evolution-views.ts', ['markChangelogSeen'],
      'markChangelogSeen\'s RPC answer'],
    ['packages/core/src/read-models/files.ts', ['ExecutorFileUpload', 'ExecutorWriteResult', 'writeExecutorFileOp', 'onSuccess', 'renameExecutorPathOp', 'deleteExecutorPathOp'],
      '`ExecutorWriteResult`, the executor file write answer over RPC and HTTP'],
    ['packages/core/src/read-models/instruction-desk.ts', ['approve'],
      'approveInstruction\'s RPC answer to the CLI and the settings page'],
    ['packages/core/src/read-models/workspace-diff.ts', ['result', 'WorkspaceReviewResult', 'restoreWorkspaceBaseline'],
      'baseline reset and restore answers over RPC'],
    ['packages/core/src/safety/instruction-trust.ts', ['AdmittedInstructionDecision', 'admitInstructionDecision'],
      '`AdmittedInstructionDecision`, the instruction decision answered over DO RPC to the CLI'],
    ['packages/core/src/scaffold/executor.ts', ['runScaffold', 'outcome'],
      'a scaffold run\'s result and tool outcomes, reported over MCP'],
    ['packages/core/src/scaffold/modify.ts', ['modifyScaffold'],
      'modifyScaffold\'s verdict, the proposeScaffold tool\'s answer to the model'],
    ['packages/core/src/skills/drive.ts', ['DriveUploadOutcome', 'received'],
      '`DriveUploadOutcome`, the Drive upload answer over RPC and HTTP'],
    ['packages/core/src/slates/rpc.ts', ['SlateAnswer'],
      '`SlateAnswer`, the slate RPC refusal-as-value'],
    ['packages/core/src/subordinates/support.ts', ['rename', 'recordTitle', 'assign', 'message', 'dismiss'],
      'the TeamToolDeps implementations\' answers, over RPC and to the model'],
    ['packages/core/src/tools/builtins.ts', ['execute'],
      'submit_plan\'s answer to the model'],
    ['packages/core/src/tools/db-codemode.ts', ['execute'],
      '`db.dropTable`\'s codemode answer to the model\'s program'],
    ['packages/core/src/tools/memory-tool.ts', ['runFactAction'],
      'the memory tool\'s answer to the model and the `memory.*` codemode namespace'],
    ['packages/core/src/tools/state-codemode.ts', ['createStateCodemodeProvider'],
      'the `state.*` codemode answers declared in STATE_TYPES'],
    ['packages/core/src/types/peers.ts', ['PeerReplyOutcome'],
      '`PeerReplyOutcome`, the msg tool\'s answer to the model'],
    ['packages/core/src/types/plans.ts', ['PlanReviewResult', 'PlanDecisionOutcome'],
      '`PlanReviewResult` and `PlanDecisionOutcome`, plan answers over DO RPC'],
    ['packages/devbox/src/sync.ts', ['SyncReply', 'serveSync'],
      '`SyncReply`, the container sync\'s HTTP answer the in-container client parses'],
    ['packages/cli/src/local-inspection.ts', ['cancelLocalJob'],
      'the local job cancel, printed as `kinu control job cancel --json` the way the cloud cancel answers'],
    ['packages/cli-backend/src/local-session.ts', ['decidePlanReview'],
      '`PlanDecisionOutcome`, which the local session answers through the same AgentClient the cloud RPC does'],
    ['packages/cf-backend/src/components/surfaces/ChangesSurface.tsx', ['answered', 'load', 'send', 'undoReviewed'],
      'stand-ins for the change-notes and restore RPC answers, built where a call fails so one renderer reads both'],
    ['packages/cf-backend/src/components/surfaces/changelog-entries.tsx', ['revert', 'decide'],
      'stand-ins for the revert and refinement-decision RPC answers, built where a call fails'],
    ['packages/cf-backend/src/components/landing/landing-movie-timeline.ts', ['messagesAt'],
      'a scripted tool output in the landing film, shaped as the tool answers the model'],
  ] as const).map(([file, owners, reason]) => [file, {
    mechanisms: ['result-literal', 'result-type'],
    within: owners,
    reason,
  }] as const),
  // Records and displays, not failure channels: `ok` here is a fact the value carries (a probe passed, a tool
  // call succeeded, which glyph to show), stored or rendered as data rather than branched on as an error.
  ...([
    ['packages/core/src/http/synthetic-probes.ts', ['probe'],
      'a synthetic probe\'s verdict, recorded per run by the monitor as whether the probe passed'],
    ['packages/core/src/control-plane/fleet-alerts.ts', ['settleFleet'],
      'a probe verdict the fleet monitor records per run'],
    ['packages/core/src/orchestrator/actor-session.ts', ['recordToolResult'],
      'the tool ledger\'s stored success flag for one call'],
    ['packages/core/src/heads/head-inference.ts', ['execute'],
      'a head tool call\'s stored outcome record'],
    ['packages/core/src/layergate/layers.ts', ['probes', 'observe', 'small'],
      'layer-gate fixtures: tool answers and stored records the probes observe and hash'],
    ['packages/core/src/bench/split.ts', ['validateWithRetries'],
      'a seeded task\'s validation report: whether its oracle passed, and on which attempt'],
    ['packages/core/src/vfs/context-plane.ts', ['write'],
      '`VfsCasResult`, the vendored Nimbus VFS\'s revision-checked write answer; its shape is that package\'s contract'],
    ['packages/cli/src/device-connect.ts', ['describeConnectOutcome'],
      'which glyph the connect message shows; both branches are printed, neither fails'],
    ['packages/cli/src/tui/overlays.tsx', ['ModelListOverlay'],
      'which glyph the model-list overlay shows'],
    ['packages/cli/src/tui/use-device-connect.ts', ['useDeviceConnectPrompt'],
      'which glyph the connect prompt shows'],
  ] as const).map(([file, owners, reason]) => [file, {
    mechanisms: ['result-literal', 'result-type'],
    within: owners,
    reason,
  }] as const),
  ['packages/devbox/src/devbox.ts', {
    mechanisms: ['result-literal'],
    within: ['devboxSync'],
    reason: 'the container sync\'s HTTP answer body: the in-container sync client reads `ok` off the wire',
  }],
  ['packages/core/src/tools/outcome.ts', {
    mechanisms: ['result-literal', 'result-type'],
    reason: '`ToolOutcome`, the recorded outcome of a native tool invocation; `success` is its stored field',
  }],
]);

/** Where an effect is run for a host that owns the call, permanently: not a bridge. */
export const HOST_BOUNDARIES = new Map<string, string>([
  ['packages/core/src/scaffold/executor.ts', 'a scaffold\'s `host.*` functions answer the sandbox that calls them: a platform-owned call'],
  ['packages/core/src/execution/parent.ts', '`answerParentRpc` answers a fork over DO RPC and in the CLI: a platform-owned call'],
]);

const RUNNERS: readonly string[] = ['settle', 'settleSync', 'observe', 'detach'];

const DETACH_ONLY_AT_REACT = 'detach runs only where its caller never awaits: a timer, a listener, or a function a component hands out';

/** A Hono app's registrations: each takes its handlers after the path. */
const ROUTE_METHODS: readonly string[] = ['get', 'post', 'put', 'delete', 'patch', 'options', 'all', 'use', 'on'];

/**
 * The one sanctioned mid-body runner: a surface adapter's `flight(run, { key, keep })` runs `run` once per
 * key and replays its exit to every joiner. Built once and held, its runs are shared; called where it is
 * built, or keyed by a fresh value, it is a runner in disguise.
 */
const FLIGHT = 'flight';

/** Calls that mint a value no other call shares. */
const FRESH_KEYS: readonly string[] = ['nanoid', 'randomUUID', 'random', 'now'];

/** The selected library's runner, imported through its boundary or public barrel. */
function isFailureModule(file: string, specifier: string): boolean {
  const surface = failureSurface(file);

  return surface.modules.some(module => module === specifier)
    || surface.relativeModules.some(module => specifier === module || specifier.endsWith('/' + module));
}

/**
 * Bridges: a migrated function run at its own edge so its callers keep their signature, spelled
 * `return settle(…)` or `return settleSync(…)` with the runner imported from `obs`, inside an exported
 * function or a public class member. Each is removed when its callers' wave arrives; the migration
 * ends at zero. A runner returned anywhere else is a finding: a private helper must return the Effect.
 * One more edge is platform-owned: a `transactionSync(() => …)` callback, where only a synchronous throw
 * rolls the transaction back, so `settleSync(…)` as that callback's whole return is a bridge too.
 */
export interface BridgeCensus {
  readonly bridges: string[];
  /** Each `flight` built and held: the sanctioned mid-body runner. */
  readonly flights: string[];
  /** Each runner a Hono route handler returns: the handler is the edge, Hono owns the call. */
  readonly routes: string[];
  /** Each detached root handed straight to a platform holder, which owns its lifetime. */
  readonly held: string[];
  /** Each runner where a component hands out a function: a detach React calls, or a settle its own caller awaits. */
  readonly react: string[];
  /** A runner returned from a private helper or a local function: not a bridge, a mistake. */
  readonly findings: string[];
}

export function bridgeSites(sources: ReadonlyMap<string, string>): BridgeCensus {
  const bridges: string[] = [];
  const flights: string[] = [];
  const routes: string[] = [];
  const held: string[] = [];
  const react: string[] = [];
  const findings: string[] = [];

  for (const [file, text] of sources) {
    if (Object.values(FAILURE_SURFACES).some(surface => file === surface.adapter) || HOST_BOUNDARIES.has(file)) continue;
    const parsed = parse(file, text);
    const runners = new Set<string>();
    const syncRunners = new Set<string>();
    const flightNames = new Set<string>();
    const detachNames = new Set<string>();

    walk(parsed.root, (node) => {
      const { raw } = node;

      if (raw.type !== 'ImportDeclaration' || !isFailureModule(file, raw.source.value)) return;

      for (const specifier of raw.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === FLIGHT) {
          flightNames.add(specifier.local.name);
        }

        if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && RUNNERS.includes(specifier.imported.name)) {
          runners.add(specifier.local.name);

          if (specifier.imported.name === 'settleSync') syncRunners.add(specifier.local.name);

          if (specifier.imported.name === 'detach') detachNames.add(specifier.local.name);
        }
      }
    });

    if (runners.size === 0 && flightNames.size === 0) continue;
    const apps = honoApps(parsed.root);

    walk(parsed.root, (node) => {
      const { raw } = node;

      if (raw.type !== 'CallExpression' || raw.callee.type !== 'Identifier') return;
      const site = `${file}:${String(parsed.lineAt(node.start))}`;

      if (flightNames.has(raw.callee.name)) {
        const disguised = disguisedRunner(node, parsed.root);

        if (disguised === undefined) flights.push(site);
        else findings.push(`${site}: ${disguised}`);

        return;
      }

      if (!runners.has(raw.callee.name)) return;

      if (heldBy(node)) {
        held.push(site);

        return;
      }

      const caller = edgeCaller(node, file.endsWith('.tsx'));

      if (detachNames.has(raw.callee.name)) {
        if (caller !== null) react.push(site);
        else findings.push(`${site}: ${DETACH_ONLY_AT_REACT}`);

        return;
      }

      // devbox's observe hands its exit to observers and returns no promise, so nothing floats.
      if (caller === 'react' && raw.callee.name === 'observe') {
        react.push(site);

        return;
      }

      if (caller === 'react') {
        findings.push(`${site}: a settle whose caller never awaits it (React, a timer or a listener), so a rejection would float; run the answered effect with detach`);

        return;
      }

      // A component's own surface: its caller awaits what it returns.
      if (caller === 'component') {
        react.push(site);

        return;
      }

      // `return settle(…)`, `return await settle(…)`, or an arrow whose whole body is the call: the edge, spelled short.
      const awaited = node.parent?.raw.type === 'AwaitExpression' ? node.parent : node;
      const holder = awaited.parent;
      const returned = holder !== undefined && (holder.raw.type === 'ReturnStatement' || arrowBody(holder.raw) === awaited.raw);

      if (!returned) {
        findings.push(`${site}: a runner called mid-body; the effect is run once, at the edge, as its return`);

        return;
      }

      if (isRouteHandler(holder.raw.type === 'ReturnStatement' ? holder : { parent: holder }, apps)) {
        routes.push(site);

        return;
      }

      if (syncRunners.has(raw.callee.name) && isTransactionCallback(holder.raw.type === 'ReturnStatement' ? holder : { parent: holder })) {
        bridges.push(site);

        return;
      }

      const owner = bridgeOwner(holder.raw.type === 'ReturnStatement' ? holder : { parent: holder });

      if (owner === null) findings.push(`${site}: a runner returned outside an exported function or public member`);
      else bridges.push(site);
    });
  }

  return { bridges: bridges.sort(), flights: flights.sort(), routes: routes.sort(), held: held.sort(), react: react.sort(), findings: findings.sort() };
}

/**
 * Holders that keep a detached run alive: `waitUntil` takes its promise, `keepAliveWhile` and the durable
 * fiber host take a callback. Nothing awaits such a run, so its own body must answer every failure.
 */
const HOLDERS: readonly string[] = ['waitUntil', 'keepAliveWhile', 'fiber', 'runFiber'];

/** React calls these and never awaits them. */
const REACT_CALLED: readonly string[] = ['startTransition', 'useEffect', 'useLayoutEffect', 'useKeyboard'];

/** Callers that call and never await: a timer's or a frame's callback, and a listener (addEventListener, on, once, subscribe). */
const NEVER_AWAITED: ReadonlyMap<string, number> = new Map([
  ['setTimeout', 0], ['setInterval', 0], ['queueMicrotask', 0], ['requestAnimationFrame', 0], ['addEventListener', 1], ['on', 1], ['once', 1], ['subscribe', 0],
]);

/** Where a listener is handed back to be removed: the removal's listener argument. */
const REMOVALS: ReadonlyMap<string, number> = new Map([['removeEventListener', 1], ['off', 1], ['removeListener', 1]]);

/** Whether `node` is the argument a never-awaiting caller (or, with `removals`, a removal) takes its function at. */
function handedTo(node: SyntaxNode, removals: boolean): boolean {
  const call = node.parent;

  if (call?.raw.type !== 'CallExpression') return false;
  const name = identifierCalleeName(call) ?? memberCalleeName(call) ?? '';
  const at = NEVER_AWAITED.get(name) ?? (removals ? REMOVALS.get(name) : undefined);

  return at !== undefined && call.raw.arguments[at] === node.raw;
}

/**
 * Whether a function is handed to a caller that calls it and never awaits it, in any file: directly, or as a
 * `const` listener whose every use is such a caller or the removal that hands it back.
 */
function neverAwaited(fn: SyntaxNode | undefined): boolean {
  if (fn === undefined || !isFunctionLike(fn)) return false;

  if (handedTo(fn, false)) return true;
  const declarator = fn.parent?.raw;

  if (declarator?.type !== 'VariableDeclarator' || declarator.id.type !== 'Identifier') return false;
  const { id } = declarator;
  const scope = fn.parent?.parent?.parent;
  let added = false;
  let elsewhere = false;

  if (scope !== undefined) {
    walk(scope, (node) => {
      if (node.raw.type !== 'Identifier' || node.raw.name !== id.name || node.raw === id) return;

      if (handedTo(node, false)) added = true;
      else if (!handedTo(node, true)) elsewhere = true;
    });
  }

  return added && !elsewhere;
}

/**
 * Who calls a function a component hands out: `react` for an intrinsic element's attribute or startTransition's or an
 * effect's argument, which React calls and never awaits; `component` for another component's attribute or
 * useCallback's argument, which the receiving code calls and may await; null for anything else.
 */
function reactCaller(fn: SyntaxNode | undefined): 'react' | 'component' | null {
  if (fn === undefined || !isFunctionLike(fn)) return null;
  const attribute = fn.parent?.raw.type === 'JSXExpressionContainer' ? fn.parent.parent : undefined;

  if (attribute?.raw.type === 'JSXAttribute') {
    const element = attribute.parent?.raw;
    const name = element?.type === 'JSXOpeningElement' && element.name.type === 'JSXIdentifier' ? element.name.name : '';

    return /^[a-z]/.test(name) ? 'react' : 'component';
  }

  const call = fn.parent;

  if (call?.raw.type !== 'CallExpression' || call.raw.arguments[0] !== fn.raw) return null;
  const hook = identifierCalleeName(call) ?? memberCalleeName(call) ?? '';

  if (REACT_CALLED.includes(hook)) return 'react';

  return hook === 'useCallback' ? 'component' : null;
}

/** The function a runner is the expression body of, or a return or statement directly in the block of. */
function heldIn(runner: SyntaxNode): SyntaxNode | undefined {
  const holder = runner.parent;

  if (holder !== undefined && arrowBody(holder.raw) === runner.raw) return holder;
  const statement = holder?.raw.type === 'ReturnStatement' || holder?.raw.type === 'ExpressionStatement' ? holder : undefined;
  const block = statement?.parent;

  if (block?.raw.type !== 'BlockStatement') return undefined;
  const fn = block.parent;

  return fn !== undefined && 'body' in fn.raw && fn.raw.body === block.raw ? fn : undefined;
}

/**
 * Who calls the function a runner sits in: `react` for a caller that never awaits (a timer, a listener, or React's
 * positions in `.tsx`), `component` for a component's own surface (`.tsx`), or null.
 */
function edgeCaller(runner: SyntaxNode, tsx: boolean): 'react' | 'component' | null {
  const fn = heldIn(runner);

  if (neverAwaited(fn)) return 'react';

  return tsx ? reactCaller(fn) : null;
}

/** Whether a runner is a holder's whole argument, or the whole body of a callback that is one. */
function heldBy(runner: SyntaxNode): boolean {
  const callback = runner.parent !== undefined && arrowBody(runner.parent.raw) === runner.raw ? runner.parent : undefined;
  const argument = callback ?? runner;
  const holder = argument.parent;

  if (holder?.raw.type !== 'CallExpression' || !holder.raw.arguments.some((given) => given === argument.raw)) return false;

  return HOLDERS.includes(identifierCalleeName(holder) ?? memberCalleeName(holder) ?? '');
}

/** Whether an expression is, or chains off, `new Hono(…)`. */
function isHonoBuilt(raw: SyntaxNode['raw'] | null | undefined): boolean {
  if (raw?.type === 'NewExpression') return raw.callee.type === 'Identifier' && raw.callee.name === 'Hono';

  if (raw?.type === 'CallExpression' && raw.callee.type === 'MemberExpression') return isHonoBuilt(raw.callee.object);

  return false;
}

/** Names bound to a Hono app in this file: `const app = new Hono()`, a `new Hono()` class field, or one assigned to it. */
function honoApps(tree: SyntaxNode): ReadonlySet<string> {
  const apps = new Set<string>();

  walk(tree, (node) => {
    const { raw } = node;

    if (raw.type === 'VariableDeclarator' && raw.id.type === 'Identifier' && isHonoBuilt(raw.init)) apps.add(raw.id.name);

    if (raw.type === 'PropertyDefinition' && raw.key.type === 'Identifier' && isHonoBuilt(raw.value)) apps.add(raw.key.name);

    if (raw.type === 'AssignmentExpression' && raw.left.type === 'MemberExpression' && raw.left.property.type === 'Identifier' && isHonoBuilt(raw.right)) {
      apps.add(raw.left.property.name);
    }
  });

  return apps;
}

/** Whether a registration's receiver is a Hono app: a bound name, `this.<name>`, `new Hono()`, or a chain off one. */
function isHonoReceiver(raw: SyntaxNode['raw'], apps: ReadonlySet<string>): boolean {
  if (raw.type === 'Identifier') return apps.has(raw.name);

  if (raw.type === 'MemberExpression' && raw.object.type === 'ThisExpression' && raw.property.type === 'Identifier') return apps.has(raw.property.name);

  if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression' && raw.callee.property.type === 'Identifier'
    && ROUTE_METHODS.includes(raw.callee.property.name)) return isHonoReceiver(raw.callee.object, apps);

  if (raw.type === 'AssignmentExpression') return isHonoBuilt(raw.right);

  return isHonoBuilt(raw);
}

/** Whether the return belongs directly to a handler a Hono app registers: an argument after the path. */
function isRouteHandler(statement: Pick<SyntaxNode, 'parent'>, apps: ReadonlySet<string>): boolean {
  let node: SyntaxNode | undefined = statement.parent;

  while (node !== undefined && !isFunctionLike(node)) node = node.parent;
  const call = node?.parent;

  if (node === undefined || call?.raw.type !== 'CallExpression' || call.raw.callee.type !== 'MemberExpression') return false;
  const { callee } = call.raw;

  if (callee.property.type !== 'Identifier' || !ROUTE_METHODS.includes(callee.property.name) || !isHonoReceiver(callee.object, apps)) return false;
  const handler = node.raw;
  const at = call.raw.arguments.findIndex((argument) => argument === handler);

  // `use(handler)` takes no path; every other registration takes one first.
  return at > 0 || (at === 0 && callee.property.name === 'use');
}

const enclosingFunction = (node: SyntaxNode): SyntaxNode | undefined => {
  let up = node.parent;

  while (up !== undefined && !isFunctionLike(up)) up = up.parent;

  return up;
};

/** Why a `flight(…)` call shares no run, or undefined when it is built once and held. */
function disguisedRunner(built: SyntaxNode, tree: SyntaxNode): string | undefined {
  const calledWhereBuilt = 'a flight called where it is built runs once per call; build it once and hold it';
  const holder = built.parent;

  if (holder?.raw.type === 'CallExpression' && holder.raw.callee === built.raw) return calledWhereBuilt;
  const options = built.children.find((child) => child.raw.type === 'ObjectExpression');
  const key = options?.children.find((property) => property.raw.type === 'Property' && property.raw.key.type === 'Identifier' && property.raw.key.name === 'key');
  let fresh = false;

  if (key !== undefined) {
    walk(key, (node) => {
      if (node.raw.type === 'UpdateExpression' || FRESH_KEYS.includes(identifierCalleeName(node) ?? memberCalleeName(node) ?? '')) fresh = true;
    });
  }

  if (fresh) return 'a flight keyed by a fresh value never joins a run; key it by what its callers share';
  const scope = enclosingFunction(built);

  if (holder?.raw.type !== 'VariableDeclarator' || holder.raw.id.type !== 'Identifier' || scope === undefined) return undefined;
  const name = holder.raw.id.name;
  let calledInScope = false;

  walk(tree, (node) => {
    if (identifierCalleeName(node) === name && enclosingFunction(node) === scope) calledInScope = true;
  });

  return calledInScope ? calledWhereBuilt : undefined;
}

/**
 * The exported function or public member a return statement belongs to; null for any other owner. A
 * callback or an object method written inside an exported function's body is that function's code, so
 * a runner returned there (a seam method on the object it builds) counts; one inside a private helper
 * or a local function does not.
 */
function bridgeOwner(statement: Pick<SyntaxNode, 'parent'>): SyntaxNode | null {
  let node: SyntaxNode | undefined = statement.parent;

  while (node !== undefined && !isFunctionLike(node)) node = node.parent;

  if (node === undefined) return null;
  const owner = functionOwner(node);
  const { raw } = owner;

  if (raw.type === 'MethodDefinition') return isPublicMember(raw) ? owner : null;

  if (raw.type === 'FunctionDeclaration') return owner.parent?.raw.type === 'ExportNamedDeclaration' ? owner : null;

  // An object held by a class field (a seam table) is that field's surface.
  const field = owner.parent?.raw.type === 'Property' ? owner.parent.parent?.parent : owner.parent?.parent;

  if (field?.raw.type === 'PropertyDefinition') return isPublicMember(field.raw) ? owner : null;

  // A variable-bound function is exported with its declaration; anything else (a callback, an object
  // method, a function expression) belongs to the function that encloses it.
  const declaration = owner.parent?.parent;

  if (raw.type === 'ArrowFunctionExpression' && declaration?.raw.type === 'VariableDeclaration') {
    return declaration.parent?.raw.type === 'ExportNamedDeclaration' ? owner : null;
  }

  return owner.parent === undefined ? null : bridgeOwner(owner);
}

/** Whether the return belongs directly to a function passed as `transactionSync`'s argument. */
function isTransactionCallback(statement: Pick<SyntaxNode, 'parent'>): boolean {
  let node: SyntaxNode | undefined = statement.parent;

  while (node !== undefined && !isFunctionLike(node)) node = node.parent;
  const call = node?.parent;

  if (node === undefined || call?.raw.type !== 'CallExpression' || !call.raw.arguments.some((argument) => argument === node.raw)) return false;
  const { callee } = call.raw;

  if (callee.type === 'Identifier') return callee.name === 'transactionSync';

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'transactionSync';
}

const arrowBody = (raw: SyntaxNode['raw']): SyntaxNode['raw'] | null =>
  raw.type === 'ArrowFunctionExpression' && raw.body.type !== 'BlockStatement' ? raw.body : null;

const isPublicMember = (member: { accessibility?: string | null; key: { type: string } }): boolean =>
  member.accessibility !== 'private' && member.accessibility !== 'protected' && member.key.type !== 'PrivateIdentifier';

/** Subclassing either library failure creates a second convention; tagged constructors do not. */
const ERROR_BASES: readonly string[] = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'DOMException', ...Object.values(FAILURE_SURFACES).map(surface => surface.type)];

const RESULT_KEYS: readonly string[] = ['ok', 'success'];

const isResultKey = (node: SyntaxNode): boolean => RESULT_KEYS.includes(declaredName(node) ?? literalKey(node) ?? '');

function literalKey(node: SyntaxNode): string | undefined {
  const { raw } = node;

  return raw.type === 'Property' || raw.type === 'TSPropertySignature' ? literalString(raw.key) : undefined;
}

function mechanismOf(node: SyntaxNode): Mechanism | undefined {
  const { raw } = node;

  if (raw.type === 'ThrowStatement') return 'throw';

  if (raw.type === 'CatchClause') return 'catch';

  if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression') {
    const { object } = raw.callee;
    const name = memberCalleeName(node);
    // `Effect.catch(…)` is the target model's own handler, not a promise rejection.
    const onEffect = object.type === 'Identifier' && object.name === 'Effect';
    const onPromise = object.type === 'Identifier' && object.name === 'Promise';

    if (!onEffect && (name === 'catch' || (name === 'then' && raw.arguments.length === 2))) return 'promise-rejection';

    return onPromise && name === 'reject' ? 'promise-rejection' : undefined;
  }

  if (raw.type === 'Property' && node.parent?.raw.type === 'ObjectExpression' && isResultKey(node)) {
    return raw.value.type === 'Literal' && (raw.value.value === true || raw.value.value === false) ? 'result-literal' : undefined;
  }

  if (raw.type === 'TSPropertySignature' && isResultKey(node)) {
    const annotation = raw.typeAnnotation?.typeAnnotation;

    if (annotation?.type !== 'TSLiteralType' || annotation.literal.type !== 'Literal') return undefined;

    return annotation.literal.value === true || annotation.literal.value === false ? 'result-type' : undefined;
  }

  return undefined;
}

function isDeclared(file: string, mechanism: Mechanism, node: SyntaxNode): boolean {
  return (DECLARED.get(file) ?? []).some((declaration) => {
    if (!declaration.mechanisms.includes(mechanism)) return false;

    if (declaration.within === undefined) return true;

    for (let up: SyntaxNode | undefined = node; up !== undefined; up = up.parent) {
      const name = declaredName(up);

      if (name !== undefined && declaration.within.includes(name)) return true;
    }

    return false;
  });
}

/** Sites per `path#mechanism`, declared boundary mechanisms left out. */
export function measure(sources: ReadonlyMap<string, string>): LockedNumber[] {
  const counts = new Map<string, number>();
  const classes: { readonly file: string; readonly name: string | undefined; readonly base: string; readonly node: SyntaxNode }[] = [];

  const count = (file: string, mechanism: Mechanism, node: SyntaxNode): void => {
    if (isDeclared(file, mechanism, node)) return;
    const key = `${file}#${mechanism}`;

    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const [file, text] of sources) {
    walk(parse(file, text).root, (node) => {
      const base = superClassName(node);

      if (base !== undefined) classes.push({ file, name: declaredName(node), base, node });
      const mechanism = mechanismOf(node);

      if (mechanism !== undefined) count(file, mechanism, node);
    });
  }

  const errorish = new Set(ERROR_BASES);

  for (let grew = true; grew;) {
    grew = false;

    for (const { name, base } of classes) {
      if (name === undefined || errorish.has(name) || !errorish.has(base)) continue;
      errorish.add(name);
      grew = true;
    }
  }

  for (const { file, base, node } of classes) if (errorish.has(base)) count(file, 'error-class', node);

  return [...counts].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
}

const LockSchema = v.object({
  measuredAt: v.pipe(v.string(), v.minLength(1)),
  counts: v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export type ErrorModelLock = v.InferOutput<typeof LockSchema>;

export interface Verdict {
  /** Keys above their locked number; `was` is absent for a key the lock never held. */
  readonly over: readonly LockRefusal[];
  /** Keys below their locked number; `now` is 0 for a key that is gone. */
  readonly stale: readonly { readonly key: string; readonly was: number; readonly now: number }[];
}

export function judge(measured: readonly LockedNumber[], lock: ErrorModelLock): Verdict {
  const held = new Map(Object.entries(lock.counts));
  const present = new Map(measured.map(({ key, value }) => [key, value]));

  return {
    over: measured.flatMap(({ key, value }) => {
      const was = held.get(key);

      return value > (was ?? 0) ? [{ key, was, now: value }] : [];
    }),
    stale: [...held].flatMap(([key, was]) => {
      const now = present.get(key) ?? 0;

      return now < was ? [{ key, was, now }] : [];
    }),
  };
}

/** What `--lock` may write, or the keys that refused it. */
export interface Lowered {
  readonly lock: ErrorModelLock | undefined;
  readonly refusals: readonly LockRefusal[];
}

/** What `--lock` may write over `previous`: every key at the lower of its two numbers, none raised. */
export function lower(previous: ErrorModelLock, measured: readonly LockedNumber[], measuredAt: string): Lowered {
  const held = Object.entries(previous.counts).map(([key, value]) => ({ key, value }));
  const { merged, refusals } = shrinkOnly(held, measured);

  return {
    refusals,
    lock: refusals.length > 0 ? undefined : { measuredAt, counts: Object.fromEntries(merged.map(({ key, value }) => [key, value])) },
  };
}

/** What this gate cannot see, printed on the green path. */
export const BLIND_SPOTS: readonly string[] = [
  'A FAILURE SPELLED AS A STRING STATUS — NOT COUNTED. `status: \'failed\'` and `kind: \'error\'` are also '
  + 'real domain states, so a union discriminated by a word is left to review.',
  'A RETURNED `{ error }` WITH NO `ok` FIELD — NOT COUNTED. It is a failure value by convention only.',
  'TESTS, SCRIPTS AND TOOLS — OUT OF SCOPE. The corpus is product source (`readSources`).',
  'A MECHANISM MOVED INTO A DECLARED FILE — NOT DETECTED. `DECLARED` is read by review, one reason per declaration.',
  'A BRIDGE SPELLED ANOTHER WAY — NOT COUNTED. A runner result stored and returned later, or a runner '
  + 'called outside a `return`, is not the bridge shape; review keeps bridges to the one spelling.',
  'A DELETED LOCK — REFUSED. With no lock on disk the gate is red; the first lock is written with '
  + '`--init`, which only a reviewer should see in a diff.',
];

function readLockFile(): ErrorModelLock | undefined {
  return existsSync(LOCK) ? v.parse(LockSchema, JSON.parse(readFileSync(LOCK, 'utf8'))) : undefined;
}

function writeLockFile(lock: ErrorModelLock): void {
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

if (import.meta.main) {
  const sources = readSources();
  const measured = measure(sources);
  const total = measured.reduce((sum, { value }) => sum + value, 0);

  const summary = assertMeasured('error-model', [
    ['product source files', sources.size],
    ['path#mechanism keys', measured.length],
    ['legacy sites', total],
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const previous = readLockFile();

  if (process.argv.includes('--init')) {
    if (previous !== undefined) {
      console.error('error-model: a lock exists; `--init` records only the first one. Use `--lock`.');
      process.exit(1);
    }

    writeLockFile({ measuredAt: today, counts: Object.fromEntries(measured.map(({ key, value }) => [key, value])) });
    console.log(`error-model: recorded the first lock, ${String(total)} sites over ${summary}`);
    process.exit(0);
  }

  if (previous === undefined) {
    console.error('error-model: no lock is recorded; nothing can be held to a number.');
    process.exit(1);
  }

  if (process.argv.includes('--lock')) {
    const { lock, refusals } = lower(previous, measured, today);

    if (lock === undefined) process.exit(refuseLock('error-model', refusals, 'move the failure into the Effect channel'));
    writeLockFile(lock);
    console.log(`error-model: locked ${String(Object.keys(lock.counts).length)} key(s), ${String(total)} sites over ${summary}`);
    process.exit(0);
  }

  const verdict = judge(measured, previous);

  if (verdict.over.length > 0) {
    console.error(`error-model: ${String(verdict.over.length)} key(s) above their locked number\n`);

    for (const { key, was, now } of verdict.over) {
      console.error(finding({
        at: key,
        invariant: 'a product file holds no more of a legacy failure mechanism than the lock records',
        found: `${String(now)}, ${was === undefined ? 'and the lock holds none for this file' : `locked at ${String(was)}`}`,
        silently: 'a second failure convention grows beside the one being migrated to, and the migration '
          + 'never finishes because each slice lands on a larger tree than it measured',
        fix: `fail with ${failureSurface(key).type} in an effect and cross the boundary with settle `
          + `(${failureSurface(key).adapter}); --lock never raises a number`,
      }));
    }

    process.exit(1);
  }

  const misplaced = bridgeSites(sources).findings;

  if (misplaced.length > 0) {
    console.error(`error-model: ${String(misplaced.length)} runner(s) returned outside a bridge\n`);

    for (const site of misplaced) {
      console.error(finding({
        at: site,
        invariant: 'an effect is run only at an exported function or public member, the bridge its callers see',
        found: site.includes(': a flight') ? 'a flight that shares no run' : 'a runner returned from a private helper or a local function',
        silently: 'the helper reads as migrated while its callers still get a thrown failure, and the bridge count '
          + 'names a site no caller wave will remove',
        fix: 'return the Effect from the helper and run it once at the exported edge',
      }));
    }

    process.exit(1);
  }

  const byMechanism = MECHANISMS.map((mechanism) => {
    const sites = measured.filter(({ key }) => key.endsWith(`#${mechanism}`)).reduce((sum, { value }) => sum + value, 0);

    return `${mechanism} ${String(sites)}`;
  });

  console.log(`error-model: ok — ${String(total)} legacy sites (${byMechanism.join(', ')}), none above the lock `
    + `(locked ${previous.measuredAt}), over ${summary}`);

  for (const { key, was, now } of verdict.stale) {
    console.log(`  stale: ${key} locked at ${String(was)}, now ${String(now)}; \`bun scripts/error-model.ts --lock\` lowers it`);
  }

  for (const [file, { mechanisms, reason, within }] of [...DECLARED].flatMap(([path, all]) => all.map((one) => [path, one] as const))) {
    console.log(`  declared: ${file} (${mechanisms.join(', ')}${within === undefined ? '' : ` within ${within.join(', ')}`}): ${reason}`);
  }

  const { bridges, flights, routes, held, react, findings } = bridgeSites(sources);

  console.log(`  bridges: ${String(bridges.length)} (the migration ends at zero)`);

  for (const site of bridges) console.log(`    ${site}`);
  console.log(`  flights: ${String(flights.length)} (\`flight\`, the sanctioned mid-body runner)`);

  for (const site of flights) console.log(`    ${site}`);
  console.log(`  routes: ${String(routes.length)} (a Hono route handler's runner: Hono owns the call)`);

  for (const site of routes) console.log(`    ${site}`);
  console.log(`  held: ${String(held.length)} (a detached root a platform holder keeps alive: ${HOLDERS.join(', ')})`);

  for (const site of held) console.log(`    ${site}`);
  console.log(`  react: ${String(react.length)} (a detach React calls, or a settle a component attribute or useCallback hands its awaiting caller)`);

  for (const site of react) console.log(`    ${site}`);

  for (const wrong of findings) console.log(`  finding: ${wrong}`);

  for (const [file, reason] of HOST_BOUNDARIES) console.log(`  host boundary: ${file}: ${reason}`);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
