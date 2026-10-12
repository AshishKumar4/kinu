/** Asks the owner about what review gates, and keeps their grants. */

import { Effect } from 'effect';
import { CODE_WORK_DID_NOT_START, detach, diagnostics, KinuError, toKinuError, type ErrorCode } from '../obs/index';
import { boundWriteCommand, type WriteSubject } from './bound-write';
import { dominant, reviewFileAccess, reviewShellCommand, type ApprovalResult, type FileAccess, type GatedExecutor } from './command-review';

export interface ShellApprovalRequest {
  readonly command: string;
  /** The target executor; the same command is a different request on a different machine. */
  readonly executor: string;
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
      { command: `file ${access.op} ${access.hostPath}`, executor, write: write?.subject, parks: write?.parks ?? false }, review, policy,
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
  /** Remember 'allow_always' for every rule the command tripped on this executor. */
  remember?(grants: readonly ApprovalGrant[]): void;
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
  | { readonly run: false; readonly reason: 'denied' | 'unavailable'; readonly message: string; readonly waiting?: string };

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
  /** Absent: a shell command from the executor's session. */
  readonly review?: (command: string, rest: readonly unknown[]) => Promise<ApprovalResult>;
}

export function gateExec<R>(
  execute: (command: string, ...rest: unknown[]) => Promise<R>,
  denyResult: (error: KinuError) => R,
  executor: GatedExecutor,
  tuning: ExecGateTuning<R> = {},
): (...args: unknown[]) => Promise<R> {
  const policy = tuning.policy ?? STRICT_NO_CHANNEL_POLICY;
  const refusalCode = tuning.refusalCode;

  // Rest args keep this assignable to `ExecutorProvider['tools'][name].execute` and to `Shell.exec`.
  return async (...args) => {
    const [command, ...rest] = args;
    const cmd = String(command);

    const review = tuning.review === undefined
      ? reviewShellCommand(executor, cmd, await executor.shellSession?.at(undefined, undefined))
      : await tuning.review(cmd, rest);

    const decision = await decideApproval({ command: cmd, executor: executor.name }, review, policy);

    if (!decision.run) return denyResult(decision.error);
    const result = await execute(cmd, ...rest);

    if (decision.spent) {
      const code = refusalCode?.(result) ?? null;
      await policy.deferrals?.settle(
        decision.spent,
        code !== null && CODE_WORK_DID_NOT_START[code] ? 'did-not-run' : 'spent',
      );
    }

    return result;
  };
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
  const id = parked.waiting;
  const shown = new AbortController();
  const answering = live({ ...await ask.request(false), approvalId: id }, shown.signal);
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

  if (outcome === 'allow_always') policy.remember?.(gatedGrants(review.hits, ask.executor));

  return { run: true };
}

/** The mode/grant/channel/deferral ladder; a `run: true` from a replayed park carries a spend the caller settles.
 *  A write is shown to whoever is asked and parks bound to its bytes; `parks` false refuses an unanswered ask. */
async function decideApproval(
  subject: {
    readonly command: string; readonly executor: string;
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

  // A parked write's text names its bytes; the one asked now is shown them.
  const request = async (parking: boolean): Promise<ShellApprovalRequest> => {
    shown ??= write?.() ?? null;
    const bytes = await shown;

    if (bytes === null) return { command: cmd, executor, review };

    return { command: parking ? boundWriteCommand(bytes) : cmd, executor, review, write: bytes };
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
      const asked = await askOwner(review, policy, { mode, executor, parks, request });

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

/** Grants an 'always' answer buys: each asked rule, on its executor. */
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
 * A facet's policy: no `remember` or `requestApproval`, so it cannot widen its reach; `strict` with nothing
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
