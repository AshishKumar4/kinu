/** Asks the owner about what review gates, and keeps their grants. */

import { Effect } from 'effect';
import { CODE_WORK_DID_NOT_START, diagnostics, KinuError, type ErrorCode } from '../obs/index';
import { boundWriteCommand, type WriteSubject } from './bound-write';
import { dominant, reviewFileAccess, reviewShellCommand, type ApprovalResult, type FileAccess, type GatedExecutor } from './command-review';

export interface ShellApprovalRequest {
  readonly command: string;
  /** The target executor; the same command is a different request on a different machine. */
  readonly executor: string;
  readonly review: ApprovalResult;
  /** A file write's ask: what it replaces and with what. A parked one is bound to these bytes. */
  readonly write?: WriteSubject;
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
export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Read at call time, so a mode or channel change applies to the next command. */
export interface ShellApprovalPolicy {
  mode(): ShellApprovalMode;
  /** Whether the owner granted this rule on this executor; consulted before asking. */
  granted?(grant: ApprovalGrant): boolean;
  /** The 'gate' channel under 'strict', read live; null: nobody listens, so `deferrals`, else a refusal. */
  requestApproval?: ((req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>) | null;
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

/** Parks an unanswered 'gate' on the owner (safety/deferred-approval.ts). `run: true`: the grant is spent;
 *  `settle` refunds unrun attempts. */
export interface DeferredApprovalChannel {
  park(req: ShellApprovalRequest): Promise<
    | { readonly run: true; readonly spent: ApprovalSpend }
    | { readonly run: false; readonly reason: 'denied' | 'unavailable'; readonly message: string }
  >;
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

/** The mode/grant/channel/deferral ladder; a `run: true` from a replayed park carries a spend the caller settles.
 *  A write is shown to whoever is asked and parks bound to its bytes; `parks` false refuses an unanswered ask. */
async function decideApproval(
  subject: {
    readonly command: string; readonly executor: string;
    readonly write?: () => Promise<WriteSubject>; readonly parks?: boolean;
  },
  rawReview: ApprovalResult,
  policy: ShellApprovalPolicy,
): Promise<
  | { readonly run: true; readonly spent?: ApprovalSpend }
  | { readonly run: false; readonly error: KinuError }
> {
  const { command: cmd, executor, write, parks = true } = subject;
  await policy.resolve?.();
  const mode = policy.mode();
  const review = afterGrants(rawReview, policy, executor);
  const refuse = (reason: ErrorCode, message: string) => ({ run: false, error: new KinuError(reason, message) } satisfies { run: false; error: KinuError });
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
      // 'deny_all' never asks; null channel means nobody is listening.
      const outcome = mode === 'strict' && policy.requestApproval
        ? await policy.requestApproval(await request(false))
        : null;

      if (outcome === null) {
        // Under 'strict', an unanswered ask parks if a queue is wired, only after the channel declines.
        const deferrals = mode === 'strict' && parks ? policy.deferrals : undefined;
        const parked = deferrals === undefined ? undefined : await deferrals.park(await request(true));

        if (parked && !parked.run) return refuse(parked.reason, parked.message);

        if (!parked) {
          // Do not say "nobody to ask" under deny_all; it would invite re-asking.
          return mode === 'deny_all'
            ? refuse('denied', `NOT RUN: refused by standing policy (deny_all): ${formatApproval(review)}`)
            : refuse('unavailable', `NOT RUN: needs owner approval, nobody to ask: ${formatApproval(review)}`);
        }

        // A parked grant was just spent; execute and carry the spend out.
        spent = parked.spent;
      } else if (!approvalGrants(outcome)) {
        return refuse('denied', `${APPROVAL_DENIED} by the owner: ${formatApproval(review)}`);
      } else if (outcome === 'allow_always') {
        policy.remember?.(gatedGrants(review, executor));
      }
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
export function gatedGrants(review: ApprovalResult, executor: string): ApprovalGrant[] {
  return review.hits.filter((h) => h.decision === 'gate').map((h) => ({ rule: h.rule, executor }));
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
}

/**
 * A facet's policy: no `remember` or `requestApproval`, so it cannot widen its reach; `strict` with nothing
 * granted until the first resolve.
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
  };
}
