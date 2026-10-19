/** Asks the owner about what review gates, and keeps their grants. */

import { wasNotDispatched } from '@kinu.run/agent-utils';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, classifyErrorCode, CODE_WORK_DID_NOT_START, detach, diagnostics, KinuError, settle, toKinuError, type ErrorCode } from '../obs/index';
import { boundWriteCommand, type WriteSubject } from './bound-write';
import { stableStringify } from './argument-digest';
import type { JsonObject } from '../utils/json';
import {
  dominant, reviewFileAccess, reviewShellCommand,
  type ApprovalResult, type FileAccess, type GatedExecutor,
} from './command-review';

/**
 * Where and how a command runs on its executor, besides its words: part of what an approval answers, so the same words
 * anywhere else are another ask. Each field is one the running member honours; a value that may be secret is a digest.
 * Compared as {@link executionContextKey}, never as its display.
 *
 * A label Kinu assigns to the run, such as the job id the sandbox stamps into a background run's environment as
 * `KINU_JOB_ID`, is not part of it: the owner answers for the command and where it runs, not for Kinu's bookkeeping,
 * and the label is fresh on every call, so an ask re-made after its approval could never meet it. Two background runs
 * alike in every field here are one action, and one answer runs one of them.
 */
export interface ExecutionContext {
  /** The member that runs it (`exec`, `startProcess`): a foreground command and a supervised process that restarts
   *  are different invocations of the same words. */
  readonly member?: string;
  /** The directory it starts in: resolved on the executor's session when the gate can, else as asked. */
  readonly cwd?: string;
  /** The named shell whose directory and exported variables it starts from. */
  readonly shell?: string;
  /** The machine it runs on, of the several one executor reaches: its id, and its name for the owner. */
  readonly machine?: { readonly id: string; readonly name: string };
  /** A digest of what it reads on stdin. */
  readonly stdinSha256?: string;
  /** It runs as a background job: it may outlive the turn. The job's id is a Kinu label, outside the ask (see above). */
  readonly background?: true;
  /** What its named shell restores before it (directory and exported variables), as a digest: a call in that shell
   *  after the shell moved is another ask. */
  readonly shellState?: string;
}

export const ExecutionContextSchema = v.object({
  member: v.optional(v.string()),
  cwd: v.optional(v.string()),
  shell: v.optional(v.string()),
  machine: v.optional(v.object({ id: v.string(), name: v.string() })),
  stdinSha256: v.optional(v.string()),
  background: v.optional(v.literal(true)),
  shellState: v.optional(v.string()),
}) satisfies v.GenericSchema<ExecutionContext>;

/** The context's identity: one canonical spelling, so equal contexts are equal keys whatever a value contains. */
export function executionContextKey(context: ExecutionContext): string {
  const json: JsonObject = {};

  for (const field of ['member', 'cwd', 'shell', 'stdinSha256', 'shellState'] as const) {
    const value = context[field];

    if (value !== undefined) json[field] = value;
  }

  if (context.machine !== undefined) json.machine = { id: context.machine.id, name: context.machine.name };

  if (context.background !== undefined) json.background = context.background;

  return stableStringify(json);
}

/** What the owner reads of a context: each value quoted, so a delimiter inside one cannot pass for another field. */
export function describeExecutionContext(context: ExecutionContext): string {
  const parts: string[] = [];

  if (context.member !== undefined) parts.push(`via ${JSON.stringify(context.member)}`);

  if (context.machine !== undefined) parts.push(`on ${JSON.stringify(context.machine.name)}`);

  if (context.cwd !== undefined) parts.push(`in ${JSON.stringify(context.cwd)}`);

  if (context.shell !== undefined) parts.push(`shell ${JSON.stringify(context.shell)}`);

  if (context.stdinSha256 !== undefined) parts.push(`stdin sha256:${context.stdinSha256.slice(0, 12)}`);

  if (context.background !== undefined) parts.push('as a background job');

  if (context.shellState !== undefined) parts.push(`shell state sha256:${context.shellState.slice(0, 12)}`);

  return parts.join(' · ');
}

/**
 * What a command-taking member runs, read once from its arguments: the gate reviews and keys exactly this, and the
 * member's `run` runs exactly this, so what an answer approves is what runs.
 */
export interface CommandCall {
  /** The shell command. */
  readonly text: string;
  /** Where it starts, as the member will be told; the gate resolves it on the executor's session. */
  readonly cwd?: string;
  /** The named shell it runs in. */
  readonly shell?: string;
  /** Everything else the member honours that changes what runs. */
  readonly context: Omit<ExecutionContext, 'cwd' | 'shell' | 'shellState'>;
  /** Reads the digest of what `shell` restores before a call ({@link namedShellState}). Read only for a call that
   *  waits on an owner's answer, and handed to `run`, which runs only while the shell still restores exactly that. */
  readonly shellState?: () => Promise<string | KinuError>;
  /** The call's own cancel, where its member never dispatches once it has fired: an approved run whose cancel fired
   *  first is not dispatched, and its approval returns. Not part of the ask. */
  readonly signal?: AbortSignal;
}

/** A call whose named shell no longer restores what it did when the call was asked (or cannot say): NOT RUN, a
 *  did-not-start code, so a spent approval returns, and the owner is asked again about the shell as it is. */
function shellMoved(shell: string, how: 'changed' | 'could not be read', cause?: KinuError): KinuError {
  return new KinuError('unavailable', how === 'changed'
    ? `NOT RUN: shell ${JSON.stringify(shell)} changed (its directory or exported variables) since this was asked, so the approval does not cover it. Ask again.`
    : `NOT RUN: the state of shell ${JSON.stringify(shell)} could not be read, so this cannot be approved. Ask again.`, cause === undefined ? undefined : { cause });
}

/** A named shell's state from its machine's `read` (null: unreadable), or the NOT RUN refusal that says it could not be
 *  read; a failed read never escapes. */
function namedShellState(read: () => Promise<string | null>, shell: string) {
  return Effect.match(attempt({ doing: `reading the state of shell ${JSON.stringify(shell)}`, otherwise: 'unavailable' }, read), {
    onSuccess: (state): string | KinuError => state ?? shellMoved(shell, 'could not be read'),
    onFailure: (failure) => shellMoved(shell, 'could not be read', failure),
  });
}

/**
 * Why a call pinned to its named shell's state must not run now: the shell, read again just before, no longer restores
 * exactly that, or cannot be read. Null: run it. The refusal refunds a spent approval.
 */
async function pinnedShellMoved(
  pinned: string, shell: string, read: (() => Promise<string | KinuError>) | undefined,
): Promise<KinuError | null> {
  const now = read === undefined ? shellMoved(shell, 'could not be read') : await read();

  if (now instanceof KinuError) return now;

  return now === pinned ? null : shellMoved(shell, 'changed');
}

/**
 * A gated call in its named shell: `call` asked with what the shell restores (`shellState`), where `read` reads that on
 * the shell's machine, and `run`, which runs a call pinned to that state (one an answer was asked for) only while the
 * shell still restores exactly that, else answers `notRun` ({@link pinnedShellMoved}). A member runs it inside the
 * shell's hold, so nothing of this agent moves the shell between the read and the run. An unpinned run awaits nothing
 * first, so its dispatch keeps its timing.
 */
export function namedShellCall(call: CommandCall, name: string | undefined, read: ((name: string) => Promise<string | null>) | undefined) {
  const state = name === undefined || read === undefined ? undefined : () => settle(namedShellState(() => read(name), name));

  async function pinnedRun<R>(pinned: string, run: () => Promise<R>, notRun: (moved: KinuError) => R): Promise<R> {
    const moved = await pinnedShellMoved(pinned, name ?? '', state);

    return moved === null ? await run() : notRun(moved);
  }

  return {
    call: { ...call, ...(state !== undefined && { shellState: state }) } satisfies CommandCall,
    run: <R>(pinned: string | undefined, run: () => Promise<R>, notRun: (moved: KinuError) => R): Promise<R> => (
      pinned === undefined ? run() : pinnedRun(pinned, run, notRun)
    ),
  };
}

/** A member's reading of one call: what runs and how to run exactly that, or its own refusal before anything runs. */
export type PreparedCall<R> =
  | { readonly call: CommandCall; readonly run: (shellState?: string) => Promise<R> }
  | { readonly refused: R };

export interface ShellApprovalRequest {
  readonly command: string;
  /** The target executor; the same command is a different request on a different machine. */
  readonly executor: string;
  /** Where and how it runs there; the same command in another context is another request. */
  readonly context: ExecutionContext;
  readonly review: ApprovalResult;
  /** A file write's ask: what it replaces and with what. A parked one is bound to these bytes. */
  readonly write?: WriteSubject;
  /** The queue row this ask is: a prompt showing it shows that row, and its answer decides that row. */
  readonly approvalId?: string;
}

/** A channel's answer. 'allow_always' grants each tripped rule on this executor ({@link ApprovalGrant}). */
export type ShellApprovalOutcome = 'allow' | 'allow_always' | 'deny';

function approvalGrants(outcome: ShellApprovalOutcome): boolean {
  return outcome === 'allow' || outcome === 'allow_always';
}

/** A standing grant: one rule on one executor. */
export interface ApprovalGrant {
  readonly rule: string;
  readonly executor: string;
}

/** Stored spelling of a grant; one token, stored as a comma-separated list. */
export function formatApprovalGrant(grant: ApprovalGrant): string {
  return `${grant.rule}@${grant.executor}`;
}

/** Whether a standing grant covers this rule on this executor. */
export function holdsGrant(grants: readonly ApprovalGrant[], grant: ApprovalGrant): boolean {
  return grants.some((held) => held.rule === grant.rule && held.executor === grant.executor);
}

export function parseApprovalGrant(raw: string): ApprovalGrant | null {
  const at = raw.indexOf('@');

  if (at <= 0 || at === raw.length - 1) return null;
  const rule = raw.slice(0, at).trim();
  const executor = raw.slice(at + 1).trim();

  return rule && executor ? { rule, executor } : null;
}

/** A write's bytes, read only when someone is asked or it parks; `parks` false refuses it unanswered. */
export interface WriteAsk {
  readonly subject: () => Promise<WriteSubject>;
  readonly parks: boolean;
}

/** Only a write parks, bound to its bytes: a parked approval answers any later request with the same text. */
export function approveFileAccess(
  access: FileAccess, executor: string, policy: ShellApprovalPolicy, write?: WriteAsk,
): Effect.Effect<void, KinuError> {
  const review = reviewFileAccess(access);

  if (review.decision === 'allow') return Effect.void;

  return Effect.gen(function* () {
    const decision = yield* Effect.promise(() => decideApproval(
      // The path is the whole of where a file access lands.
      { command: `file ${access.op} ${access.hostPath}`, executor, context: async () => ({}), write: write?.subject, parks: write?.parks ?? false }, review, policy,
    ));

    if (!decision.run) return yield* Effect.fail(decision.error);

    const { spent } = decision;

    if (spent !== undefined) yield* Effect.promise(async () => { await policy.deferrals?.settle(spent, 'spent'); });
  });
}

/** Human-readable result for approval prompts and deny errors. */
export function formatApproval(result: ApprovalResult): string {
  if (result.decision === 'allow') return '';
  const lines = result.hits.map((h) => `- ${h.rule} (${h.decision}): ${h.explanation}`);

  return [`Approval review: ${result.decision}`, ...lines].join('\n');
}

const APPROVAL_DENIED = 'Denied';

/** Not imported from config/store.ts: a layergate subject source stays import-free. */
type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Read at call time, so a mode or channel change applies to the next command. */
export interface ShellApprovalPolicy {
  mode(): ShellApprovalMode;
  /** Whether the owner granted this rule on this executor; consulted before asking. */
  granted?(grant: ApprovalGrant): boolean;
  /**
   * A prompt in front of the owner under 'strict', read live; null: nobody answers there. With a queue it shows the
   * ask's row and its answer decides that row; `signal` aborts once another surface decided it first.
   */
  requestApproval?: ((req: ShellApprovalRequest, signal: AbortSignal) => Promise<ShellApprovalOutcome | null>) | null;
  /** Where an unanswered 'gate' decision is parked on the owner. */
  deferrals?: DeferredApprovalChannel;
  /** Refreshes `mode()` and `granted()` before a decision, for facets whose grants are the root's. */
  resolve?(): Promise<void>;
}

/** Default policy: 'strict' with nobody to ask, so 'gate' decisions are refused. */
export const STRICT_NO_CHANNEL_POLICY: ShellApprovalPolicy = { mode: () => 'strict' };

/** One spend of one grant. The spend counter makes late, replayed, or duplicate settles no-ops. */
export interface ApprovalSpend {
  readonly approvalId: string;
  readonly spend: number;
}

/** A spent grant's outcome. Only proven `did-not-run` refunds; an unsettled spend stays spent. */
export type ApprovalSpendOutcome =
  /** The boundary proved the command never reached its machine; the grant is refunded. */
  | 'did-not-run'
  | 'spent';

/** What the queue answers an ask: run on a grant it just spent, or the words to hand the model. */
type QueueAnswer =
  | { readonly run: true; readonly spent: ApprovalSpend }
  /** `waiting`: the row the owner has yet to decide. */
  | {
    readonly run: false; readonly reason: 'denied' | 'unavailable'; readonly message: string;
    /** The row the owner has yet to decide, and the rules it holds: what an always-answer to it grants. */
    readonly waiting?: { readonly id: string; readonly rules: readonly string[] };
  };

/**
 * The owner's queue (safety/deferred-approval.ts): every gated ask is a row of it, whichever surface answers, so the
 * first answer decides it once. `run: true`: the row's grant is spent; `settle` refunds unrun attempts.
 */
export interface DeferredApprovalChannel {
  park(req: ShellApprovalRequest): Promise<QueueAnswer>;
  /**
   * `decided` once row `id` no longer waits: decided from any surface while this ask waited on it, so the queue tells
   * it here and wakes nobody. `aborted` once `signal` aborted first: a decision after that wakes the agent instead.
   */
  decided(id: string, signal: AbortSignal): Promise<'decided' | 'aborted'>;
  /** A prompt's answer to row `id`; a row another surface decided first keeps that decision. */
  decide(id: string, outcome: ShellApprovalOutcome): Promise<void>;
  /** The decided row `id`, for the ask that waited on it: its approval spent, its denial, or that another ask of the
   *  same row used its approval. Never a new row. */
  take(id: string): Promise<QueueAnswer>;
  /** An always-answer to an ask no row holds (a write this deployment cannot park), kept as the queue keeps its own. */
  remember(grants: readonly ApprovalGrant[]): void;
  /** Close out a spend. Called once per spend on every returning path, never when unknown. Idempotent. */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): Promise<void>;
}

/** The review minus rules the owner granted on this executor. Deny is never grantable. */
function afterGrants(review: ApprovalResult, policy: ShellApprovalPolicy, executor: string): ApprovalResult {
  if (review.decision !== 'gate' || !policy.granted) return review;

  const hits = review.hits.filter(
    (h) => h.decision !== 'gate' || !policy.granted?.({ rule: h.rule, executor }),
  );

  return hits.length === review.hits.length ? review : { decision: dominant(hits), hits };
}

/** The one gate for every boundary that reaches a shell; a proven not-run code refunds a spent grant. */
export interface ExecGateTuning<R> {
  readonly policy?: ShellApprovalPolicy;
  readonly refusalCode?: (result: R) => ErrorCode | null;
  /** The member gated ({@link ExecutionContext.member}). */
  readonly member?: string;
}

/**
 * Gates a command-taking member through its own reading of each call (`prepare`): the call it returns is reviewed on
 * the executor's session and keyed with its context, and only its `run` runs. Nothing here reads the arguments again.
 */
export function gateExec<R>(
  prepare: (args: readonly unknown[]) => PreparedCall<R>,
  denyResult: (error: KinuError) => R,
  executor: GatedExecutor,
  tuning: ExecGateTuning<R> = {},
): (...args: unknown[]) => Promise<R> {
  const policy = tuning.policy ?? STRICT_NO_CHANNEL_POLICY;
  const refusalCode = tuning.refusalCode;

  // Rest args keep this assignable to `ExecutorProvider['tools'][name].execute` and to `Shell.exec`.
  return async (...args) => {
    const prepared = prepare(args);

    if ('refused' in prepared) return prepared.refused;
    const { call } = prepared;
    const at = await executor.shellSession?.at(call.shell, call.cwd);

    const review = reviewShellCommand(executor, call.text, at);

    const cwd = at !== undefined && !at.mayBeUsers ? at.cwd : call.cwd;

    const context: ExecutionContext = {
      ...(tuning.member !== undefined && { member: tuning.member }), ...call.context,
      ...(cwd !== undefined && { cwd }), ...(call.shell !== undefined && { shell: call.shell }),
    };

    // Read only when the call waits on an owner's answer (after grants and the mode): its named shell's state joins
    // the ask, and the run is pinned to it. One that cannot be read is not asked.
    let pinned: string | undefined;
    const read = call.shellState;

    const asked = async (): Promise<ExecutionContext | KinuError> => {
      if (read === undefined) return context;
      const state = await read();

      if (state instanceof KinuError) return state;
      pinned = state;

      return { ...context, shellState: state };
    };

    const decision = await decideApproval({ command: call.text, executor: executor.name, context: asked }, review, policy);

    if (!decision.run) return denyResult(decision.error);
    const { spent } = decision;

    // An approved run whose cancel fired while the owner answered is not dispatched, and its approval returns.
    if (spent !== undefined && call.signal?.aborted === true) {
      await policy.deferrals?.settle(spent, 'did-not-run');

      return denyResult(new KinuError('cancelled', 'NOT RUN: cancelled before it was dispatched; the approval stands for the next ask.'));
    }

    const running = prepared.run(pinned);

    if (spent !== undefined) {
      const [ran] = await Promise.allSettled([running]);
      await policy.deferrals?.settle(spent, ran !== undefined && provedNotRun(ran, refusalCode) ? 'did-not-run' : 'spent');
    }

    return running;
  };
}

/**
 * Whether an approved run proved nothing started, so its approval returns: a refusal, or a failure whose code says so,
 * or a cancel its member raised before dispatching. Anything else spent it.
 */
function provedNotRun<R>(ran: PromiseSettledResult<R>, refusalCode: ((result: R) => ErrorCode | null) | undefined): boolean {
  if (ran.status === 'rejected' && wasNotDispatched(ran.reason)) return true;
  const code = ran.status === 'fulfilled' ? refusalCode?.(ran.value) ?? null : classifyErrorCode({ cause: ran.reason });

  return code !== null && CODE_WORK_DID_NOT_START[code];
}

type GateAnswer =
  | { readonly run: true; readonly spent?: ApprovalSpend }
  | { readonly run: false; readonly error: KinuError };

function refuse(reason: ErrorCode, message: string): GateAnswer {
  return { run: false, error: new KinuError(reason, message) };
}

/**
 * A gated ask under 'strict' or 'deny_all' ('deny_all' never asks or parks). With a queue, the ask is its row first
 * (one write per ask): a row already decided answers it, and a waiting one is shown on the live prompt, if one is in
 * front of the owner, beside every other surface that lists the queue. Whichever answers first decides the row once,
 * and the ask follows that row: run on its approval, spent, or refused. Without a queue (a bare gate, or a write this
 * deployment cannot park) the live prompt alone answers.
 */
async function askOwner(
  review: ApprovalResult,
  rawReview: ApprovalResult,
  policy: ShellApprovalPolicy,
  ask: { readonly mode: ShellApprovalMode; readonly executor: string; readonly parks: boolean; readonly request: (parking: boolean) => Promise<ShellApprovalRequest> },
): Promise<GateAnswer> {
  const deferrals = ask.mode === 'strict' && ask.parks ? policy.deferrals : undefined;

  if (deferrals === undefined) return askLive(review, policy, ask);
  const parked = await deferrals.park(await ask.request(true));

  if (parked.run) return { run: true, spent: parked.spent };
  const live = policy.requestApproval;

  // A parked write is decided on its row alone: the queue writes its bytes when approved.
  if (parked.waiting === undefined || !live || (await ask.request(false)).write !== undefined) return refuse(parked.reason, parked.message);
  const { id, rules } = parked.waiting;
  const shown = new AbortController();

  // The row as the queue holds it: the rules a live always-answer grants are the ones its prompt shows.
  const held: ApprovalResult = {
    decision: 'gate',
    hits: rules.map((rule) => rawReview.hits.find((hit) => hit.rule === rule) ?? { rule, decision: 'gate', explanation: rule }),
  };

  const answering = live({ ...await ask.request(false), review: held, approvalId: id }, shown.signal);
  let retired = false;

  // A prompt retired because another surface decided first may still fail after; that is recorded, never thrown.
  shown.signal.addEventListener('abort', () => {
    detach(Effect.map(Effect.promise(() => Promise.allSettled([answering])), ([late]) => {
      if (retired && late?.status === 'rejected') {
        diagnostics.failure('approval.prompt_failed', toKinuError({ doing: 'showing an approval another surface decided', cause: late.reason, otherwise: 'io' }), { approvalId: id });
      }
    }));
  }, { once: true });

  const row = deferrals.decided(id, shown.signal);

  try {
    const first = await Promise.race([answering, row]);

    if (first === 'decided' || first === 'aborted') {
      retired = true;
    } else if (first === null) {
      // The prompt went away unanswered: let go of the row. Decided before that, its answer stands for this ask;
      // decided after, it wakes the agent, and the ask is NOT RUN while the row waits.
      shown.abort();

      if (await row === 'aborted') return refuse(parked.reason, parked.message);
    } else {
      // Recorded while this ask still waits on the row, so the queue tells it here; a row another surface decided
      // first keeps that decision.
      await deferrals.decide(id, first);
    }
  } finally {
    shown.abort();
  }

  return finish(await deferrals.take(id));
}

function finish(answer: QueueAnswer): GateAnswer {
  return answer.run ? { run: true, spent: answer.spent } : refuse(answer.reason, answer.message);
}

/** No queue to hold the ask: the live prompt answers it alone, or nobody can. */
async function askLive(
  review: ApprovalResult,
  policy: ShellApprovalPolicy,
  ask: { readonly mode: ShellApprovalMode; readonly executor: string; readonly request: (parking: boolean) => Promise<ShellApprovalRequest> },
): Promise<GateAnswer> {
  const outcome = ask.mode === 'strict' && policy.requestApproval
    ? await policy.requestApproval(await ask.request(false), new AbortController().signal)
    : null;

  if (outcome === null) {
    // Do not say "nobody to ask" under deny_all; it would invite re-asking.
    return ask.mode === 'deny_all'
      ? refuse('denied', `NOT RUN: refused by standing policy (deny_all): ${formatApproval(review)}`)
      : refuse('unavailable', `NOT RUN: needs owner approval, nobody to ask: ${formatApproval(review)}`);
  }

  if (!approvalGrants(outcome)) return refuse('denied', `${APPROVAL_DENIED} by the owner: ${formatApproval(review)}`);

  if (outcome === 'allow_always') policy.deferrals?.remember(gatedGrants(review.hits, ask.executor));

  return { run: true };
}

/** The mode/grant/channel/deferral ladder; a `run: true` from a replayed park carries a spend the caller settles.
 *  A write is shown to whoever is asked and parks bound to its bytes; `parks` false refuses an unanswered ask. */
async function decideApproval(
  subject: {
    readonly command: string; readonly executor: string;
    /** Resolved only when an owner's answer is asked for; a refusal there is the answer. */
    readonly context: () => Promise<ExecutionContext | KinuError>;
    readonly write?: () => Promise<WriteSubject>; readonly parks?: boolean;
  },
  rawReview: ApprovalResult,
  policy: ShellApprovalPolicy,
): Promise<GateAnswer> {
  const { command: cmd, executor, write, parks = true } = subject;
  await policy.resolve?.();
  const mode = policy.mode();
  const review = afterGrants(rawReview, policy, executor);
  let shown: Promise<WriteSubject> | null = null;
  let context: ExecutionContext = {};

  // A parked write's text names its bytes; the one asked now is shown them.
  const request = async (parking: boolean): Promise<ShellApprovalRequest> => {
    shown ??= write?.() ?? null;
    const bytes = await shown;

    if (bytes === null) return { command: cmd, executor, context, review };

    return { command: parking ? boundWriteCommand(bytes) : cmd, executor, context, review, write: bytes };
  };

  let spent: ApprovalSpend | undefined;

  if (review.decision === 'deny') {
    return refuse('denied', `${APPROVAL_DENIED}: ${formatApproval(review)}`);
  }

  if (review.decision === 'gate') {
    if (mode === 'allow_all') {
      diagnostics.failure(
        'approval.gate_bypassed',
        new KinuError('unsupported', 'allow_all mode cannot ask the owner; the gated command ran unapproved'),
        { executor, rules: review.hits.map((h) => h.rule).join(',') },
      );
    } else {
      // Only 'strict' asks anyone; the context it asks with is read now, once.
      const resolved = mode === 'strict' ? await subject.context() : context;

      if (resolved instanceof KinuError) return { run: false, error: resolved };
      context = resolved;
      const asked = await askOwner(review, rawReview, policy, { mode, executor, parks, request });

      if (!asked.run) return asked;
      spent = asked.spent;
    }
  }

  if (review.decision === 'warn') {
    if (mode === 'deny_all') {
      return refuse('denied', `${APPROVAL_DENIED} (deny_all mode): ${formatApproval(review)}`);
    }

    diagnostics.failure(
      'approval.warn_unenforced',
      new KinuError('unsupported', 'a warn-level review is not put to the owner; the command ran'),
      { executor, rules: review.hits.map((h) => h.rule).join(',') },
    );
  }

  return spent === undefined ? { run: true } : { run: true, spent };
}

/** Grants an 'always' answer buys: each asked rule, on its executor. Wider than the ask on purpose: the ask is the
 *  command in its context, while "always allow" trusts the rules it tripped on that machine, wherever they recur. */
export function gatedGrants(hits: readonly { readonly rule: string; readonly decision: string }[], executor: string): ApprovalGrant[] {
  return hits.filter((h) => h.decision === 'gate').map((h) => ({ rule: h.rule, executor }));
}

/** Whether every grant in `child` is in `parent`: the facet invariant. */
export function grantsAreSubset(
  child: readonly ApprovalGrant[],
  parent: readonly ApprovalGrant[],
): boolean {
  const held = new Set(parent.map(formatApprovalGrant));

  return child.every((g) => held.has(formatApprovalGrant(g)));
}

/** A facet's grants: the root's set (`own === null` inherits) intersected with its own narrowing. */
export function resolveInheritedGrants(source: {
  readonly root: readonly ApprovalGrant[];
  readonly own: readonly ApprovalGrant[] | null;
}): ApprovalGrant[] {
  const root = [...source.root];

  if (source.own === null || source.own.length === 0) return root;
  const held = new Set(root.map(formatApprovalGrant));

  return source.own.filter((g) => held.has(formatApprovalGrant(g)));
}

export interface InheritedApprovalSource {
  /** The root's mode and grants; fetched once per decision via {@link ShellApprovalPolicy.resolve}. */
  fetchRoot(): Promise<{ mode: ShellApprovalMode; grants: readonly ApprovalGrant[] }>;
  /** This facet's own narrowing; `null` inherits the root's set. */
  ownGrants(): readonly ApprovalGrant[] | null;
  /**
   * The workspace's queue, as this facet parks on it (`DeferredApprovalQueue.channelFor`): its gated commands wait on
   * the owner as the root's do. Absent, nobody listens and a gate is refused.
   */
  deferrals?(): DeferredApprovalChannel | undefined;
}

/**
 * A facet's policy: no `requestApproval`, so it cannot widen its reach; `strict` with nothing
 * granted until the first resolve. A gated command parks on the owner through the workspace's one queue.
 */
export function createInheritedApprovalPolicy(
  source: InheritedApprovalSource,
): ShellApprovalPolicy {
  let mode: ShellApprovalMode = 'strict';
  let grants: readonly ApprovalGrant[] = [];

  return {
    async resolve() {
      const root = await source.fetchRoot();
      mode = root.mode;
      grants = resolveInheritedGrants({ root: root.grants, own: source.ownGrants() });
    },
    mode: () => mode,
    granted: (grant) => holdsGrant(grants, grant),
    get deferrals() { return source.deferrals?.(); },
  };
}
