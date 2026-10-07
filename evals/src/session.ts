/**
 * THE PUBLIC-API SESSION: one reusable session over the surfaces the WEB CLIENT
 * speaks, against a DEPLOYED workspace.
 *
 * WHY THIS EXISTS BESIDE `tests/first-run/operator-session.ts`, which also reaches the
 * deployment. That session drives the OPERATOR plane: a socket over a connect ticket,
 * and every read a named method over `POST /api/cli/workspaces/:name/rpc` whose
 * `AGENT_RPC_ACCESS` table is its allowlist. So it measures what a credentialed
 * CLI operator can reach. Nothing in this tree measured what the PRODUCT'S OWN
 * CLIENT reaches — the REST the browser creates a workspace with, the chat
 * frames `useAgentChat` puts on the socket, the run-event and file routes the
 * panes read, and the delete the sidebar calls — and those are the surfaces
 * every user actually touches. A green operator-plane arm is compatible with a
 * web app that cannot create a workspace, cannot see a run event, and cannot
 * read back a file the agent wrote.
 *
 * WHAT IT DRIVES, surface by surface, each cited so a reader can open the
 * handler rather than trust this list:
 *
 *   create      `POST /api/user/workspaces` — user/routes.ts:182, into
 *               `handleCreateWorkspaceRequest` (user/workspace-access.ts:16),
 *               which is the SAME handler the CLI plane calls
 *               (cli/routes.ts:214). One create path, two doors.
 *   model       the socket RPC `setModel` (actor-agent.ts:4555, reached by the
 *               web client through `rpc("setModel", …)`), because the create
 *               REST CANNOT carry one: its body parse admits
 *               `name`/`displayName`/`purpose`/`role` and nothing else
 *               (workspace-access.ts:23-41), so a `model` field is dropped in
 *               silence — measured by reading the parse, and the reason the CLI
 *               plane's `createCloudAgent({… model})` (cli/cloud-api.ts:401)
 *               does not pin one either. A run whose model is whatever the
 *               account defaults to is a run whose cost basis is a guess, so
 *               this pins it and refuses when the deployment will not take it.
 *   turns       the agents-SDK chat frames: `CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST`
 *               carrying `{messages:[UIMessage], trigger:'submit-message'}`, and
 *               `USE_CHAT_RESPONSE` frames back until `done`. Frame NAMES come
 *               from the SDK constant, so a rename there is a compile error here
 *               rather than a silent hang.
 *   steer       the socket RPC `send` (actor-agent.ts), which is
 *               exactly what the composer calls mid-turn (hooks/use-kinu.ts
 *               `sendChat`): the call admits the words under an id minted
 *               here, and the DO's `steer_status` broadcast for that id says
 *               where they landed — `landed` (the running turn read them) or
 *               `turn` (they ran as a turn of their own) — once that is decided.
 *   history     `GET /agents/<slug>/<name>/get-messages`, the SDK's transport
 *               endpoint the pane is seeded from (agent-routing.ts:24-40).
 *   events      `GET /api/workspaces/<name>/runs` then
 *               `…/runs/<runId>/events?since=&limit=` (run-events-routes.ts:82,
 *               :104). WALKED, both ways: runs are cursored and the events read
 *               is closed at `RUN_EVENT_LIMIT_MAX` = 500 rows
 *               (core/src/events/recorder.ts:203, :220), so a multi-turn episode
 *               read in one call is a truncated denominator.
 *   files       `GET|PUT /api/workspaces/<name>/files?executor=&path=`
 *               (files-routes.ts:65-90) — the plane the web file manager writes
 *               through, which is why it is the one this harness seeds and
 *               verifies through.
 *   teardown    `DELETE /api/user/workspaces/<name>` — user/routes.ts:191, i.e.
 *               `removeWorkspace`, the sidebar's own delete. Callers put it in a
 *               `finally`: a run that threw must not leave a row on the account.
 *
 * WHO IT RUNS AS, and the one thing that makes this arm cost more than the
 * operator arm. Every surface above except the socket's frames sits behind the
 * BROWSER auth gate: `authenticateRequest` (auth/session.ts:136) takes a session
 * cookie or, on a deployment that sets `DEV_USER_EMAIL`, a request presenting
 * `DEV_IDENTITY_SECRET` in core's `DEV_IDENTITY_HEADER`. The eval
 * tier's own credential is a CLI bearer, and `handleCliRequest` returns null for
 * anything outside `/api/cli` (cli/routes.ts:87) — so the bearer cannot reach
 * one of these routes and this harness cannot borrow it. It therefore resolves
 * the browser-plane identity itself, and a run without it SKIPS WITH THE
 * REMEDY: the variable to export and the `wrangler secret put` that produced the
 * value. A skip that says "the public session is unavailable" is the false green
 * this tier was rebuilt to remove.
 *
 * CLOUD ONLY, AND FIRST. {@link resolvePublicSessionPlan} refuses before it
 * consults a credential, because there is no public REST or WebSocket surface in
 * front of an in-process `CLIRuntime`: under `KINU_EVAL_BACKEND=local` this arm
 * has nothing to drive, and provisioning a local workspace under its banner
 * would report an in-process measurement as a public-API one. That ordering is
 * also what makes the gating PROVABLE credential-free — the knob decides before
 * `liveModelTarget` is asked anything.
 *
 * NO ELAPSED DEADLINE ANYWHERE. A turn ends when the DO says it ended — the
 * terminal `USE_CHAT_RESPONSE` frame — or when the socket dies. There is no
 * timer racing the agent's work, because a timer that rejects a running turn
 * reports a bound as a behaviour.
 *
 * WHAT IS NOT RE-IMPLEMENTED HERE. The chunk vocabulary inside a response
 * frame's `body` — text deltas, tool input/output, step boundaries — is decoded
 * by the SHIPPED `CloudTurnStream` (cli/src/cloud-turn-stream.ts), the same
 * accumulator `kinu chat --cloud` renders from. Only the ENVELOPE parse is
 * local, and it is deliberately narrower than the client's: this session reads
 * response frames, RPC replies and the stream-resume announcement, and ignores
 * the rest. One decoder for the expensive half, so a chunk type the product learns
 * cannot mean two things.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { ActorLedger } from './results';

import {
  DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, hostedActorSocketPath, JOB_OUTPUT_EVENT, JsonValueSchema, ORCHESTRATOR_AGENT_SLUG,
  RunEventSchema, SendStateSchema, STEER_STEP_METADATA_KEY, ChatHistoryEntrySchema, positionPageSchema, parseJsonValue, renderSoulMarkdown, rowText, CommandResultSchema,
  type EvalAccount, type JsonValue, type LLMProviderConfig, type PendingDeviceConsent, type PositionPageRequest, type RunEvent, type SendState,
  type SubordinateInspectionRequest, type WorkMode, type WorkspaceSpend,
  QualityDaySchema, type QualityDay, ProfileCatalogEnvelopeSchema, betaSwarms, type ProfileCatalog,
} from '../../packages/core/src/index';
import { renderThrownChain, tolerate, detach } from '../../packages/core/src/obs/index';
import {
  decodeFrame, encodeChatRequest, encodeRpcRequest, HEADER_WEBSOCKET, HeardStreams, recordPublicTurn,
  type PublicResponseFrame, type PublicSendResult, type PublicTurn, type PublicTurnRecorder, type SocketPayload,
} from './session-protocol';
import { ActivitySpendSchema } from '../../packages/cli/src/cloud-api';
import { recordedAnswer } from '../../packages/cli/src/agent-client';
import {
  absorbingRunId, compareRunEventOrder, DeploymentAnswer, evalAccount, evalNameSlug, evalTargetVerdict,
  evalWebIdentityEnv, evalWorkspaceName, INFRA_FAILURE_MARKER, infraBoundary, liveModelTarget, resolveEvalBackend,
  workerSession, EVAL_BACKEND_ENV,
} from '@kinu.run/test-utils';

/** The executor a deployed workspace's own filesystem lives on — the same name
 *  the operator-plane target addresses it by, so the two arms read one plane. */
const WORKSPACE_EXECUTOR = 'workspace';

/** Runs asked for per page, and events asked for per read. The events figure is
 *  the route's own ceiling (`RUN_EVENT_LIMIT_MAX`); asking for more is answered
 *  with 500 anyway, and asking for less only lengthens the walk. */
const RUN_PAGE = 200;

const EVENT_PAGE = 500;

/** Hosts that can only be a developer's own machine — where possession of the
 *  machine IS the authority and `authenticateRequest` needs no secret
 *  (auth/session.ts:128, :164). Spelled as the auth module spells it. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

/** How this session proves it may act as the deployment's web identity, and as which of its eval accounts:
 *  `account` absent is the eval service's own. */
export type PublicWebIdentity =
  /** A loopback deployment: the machine is the boundary, no header needed. */
  | { readonly kind: 'loopback'; readonly account?: EvalAccount }
  /** A remote deployment: the synthetic identity's secret, sent per request. */
  | { readonly kind: 'secret'; readonly secret: string; readonly account?: EvalAccount };

/** A workspace as its owner's browser reaches it. */
export type WorkspaceWeb = { readonly origin: string; readonly identity: PublicWebIdentity; readonly workspace: string };

export type PublicWebIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: PublicWebIdentity }
  /** No authority for the browser plane. `remedy` names the command and the
   *  variable that would make the run happen — never "unavailable". */
  | { readonly kind: 'absent'; readonly remedy: string };

/**
 * The browser-plane identity for `origin`, or the remedy that would supply one.
 *
 * Pure over its inputs so the gating is testable credential-free: the wiring
 * suite drives it with the deployed origin and an empty environment and asserts the
 * remedy names both halves.
 */
export function resolveWebIdentity(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): PublicWebIdentityResolution {
  const variable = evalWebIdentityEnv(origin);
  const secret = env[variable]?.trim();
  const account = evalAccount(env);
  const named = account === undefined ? {} : { account };

  if (secret) return { kind: 'ready', identity: { kind: 'secret', secret, ...named } };

  if (LOOPBACK_HOSTS.includes(new URL(origin).hostname)) {
    return { kind: 'ready', identity: { kind: 'loopback', ...named } };
  }

  return {
    kind: 'absent',
    remedy: `${origin} needs the browser plane's own authority and this run has none. The eval `
      + 'tier\'s KINU_EVAL_TOKEN is a CLI bearer, and `handleCliRequest` answers nothing outside '
      + '`/api/cli` (cli/routes.ts:87), so it cannot reach `/api/user/workspaces`, '
      + '`/api/workspaces/:name/runs` or the files route this session reads. Export the '
      + `deployment's synthetic-identity secret as ${variable} — the value installed on it `
      + 'with `wrangler secret put DEV_IDENTITY_SECRET`, which is what '
      + `\`authenticateRequest\` accepts in \`${DEV_IDENTITY_HEADER}\` (auth/session.ts). `
      + 'A loopback `wrangler dev` origin needs no secret at all.',
  };
}

/** What one case needs to become a session. Deliberately the same two fields
 *  `EvalCaseRequest` carries, minus the arm's evolution knob: a deployed
 *  workspace's evolution is its own durable config, not a provisioning input. */
export interface PublicSessionRequest {
  /** Distinguishes this case's workspace from its siblings', folded into the
   *  `eval-` prefixed name so a survivor on the account is attributable. */
  readonly subject: string;
  readonly purpose: string;
  /** `false` means the workspace is created WITHOUT a genesis turn: the create
   *  carries no mission, so creation writes the placeholder soul that
   *  `isPlaceholderMission` (core/src/identity/soul.ts:45) declines a first
   *  turn on, and the purpose is written into SOUL.md over `setSoul` — the same
   *  callable the soul surface drives — before the session is handed back. The
   *  workspace a case gets still runs its first prompt under the real mission;
   *  it has simply never run the agent's own unrequested turn. Omitted or true
   *  is the product's own path: mission on the create, genesis turn queued. */
  readonly genesis?: boolean;
}

export interface PublicSessionPlan {
  /** The line a suite prints before it spends. */
  readonly describe: string;
  /** The model config in force — read off the plan so a record cannot name a
   *  model the run did not pin. */
  readonly llm: LLMProviderConfig;
  readonly origin: string;
  /** The authority this plan resolved for the browser plane. It rides on the
   *  plan because the ACCOUNT routes no workspace can answer for — the device
   *  list, a consent grant, a revocation — belong to the same identity, and a
   *  second read of the environment is a second answer to who this run is. */
  readonly identity: PublicWebIdentity;
  /** Create the workspace, connect the socket, pin the model. Throws rather
   *  than returning a degraded session; `teardown` pairs with it. */
  open(request: PublicSessionRequest): Promise<KinuPublicSession>;
}

export type PublicSessionResolution =
  | { readonly kind: 'ready'; readonly plan: PublicSessionPlan }
  /** This environment cannot run the arm, and `remedy` says what would. */
  | { readonly kind: 'unavailable'; readonly remedy: string };

/**
 * The plan for `suite` on `model`, or the remedy for the thing that is missing.
 *
 * THREE GATES, IN THIS ORDER, and the order is the load-bearing part:
 *
 *   1. THE BACKEND KNOB, before anything else. `KINU_EVAL_BACKEND=cloud` is the
 *      only value this arm can honour, and refusing here — with no credential
 *      consulted — is what makes "the live arm is reachable only under cloud" an
 *      assertion a credential-free test can make.
 *   2. THE LIVE TARGET. `liveModelTarget` applies `KINU_EVAL_LIVE` and prints
 *      the one banner, and a gateway credential under `=cloud` is refused: it
 *      fronts a model and no deployment, so there is nothing to create against.
 *   3. THE ORIGIN, re-checked. `evalTargetVerdict` rules on the deployment again
 *      here for the reason the operator target re-checks it: this session
 *      CREATES and DELETES, and a target that trusts its caller about where it
 *      is pointing is a door.
 *
 * The web identity is resolved last, so a run that is refused for a reason
 * nothing can fix does not report a missing secret as its problem.
 */
export function resolvePublicSessionPlan(
  suite: string,
  model: string,
  env: Record<string, string | undefined> = process.env,
): PublicSessionResolution {
  const backend = resolveEvalBackend(env);

  if (backend.kind === 'refused') throw new Error(`${suite}: ${backend.reason}`);

  if (backend.backend !== 'cloud') {
    return {
      kind: 'unavailable',
      remedy: `${suite} drives the DEPLOYED public API — the REST the web app creates a workspace `
        + 'with, the chat frames its socket speaks, and the run-event and file routes its panes '
        + `read. There is no such surface in front of an in-process runtime, so ${EVAL_BACKEND_ENV}`
        + `=${backend.backend} has nothing for it to drive. Run \`bun run gate:first-run\` `
        + `(${EVAL_BACKEND_ENV}=cloud), which is also the only invocation that may create `
        + 'workspaces on a shared deployment.',
    };
  }

  const target = liveModelTarget(suite);

  if (target === null) {
    return {
      kind: 'unavailable',
      remedy: `${suite} resolved no live target — \`liveModelTarget\` printed which variable is `
        + 'missing on the line above this one. The first-run tier supplies them: `bun run gate:first-run`.',
    };
  }

  // A gateway credential fronts a model and no deployment: there is no workspace API behind it.
  if (target.via !== 'worker-proxy') {
    throw new Error(`${suite}: ${EVAL_BACKEND_ENV}=cloud needs a credential for a Kinu deployment, and this `
      + `run resolved a bare model endpoint (${target.via}). Mint an eval-service credential with `
      + '`KINU_EVAL_WEB_IDENTITY=... bun scripts/eval-session-mint.ts`, which scripts/eval-credentials.ts '
      + 'then resolves as KINU_EVAL_TOKEN.');
  }

  const llm: LLMProviderConfig = { ...target.llm, model };
  const session = workerSession(llm);
  const verdict = evalTargetVerdict(session.origin);

  if (verdict.kind === 'refused') {
    throw new Error(`${suite}: public session target REFUSED — ${verdict.reason}`);
  }

  const web = resolveWebIdentity(verdict.origin, env);

  if (web.kind === 'absent') return { kind: 'unavailable', remedy: `${suite} — ${web.remedy}` };

  const suiteSlug = evalNameSlug(suite);
  const identity = web.identity;

  return {
    kind: 'ready',
    plan: {
      describe: `public API · ${verdict.origin} (${verdict.why}) · web identity ${identity.kind} `
        + `· model ${llm.model}`,
      llm,
      origin: verdict.origin,
      identity,
      open: (request) => openPublicSession({
        origin: verdict.origin,
        identity,
        workspace: evalWorkspaceName(`${suiteSlug}-${request.subject}`),
        purpose: request.purpose,
        genesis: request.genesis,
        llm,
      }),
    },
  };
}

// ── The session ────────────────────────────────────────────────────
interface PublicSessionInput {
  readonly origin: string;
  readonly identity: PublicWebIdentity;
  readonly workspace: string;
  readonly purpose: string;
  readonly genesis?: boolean;
  readonly llm: LLMProviderConfig;
  /** A catalog role the workspace is created in, which narrows its tools; absent is the account's default. */
  readonly role?: string;
  /** What the workspace needs of its account's catalog besides Beta: swarms, such as its role's definition. */
  readonly catalog?: readonly CatalogNeed[];
}

/** The POST /api/user/workspaces body, exactly the optional fields
 *  `handleCreateWorkspaceRequest` parses (user/workspace-access.ts): `purpose`
 *  may legitimately be absent, which is what a `genesis: false` open sends. */
interface CreateWorkspaceBody {
  name: string;
  displayName: string;
  purpose?: string;
  role?: string;
}

const WorkspaceEntrySchema = v.object({
  name: v.string(),
  displayName: v.optional(v.string()),
});

const RunPageSchema = v.variant('status', [
  v.object({
    status: v.literal('more'),
    items: v.array(v.object({ runId: v.string() })),
    next: v.object({ after: v.string() }),
  }),
  v.object({ status: v.literal('end'), items: v.array(v.object({ runId: v.string() })) }),
]);

/** Every ledger row type this harness reads. A row of another type is another build's (`LedgerPageSchema`). */
const RUN_EVENT_TYPES: ReadonlySet<string> = new Set(RunEventSchema.options.map((option) => option.entries.type.literal));

/** A ledger row as far as paging needs it: its type and its index. */
const LedgerRowSchema = v.looseObject({ type: v.string(), eventIndex: v.number() });

/**
 * A page of a run's ledger, less the rows of a type this harness does not know: those are another build's. The eval
 * verdict's baseline leg runs the promoted build, which can still write a type the candidate retired (2f660875cc
 * writes `step_partial`). A row of a known type that does not parse is a broken contract, and fails the read.
 */
const LedgerPageSchema = v.pipe(
  v.array(LedgerRowSchema),
  v.transform((rows) => ({
    rows: rows.length,
    highest: rows.reduce((max, row) => Math.max(max, row.eventIndex), -1),
    events: rows.filter((row) => RUN_EVENT_TYPES.has(row.type)),
  })),
  v.object({ rows: v.number(), highest: v.number(), events: v.array(RunEventSchema) }),
);

/**
 * A page of an inspector or work-board answer, read as far as a check reads it. These answers come from both legs of
 * the eval verdict, and the baseline leg runs the promoted build, whose rows can lack a field the candidate added or
 * renamed: 2f660875cc's roster rows carry `createdBy` where the candidate's carry `origin`, and its work-board owners
 * have no `path`. So the harness reads only what a check reads, and nothing it does not.
 */
function pageOf<Item extends v.GenericSchema>(item: Item) {
  return v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(item), next: v.object({ after: v.string() }) }),
    v.object({ status: v.literal('end'), items: v.array(item) }),
  ]);
}

/** The inspector's answers a check reads (`inspectSubordinate`): the lead's helpers and each helper's runs. */
const InspectionAnswerSchema = v.variant('view', [
  v.object({ view: v.literal('children'), page: pageOf(v.object({
    name: v.string(), status: v.string(), lifetime: v.string(), actorReference: v.nullable(v.object({ actorId: v.string() })),
  })) }),
  v.object({ view: v.literal('runs'), page: pageOf(v.object({ runId: v.string(), startedAt: v.number(), status: v.nullable(v.string()), userMessage: v.nullable(v.string()) })) }),
  v.object({ view: v.literal('events'), page: v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(RunEventSchema), next: v.number() }),
    v.object({ status: v.literal('end'), items: v.array(RunEventSchema) }),
  ]) }),
  v.object({ view: v.literal('missing'), reason: v.string(), error: v.string() }),
]);

export type InspectionAnswer = v.InferOutput<typeof InspectionAnswerSchema>;

/** The work board's owners and their tasks (`listWorkspaceWork`); an owner's `path` is absent on 2f660875cc. */
const WorkEntrySchema = v.object({
  owner: v.object({ name: v.string(), path: v.optional(v.nullable(v.array(v.string()))) }),
  tasks: v.array(v.object({
    title: v.string(), status: v.string(),
    subtasks: v.optional(v.array(v.object({ title: v.string(), status: v.string() })), []),
  })),
});

const WorkBoardSchema = v.object({ plans: v.array(WorkEntrySchema), tasks: v.array(WorkEntrySchema) });

export type WorkBoard = v.InferOutput<typeof WorkBoardSchema>;

/**
 * One swarm the lead ran, as the Swarms pane draws it (`getExplorationCanvas`): the run, its search's dispatch
 * parameters, and each node's journalled row. `head.rationale` is the preset, or a `custom` run's label (core
 * `swarm-setup.ts`); a search scored by its verifier requested no judge samples (core `swarm-run.ts`).
 */
const SwarmRunSchema = v.object({
  run: v.object({ id: v.string(), status: v.string(), startedAt: v.number(), winnerScore: v.nullable(v.number()) }),
  params: v.nullable(v.object({ search: v.nullable(v.object({ judgeSamplesRequested: v.nullable(v.number()) })) })),
  head: v.nullable(v.object({
    rationale: v.string(),
    heads: v.array(v.object({ depth: v.number(), status: v.string(), spawnedAt: v.number(), wallClockMs: v.number() })),
  })),
});

export type PublicSwarmRun = v.InferOutput<typeof SwarmRunSchema>;

const SwarmPageSchema = pageOf(SwarmRunSchema);

/** A helper's room: the socket on its path, and the streams it hears. */
type HelperRoom = { readonly socket: WebSocket; readonly heard: HeardStreams };

/** The broadcasts live output rides, to every socket: a head's words and each step its journal lands
 *  (`publishHeadStreamFrame`, `announceHeadActivity` in cf-backend `actor-agent.ts`), where swarm nodes speak only,
 *  and a running job's output (`job_output`, core `jobs/live-output.ts`), where a detached build speaks only. */
const LIVE_OUTPUT_FRAMES: ReadonlySet<string> = new Set(['head_stream', 'head_activity', JOB_OUTPUT_EVENT]);

/** How soon a helper's room that closed is opened again: a room the edge refuses is not dialled at every poll. */
const ROOM_REDIAL_MS = 30_000;

const SetModelSchema = v.object({ spec: v.string() });


/** The executor's display fields and its producer-owned command refusal.
 * Success omits refusal; historical responses may lack classification. */
const ExecutorCommandSchema = v.object({
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  error: v.optional(v.string()),
  refusal: v.optional(CommandResultSchema.options[1]),
});

/** One command's answer on an executor, as the Env pane receives it. */
export type PublicExecutorResult = v.InferOutput<typeof ExecutorCommandSchema>;

/** The parked-command rows `listDeferredApprovals` serves — the needs-you
 *  queue's own shape (`core/src/safety/deferred-approval.ts`), narrowed to what
 *  a caller can decide on: which command, where it would run, and whether it is
 *  still parked. `list()` returns queued rows only, so a decided row LEAVING
 *  this array is the decision landing. */
const DeferredApprovalSchema = v.object({
  id: v.string(),
  command: v.string(),
  executor: v.string(),
  status: v.string(),
});

/** The device consent cards `listPendingConsents` serves — the bind prompt a
 *  workspace's first call on a machine raises (`core/src/safety/
 *  device-consent.ts`), narrowed to what a caller answers on: which machine
 *  asks, and the id the answer is addressed to. */
/** A card as the chat paints it: which machine, and the exact call the owner is asked to let through. */
const PendingConsentsSchema = v.array(v.object({ consentId: v.string(), deviceId: v.string(), method: v.string(), command: v.string() }));

const ResolveConsentSchema = v.object({ ok: v.boolean() });

const WorkspaceSnapshotSchema = v.object({
  status: v.object({ messageCount: v.number(), model: v.string() }),
});

export type PublicWorkspaceSnapshot = v.InferOutput<typeof WorkspaceSnapshotSchema>['status'];

const DeferredApprovalsSchema = v.array(DeferredApprovalSchema);

const DecideApprovalsSchema = v.object({ decided: v.array(v.string()) });

/** One background job's durable row, as `listBackgroundJobs` serves it. The
 *  settled halves are what a recovery check reads: `status` leaves `running`,
 *  `result`/`error` hold what the work produced. Other row fields exist; a
 *  reader that needs none of them asks for no more than these. */
const PublicBackgroundJobSchema = v.object({
  id: v.string(),
  kind: v.string(),
  /** What the job runs, as the Supervise pane names it (`workspace: node server.js`). */
  label: v.optional(v.nullable(v.string())),
  status: v.string(),
  result: v.optional(v.nullable(v.string())),
  error: v.optional(v.nullable(v.string())),
  /** When the job began, in milliseconds since the epoch. */
  createdAt: v.optional(v.number()),
});

const BackgroundJobsSchema = v.array(PublicBackgroundJobSchema);

export type PublicBackgroundJob = v.InferOutput<typeof PublicBackgroundJobSchema>;

/** One parked command, as the queue hands it to the surface that decides it. */
export type PublicDeferredApproval = v.InferOutput<typeof DeferredApprovalSchema>;

/** The crafted half of `getToolDescriptions` — the tools this workspace holds
 *  that the MODEL wrote. `usageCount` is the store's own counter, which is what
 *  makes "the tool exists" and "the tool ran" separable facts. The built-in
 *  half is not modelled: no caller here asks about it. */
const CraftedToolSchema = v.object({
  name: v.string(),
  description: v.string(),
  usageCount: v.optional(v.number()),
  /** What the Tools pane shows beside the name: wired into `eval`, and the quality the platform measured. */
  wired: v.optional(v.boolean()),
  exposure: v.optional(v.string()),
  qualityScore: v.optional(v.number()),
});

const ToolDescriptionsSchema = v.object({ crafted: v.array(CraftedToolSchema) });

/** One tool the model built for itself, as the Tools pane lists it. */
export type PublicCraftedTool = v.InferOutput<typeof CraftedToolSchema>;

/** The Slate tab listing, including projects that could not be loaded. */
const SlateSummarySchema = v.object({
  id: v.string(),
  title: v.string(),
  bindings: v.array(v.string()),
  port: v.optional(v.number()),
});

const SlateListingSchema = v.object({
  slates: v.array(SlateSummarySchema),
  problems: v.array(v.object({ id: v.string(), reason: v.string(), error: v.string() })),
});

export type PublicSlateListing = v.InferOutput<typeof SlateListingSchema>;

/** The roster rows `listSubordinates` serves (orchestrator.ts:5536), narrowed
 *  to the three facts a delegation case grades: WHO was hired, whether the row
 *  is still active, and the `lifetime` that decided it — the one column no
 *  later state recovers (core/src/subordinates/roster.ts:38-44), which is what
 *  makes "a task hire retired itself" checkable at all.
 *
 *  The RPC the AGENT SURFACE reads: `AgentSurface.tsx:321`'s `loadRoster` and
 *  the chat's own roster refresh (`hooks/use-kinu.ts:1990`) both call it. */
const SubordinateRowSchema = v.object({
  name: v.string(),
  status: v.picklist(['idle', 'working', 'awaiting_input', 'dismissed']),
  lifetime: v.string(),
});

const SubordinateRosterSchema = v.array(SubordinateRowSchema);

/** One row of the roster, as the Agents surface lists it. */
export type PublicSubordinate = v.InferOutput<typeof SubordinateRowSchema>;

/** An agent as the Agents panel lists it: `working` from a turn owed to it (queued, handed over, or due from its event
 *  log) through the claim that runs it, until that turn ends (core `read-models/workspace-agents.ts`). `open.path` is a
 *  chat agent's roster path, null for the lead. */
const PanelAgentSchema = v.object({
  label: v.string(),
  category: v.picklist(['main', 'user', 'hired', 'swarm', 'background']),
  activity: v.picklist(['working', 'waiting', 'idle', 'done', 'stopped', 'failed', 'dismissed']),
  open: v.object({ kind: v.string(), path: v.optional(v.nullable(v.string())) }),
});

export type PublicAgent = v.InferOutput<typeof PanelAgentSchema>;

/** One entry of a folder as the Files tab lists it (`getExecutorFiles`). */
const DirEntrySchema = v.object({ name: v.string(), type: v.picklist(['file', 'dir']) });

const DirectorySchema = v.object({ entries: v.optional(v.array(DirEntrySchema)), error: v.optional(v.string()) });

export type PublicDirEntry = v.InferOutput<typeof DirEntrySchema>;

/** What the harness reads of `readExecutorFile`'s answer (`ExecutorTextFile`,
 *  core/src/read-models/files.ts): the preview's text, or the reason there is
 *  none. Both optional, because the read model answers one or the other. */
const ViewedFileSchema = v.object({
  content: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
  readOnlyReason: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** One file as the Files tab shows it. */
export type PublicViewedFile = v.InferOutput<typeof ViewedFileSchema>;

/** One page of the conversation as `getChatHistoryPage` answers it: each entry names its turn. */
const HistoryPageSchema = positionPageSchema(ChatHistoryEntrySchema);

/** The SDK's message rows as `get-messages` serves them. Narrowed to what a
 *  trajectory asserts on — who spoke, and the text they said — because the parts
 *  array also carries tool and reasoning parts this projection does not read. */
const HistorySchema = v.array(v.object({
  id: v.optional(v.string()),
  role: v.string(),
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
  metadata: v.optional(v.record(v.string(), JsonValueSchema)),
}));

/** One durable message, as the web pane's seed carries it. */
export interface PublicMessage {
  /** Absent on a row the transcript keeps no id for. */
  readonly id?: string;
  readonly role: string;
  /** What it says: an answer's final text, never the narration its steps streamed before it. */
  readonly text: string;
  /** For a user row that landed mid-turn: the step index of the step it was
   *  spliced into — the product's own statement of where inside the absorbing
   *  turn the model read it. Absent on every other row. */
  readonly landedAtStep?: number;
}

interface OpenTurn {
  readonly recorder: PublicTurnRecorder;
  readonly resolve: (turn: PublicTurn) => void;
  readonly reject: (error: Error) => void;
}

/** How a send the DO answered `mid-turn` names its absorbing run in the run events. */
type Absorber = (events: readonly RunEvent[]) => string | null;

/** A turn in flight: the id the DO knows it by, and the promise it settles. A
 *  submission rather than a bare promise, because a mid-turn steer has to be
 *  issued while this one is still open. */
export interface PublicSubmission {
  readonly requestId: string;
  readonly settled: Promise<PublicSendResult>;
}

/** The display name every eval workspace is created under, used twice when a
 *  `genesis: false` open rewrites the soul itself: the document's heading must
 *  read what a mission-first create would have written, so the constant is
 *  shared rather than re-typed. */
const SESSION_DISPLAY_NAME = 'Trajectory Evals';

const RosterRowSchema = v.object({ name: v.string(), lastVisited: v.number() });

const RosterPageSchema = v.object({ entries: v.array(RosterRowSchema), nextCursor: v.nullable(v.string()) });

/** A workspace as the account's roster lists it: `lastVisited` is the last mark any run or visit put on it. */
export type RosterRow = v.InferOutput<typeof RosterRowSchema>;

/**
 * How often a run marks its workspace live on the deployment, through `touch` (the roster's
 * `last_visited`, which every machine reads). The eval sweep deletes an `eval-` workspace whose mark
 * is older than its lease (`sweep.ts`), so a run on any machine keeps its workspaces by beating.
 */
export const WORKSPACE_BEAT_MS = 60_000;

/** Ten missed beats: long past any live run's last mark, and past any skew between two machines' clocks. */
export const WORKSPACE_LEASE_MS = 10 * WORKSPACE_BEAT_MS;

/**
 * Why a trial's own workspace answering 404 measured nothing of the build, or undefined when it may have: its last
 * mark is at least a lease old, so another run's sweep may have deleted it. A machine that sleeps past the lease
 * stops beating, and the trial wakes to a workspace that is gone.
 */
export function sweptAway(answer: DeploymentAnswer, lastMarked: number, now: number): string | undefined {
  if (answer.status !== 404 || now - lastMarked < WORKSPACE_LEASE_MS) return undefined;

  return `the workspace was swept: its last mark is ${String(Math.floor((now - lastMarked) / 60_000))} min old, past the `
    + `${String(WORKSPACE_LEASE_MS / 60_000)} min lease after which a run's sweep deletes it, so this 404 measured nothing of the build`;
}

/** Every workspace on the identity's account, page by page, as the sidebar's roster lists them. */
export async function listWorkspaces(origin: string, identity: PublicWebIdentity): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  let cursor: string | null = null;

  do {
    const url = `${origin}/api/user/workspaces${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`;

    // Annotated because the loop reads its own result: `page.nextCursor` feeds the next iteration.
    const page: v.InferOutput<typeof RosterPageSchema> = v.parse(RosterPageSchema, await infraBoundary(`GET ${url}`, async () =>
      readJson(await fetch(url, { headers: webHeaders(identity) }), 'list the workspaces')));

    rows.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return rows;
}

/** Delete a workspace, the DELETE the sidebar's Remove issues. */
export async function deleteWorkspace(origin: string, identity: PublicWebIdentity, name: string): Promise<void> {
  await infraBoundary(`DELETE ${origin}/api/user/workspaces/${name}`, async () => {
    const response = await fetch(`${origin}/api/user/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE', headers: webHeaders(identity) });

    await readJson(response, `delete the workspace ${name}`);
  });
}

/** One beat: the roster's mark on `name` moves to now, and whether the deployment took it. A workspace the roster no
 *  longer holds refuses the mark with 404. A beat that fails is said, and the lease rides out the next nine. */
async function markLive(origin: string, identity: PublicWebIdentity, name: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/user/workspaces/${encodeURIComponent(name)}/touch`, { method: 'POST', headers: webHeaders(identity) });

    await readJson(response, `mark the workspace ${name} live`);

    return true;
  } catch (error) {
    console.warn(`[evals] ${name} missed a beat: ${renderThrownChain({ cause: error })}`);

    return false;
  }
}

/** Runs `beat` every {@link WORKSPACE_BEAT_MS} until the returned stop is called. */
function everyBeat(beat: () => Promise<boolean>): () => void {
  const timer = setInterval(() => detach(Effect.promise(async () => { await beat(); })), WORKSPACE_BEAT_MS);

  timer.unref();

  return () => { clearInterval(timer); };
}

/** Mark `name` live every {@link WORKSPACE_BEAT_MS} until the returned stop is called; its create is the first mark. */
export function beatWorkspace(origin: string, identity: PublicWebIdentity, name: string): () => void {
  return everyBeat(() => markLive(origin, identity, name));
}

/** Writers per account racing for its catalog, and a spare: each lost race means another writer landed. */
const CATALOG_WRITE_ATTEMPTS = 4;

/** What a workspace needs of its account's catalog: the catalog with it, or null when the catalog already holds it. */
export type CatalogNeed = (catalog: ProfileCatalog) => ProfileCatalog | null;

/** "Beta: swarms" on for the account the evals run as, whose swarms are part of what they measure. */
const SWARMS_ON: CatalogNeed = (catalog) => betaSwarms(catalog) ? null : { ...catalog, betaSwarms: true };

/** Bring the account's catalog to what `needs` ask of it. The cases of one run race to write it, so a lost version race
 *  reads again, until nothing is left to write. */
async function settleCatalog(origin: string, headers: Record<string, string>, needs: readonly CatalogNeed[]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const read = await fetch(`${origin}/api/user/profile-catalog`, { headers });
    const { version, catalog } = v.parse(ProfileCatalogEnvelopeSchema, await readJson(read, 'read the profile catalog'));
    const wanted = needs.reduce<ProfileCatalog | null>((sofar, need) => need(sofar ?? catalog) ?? sofar, null);

    if (wanted === null) return;

    const answer = await fetch(`${origin}/api/user/profile-catalog`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ catalog: wanted, expectedVersion: version }),
    });

    if (answer.ok || (answer.status === 409 && attempt < CATALOG_WRITE_ATTEMPTS)) continue;
    await readJson(answer, 'write the profile catalog');
  }
}

export async function openPublicSession(input: PublicSessionInput): Promise<KinuPublicSession> {
  const headers = webHeaders(input.identity);

  await infraBoundary(`PUT ${input.origin}/api/user/profile-catalog`, () => settleCatalog(input.origin, headers, [SWARMS_ON, ...input.catalog ?? []]));

  const created = await infraBoundary(
    `POST ${input.origin}/api/user/workspaces`,
    async () => {
      const body: CreateWorkspaceBody = {
        name: input.workspace,
        displayName: SESSION_DISPLAY_NAME,
      };

      // A mission on the create queues the workspace's own genesis turn —
      // creation fires it on any non-placeholder mission (orchestrator.ts's
      // beginGenesisTurn over soul.ts:77). A case that asked for
      // `genesis: false` sends NO purpose, so the workspace is born on the
      // placeholder mission `workspaceGenesisSignal` returns null for, and
      // the real mission is written over the socket below.
      if (input.genesis !== false) body.purpose = input.purpose;

      if (input.role !== undefined) body.role = input.role;

      const response = await fetch(`${input.origin}/api/user/workspaces`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      return v.parse(WorkspaceEntrySchema, await readJson(response, 'create a workspace'));
    },
  );

  const session = new KinuPublicSession(input, created.name);

  session.beat();

  try {
    await session.connect();

    if (input.genesis === false) {
      // `setSoul` is the soul surface's own callable, writing exactly the
      // markdown `initializeOrchestrator` seeds when it DOES carry a mission
      // (workspace-create.ts's renderSoulMarkdown over the same display name),
      // and it lands before the first prompt — so every turn still runs under
      // the case's real mission and only the unrequested first turn is gone.
      await session.setMission(input.purpose);
    }

    await session.pinModel(input.llm.model);
  } catch (error) {
    // A half-opened session must not leave a workspace on the account: this is
    // the one place `teardown` cannot be the caller's `finally`, because the
    // caller never received the session.
    await session.teardown();
    throw error;
  }

  return session;
}

/** The messages of one SSE body, as `{ event, data }`: a blank line ends a
 *  message, a `:` line is a comment (the route's heartbeat). */
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });

    for (;;) {
      const end = buffered.indexOf('\n\n');

      if (end < 0) break;
      const raw = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      let event = 'message';
      const data: string[] = [];

      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }

      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }
}

export function webHeaders(identity: PublicWebIdentity): Record<string, string> {
  const headers: Record<string, string> = identity.kind === 'secret' ? { [DEV_IDENTITY_HEADER]: identity.secret } : {};

  if (identity.account !== undefined) headers[DEV_IDENTITY_ACCOUNT_HEADER] = identity.account;

  return headers;
}

/** One response body, or the deployment's own words on a failure. The body is
 *  kept on the error path deliberately: a 409 naming an unserveable model and a
 *  503 naming a missing binding are different repairs. */
async function readJson(response: Response, doing: string): Promise<JsonValue> {
  const text = await response.text();

  if (!response.ok) {
    throw new DeploymentAnswer(`could not ${doing}: ${String(response.status)} ${response.statusText} `
      + `— ${text.slice(0, 400)}`, response.status);
  }

  const parsed = tolerate(() => parseJsonValue(text), 'malformed-input');

  if (parsed === undefined) {
    throw new Error(`could not ${doing}: the response was not JSON — ${text.slice(0, 200)}`);
  }

  return parsed;
}

/**
 * A workspace on a deployment, driven the way the product's own client drives
 * one.
 *
 * MULTI-TURN BY CONSTRUCTION: the socket stays open across prompts and the DO
 * owns the conversation, so turn two is a follow-up rather than a fresh task.
 * The client never mirrors history — `submit` puts only the new user message on
 * the wire, exactly as the web transport does.
 */
export class KinuPublicSession {
  private socket: WebSocket | null = null;

  private opening: Promise<void> | null = null;

  private readonly turns = new Map<string, OpenTurn>();

  /** Callers waiting on one response chunk of a request: settled by the
   *  first frame body the predicate accepts, then dropped. */
  private readonly chunkWatchers = new Map<string, Array<{ readonly accept: (body: string) => boolean; readonly resolve: () => void }>>();
  /** For each send the DO answered `mid-turn`, how its absorbing run is named: live, by the done frame's arrival in the
   *  run events' own clock domain; after a drop, by the turn its state names. Outlives the `turns` entry, which is
   *  deleted at settle. */
  private readonly absorbers = new Map<string, Absorber>();
  /** One follower per run, however many sends it absorbed: each waiter on the run's end awaits the same stream.
   *  A follower per waiter was nineteen SSE streams on one run of a trial on 2026-09-24, and the object died under
   *  their reads. */
  private readonly runEnds = new Map<string, Promise<void>>();
  /** Steers awaiting their landing, by the id each was admitted under. */
  private readonly steerLandings = new Map<string, {
    resolve: (landing: 'mid-turn' | 'turn') => void;
    reject: (error: Error) => void;
  }>();
  private readonly rpcs = new Map<string, {
    readonly resolve: (result: JsonValue) => void;
    readonly reject: (error: Error) => void;
  }>();
  private nextId = 0;

  /** Stops the beat that keeps this workspace out of every eval sweep; none until {@link beat}. */
  private stopBeat: () => void = () => undefined;

  /** When the deployment last took this workspace's mark: its create, then each beat that landed. A machine that
   *  sleeps stops beating, and a sweep deletes a workspace whose mark is older than the lease (`sweep.ts`). */
  lastMarked = Date.now();

  /** Told what arrives for the turns this session sent: each chunk's type as it arrives, `replay` for a chunk the
   *  deployment sends again after a redial, `done` at a turn's last frame, and `closed <code>` when the socket drops. */
  onChunk: (type: string) => void = () => undefined;

  /** Told of each live chunk heard outside this session's own turns: a turn the product opened in the workspace's room
   *  (`room` null), a helper's turn in its own room, a head's words (`head_stream`) and each step it lands (`head_activity`). */
  onHeard: (room: string | null, type: string) => void = () => undefined;

  /** Live frames heard so far in every room this session hears. The ledger writes a step only when it ends, so a model
   *  streaming one step for minutes is heard working only here. */
  private framesHeard = 0;

  /** How often the workspace has said each live read moved, and the sockets this session has opened on its room. */
  private readonly moved = new Map<string, number>();

  private socketsOpened = 0;

  private moving = new AbortController();

  /** The streams each open socket hears: the workspace's room from `dial`, each helper's from `listen`. The ledger writes
   *  a call only when it ends (`tool_call_end`), so a call that runs for minutes, a helper's task, is seen running only here. */
  private readonly hearing = new Set<HeardStreams>();

  /** The helpers' rooms this session listens to, by helper name, and when each one that closed last closed. */
  private readonly rooms = new Map<string, HelperRoom>();

  private readonly roomsClosedAt = new Map<string, number>();

  /** The ledger read so far, by run. Its rows are never rewritten, so a later read asks each run only for what it
   *  added: a settle poll that walked every row of a long trial again was the harness's heaviest read. */
  private readonly ledger = new Map<string, readonly RunEvent[]>();

  constructor(
    private readonly input: PublicSessionInput,
    /** The name the deployment gave this workspace, which is not always the one
     *  asked for: the create path may answer with an existing row. */
    readonly workspace: string,
  ) {}

  /** Mark this workspace live on the deployment until teardown, one {@link markLive} a beat. */
  beat(): void {
    this.lastMarked = Date.now();
    this.stopBeat = everyBeat(() => this.markLive());
  }

  /** One beat: whether the deployment took this workspace's mark, which moves {@link lastMarked} only when it did. */
  async markLive(): Promise<boolean> {
    const took = await markLive(this.input.origin, this.input.identity, this.workspace);

    if (took) this.lastMarked = Date.now();

    return took;
  }

  /** Where this workspace's pages are, and who opens them: this session's own account. */
  get web(): WorkspaceWeb {
    return { origin: this.input.origin, identity: this.input.identity, workspace: this.workspace };
  }

  get describe(): string {
    return `public session · ${this.input.origin} · workspace ${this.workspace} `
      + `· model ${this.input.llm.model}`;
  }

  /** `infraBoundary` for this workspace's own requests, which reads one more failure as not the build's: a 404 once
   *  the workspace's last mark is a lease old ({@link sweptAway}). */
  private async boundary<T>(boundary: string, op: () => Promise<T>): Promise<T> {
    try {
      return await infraBoundary(boundary, op);
    } catch (error) {
      const swept = error instanceof DeploymentAnswer ? sweptAway(error, this.lastMarked, Date.now()) : undefined;

      if (swept === undefined) throw error;

      throw new Error(`${INFRA_FAILURE_MARKER} — ${boundary}: ${swept}`, { cause: error });
    }
  }

  /**
   * Open the socket the web client opens.
   *
   * The upgrade carries the web identity's header rather than a connect ticket:
   * the ticket path is the CLI's (server.ts:192-253) and this session is the
   * browser's. It settles on the socket's OWN lifecycle — open, error, close —
   * and on nothing else. A timer here would be an elapsed deadline on the
   * deployment's handshake, and the socket already fails when the TCP or TLS
   * layer does.
   */
  async connect(): Promise<void> {
    // Concurrent sends during a redial share the one handshake instead of racing a CONNECTING socket.
    this.opening ??= this.socket === null ? this.dial().finally(() => { this.opening = null; }) : null;
    await this.opening;
  }

  /**
   * Clear the chat as its Clear control does. The deployment answers the clear to every socket but the sender's, so a
   * second socket hears it land: the clear is done once that socket is told, after storage dropped the conversation.
   */
  async clearConversation(): Promise<void> {
    await this.boundary(`clearing the conversation on ${this.workspace}`, async () => {
      const observer = this.newSocket();

      try {
        await new Promise<void>((resolve, reject) => {
          observer.addEventListener('open', () => {
            this.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR })).catch(reject);
          }, { once: true });
          observer.addEventListener('message', (event: MessageEvent) => {
            const frame = decodeFrame(event.data);

            if (frame?.kind === 'other' && frame.type === CHAT_MESSAGE_TYPES.CHAT_CLEAR) resolve();
          });
          observer.addEventListener('error', () => { reject(new Error('the socket that hears the clear failed')); }, { once: true });
          observer.addEventListener('close', () => { reject(new Error('the socket that hears the clear closed before it was told')); }, { once: true });
        });
      } finally { observer.close(); }
    });
  }

  /** A socket on the workspace's room, or on a helper's when `room` is its path tail (`hostedActorSocketPath`). */
  private newSocket(room?: string): WebSocket {
    const url = new URL(
      `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.workspace)}${room === undefined ? '' : `/${room}`}`,
      this.input.origin,
    );

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    return new HEADER_WEBSOCKET(url.toString(), {
      headers: webHeaders(this.input.identity),
    });
  }

  private async dial(): Promise<void> {
    const socket = this.newSocket();
    const where = new URL(socket.url);
    const heard = new HeardStreams();

    this.socket = socket;
    this.hearing.add(heard);
    // A frame the workspace sent while no socket was open is lost: a socket opened is every read moving.
    this.socketsOpened += 1;
    this.moveOn();
    socket.addEventListener('message', (event: MessageEvent) => {
      this.handleFrame(event.data, heard);
    });
    // The platform closes an idle socket when it deactivates the instance (1006, "no longer active,
    // reconnect"); the next send redials rather than writing into a CLOSED socket, which discards the
    // frame without an error and leaves its caller waiting forever.
    socket.addEventListener('close', (event: CloseEvent) => {
      this.hearing.delete(heard);

      // A socket this session let go of (`disconnect`, `teardown`) is no longer `this.socket`; any other close is news.
      if (this.socket === socket) {
        this.socket = null;
        this.onChunk(`closed ${String(event.code)}`);
      }

      const reason = `the workspace socket closed (code ${String(event.code)}${event.reason ? `, ${event.reason}` : ''})`;

      detach(Effect.promise(() => this.survive(reason)));
    });
    await this.boundary(`ws ${where.host}${where.pathname}`, () => new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => {
        reject(new Error(`could not open the public chat socket to ${where.host}${where.pathname}`));
      }, { once: true });
      socket.addEventListener('close', () => {
        reject(new Error('the public chat socket closed before it opened — the deployment '
          + 'refused the upgrade, which for this plane means the web identity was not accepted'));
      }, { once: true });
    }));
  }

  /**
   * Pin the model this run announced, and refuse a substitution.
   *
   * The deployment NORMALIZES a spec (actor-agent.ts:4560), so the accepted
   * string legitimately differs from the one asked for — `workers-ai/@cf/…`
   * against `@cf/…`. Containment is therefore the honest check: it catches the
   * account default standing in for the arm's model, which is the substitution
   * that makes a cost basis fiction, and tolerates the spelling the registry
   * chose.
   */
  async pinModel(spec: string): Promise<string> {
    const accepted = v.parse(SetModelSchema, await this.rpc('setModel', [spec])).spec;

    if (!accepted.includes(spec)) {
      throw new Error(`this workspace answered \`setModel(${spec})\` with ${accepted}, so the `
        + 'deployment substituted a model the run never announced and its cost basis would be '
        + "somebody else's. Check the account's model menu (`/api/user/models`).");
    }

    return accepted;
  }

  /**
   * Write SOUL.md, the call the soul surface itself makes.
   *
   * Reachable here for one job: a `genesis: false` open created the workspace
   * on the placeholder mission so no genesis turn was ever queued, and this
   * write lands the case's real mission before its first prompt.
   */
  async setSoul(markdown: string): Promise<void> {
    await this.boundary(`setSoul on ${this.input.origin}/${this.workspace}`, () =>
      this.rpc('setSoul', [markdown]));
  }

  /** The mission, written as creation writes it. */
  setMission(mission: string): Promise<void> {
    return this.setSoul(renderSoulMarkdown({ name: SESSION_DISPLAY_NAME, mission }));
  }

  /** Start a turn and hand back its id and its promise. The promise resolves
   *  when the run that ANSWERS the prompt closes — the prompt's own turn, or
   *  the run it spliced into when the done frame answers `mid-turn`. */
  submit(text: string, mode?: WorkMode): PublicSubmission {
    const requestId = this.mintId('turn');
    const recorder = recordPublicTurn();

    const admitted = new Promise<PublicTurn>((resolve, reject) => {
      this.turns.set(requestId, { recorder, resolve, reject });
      this.send(encodeChatRequest({ requestId, text, ...(mode !== undefined && { mode }) })).catch(reject);
    });

    // The observation window IS the absorbing run: a mid-turn landing is
    // counted under the run that was open when it landed, so the send resolves
    // only when THAT run's `run_end` is on the wire — not at the done frame,
    // which precedes the steps the splice provokes.
    const settled: Promise<PublicSendResult> = admitted.then(async (result) => {
      if (result.landed !== 'mid-turn') return result;

      const absorber = this.absorbers.get(requestId) ?? ((events) => absorbingRunId(events, new Date().toISOString()));
      this.absorbers.delete(requestId);

      return { landed: 'mid-turn', absorbedBy: await this.awaitAbsorbingRunEnd(absorber) };
    });

    return { requestId, settled };
  }

  /** Follow the absorbing run to its terminal event. A stream rollover is not
   * completion; followRun resumes it from the last recorded event. */
  private async awaitAbsorbingRunEnd(absorber: Absorber): Promise<string | null> {
    const events = await this.runEvents();
    const runId = absorber(events);

    if (runId === null) return null;
    const own = events.filter((event) => event.runId === runId);

    if (own.some((event) => event.type === 'run_end')) return runId;
    const cursor = own.reduce((last, event) => Math.max(last, event.eventIndex), 0);
    const following = this.runEnds.get(runId) ?? this.followToEnd(runId, cursor);
    await following;

    return runId;
  }

  private followToEnd(runId: string, cursor: number): Promise<void> {
    const following = (async () => {
      for await (const event of this.followRun(runId, cursor)) {
        if (event.type === 'run_end') break;
      }
    })().finally(() => { this.runEnds.delete(runId); });

    this.runEnds.set(runId, following);

    return following;
  }

  /** One user turn, awaited to settle. Every ledger row a suite reads is written
   *  when the turn closes, so a read before settle reports a zero denominator
   *  from a turn that was merely still running. A send the DO answers
   *  `mid-turn` resolves when the run it spliced into closes — the same
   *  denominator rule, one run further up. */
  prompt(text: string, mode?: WorkMode): Promise<PublicSendResult> {
    return this.boundary(`turn on ${this.input.origin}/${this.workspace}`, () =>
      this.submit(text, mode).settled);
  }

  /**
   * Steer the running turn, the way the composer does.
   *
   * The call admits the words under an id minted here; the answer is the DO's
   * own statement about what then happened to them, its `steer_status` for
   * that id: `'mid-turn'` means the running turn read them at a step, `'turn'`
   * means that turn ended first and they ran as the next ordinary turn. Both
   * are landings, decided by the turn and heard when decided, and a caller
   * that treated `'turn'` as a failure would be failing on a race the product
   * resolves correctly. The waiter is registered before the call, so a
   * broadcast cannot precede it.
   */
  async steer(text: string): Promise<'mid-turn' | 'turn'> {
    const steerId = this.mintId('steer');
    const landing = new Promise<'mid-turn' | 'turn'>((resolve, reject) => { this.steerLandings.set(steerId, { resolve, reject }); });

    return this.boundary(`send on ${this.input.origin}/${this.workspace}`, async () => {
      try {
        await this.rpc('send', [text, steerId, [], 'build']);
      } catch (cause) {
        this.steerLandings.delete(steerId);
        throw cause;
      }

      return landing;
    });
  }

  /**
   * Run one command on an executor, the way the Env tab's terminal runs one.
   *
   * `executeInExecutor` is the RPC the pane is bound to (hooks/use-kinu.ts:1775)
   * and this is the same frame over the same socket, so a green here is a
   * statement about the surface a person uses. The answer is returned whole
   * rather than reduced to stdout: a refusal arrives as `{error}` or as a
   * classified payload on the stdout channel, and which one it is is the finding
   * a device case reads. `device` is the fleet member the call names — the
   * same third argument the RPC carries for the device executor, left absent
   * rather than defaulted so an unnamed call keeps its own answer.
   */
  async execute(executor: string, command: string, device?: string): Promise<PublicExecutorResult> {
    const args: JsonValue[] = device === undefined ? [executor, command] : [executor, command, device];

    const result = await this.boundary(
      `executeInExecutor(${executor}) on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('executeInExecutor', args),
    );

    return v.parse(ExecutorCommandSchema, result);
  }

  /**
   * The pending device bind prompts, as the consent card's own list serves
   *  them — `listPendingConsents`, the RPC the chat calls to re-render cards
   *  (use-kinu.ts). A workspace's first call on a machine parks inside the
   *  device hub until one of these is answered, so a caller that needs the
   *  call's result must answer the card rather than out-wait it.
   */
  async pendingConsents(): Promise<readonly Pick<PendingDeviceConsent, 'consentId' | 'deviceId' | 'method' | 'command'>[]> {
    const rows = await this.boundary(
      `listPendingConsents on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listPendingConsents', []),
    );

    return v.parse(PendingConsentsSchema, rows);
  }

  /**
   * Answer one device consent card — `resolveDeviceConsent`, the RPC the
   * card's own button calls. The decision is the product's vocabulary:
   * `once` unblocks only the parked call, `always` writes the
   * (workspace, device) binding, `deny` refuses it.
   */
  async resolveConsent(
    consentId: string, decision: 'once' | 'always' | 'deny',
  ): Promise<{ ok: boolean }> {
    const answer = await this.boundary(
      `resolveDeviceConsent on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('resolveDeviceConsent', [consentId, decision]),
    );

    return v.parse(ResolveConsentSchema, answer);
  }

  /**
   * The needs-you queue, as the Work tab reads it.
   *
   * `listDeferredApprovals` answers the STILL-PARKED rows and nothing else, so
   * a row's absence here after a decision is the decision landing rather than a
   * projection this harness maintains. That is what makes the queue's own
   * clearing checkable over the wire instead of only in the component.
   */
  async parkedCommands(): Promise<readonly PublicDeferredApproval[]> {
    const rows = await this.boundary(
      `listDeferredApprovals on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listDeferredApprovals', []),
    );

    return v.parse(DeferredApprovalsSchema, rows);
  }

  /**
   * Decide parked commands — the RPC the Approve button is bound to
   * (components/surfaces/WorkTab.tsx:306), with the same argument shape: the
   * ids the owner had selected, and one answer for all of them.
   *
   * Deliberately the same call the click makes rather than a REST equivalent:
   * the two halves of the approve case have to be a statement about ONE
   * mechanism, or the UI half could pass over a queue the API half never
   * cleared.
   */
  async decideParkedCommands(
    ids: readonly string[], decision: 'approved' | 'denied' | 'always',
  ): Promise<readonly string[]> {
    const answer = await this.boundary(
      `decideDeferredApprovals on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('decideDeferredApprovals', [[...ids], decision]),
    );

    return v.parse(DecideApprovalsSchema, answer).decided;
  }

  /** The tool calls running in every stream this session hears, by id: its own turns', the product's own, and the
   *  rooms of the helpers it listens to. */
  toolCallsInFlight(): string[] {
    return [...this.hearing].flatMap((streams) => streams.running());
  }

  /** How many live frames this session has heard, in every room it hears: a count that moved is the workspace working. */
  heard(): number {
    return this.framesHeard;
  }

  /** How often the workspace has said one of `reads` moved, each socket this session opened counting as all of them. */
  readsMoved(reads: readonly string[]): number {
    return reads.reduce((sum, read) => sum + (this.moved.get(read) ?? 0), this.socketsOpened);
  }

  /** Aborts at the workspace's next `reads_changed` frame, or the next socket this session opens on its room. */
  get readsMoving(): AbortSignal {
    return this.moving.signal;
  }

  private readsChanged(reads: readonly string[]): void {
    for (const read of reads) this.moved.set(read, (this.moved.get(read) ?? 0) + 1);
    this.moveOn();
  }

  private moveOn(): void {
    this.moving.abort();
    this.moving = new AbortController();
  }

  /**
   * Listen to exactly these helpers' rooms, by name or path. A helper's turn streams to its own window alone (`broadcastToActor`), so it
   * is heard only on a socket opened on its path, as its window opens one. A room opened mid-turn is replayed the turn, as every room
   * is, so a call that started before it opened is known to run.
   */
  listen(helpers: readonly string[]): void {
    for (const [name, room] of this.rooms) {
      if (helpers.includes(name)) continue;
      this.rooms.delete(name);
      this.hearing.delete(room.heard);
      room.socket.close();
    }

    for (const name of helpers) {
      if (this.rooms.has(name) || Date.now() - (this.roomsClosedAt.get(name) ?? -Infinity) < ROOM_REDIAL_MS) continue;
      this.rooms.set(name, this.openRoom(name));
    }
  }

  private openRoom(name: string): HelperRoom {
    const socket = this.newSocket(hostedActorSocketPath(name));
    const heard = new HeardStreams();
    const acked = new Set<string>();

    this.hearing.add(heard);
    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = decodeFrame(event.data);

      // Told on connect and again on request, acked once as the SDK's hook acks it: until then the room keeps the turn's
      // live chunks from this socket.
      if (frame?.kind === 'resuming' && !acked.has(frame.id)) {
        acked.add(frame.id);
        socket.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: frame.id }));
      }

      // A head's broadcasts reach every socket, and the workspace's own hears them.
      if (frame?.kind !== 'response') return;
      const { live, chunk } = heard.hear(frame.frame.id, frame.frame);

      if (live) this.hearElsewhere(name, chunk?.type ?? 'done');
    });
    socket.addEventListener('close', () => {
      this.hearing.delete(heard);

      // A room this session let go of closed on purpose; one the deployment closed or refused waits out its redial.
      if (this.rooms.get(name)?.socket !== socket) return;
      this.rooms.delete(name);
      this.roomsClosedAt.set(name, Date.now());
    });

    return { socket, heard };
  }

  private hearElsewhere(room: string | null, type: string): void {
    this.framesHeard += 1;
    this.onHeard(room, type);
  }

  /**
   * The workspace's background jobs, as the Work tab's Supervise pane reads
   *   them — `listBackgroundJobs`, the `@callable` the pane's own rpc is bound
   *   to (pages/SupervisePage.tsx:240). This is how a harness asks what a
   *   detached tool call became: `shell`/`eval` calls that outrun the
   *   foreground window answer a `{jobId}` handle and settle out of turn, so
   *   their result is reachable only through this row — never in the run
   *   events of the prompt that issued them. `of`, a helper's name, reads
   *   that helper's own jobs (the RPC's `actor`); a helper dismissed since the
   *   roster was read has none.
   */
  async backgroundJobs(of?: string): Promise<readonly PublicBackgroundJob[]> {
    try {
      const answer = await this.boundary(
        `listBackgroundJobs${of === undefined ? '' : ` of ${of}`} on ${this.input.origin}/${this.workspace}`,
        () => this.rpc('listBackgroundJobs', of === undefined ? [50] : [50, of]),
      );

      return v.parse(BackgroundJobsSchema, answer);
    } catch (error) {
      if (of !== undefined && error instanceof DeploymentAnswer && error.message.includes('is not an agent of this workspace')) return [];
      throw error;
    }
  }

  /** The tools this workspace holds that the MODEL wrote, as the Tools pane
   *  lists them. The built-in half of `getToolDescriptions` is dropped at the
   *  boundary: a crafted-tool case asks about the crafted set. */
  async craftedTools(): Promise<readonly PublicCraftedTool[]> {
    const answer = await this.boundary(
      `getToolDescriptions on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getToolDescriptions', []),
    );

    return v.parse(ToolDescriptionsSchema, answer).crafted;
  }

  /** The agent's own learning setting, as Settings and `--no-auto-evolve` set it (`setEvolutionConfig`). */
  async setLearning(on: boolean): Promise<void> {
    await this.boundary(`setEvolutionConfig on ${this.input.origin}/${this.workspace}`, () => this.rpc('setEvolutionConfig', [{ learning: on }]));
  }

  /** A thumb on one answer, as the web pane gives it (`setTurnFeedback`). */
  async rate(messageId: string, feedback: 'positive' | 'negative'): Promise<void> {
    await this.boundary(`setTurnFeedback on ${this.input.origin}/${this.workspace}`, () => this.rpc('setTurnFeedback', [messageId, feedback]));
  }

  /** Satisfaction per day as the Quality tab reads it (`getQuality`): rated turns, by thumbs or the decision model. */
  async quality(days = 1): Promise<readonly QualityDay[]> {
    return v.parse(v.array(QualityDaySchema), await this.boundary(
      `getQuality on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getQuality', [days]),
    ));
  }

  /** The memory note displayed by the UI's memory pane. */
  async memoryContent(): Promise<string> {
    return v.parse(v.string(), await this.boundary(
      `getMemoryContent on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getMemoryContent', []),
    ));
  }

  /** The same public fact listing the workspace exposes to its owner. */
  async memoryFacts(): Promise<readonly { key: string; value: JsonValue }[]> {
    return v.parse(v.array(v.object({ key: v.string(), value: JsonValueSchema })), await this.boundary(
      `getFacts on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getFacts', []),
    ));
  }

  /** Every agent's plans and tasks, retired agents' included, as the Work tab reads them (`listWorkspaceWork`). */
  async workspaceWork(): Promise<WorkBoard> {
    return v.parse(WorkBoardSchema, await this.boundary(
      `listWorkspaceWork on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listWorkspaceWork', []),
    ));
  }

  /** Every swarm the lead ran, newest first, as the Swarms pane pages them (`getExplorationCanvas`). */
  async swarmRuns(): Promise<PublicSwarmRun[]> {
    const runs: PublicSwarmRun[] = [];

    for (let cursor: { after: string } | undefined; ;) {
      const request: JsonValue = cursor === undefined ? {} : { cursor };

      const page = v.parse(SwarmPageSchema, await this.boundary(
        `getExplorationCanvas on ${this.input.origin}/${this.workspace}`,
        () => this.rpc('getExplorationCanvas', [request]),
      ));

      runs.push(...page.items);

      if (page.status === 'end') return runs;
      cursor = page.next;
    }
  }

  /** A subordinate's children, transcript, runs or events, as the Agents surface's inspector reads them
   *  (`inspectSubordinate`). */
  async inspect(request: SubordinateInspectionRequest): Promise<InspectionAnswer> {
    return v.parse(InspectionAnswerSchema, await this.boundary(
      `inspectSubordinate on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('inspectSubordinate', [v.parse(JsonValueSchema, request)]),
    ));
  }

  /** The agent-written tabs, including project loading failures. */
  async listSlates(): Promise<PublicSlateListing> {
    const answer = await this.boundary(
      'listSlates on ' + this.input.origin + '/' + this.workspace,
      () => this.rpc('listSlates', []),
    );

    return v.parse(SlateListingSchema, answer);
  }

  /** One slate operation through the socket RPC the slate tab drives. */
  async slateOp(operation: JsonValue): Promise<JsonValue> {
    return this.boundary(
      'slate on ' + this.input.origin + '/' + this.workspace,
      () => this.rpc('slate', [operation]),
    );
  }


  /** Read existing preview endpoints without starting the app under test. */
  async exposedPorts(executor: string): Promise<readonly { port: number; url: string }[]> {
    const answer = await this.boundary(
      'getExposedPorts(' + executor + ') on ' + this.input.origin + '/' + this.workspace,
      () => this.rpc('getExposedPorts', [executor]),
    );

    return v.parse(v.object({ ports: v.array(v.object({ port: v.number(), url: v.string() })) }), answer).ports;
  }

  /**
   * The delegation roster — `listSubordinates`, the RPC the Agents surface's
   * own card is bound to (`components/surfaces/AgentSurface.tsx:321`) and the
   * one the chat refreshes on every reconnect (`hooks/use-kinu.ts:1990`).
   *
   * Read rather than derived from the hire results: a `lifetime:'task'` row
   * retires itself when it answers, and "the row LEFT the roster" is a fact
   * only the roster holds — a hire result says who was hired, never who is
   * still employed.
   */
  async subordinates(): Promise<readonly PublicSubordinate[]> {
    const rows = await this.boundary(
      `listSubordinates on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listSubordinates', []),
    );

    return v.parse(SubordinateRosterSchema, rows);
  }

  /** Every agent of the workspace as the Agents panel lists it (`listWorkspaceAgents`, `hooks/use-kinu.ts`). */
  async agents(): Promise<readonly PublicAgent[]> {
    const rows = await this.boundary(
      `listWorkspaceAgents on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listWorkspaceAgents', []),
    );

    return v.parse(v.array(PanelAgentSchema), rows);
  }

  /** One folder of the workspace as the Files tab lists it. A folder that does not exist lists nothing; any other
   *  refusal is the build's answer. */
  async listFiles(dir: string): Promise<readonly PublicDirEntry[]> {
    const listing = v.parse(DirectorySchema, await this.boundary(
      `getExecutorFiles ${dir} on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getExecutorFiles', [WORKSPACE_EXECUTOR, dir]),
    ));

    if (listing.error === undefined) return listing.entries ?? [];

    if (/\bENOENT\b/.test(listing.error)) return [];

    throw new DeploymentAnswer(`could not list ${dir}: ${listing.error.slice(0, 200)}`, 500);
  }

  /** Resolve when a response chunk of `requestId` satisfies `accept` — a
   *  wait on the socket's own output, for a row that must act while a turn
   *  is inside its work (its first tool result has streamed). */
  awaitChunk(requestId: string, accept: (body: string) => boolean): Promise<void> {
    const settled = Promise.withResolvers<void>();
    const watchers = this.chunkWatchers.get(requestId) ?? [];
    watchers.push({ accept, resolve: settled.resolve });
    this.chunkWatchers.set(requestId, watchers);

    return settled.promise;
  }

  /**
   * Follow one run's ledger over the SSE route, from `since` (exclusive), as
   * a wait on the stream: each event as the route sends it, re-opened with
   * `Last-Event-ID` whenever the route closes the stream short of `run_end`
   * — its own five-minute wall, or the object it reads ending its activation
   * under it, which the route reports as an `error` message and closes. Ends
   * at `run_end`.
   */
  async *followRun(runId: string, since: number): AsyncGenerator<RunEvent> {
    let cursor = since;

    for (;;) {
      const response = await fetch(
        `${this.input.origin}/api/workspaces/${encodeURIComponent(this.workspace)}/runs/${encodeURIComponent(runId)}/stream`,
        { headers: { ...webHeaders(this.input.identity), 'Last-Event-ID': String(cursor) } },
      );

      if (!response.ok) throw new DeploymentAnswer(`follow run ${runId}: HTTP ${String(response.status)}`, response.status);

      if (response.body === null) throw new Error(`follow run ${runId}: the stream answered with no body`);

      for await (const message of sseMessages(response.body)) {
        if (message.event === 'error') break;
        const row = v.parse(LedgerRowSchema, JSON.parse(message.data));

        if (row.eventIndex <= cursor) continue;
        cursor = row.eventIndex;

        // Another build's row type, as `LedgerPageSchema` leaves out of a page.
        if (!RUN_EVENT_TYPES.has(row.type)) continue;
        const event = v.parse(RunEventSchema, row);

        yield event;

        if (event.type === 'run_end') return;
      }
    }
  }

  /**
   * Close the socket and nothing else: the product keeps running the turn
   * with no client connected, which is the state the `background-wake` row
   * measures. A turn submitted before this is abandoned here — its promise
   * never settles and the row reads the ledger instead — so nothing rejects
   * into a case that stopped listening on purpose. The ledger and history
   * reads are HTTP and need no socket; `connect()` opens a new one.
   */
  disconnect(): void {
    this.turns.clear();
    this.absorbers.clear();
    this.listen([]);
    this.socket?.close();
    this.socket = null;
  }

  /**
   * EVAL-ONLY: end the workspace object's activation on the deployed build,
   * through the route only the eval-service identity may call
   * (`cf-backend/src/eval/abort-route.ts`). The next request over the same
   * storage is a fresh activation; what it re-drives is what the ledger shows.
   */
  async abortActivation(): Promise<void> {
    await this.boundary(`POST ${this.input.origin}/api/workspaces/${this.workspace}/eval/abort`, async () => {
      const response = await fetch(
        `${this.input.origin}/api/workspaces/${encodeURIComponent(this.workspace)}/eval/abort`,
        { method: 'POST', headers: webHeaders(this.input.identity) },
      );

      const body = await readJson(response, `abort the activation of ${this.workspace}`);
      v.parse(v.object({ aborted: v.literal(true) }), body);
    });
  }

  /** The durable transcript the web pane is seeded from. */
  /** The one read the web app makes on open, `getWorkspaceSnapshot`, reduced to
   *  what a first-run case asserts: that it answered, that it counts the turns
   *  the transcript holds, and that it names the model the next turn runs. */
  async snapshot(): Promise<PublicWorkspaceSnapshot> {
    const answer = await this.boundary(
      `getWorkspaceSnapshot on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getWorkspaceSnapshot', []),
    );

    return v.parse(WorkspaceSnapshotSchema, answer).status;
  }

  async history(): Promise<readonly PublicMessage[]> {
    const rows = await this.boundary(
      `GET ${this.input.origin}/agents/.../get-messages`,
      async () => {
        const response = await fetch(
          `${this.input.origin}/agents/${ORCHESTRATOR_AGENT_SLUG}/`
          + `${encodeURIComponent(this.workspace)}/get-messages`,
          { headers: webHeaders(this.input.identity) },
        );

        return v.parse(HistorySchema, await readJson(response, 'read the chat history'));
      },
    );

    return rows.map((row) => {
      const spliceStep = v.safeParse(v.number(), row.metadata?.[STEER_STEP_METADATA_KEY]);

      const message: PublicMessage = {
        ...(row.id !== undefined && { id: row.id }), role: row.role, text: rowText({ role: row.role, parts: row.parts ?? [] }),
      };

      // SAFETY: `v.number()` above already proved the metadata value is a
      // number — the splice step is a field the row either carries or lacks.
      if (spliceStep.success) return { ...message, landedAtStep: spliceStep.output };

      return message;
    });
  }

  /**
   * The whole run-event log, oldest first, over the public routes.
   *
   * TWO WALKS, not one read. The run list is cursored and the events read is
   * closed at 500 rows, so both halves page: a single call per run understates a
   * multi-turn episode's own totals, which is the truncated-denominator defect
   * the local walk exists for. Parsed through `RunEventSchema` — core's
   * canonical union — so a field the deployment adds is a parse failure here
   * rather than a silently dropped fact.
   */
  async runEvents(): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];

    for (const runId of await this.runIds()) {
      const known = this.ledger.get(runId) ?? [];
      const read = [...known, ...await this.runEventsOf(runId, known.reduce((next, event) => Math.max(next, event.eventIndex + 1), 0))];

      this.ledger.set(runId, read);
      events.push(...read);
    }

    events.sort(compareRunEventOrder);

    return events;
  }

  /** Main's already-read ledger and every retained descendant's requests, through the public inspector's pages. */
  async actorLedgers(rootEvents: readonly RunEvent[]): Promise<ActorLedger[]> {
    const ledgers: ActorLedger[] = [{ actor: 'main', events: rootEvents }];

    const visit = async (path: string[], actor?: string): Promise<void> => {
      for (let cursor: { after: string } | undefined; ;) {
        const request: SubordinateInspectionRequest = { path, view: 'children', page: { limit: RUN_PAGE } };

        if (actor !== undefined) request.actor = actor;

        if (cursor !== undefined) request.page.cursor = cursor;

        const children = await this.inspect(request);

        if (children.view !== 'children') throw new Error(`the public inspector could not list children of ${path.join('/')}`);

        await Promise.all(children.page.items.map(async (child) => {
          if (child.actorReference === null) return;

          const childPath = [...path, child.name];
          const childActor = child.actorReference.actorId;
          const events = await this.actorStepEvents(childPath, childActor);

          ledgers.push({ actor: childActor, events });
          await visit(childPath, childActor);
        }));

        if (children.page.status === 'end') return;
        cursor = children.page.next;
      }
    };

    await visit([]);

    return ledgers;
  }

  private async actorStepEvents(path: string[], actor: string): Promise<RunEvent[]> {
    const events: RunEvent[] = [];

    for (let cursor: { after: string } | undefined; ;) {
      const request: SubordinateInspectionRequest = { path, actor, view: 'runs', page: { limit: RUN_PAGE } };

      if (cursor !== undefined) request.page.cursor = cursor;

      const runs = await this.inspect(request);

      if (runs.view !== 'runs') throw new Error(`the public inspector could not read runs of ${path.join('/')}`);

      for (const run of runs.page.items) await this.appendActorSteps(events, path, actor, run.runId);

      if (runs.page.status === 'end') return events;
      cursor = runs.page.next;
    }
  }

  private async appendActorSteps(events: RunEvent[], path: string[], actor: string, runId: string): Promise<void> {
    for (let since = 0; ;) {
      const page = await this.inspect({ path, actor, view: 'events', runId, query: { since, limit: EVENT_PAGE } });

      if (page.view !== 'events') throw new Error(`the public inspector could not read requests of ${path.join('/')}/${runId}`);

      for (const event of page.page.items) if (event.type === 'step_finish') events.push(event);

      if (page.page.status === 'end') return;
      since = page.page.next;
    }
  }

  /**
   * One file as the FILES TAB reads it — `readExecutorFile`, the RPC
   * `FileViewer.tsx:67` is bound to, which is a bounded PREVIEW off the plane's
   * ranged read rather than the whole-file download `readFile` above streams.
   *
   * The two are different surfaces and only this one carries the origin
   * session's range reader, which is where a hosted read once answered EIO with
   * the Workers runtime's own sentence about code generation. A case that read
   * the download route instead would be green over that defect, so the pane's
   * own call is the one that has to be made.
   *
   * The answer is returned WHOLE — `{content}` or `{error}` — because which one
   * it is, and what the error says, is the finding.
   */
  async viewFile(executor: string, path: string): Promise<PublicViewedFile> {
    const answer = await this.boundary(
      `readExecutorFile(${executor}) on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('readExecutorFile', [executor, path]),
    );

    return v.parse(ViewedFileSchema, answer);
  }

  /** What this workspace spent, from the deployment's own read model — the same
   *  `getActivitySnapshot().spend` the Activity pane draws and the operator arm
   *  meters, so there is one definition of what a workspace spent. */
  async spend(): Promise<WorkspaceSpend> {
    const snapshot = await this.activity();

    return v.parse(ActivitySpendSchema, snapshot).spend;
  }

  /** Raw public Activity evidence, including prompt-prefix telemetry. */
  activity(): Promise<JsonValue> {
    return this.boundary(`getActivitySnapshot on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getActivitySnapshot', []));
  }

  /** One file off the workspace plane, through the route the web file manager
   *  reads. */
  readFile(path: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    return this.boundary(`GET files ${path}`, async () => {
      const response = await fetch(this.filesUrl(path), { headers: webHeaders(this.input.identity) });
      const text = await response.text();

      if (response.status === 404 && options.allowMissing) return '';

      if (!response.ok) {
        throw new DeploymentAnswer(`could not read ${path} over the files route: ${String(response.status)} `
          + `${response.statusText} — ${text.slice(0, 200)}`, response.status);
      }

      return text;
    });
  }

  /** One file's bytes off the same route: what a trial leaves behind is kept
   *  as the workspace held it, text or not. */
  readBytes(path: string): Promise<Uint8Array> {
    return this.boundary(`GET files ${path}`, async () => {
      const response = await fetch(this.filesUrl(path), { headers: webHeaders(this.input.identity) });

      if (!response.ok) {
        throw new DeploymentAnswer(`could not read ${path} over the files route: ${String(response.status)} `
          + `${response.statusText} — ${(await response.text()).slice(0, 200)}`, response.status);
      }

      return new Uint8Array(await response.arrayBuffer());
    });
  }

  /** Seed one file through the same route, so a case's inputs arrive on the
   *  plane the agent's own tools read. */
  writeFile(path: string, content: string | Uint8Array<ArrayBuffer>): Promise<void> {
    return this.boundary(`PUT files ${path}`, async () => {
      const response = await fetch(this.filesUrl(path), {
        method: 'PUT',
        headers: { ...webHeaders(this.input.identity), 'content-type': 'application/octet-stream' },
        body: content,
      });

      if (!response.ok) {
        throw new DeploymentAnswer(`could not write ${path} over the files route: ${String(response.status)} `
          + `${response.statusText} — ${(await response.text()).slice(0, 200)}`, response.status);
      }
    });
  }

  /**
   * Delete the workspace, then close the socket.
   *
   * In that order, and for the reason the operator target states: closing first
   * would leave the deletion to a client that is no longer connected, and a run
   * that threw must not leave a row on the account. The DELETE is an infra
   * boundary like every other network call — a teardown that fails is the
   * deployment failing, not the agent.
   */
  async teardown(): Promise<void> {
    this.stopBeat();

    try {
      await deleteWorkspace(this.input.origin, this.input.identity, this.workspace);
    } finally {
      this.failInFlight('the session was torn down');
      this.listen([]);
      this.socket?.close();
      this.socket = null;
    }
  }

  /** Every run id the workspace has recorded, newest activity first, over the paged `/runs` route. */
  async runIds(): Promise<readonly string[]> {
    const ids: string[] = [];
    let after: string | null = null;

    for (;;) {
      const page: v.InferOutput<typeof RunPageSchema> = await this.getJson(
        `/api/workspaces/${encodeURIComponent(this.workspace)}/runs`
        + `?limit=${String(RUN_PAGE)}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
        RunPageSchema,
        'list the workspace runs',
      );

      ids.push(...page.items.map((run) => run.runId));

      if (page.status === 'end') return ids;
      after = page.next.after;
    }
  }

  /** One run's events from `since` (inclusive): a poll that reads only what the run added. */
  async runEventsOf(runId: string, from = 0): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];
    let since = from;

    for (;;) {
      const page = await this.getJson(
        `/api/workspaces/${encodeURIComponent(this.workspace)}/runs/`
        + `${encodeURIComponent(runId)}/events?since=${String(since)}&limit=${String(EVENT_PAGE)}`,
        LedgerPageSchema,
        `read the events of run ${runId}`,
      );

      if (page.rows === 0) break;
      events.push(...page.events);
      // The route's `since` is an INCLUSIVE lower bound (recorder.ts:169-171),
      // so the next read starts one past the highest index this one returned.
      // Advancing by `page.length` instead would re-read a run whose indices
      // are not contiguous, and stall on one whose page ended mid-index. Both
      // count the rows the route sent, the ones left out included.
      const highest = Math.max(page.highest, since);

      if (page.rows < EVENT_PAGE) break;
      since = highest + 1;
    }

    return events;
  }

  private getJson<T>(path: string, schema: v.GenericSchema<unknown, T>, doing: string): Promise<T> {
    return this.boundary(`GET ${this.input.origin}${path.split('?')[0] ?? path}`, async () => {
      const response = await fetch(`${this.input.origin}${path}`, {
        headers: webHeaders(this.input.identity),
      });

      return v.parse(schema, await readJson(response, doing));
    });
  }

  private filesUrl(path: string): string {
    return `${this.input.origin}/api/workspaces/${encodeURIComponent(this.workspace)}/files`
      + `?executor=${WORKSPACE_EXECUTOR}&path=${encodeURIComponent(path)}`;
  }

  private rpc(method: string, args: readonly JsonValue[]): Promise<JsonValue> {
    const requestId = this.mintId('rpc');

    return new Promise<JsonValue>((resolve, reject) => {
      this.rpcs.set(requestId, { resolve, reject });
      this.send(encodeRpcRequest({ requestId, method, args })).catch(reject);
    });
  }

  /** The one send path: redial a socket the platform closed, as the browser's PartySocket does, then
   *  send on an OPEN socket only. */
  private async send(frame: string): Promise<void> {
    await this.connect();
    const socket = this.socket;

    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error(`the workspace socket is not open (readyState ${String(socket?.readyState ?? 'none')}); `
        + 'this session cannot send');
    }

    socket.send(frame);
  }

  private mintId(kind: string): string {
    this.nextId += 1;

    return `${kind}-${String(this.nextId)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private handleFrame(data: SocketPayload, heard: HeardStreams): void {
    const frame = decodeFrame(data);

    if (frame === null) return;

    if (frame.kind === 'rpc') {
      const pending = this.rpcs.get(frame.id);

      if (!pending) return;
      this.rpcs.delete(frame.id);

      if (frame.error === null) pending.resolve(frame.result);
      else pending.reject(new DeploymentAnswer(frame.error));

      return;
    }

    if (frame.kind === 'steer') {
      const pending = this.steerLandings.get(frame.steerId);

      if (!pending || frame.status === 'queued') return;
      this.steerLandings.delete(frame.steerId);

      if (frame.status === 'returned') pending.reject(new DeploymentAnswer('the turn was stopped before it read the steer'));
      else pending.resolve(frame.status === 'landed' ? 'mid-turn' : 'turn');

      return;
    }

    if (frame.kind === 'resuming') {
      // Acked as the SDK's hook acks it: until then the DO keeps the stream's live chunks from this socket, and they are
      // the workspace working. A turn of this session's own that the socket dropped is not followed there (`survive`).
      this.socket?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: frame.id }));

      return;
    }

    if (frame.kind === 'reads') {
      this.readsChanged(frame.reads);

      return;
    }

    if (frame.kind === 'other') {
      if (LIVE_OUTPUT_FRAMES.has(frame.type)) this.hearElsewhere(null, frame.type);

      return;
    }

    if (frame.kind === 'response') this.handleResponse(frame.frame, heard);
  }

  /** One frame of a stream in the workspace's room: heard whoever opened the stream, recorded when it is a turn of ours. */
  private handleResponse(frame: PublicResponseFrame, heard: HeardStreams): void {
    const { live, chunk } = heard.hear(frame.id, frame);
    const requestId = frame.id;
    const turn = this.turns.get(requestId);

    // A stream nobody here submitted: a turn the product opened on its own. Heard, but its bodies
    // belong to no request of ours.
    if (!turn) {
      if (live) this.hearElsewhere(null, chunk?.type ?? 'done');

      return;
    }

    if (live) this.framesHeard += 1;

    if (frame.done === true && frame.landed === 'mid-turn') {
      const landedAt = new Date().toISOString();

      this.absorbers.set(requestId, (events) => absorbingRunId(events, landedAt));
    }

    const body = frame.body;

    if (body !== undefined) {
      if (chunk !== null) this.onChunk(chunk.type);

      const watchers = this.chunkWatchers.get(requestId) ?? [];

      const remaining = watchers.filter((watcher) => {
        if (!watcher.accept(body)) return true;
        watcher.resolve();

        return false;
      });

      if (remaining.length > 0) this.chunkWatchers.set(requestId, remaining);
      else this.chunkWatchers.delete(requestId);
    }

    if (frame.done === true) this.onChunk('done');
    turn.recorder.apply(frame);
    const done = turn.recorder.settled();

    if (done === null) return;
    this.turns.delete(requestId);
    turn.resolve(done);
  }

  /**
   * A dropped socket, survived as the browser survives it: rpcs in flight are lost with it and fail now, but a turn is
   * durable up there, so each is asked how it ended (`awaitSend`, again on each redial) and answered with what its turn
   * recorded. A turn that cannot be asked fails under the infrastructure marker, not as the agent's.
   */
  private async survive(reason: string): Promise<void> {
    this.failRequests(reason);
    const turns = [...this.turns];

    this.turns.clear();
    await Promise.all(turns.map(async ([requestId, turn]) => {
      const [asked] = await Promise.allSettled([this.reacquire(requestId, turn)]);

      if (asked.status === 'rejected') {
        turn.reject(new Error(`${INFRA_FAILURE_MARKER} — ${reason}, and how its turn ended could not be read: ${renderThrownChain({ cause: asked.reason })}`));
      }
    }));
  }

  private async reacquire(requestId: string, turn: OpenTurn): Promise<void> {
    const state = await this.endOf(requestId);

    if (state.status !== 'settled') throw new Error('no turn took the message: it was handed back or refused before one read it');

    if (state.landed === 'mid-turn') {
      this.absorbers.set(requestId, (events) => events.find((event) => event.type === 'run_start' && event.turn?.turnId === state.turnId)?.runId ?? null);
      turn.resolve({ landed: 'mid-turn' });

      return;
    }

    const page = async (request: PositionPageRequest) => v.parse(HistoryPageSchema, await this.rpc('getChatHistoryPage', [request.cursor === undefined ? {} : { cursor: { before: request.cursor.before } }]));

    turn.recorder.finish(await recordedAnswer(page, state.turnId), state.outcome !== 'completed' && state.outcome !== 'aborted');
    const done = turn.recorder.settled();

    if (done !== null) turn.resolve(done);
  }

  /** Asked again on each redial while sockets drop; a refusal, or a redial that fails, ends the asking. */
  private async endOf(requestId: string): Promise<SendState> {
    for (;;) {
      await this.connect();
      const [asked] = await Promise.allSettled([this.rpc('awaitSend', [requestId])]);

      if (asked.status === 'fulfilled') return v.parse(SendStateSchema, asked.value);

      if (asked.reason instanceof DeploymentAnswer) throw asked.reason;
    }
  }

  /** Fail what a dropped socket cannot carry over: rpc replies, as the deployment's failure, not the
   *  caller's. Turns survive it, and the next rpc redials. */
  private failRequests(reason: string): void {
    const rpcs = [...this.rpcs.values()];
    this.rpcs.clear();

    for (const rpc of rpcs) rpc.reject(new Error(`${INFRA_FAILURE_MARKER} — ${reason}`));
  }

  /** Reject what the dead socket was carrying. A turn is durable up there and
   *  its answer lands in the transcript either way, but this process cannot
   *  report it — and an eval that hangs on a closed socket reports nothing at
   *  all, which is worse than a named failure. */
  private failInFlight(reason: string): void {
    const turns = [...this.turns.values()];
    this.turns.clear();
    this.absorbers.clear();
    const rpcs = [...this.rpcs.values()];
    this.rpcs.clear();

    for (const turn of turns) turn.reject(new Error(reason));

    for (const rpc of rpcs) rpc.reject(new Error(reason));
  }
}
