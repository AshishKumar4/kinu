/**
 * THE PUBLIC-API SESSION: one reusable session over the surfaces the WEB CLIENT
 * speaks, against a DEPLOYED workspace.
 *
 * WHY THIS EXISTS BESIDE `target-cloud.ts`, which already reaches staging. That
 * target drives the OPERATOR plane: `CloudAgentClient` over a connect ticket,
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
 *   steer       the socket RPC `steerTurn` (actor-agent.ts:4580), which is
 *               exactly what the composer calls mid-turn (hooks/use-kinu.ts:1229)
 *               and answers `'mid-turn'` or `'queued'` — the DO's own statement
 *               about which of the two happened.
 *   history     `GET /agents/<slug>/<name>/get-messages`, the SDK's transport
 *               endpoint the pane is seeded from (agent-routing.ts:24-40).
 *   events      `GET /api/workspaces/<name>/runs` then
 *               `…/runs/<runId>/events?since=&limit=` (run-events-routes.ts:82,
 *               :104). WALKED, both ways: runs are cursored and the events read
 *               is closed at `RUN_EVENT_LIMIT_MAX` = 500 rows
 *               (core/src/events/recorder.ts:203, :220), so a multi-turn episode
 *               read in one call is a truncated denominator — the exact defect
 *               `walkRunEvents` exists for on the local target.
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
 * `DEV_IDENTITY_SECRET` in `x-kinu-dev-identity` (:124, :162-177). The eval
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
 * response frames, RPC replies and the two stream-resume frames, and ignores the
 * rest. One decoder for the expensive half, so a chunk type the product learns
 * cannot mean two things.
 */
import * as v from 'valibot';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';

import {
  JsonValueSchema, ORCHESTRATOR_AGENT_SLUG, RunEventSchema, initRunEventTables,
  parseJsonValue,
  type GadgetSummary, type JsonValue, type LLMProviderConfig, type RunEvent, type WorkspaceSpend,
} from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs/index';
import { CloudTurnStream } from '../../packages/cli/src/cloud-turn-stream';
import { createUserUiMessage, type AgentTurnResult } from '../../packages/cli/src/agent-client';
import { ActivitySpendSchema } from '../../packages/cli/src/cloud-api';
import {
  createTestSql, evalNameSlug, evalTargetVerdict, evalWorkspaceName, infraBoundary,
  resolveEvalBackend, scoreTrajectory, workerSession,
  EVAL_BACKEND_ENV,
  type EvalScoreRow,
} from '@kinu.run/test-utils';
import { resolveEvalTarget } from './target';

/**
 * The variable that carries the browser plane's authority to this harness.
 *
 * Named separately from `KINU_EVAL_TOKEN` because it is a different credential
 * for a different plane, and conflating them would let a run holding only the
 * CLI bearer believe it could reach `/api/user/*`. Its VALUE is the
 * deployment's `DEV_IDENTITY_SECRET` (scripts/infra-manifest.ts:586) — the whole
 * authority for staging's synthetic identity — which is why the remedy below
 * names how it was installed rather than inventing a second source for it.
 */
export const PUBLIC_IDENTITY_ENV = 'KINU_EVAL_WEB_IDENTITY';

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

/**
 * The WebSocket constructor as BUN implements it, whose second argument may be
 * the standard `protocols` OR an options object carrying per-handshake
 * `headers` (bun-types: `Bun.WebSocketOptions`, bun.d.ts:4283).
 *
 * Spelled here because the AMBIENT global in a project that also loads
 * `@types/node` is undici's, and undici's constructor takes protocols only
 * (@types/node/web-globals/fetch.d.ts:66) — measured: `new WebSocket(url,
 * {headers})` fails to compile under `tests/tsconfig.json` with
 * `'headers' does not exist in type 'string[]'`. Headers are not a convenience
 * here: they are the ONLY way to authenticate this upgrade as the web plane,
 * since the query-parameter path is the CLI ticket's (server.ts:198) and a
 * cookie is a header too. The eval tier runs this arm under `bun --bun`
 * (vitest.evals.config.ts), so the implementation behind the global is Bun's.
 */
type BunWebSocketConstructor = new (
  url: string,
  options?: string | readonly string[] | { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

// SAFETY: bun-types declares this exact options object for the same runtime
// constructor (`Bun.WebSocketOptions`), and the type above only WIDENS the
// ambient signature — it contains `string | string[]` verbatim and adds that
// object, which is why the compiler accepts a single assertion here rather than
// demanding a chained one. The value is the global constructor itself.
const HEADER_WEBSOCKET = WebSocket as BunWebSocketConstructor;

/** How this session proves it may act as the deployment's web identity. */
export type PublicWebIdentity =
  /** A loopback deployment: the machine is the boundary, no header needed. */
  | { readonly kind: 'loopback' }
  /** A remote deployment: the synthetic identity's secret, sent per request. */
  | { readonly kind: 'secret'; readonly secret: string };

export type PublicWebIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: PublicWebIdentity }
  /** No authority for the browser plane. `remedy` names the command and the
   *  variable that would make the run happen — never "unavailable". */
  | { readonly kind: 'absent'; readonly remedy: string };

/**
 * The browser-plane identity for `origin`, or the remedy that would supply one.
 *
 * Pure over its inputs so the gating is testable credential-free: the wiring
 * suite drives it with a staging origin and an empty environment and asserts the
 * remedy names both halves.
 */
export function resolveWebIdentity(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): PublicWebIdentityResolution {
  const secret = env[PUBLIC_IDENTITY_ENV]?.trim();
  if (secret) return { kind: 'ready', identity: { kind: 'secret', secret } };
  if (LOOPBACK_HOSTS.includes(new URL(origin).hostname)) {
    return { kind: 'ready', identity: { kind: 'loopback' } };
  }
  return {
    kind: 'absent',
    remedy: `${origin} needs the browser plane's own authority and this run has none. The eval `
      + 'tier\'s KINU_EVAL_TOKEN is a CLI bearer, and `handleCliRequest` answers nothing outside '
      + '`/api/cli` (cli/routes.ts:87), so it cannot reach `/api/user/workspaces`, '
      + '`/api/workspaces/:name/runs` or the files route this session reads. Export the '
      + `deployment's synthetic-identity secret as ${PUBLIC_IDENTITY_ENV} — the value installed `
      + 'with `wrangler secret put DEV_IDENTITY_SECRET --env staging`, which is what '
      + '`authenticateRequest` accepts in `x-kinu-dev-identity` (auth/session.ts:162-177). '
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
 *   2. THE TIER'S OWN RESOLUTION. `resolveEvalTarget` is reused rather than
 *      re-derived: it applies `KINU_EVAL_LIVE`, prints the one banner, and
 *      throws on a refusal (a gateway credential under `=cloud` has no
 *      deployment to create against). A second resolution would be a second
 *      answer to "where did this run go".
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
        + `=${backend.backend} has nothing for it to drive. Run \`bun run evals:cloud\` `
        + `(${EVAL_BACKEND_ENV}=cloud), which is also the only invocation that may create `
        + 'workspaces on a shared deployment.',
    };
  }

  const plan = resolveEvalTarget(suite, model);
  if (plan === null) {
    return {
      kind: 'unavailable',
      remedy: `${suite} resolved no live target — \`liveModelTarget\` printed which variable is `
        + 'missing on the line above this one. The eval tier supplies them: `bun run evals:cloud`.',
    };
  }
  const session = workerSession(plan.llm);
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
        + `· model ${plan.llm.model}`,
      llm: plan.llm,
      origin: verdict.origin,
      identity,
      open: (request) => openPublicSession({
        origin: verdict.origin,
        identity,
        workspace: evalWorkspaceName(`${suiteSlug}-${request.subject}`),
        purpose: request.purpose,
        llm: plan.llm,
      }),
    },
  };
}

// ── The frames, as data ─────────────────────────────────────────────

/**
 * The frame that starts a turn, exactly as the web client's transport puts it on
 * the socket: a request id, and an `init` whose body is the AI-SDK chat request.
 *
 * `trigger: 'submit-message'` is the SDK's own value for a user send, and the
 * message is built by `createUserUiMessage` — the shipped constructor, so the
 * UIMessage shape cannot drift from what the DO parses.
 *
 * NO `oneShot`. That flag makes each prompt an `independent_task`
 * (actor-agent.ts:470-478), which is the CLI's one-shot contract and the exact
 * opposite of what this harness measures: a MULTI-TURN trajectory, where turn
 * two is a follow-up on turn one and the completion gate may grade the previous
 * answer. The web chat sends no such flag either, which is the point.
 */
export function encodeChatRequest(input: {
  readonly requestId: string;
  readonly text: string;
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
    id: input.requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [createUserUiMessage(input.text)],
        trigger: 'submit-message',
      }),
    },
  });
}

/** One `{type:'rpc', id, method, args}` frame — the shape the agents-SDK client
 *  sends for a callable method, which is what `useKinu`'s `rpc()` wrapper is
 *  bound to (hooks/use-kinu.ts:639-641). The type word is a literal because the
 *  SDK exports no constant for it. */
export function encodeRpcRequest(input: {
  readonly requestId: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
}): string {
  return JSON.stringify({
    type: 'rpc', id: input.requestId, method: input.method, args: [...input.args],
  });
}

/** A turn frame, narrowed to the fields a turn is accumulated from. */
export interface PublicResponseFrame {
  readonly id: string;
  readonly body?: string;
  readonly done?: boolean;
  readonly error?: boolean;
  /** Set by the DO on every frame of a stream it REPLAYS. Carried because the
   *  accumulator needs it to stay idempotent across a resume. */
  readonly replay?: boolean;
}

/** What one decoded socket frame is. `other` is not an error: the DO fans
 *  broadcasts (branch status, head activity, mcts progress) down the same
 *  socket, and a session that treated an unread broadcast as a fault would fail
 *  on the product working. */
export type PublicFrame =
  | { readonly kind: 'response'; readonly frame: PublicResponseFrame }
  | {
      readonly kind: 'rpc';
      readonly id: string;
      readonly result: JsonValue;
      /** The reply's failure text, or null when it succeeded. */
      readonly error: string | null;
    }
  /** The DO announcing it holds a resumable stream for `id`, or that it holds
   *  none. Both are answered rather than ignored, because a socket that dropped
   *  mid-turn is the one case where the turn is still running up there. */
  | { readonly kind: 'resuming'; readonly id: string }
  | { readonly kind: 'resume-none' }
  | { readonly kind: 'other'; readonly type: string };

const FrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  /** The DO sets `error: true` on a terminal failure frame and carries the text
   *  in `body`; an RPC reply's `error` is the failure itself, which may be a
   *  string or a structured value. One field, two producers, so both shapes are
   *  admitted here and each branch below reads the one it means. */
  error: v.optional(v.union([v.boolean(), JsonValueSchema])),
  replay: v.optional(v.boolean()),
  success: v.optional(v.boolean()),
  result: v.optional(JsonValueSchema),
});

/**
 * Decode one frame off the wire.
 *
 * Returns null for anything that is not a JSON object with a `type` — a frame
 * this session drops rather than a failure, exactly as the shipped client drops
 * unparseable text (cloud-agent-client.ts:1063-1080). Everything it DOES
 * recognise is narrowed field by field, so a frame that grew a field is read the
 * same way and a frame that lost one is a decode miss rather than an
 * `undefined` threaded into a turn.
 */
export function decodeFrame(data: SocketPayload): PublicFrame | null {
  const parsed = decodeSocketJson(data);
  if (parsed === undefined) return null;
  const frame = v.safeParse(FrameSchema, parsed);
  if (!frame.success) return null;
  const { type, id } = frame.output;
  if (type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) {
    if (id === undefined) return { kind: 'other', type };
    return {
      kind: 'response',
      frame: {
        id,
        body: frame.output.body,
        done: frame.output.done,
        error: frame.output.error === true,
        replay: frame.output.replay,
      },
    };
  }
  // A REPLY, told from a request by the field the producer always sets. The
  // agents SDK answers every callable with `success: true|false`
  // (agents/dist/index.js:912-926) and a request carries `method`/`args` and no
  // `success` at all (dist/client.js:242-247) — so keying on `success` is what
  // stops this session reading its OWN outbound frame, or an echo of one, as a
  // refused call.
  if (type === 'rpc' && id !== undefined && frame.output.success !== undefined) {
    const detail = v.safeParse(v.string(), frame.output.error);
    return {
      kind: 'rpc',
      id,
      result: frame.output.result ?? null,
      error: frame.output.success
        ? null
        : (detail.success ? detail.output : 'the workspace RPC failed'),
    };
  }
  if (type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && id !== undefined) {
    return { kind: 'resuming', id };
  }
  if (type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE) return { kind: 'resume-none' };
  return { kind: 'other', type };
}

/** What a socket frame arrives as: text, or the bytes a binary frame carried.
 *  Both spellings are handled for the reason the shipped client handles them
 *  (cloud-agent-client.ts:1063-1074) — the transport chooses, not the caller. */
export type SocketPayload = string | ArrayBuffer | Uint8Array;

/**
 * One frame's JSON, or `undefined` when the payload is not JSON at all.
 *
 * `tolerate` with the `malformed-input` class, which is the shipped rule for
 * this exact boundary: a frame this session cannot read is a frame it DROPS, and
 * anything that is not a parse failure still throws. A bare `catch` here would
 * turn a real fault into the same value an unreadable broadcast produces.
 */
function decodeSocketJson(data: SocketPayload): JsonValue | undefined {
  const text = v.safeParse(v.string(), data);
  const bytes = v.safeParse(v.instance(Uint8Array), data);
  const buffer = v.safeParse(v.instance(ArrayBuffer), data);
  const decoded = text.success
    ? text.output
    : bytes.success
      ? new TextDecoder().decode(bytes.output)
      : buffer.success ? new TextDecoder().decode(buffer.output) : null;
  if (decoded === null) return undefined;
  return tolerate(() => parseJsonValue(decoded), 'malformed-input');
}

/** What one turn produced. The SHIPPED result type, because the accumulator
 *  behind it is the shipped one: a second shape would be a second thing to keep
 *  in step with the chunk vocabulary. */
export type PublicTurn = AgentTurnResult;

export interface PublicTurnRecorder {
  /** Feed one response frame. */
  apply(frame: PublicResponseFrame): void;
  /** The settled turn, or null while it is still open. */
  settled(): PublicTurn | null;
}

/**
 * A turn under construction, over the shipped accumulator.
 *
 * The pure seam this module is tested through: a suite can hand it recorded
 * frames and assert the turn that comes out — the text, the tool calls paired to
 * their outputs, the step count, and the replay idempotence a resumed stream
 * depends on — with no socket and no deployment.
 */
export function recordPublicTurn(): PublicTurnRecorder {
  let settled: PublicTurn | null = null;
  const stream = new CloudTurnStream(() => {}, (result) => { settled = result; });
  return {
    apply(frame) {
      if (settled !== null) return;
      if (frame.error === true) {
        stream.settle(true);
        return;
      }
      if (frame.body !== undefined && frame.body.trim() !== '') {
        stream.apply(frame.body, frame.replay === true);
      }
      if (frame.done === true) stream.settle();
    },
    settled: () => settled,
  };
}

// ── The ledger, scored by the instruments that already exist ────────

/**
 * Score events fetched over the public route with the SAME instruments a local
 * episode is scored with.
 *
 * The scorers are pure over `SqlExecutor` and read the `run_events` TABLE
 * (`packages/test-utils/src/agent-evals.ts`), so the bridge is a store rather
 * than a second scorer: the fetched events are written into a fresh in-memory
 * table in the recorder's own row shape — `run_id`, `event_index`, `type`, the
 * whole stamped event as `payload`, `ts` (events/recorder.ts:330-333) — and
 * `scoreTrajectory` reads them back through `parseStoredRunEvent`, the canonical
 * parse. Nothing about the seven instruments is re-expressed here, which is what
 * makes a cloud number comparable with a local one.
 *
 * The events are written VERBATIM. `RunEventRecorder.emit` would re-stamp
 * `eventIndex` and `timestamp` (recorder.ts:158-160) and hand the scorers a
 * different log from the one the deployment recorded.
 */
export function scorePublicLedger(events: readonly RunEvent[]): EvalScoreRow[] {
  const store = createTestSql();
  try {
    initRunEventTables(store.execRaw);
    for (const event of events) {
      void store.sql`INSERT OR REPLACE INTO run_events (run_id, event_index, type, payload, ts)
        VALUES (${event.runId}, ${event.eventIndex}, ${event.type},
                ${JSON.stringify(event)}, ${event.timestamp})`;
    }
    return scoreTrajectory(store.sql);
  } finally {
    store.close();
  }
}

// ── The session ────────────────────────────────────────────────────

interface PublicSessionInput {
  readonly origin: string;
  readonly identity: PublicWebIdentity;
  readonly workspace: string;
  readonly purpose: string;
  readonly llm: LLMProviderConfig;
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
const RunEventsSchema = v.array(RunEventSchema);
const SetModelSchema = v.object({ spec: v.string() });
const SteerSchema = v.object({ landed: v.picklist(['mid-turn', 'queued']) });
/** What `executeInExecutor` answers, exactly as `ExecutorCommandResult`
 *  declares it (cf-backend/src/lib/protocol.ts:132) — every field optional,
 *  because the orchestrator answers `{error}` alone when the executor is absent
 *  or unavailable and `{stdout, stderr, exitCode}` when the command ran. */
const ExecutorCommandSchema = v.object({
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  error: v.optional(v.string()),
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
const DeferredApprovalsSchema = v.array(DeferredApprovalSchema);
const DecideApprovalsSchema = v.object({ decided: v.array(v.string()) });

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
});
const ToolDescriptionsSchema = v.object({ crafted: v.array(CraftedToolSchema) });

/** One tool the model built for itself, as the Tools pane lists it. */
export type PublicCraftedTool = v.InferOutput<typeof CraftedToolSchema>;

/** One agent-written tab, as `listGadgets` draws it, parsed to the server's
 *  own `GadgetSummary` so a shape this guessed at cannot drift again: the
 *  first deployed run of the gadget row failed on `subtitle: null` against an
 *  optional string here, with the gadget built and listed. */
const GadgetSummarySchema: v.GenericSchema<unknown, GadgetSummary> = v.object({
  slug: v.string(),
  title: v.string(),
  subtitle: v.nullable(v.string()),
  hasServer: v.boolean(),
  hasClient: v.boolean(),
  bindings: v.array(v.string()),
});
const GadgetListingSchema = v.object({ gadgets: v.array(GadgetSummarySchema) });

/** One agent-written tab, as the tab strip draws it. */
export type PublicGadget = v.InferOutput<typeof GadgetSummarySchema>;

/** What `gadgetCall` answers: the method's value, or the refusal with its
 *  class first. The case pins the value it asked for. */
const GadgetCallResultSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), value: JsonValueSchema }),
  v.object({ ok: v.literal(false), reason: v.string(), error: v.string() }),
]);

/** One call into a gadget's server, as the tab bridge made it. */
export type PublicGadgetCall = v.InferOutput<typeof GadgetCallResultSchema>;

/** What `readExecutorFile` answers, exactly as `ExecutorTextFile` declares it
 *  (core/src/read-models/files.ts): the preview's text, or the reason there is
 *  none. Both optional, because the read model answers one or the other. */
const ViewedFileSchema = v.object({
  content: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
  revision: v.optional(v.number()),
  readOnlyReason: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** One file as the Files tab shows it. */
export type PublicViewedFile = v.InferOutput<typeof ViewedFileSchema>;

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
}));

/** One durable message, as the web pane's seed carries it. */
export interface PublicMessage {
  readonly role: string;
  readonly text: string;
}

/** A turn in flight: the id the DO knows it by, and the promise it settles. A
 *  submission rather than a bare promise, because a mid-turn steer has to be
 *  issued while this one is still open. */
export interface PublicSubmission {
  readonly requestId: string;
  readonly settled: Promise<PublicTurn>;
}

async function openPublicSession(input: PublicSessionInput): Promise<KinuPublicSession> {
  const headers = webHeaders(input.identity);
  const created = await infraBoundary(
    `POST ${input.origin}/api/user/workspaces`,
    async () => {
      const response = await fetch(`${input.origin}/api/user/workspaces`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: input.workspace,
          displayName: 'Trajectory Evals',
          purpose: input.purpose,
        }),
      });
      return v.parse(WorkspaceEntrySchema, await readJson(response, 'create a workspace'));
    },
  );
  const session = new KinuPublicSession(input, created.name);
  try {
    await session.connect();
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

export function webHeaders(identity: PublicWebIdentity): Record<string, string> {
  return identity.kind === 'secret' ? { 'x-kinu-dev-identity': identity.secret } : {};
}

/** One response body, or the deployment's own words on a failure. The body is
 *  kept on the error path deliberately: a 409 naming an unserveable model and a
 *  503 naming a missing binding are different repairs. */
async function readJson(response: Response, doing: string): Promise<JsonValue> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`could not ${doing}: ${String(response.status)} ${response.statusText} `
      + `— ${text.slice(0, 400)}`);
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
  private readonly turns = new Map<string, {
    readonly recorder: PublicTurnRecorder;
    readonly resolve: (turn: PublicTurn) => void;
    readonly reject: (error: Error) => void;
  }>();
  private readonly rpcs = new Map<string, {
    readonly resolve: (result: JsonValue) => void;
    readonly reject: (error: Error) => void;
  }>();
  private nextId = 0;

  constructor(
    private readonly input: PublicSessionInput,
    /** The name the deployment gave this workspace, which is not always the one
     *  asked for: the create path may answer with an existing row. */
    readonly workspace: string,
  ) {}

  get describe(): string {
    return `public session · ${this.input.origin} · workspace ${this.workspace} `
      + `· model ${this.input.llm.model}`;
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
    if (this.socket !== null) return;
    const url = new URL(
      `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(this.workspace)}`,
      this.input.origin,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new HEADER_WEBSOCKET(url.toString(), {
      headers: webHeaders(this.input.identity),
    });
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      this.handleFrame(event.data);
    });
    socket.addEventListener('close', () => { this.failInFlight('the workspace socket closed'); });
    await infraBoundary(`ws ${url.host}${url.pathname}`, () => new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => {
        reject(new Error(`could not open the public chat socket to ${url.host}${url.pathname}`));
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

  /** Start a turn and hand back its id and its promise. */
  submit(text: string): PublicSubmission {
    const socket = this.requireSocket();
    const requestId = this.mintId('turn');
    const recorder = recordPublicTurn();
    const settled = new Promise<PublicTurn>((resolve, reject) => {
      this.turns.set(requestId, { recorder, resolve, reject });
      socket.send(encodeChatRequest({ requestId, text }));
    });
    return { requestId, settled };
  }

  /** One user turn, awaited to settle. Every ledger row a suite reads is written
   *  when the turn closes, so a read before settle reports a zero denominator
   *  from a turn that was merely still running. */
  prompt(text: string): Promise<PublicTurn> {
    return infraBoundary(`turn on ${this.input.origin}/${this.workspace}`, () =>
      this.submit(text).settled);
  }

  /**
   * Steer the running turn, the way the composer does.
   *
   * The answer is the DO's own statement about what happened to the words:
   * `'mid-turn'` means they were spliced into the running turn's next step,
   * `'queued'` means that turn had already ended and they became the next
   * ordinary turn (actor-agent.ts:4565-4584). Both are landings, and a caller
   * that treated `'queued'` as a failure would be failing on a race the product
   * resolves correctly.
   */
  async steer(text: string): Promise<'mid-turn' | 'queued'> {
    const landed = await infraBoundary(`steerTurn on ${this.input.origin}/${this.workspace}`, () =>
      this.rpc('steerTurn', [text, 'build']));
    return v.parse(SteerSchema, landed).landed;
  }

  /**
   * Run one command on an executor, the way the Env tab's terminal runs one.
   *
   * `executeInExecutor` is the RPC the pane is bound to (hooks/use-kinu.ts:1775)
   * and this is the same frame over the same socket, so a green here is a
   * statement about the surface a person uses. The answer is returned whole
   * rather than reduced to stdout: a refusal arrives as `{error}` or as a
   * classified payload on the stdout channel, and which one it is is the finding
   * a device case reads.
   */
  async execute(executor: string, command: string): Promise<PublicExecutorResult> {
    const result = await infraBoundary(
      `executeInExecutor(${executor}) on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('executeInExecutor', [executor, command]),
    );
    return v.parse(ExecutorCommandSchema, result);
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
    const rows = await infraBoundary(
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
    const answer = await infraBoundary(
      `decideDeferredApprovals on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('decideDeferredApprovals', [[...ids], decision]),
    );
    return v.parse(DecideApprovalsSchema, answer).decided;
  }

  /** The tools this workspace holds that the MODEL wrote, as the Tools pane
   *  lists them. The built-in half of `getToolDescriptions` is dropped at the
   *  boundary: a crafted-tool case asks about the crafted set. */
  async craftedTools(): Promise<readonly PublicCraftedTool[]> {
    const answer = await infraBoundary(
      `getToolDescriptions on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getToolDescriptions', []),
    );
    return v.parse(ToolDescriptionsSchema, answer).crafted;
  }

  /** The agent-written tabs, as the tab strip draws them. */
  async listGadgets(): Promise<readonly PublicGadget[]> {
    const answer = await infraBoundary(
      `listGadgets on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('listGadgets', []),
    );
    return v.parse(GadgetListingSchema, answer).gadgets;
  }

  /** One call into a gadget's server, the way the tab's bridge makes it:
   *  the same socket RPC the UI forwards over. */
  async gadgetCall(slug: string, method: string, args: readonly JsonValue[]): Promise<PublicGadgetCall> {
    const answer = await infraBoundary(
      `gadgetCall(${slug}.${method}) on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('gadgetCall', [slug, method, [...args]]),
    );
    return v.parse(GadgetCallResultSchema, answer);
  }

  /** The durable transcript the web pane is seeded from. */
  async history(): Promise<readonly PublicMessage[]> {
    const rows = await infraBoundary(
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
    return rows.map((row) => ({
      role: row.role,
      text: (row.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(''),
    }));
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
    let after: string | null = null;
    for (;;) {
      // Annotated because the loop reads its own result: `page.next.after` feeds
      // the next iteration, so inference would be circular.
      const page: v.InferOutput<typeof RunPageSchema> = await this.getJson(
        `/api/workspaces/${encodeURIComponent(this.workspace)}/runs`
        + `?limit=${String(RUN_PAGE)}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
        RunPageSchema,
        'list the workspace runs',
      );
      for (const run of page.items) events.push(...await this.runEventsOf(run.runId));
      if (page.status === 'end') break;
      after = page.next.after;
    }
    events.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
      || a.runId.localeCompare(b.runId)
      || a.eventIndex - b.eventIndex);
    return events;
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
    const answer = await infraBoundary(
      `readExecutorFile(${executor}) on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('readExecutorFile', [executor, path]),
    );
    return v.parse(ViewedFileSchema, answer);
  }

  /** What this workspace spent, from the deployment's own read model — the same
   *  `getActivitySnapshot().spend` the Activity pane draws and the operator arm
   *  meters, so there is one definition of what a workspace spent. */
  async spend(): Promise<WorkspaceSpend> {
    const snapshot = await infraBoundary(
      `getActivitySnapshot on ${this.input.origin}/${this.workspace}`,
      () => this.rpc('getActivitySnapshot', []),
    );
    return v.parse(ActivitySpendSchema, snapshot).spend;
  }

  /** One file off the workspace plane, through the route the web file manager
   *  reads. */
  readFile(path: string): Promise<string> {
    return infraBoundary(`GET files ${path}`, async () => {
      const response = await fetch(this.filesUrl(path), { headers: webHeaders(this.input.identity) });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`could not read ${path} over the files route: ${String(response.status)} `
          + `${response.statusText} — ${text.slice(0, 200)}`);
      }
      return text;
    });
  }

  /** Seed one file through the same route, so a case's inputs arrive on the
   *  plane the agent's own tools read. */
  writeFile(path: string, content: string): Promise<void> {
    return infraBoundary(`PUT files ${path}`, async () => {
      const response = await fetch(this.filesUrl(path), {
        method: 'PUT',
        headers: { ...webHeaders(this.input.identity), 'content-type': 'application/octet-stream' },
        body: content,
      });
      if (!response.ok) {
        throw new Error(`could not write ${path} over the files route: ${String(response.status)} `
          + `${response.statusText} — ${(await response.text()).slice(0, 200)}`);
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
    try {
      await infraBoundary(
        `DELETE ${this.input.origin}/api/user/workspaces/${this.workspace}`,
        async () => {
          const response = await fetch(
            `${this.input.origin}/api/user/workspaces/${encodeURIComponent(this.workspace)}`,
            { method: 'DELETE', headers: webHeaders(this.input.identity) },
          );
          await readJson(response, `delete the workspace ${this.workspace}`);
        },
      );
    } finally {
      this.failInFlight('the session was torn down');
      this.socket?.close();
      this.socket = null;
    }
  }

  private async runEventsOf(runId: string): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];
    let since = 0;
    for (;;) {
      const page = await this.getJson(
        `/api/workspaces/${encodeURIComponent(this.workspace)}/runs/`
        + `${encodeURIComponent(runId)}/events?since=${String(since)}&limit=${String(EVENT_PAGE)}`,
        RunEventsSchema,
        `read the events of run ${runId}`,
      );
      if (page.length === 0) break;
      events.push(...page);
      // The route's `since` is an INCLUSIVE lower bound (recorder.ts:169-171),
      // so the next read starts one past the highest index this one returned.
      // Advancing by `page.length` instead would re-read a run whose indices
      // are not contiguous, and stall on one whose page ended mid-index.
      const highest = page.reduce((max, event) => Math.max(max, event.eventIndex), since);
      if (page.length < EVENT_PAGE) break;
      since = highest + 1;
    }
    return events;
  }

  private getJson<T>(path: string, schema: v.GenericSchema<T>, doing: string): Promise<T> {
    return infraBoundary(`GET ${this.input.origin}${path.split('?')[0] ?? path}`, async () => {
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
    const socket = this.requireSocket();
    const requestId = this.mintId('rpc');
    return new Promise<JsonValue>((resolve, reject) => {
      this.rpcs.set(requestId, { resolve, reject });
      socket.send(encodeRpcRequest({ requestId, method, args }));
    });
  }

  private requireSocket(): WebSocket {
    const socket = this.socket;
    if (socket === null) {
      throw new Error('this public session has no socket: `connect()` was not called, or the '
        + 'session was already torn down');
    }
    return socket;
  }

  private mintId(kind: string): string {
    this.nextId += 1;
    return `${kind}-${String(this.nextId)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private handleFrame(data: SocketPayload): void {
    const frame = decodeFrame(data);
    if (frame === null) return;
    if (frame.kind === 'rpc') {
      const pending = this.rpcs.get(frame.id);
      if (!pending) return;
      this.rpcs.delete(frame.id);
      if (frame.error === null) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error));
      return;
    }
    if (frame.kind === 'resuming') {
      // The DO holds a stream for a turn this session started: ack it so the
      // buffered chunks are replayed. The accumulator is replay-idempotent, so
      // an ack cannot double an answer.
      if (this.turns.has(frame.id)) {
        this.socket?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: frame.id }));
      }
      return;
    }
    if (frame.kind !== 'response') return;
    const turn = this.turns.get(frame.frame.id);
    if (!turn) return;
    turn.recorder.apply(frame.frame);
    const done = turn.recorder.settled();
    if (done === null) return;
    this.turns.delete(frame.frame.id);
    turn.resolve(done);
  }

  /** Reject what the dead socket was carrying. A turn is durable up there and
   *  its answer lands in the transcript either way, but this process cannot
   *  report it — and an eval that hangs on a closed socket reports nothing at
   *  all, which is worse than a named failure. */
  private failInFlight(reason: string): void {
    const turns = [...this.turns.values()];
    this.turns.clear();
    const rpcs = [...this.rpcs.values()];
    this.rpcs.clear();
    for (const turn of turns) turn.reject(new Error(reason));
    for (const rpc of rpcs) rpc.reject(new Error(reason));
  }
}
