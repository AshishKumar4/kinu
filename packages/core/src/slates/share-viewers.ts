/**
 * A live share's viewers: who is let in and when, what a viewer's call may reach, the audit row each call leaves, and
 * what the share may spend in a day. The backend answers these decisions over HTTP and runs the routes they admit.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError, refusalOf } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { usageTotal, UsageSchema, type Usage } from '../usage';
import type { MissionGovernor } from '../mission-budget';
import type { JsonValue } from '../utils/json';
import { shareCaller, type SlateCaller } from './caller';
import type { SlateLiveShareStore } from './live-shares';
import type { ApprovalSpend } from '../safety/approval-gate';
import type { OwnerEffects, ServerSend } from './shared-server';
import { AGENT_ASK_MEMBER, slateAddressImpact } from './members';
import { isJsonAnswer, type SlateCallResult, type SlateSurfaceResult } from './rpc';
import {
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, SLATE_RPC_PATH, shareGrantKey, shareSpendLabel,
  type LiveShareRecord, type ShareViewerClaim, type ViewerCall,
} from './sharing';
import { admitNestedViewerCall, routeViewerCall, SLATE_DRIVEN_MEMBERS, slateCallAddress, type SlateCall, type SlateCallRequest, type SlateInvocation, type SlateRoute, type SlateViewer } from './surface';
import { ANONYMOUS_SUBJECT_PREFIX, appAgentVisitorPayer, type AppAgentPayer } from './app-agent';
import type { ShareMode } from './share-modes';

/** Every signed-in viewer, where the deployment keeps no key to tell them apart by. */
const SIGNED_IN_VIEWER = 'viewer';

export interface SlateShareViewersDeps {
  readonly live: SlateLiveShareStore;
  /** The app's page a `users` share is entered through, or null where this deployment names no app origin. */
  shareEntry(share: string): string | null;
  /** Whether one more request under `key` fits `perMinute`; absent means no per-viewer rate bound, as at the edge. */
  admitted?(key: string, perMinute: number): Promise<boolean>;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerUserId?(): string | null;
  /**
   * A signed-in viewer's key on a share: the deployment's keyed hash of them, which no one links to them, or one share's
   * viewer to another's, without its secret. Their requests and conversations are kept under it, never their account,
   * so a deleted account leaves nothing here that names it. Absent or null, every signed-in viewer is one.
   */
  viewerKey?(share: string, userId: string): Promise<string | null>;
  /** Settles a spent approval once its call was handed on (shared-server.ts takes it at the send). */
  readonly ownerEffects?: Pick<OwnerEffects, 'settle'>;
}

/** What a request to a share's page is answered, before anything of the owner's runs. */
export type ViewerAdmission =
  | { readonly kind: 'missing' }
  /** A visitor not yet known signs in at the app, whose ticket brings them back as themselves. */
  | { readonly kind: 'sign-in'; readonly entry: string }
  | { readonly kind: 'too-many' }
  /** The grant reaches what the viewer has not accepted on Kinu's page: nothing of the owner's runs for them yet. */
  | { readonly kind: 'consent'; readonly share: LiveShareRecord }
  | { readonly kind: 'admitted'; readonly caller: SlateCaller; readonly share: LiveShareRecord; readonly viewer: SlateViewer };

/**
 * How a viewer's admitted call runs, as the caller it was admitted as, with what it reaches inside itself held to the
 * grant. `admit` is the share's and the server's word on the call read again where it acts: the dispatch calls it
 * synchronously, with nothing awaited between it and the send, and it throws when either no longer lends the call.
 */
export type ViewerRun = (route: SlateRoute, nested: (namespace: string, member: string) => void, admit: () => void) => Promise<SlateSurfaceResult>;

/**
 * A viewer's answer is JSON: their app agent's reply arrives as its whole text, and routing refuses a viewer every other
 * streamed member, so any other stream here is a routing fault.
 */
async function viewerAnswer(result: SlateSurfaceResult): Promise<SlateCallResult> {
  if (!result.ok) return result;
  const { value } = result;

  if (isJsonAnswer(value)) return { ...result, value };

  if (!(value instanceof ReadableStream)) return { ok: true, value: { reply: await new Response(value.reply).text() } };

  return { ok: false, ...refusalOf(new KinuError('io', 'A share viewer\'s call answered a stream')) };
}

/** What a call's answer says it spent, where it says so (an `ai.run`'s `usage`). */
function usageOf(value: JsonValue): Usage | undefined {
  const parsed = v.safeParse(v.object({ usage: v.optional(UsageSchema) }), value);

  return parsed.success ? parsed.output.usage : undefined;
}

/** Whether a grant, by its key, is one its viewer accepted: theirs exactly, or one reaching nothing of the owner's. */
function grantAccepted(grant: string, consented: string): boolean {
  return grant === '' || grant === consented;
}

/** Why a viewer's call waits: the share's grant reaches more of its owner's than they accepted on Kinu's page. */
const UNACCEPTED = 'This app reaches more of its owner\'s than you accepted: see what first';

export class SlateShareViewers {
  constructor(private readonly deps: SlateShareViewersDeps) {}

  admits(share: string, userId: string): boolean {
    return userId === this.deps.ownerUserId?.() || this.deps.live.hasUser(share, userId);
  }

  /** What a signed-in viewer is kept under on `share`: its key for them, or, with none, every signed-in viewer's. */
  private async signedIn(share: string, userId: string): Promise<string> {
    const key = await this.deps.viewerKey?.(share, userId) ?? null;

    return key === null ? SIGNED_IN_VIEWER : `viewer:${key}`;
  }

  /** Whom a share's visitor is to it: their account's key signed in, their browser's anonymous id, else where they came from. */
  private async subjectOf(share: string, claim: ShareViewerClaim): Promise<string> {
    if (claim.userId !== null) return await this.signedIn(share, claim.userId);

    return claim.anonymous === undefined ? `source:${claim.source}` : `${ANONYMOUS_SUBJECT_PREFIX}${claim.anonymous}`;
  }

  /** Re-reads the share row now (S6: a revoked share refuses before a process starts). */
  async admit(input: { readonly handle: string; readonly claim: ShareViewerClaim; readonly pathname: string }): Promise<ViewerAdmission> {
    const share = this.deps.live.byHandle(input.handle);

    if (share === undefined) return { kind: 'missing' };
    const entry = share.visibility === 'users' && input.claim.userId === null ? this.deps.shareEntry(share.id) : null;

    if (entry !== null) return { kind: 'sign-in', entry };

    if (share.visibility === 'users' && (input.claim.userId === null || !this.admits(share.id, input.claim.userId))) return { kind: 'missing' };
    const subject = await this.subjectOf(share.id, input.claim);

    // S2: a viewer past the bound is refused; the share is never paused.
    if (this.deps.admitted !== undefined && !await this.deps.admitted(`${share.id}:${subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) return { kind: 'too-many' };
    const grant = shareGrantKey(share.grant);
    const consented = input.claim.consented ?? '';

    // D3: what the grant reaches of the owner's is accepted on Kinu's page before anything of theirs runs, for named
    // viewers too, and again once it reaches more; a grant reaching nothing of the owner's has nothing to accept. The
    // app's page's session is let in regardless, its every call refused until then (`unaccepted`): that refusal is how a
    // page already open, its socket reopened as the grant widened, tells Kinu's page to ask.
    if (!grantAccepted(grant, consented) && input.pathname !== SLATE_RPC_PATH) return { kind: 'consent', share };
    const request = this.deps.live.openRequest({ share: share.id, viewer: subject, path: input.pathname });

    const viewer: SlateViewer = { share: share.id, subject, request, consented, ...(input.claim.userId !== null && { userId: input.claim.userId }) };

    return { kind: 'admitted', caller: shareCaller(share.id), share, viewer };
  }

  /** A viewer's call routed and weighed before anything of the owner's is asked: held first to the shared server's
   *  bound, then to the grant; and whether it acts. */
  private routed(input: Parameters<SlateShareViewers['call']>[0], share: LiveShareRecord): Effect.Effect<{ readonly call: SlateCall; readonly effect: boolean }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { id, request, chain } = input;
      const beyond = yield* input.bound(slateCallAddress(request.path));

      if (beyond !== null) return yield* beyond;
      const call = routeViewerCall({ id, request, chain, grant: share.grant });
      // A browser member the class runs acts there once the host authorizes it, so that ask is what acts; its host
      // member only ever reports the class's refusal (web-operations.ts), which acts on nothing.
      const reportOnly = request.authorize !== true && call.address.namespace === 'web' && SLATE_DRIVEN_MEMBERS.includes(call.address.member);

      return { call, effect: call.impact !== 'observe' && !reportOnly };
    });
  }

  /** Reads the ledger row, never `guard`, which stamps exhaustion and fires the once-per-label event. */
  paused(share: LiveShareRecord): boolean {
    const governor = this.deps.budget?.();

    if (governor === undefined) return false;

    return governor.snapshot(shareSpendLabel(share.id)).some((row) => row.exhausted);
  }

  /**
   * A viewer's call: the grant decides, every call is audited, and what it spends is the share's. The share row is read
   * now, so a revoked share refuses before there is a call of it to audit.
   */
  call(input: {
    readonly share: string;
    readonly id: string;
    readonly request: SlateCallRequest;
    readonly chain: readonly string[];
    readonly issued: SlateInvocation | null;
    readonly run: ViewerRun;
    /**
     * The shared server's word on the routed call (shared-server.ts `SharedServers.gate`): refused where it lends nothing
     * or does not reach it, or where its owner has not approved the effect; else the send, which weighs it again.
     */
    readonly gate: (call: { readonly address: { readonly namespace: string; readonly member: string }; readonly effect: boolean }) => Effect.Effect<ServerSend, KinuError>;
    /** The shared server's bound alone, met first (it asks no one): why it lends nothing or no reach here, or null. */
    readonly bound: (address: { readonly namespace: string; readonly member: string }) => Effect.Effect<KinuError | null>;
  }): Promise<SlateCallResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const { id, request, issued } = input;

      if (issued?.viewer === undefined) return yield* new KinuError('denied', 'A viewer call must name the invocation it was issued under');
      const viewer = issued.viewer;
      const named = slateCallAddress(request.path);
      // What the audit row says, as far as the call got: refused until it is routed and answered.
      let row: ViewerCall = { slate: id, ...named, impact: slateAddressImpact(named) ?? 'administer', ok: false };
      const share = this.deps.live.live(input.share);

      const answered = Effect.gen({ self: this }, function* () {
        const unaccepted = yield* this.unaccepted(share, viewer);

        if (unaccepted !== null) return unaccepted;
        yield* this.notPaused(share);
        const routed = yield* this.routed(input, share);
        const { call } = routed;
        row = { slate: id, ...call.address, impact: call.impact, ok: false };
        const send = yield* input.gate({ address: call.address, effect: routed.effect });
        const taken: ApprovalSpend[] = [];

        // The share's and the server's word read again where the call acts: a revoke, a mode change or an approval
        // taken back while the dispatch prepared stops the call there, and nothing of the owner's is spent.
        const admit = (): void => {
          this.stillLends(share);
          this.stillAccepted(input.share, viewer);
          const spend = send.admit();

          if (spend !== null) taken.push(spend);
        };

        // What the call reaches inside itself meets the grant as it stands then: a revoke mid-call ends it there.
        const nested = (namespace: string, member: string) => {
          this.stillAccepted(input.share, viewer);
          admitNestedViewerCall(this.deps.live.live(input.share).grant, id, { namespace, member });
        };

        const ran = yield* Effect.exit(Effect.promise(async () => input.run(call.route, nested, admit)));
        const [spend = null] = taken;

        // The approval is used once the call was handed on: a failure after that may have acted, so it never runs twice
        // on one word of the owner's. The same call made again asks again.
        if (spend !== null) yield* Effect.promise(async () => this.deps.ownerEffects?.settle(spend, 'spent'));
        const surfaced = yield* ran;
        const result = yield* Effect.promise(async () => viewerAnswer(surfaced));
        row = { ...row, ok: result.ok };

        if (result.ok) this.debit(share, usageOf(result.value));

        return result;
      });

      return yield* Effect.ensuring(answered, Effect.sync(() => { this.deps.live.recordCall(viewer.request, row); }));
    }));
  }

  /** The viewer's share still as it lent the call: live, and in the mode it was in. Throws to refuse at the send. */
  stillLends(lent: LiveShareRecord): void {
    return settleSync(Effect.suspend(() => {
      const now = this.deps.live.get(lent.id);

      if (now === undefined || now.revokedAt !== null) return Effect.fail(new KinuError('denied', 'This slate is no longer shared'));

      return now.mode === lent.mode ? Effect.void : Effect.fail(new KinuError('denied', 'This share changed how it lends before the call was made'));
    }));
  }

  /**
   * A viewer's `agent.ask`, admitted as the share stands now: who pays for their app agent (app-agent.ts), or what they
   * must do first; audited as each of their calls is. `run` answers it as that payer, the share lending as it does now.
   */
  ask(input: {
    readonly id: string;
    readonly viewer: SlateViewer;
    /** What the visitor last acknowledged of how the share lends (app-agent.ts `acknowledgedMode`). */
    readonly acknowledged: ShareMode | null;
    readonly run: (payer: AppAgentPayer, share: LiveShareRecord) => Promise<SlateSurfaceResult>;
  }): Promise<SlateCallResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const { id, viewer } = input;
      const share = this.deps.live.live(viewer.share);
      let row: ViewerCall = { slate: id, namespace: 'agent', member: AGENT_ASK_MEMBER, impact: 'observe', ok: false };

      const answered = Effect.gen({ self: this }, function* () {
        if (id !== share.slate) return yield* new KinuError('denied', `A share's assistant answers for its app, ${share.slate}, alone`);
        const unaccepted = yield* this.unaccepted(share, viewer);

        if (unaccepted !== null) return unaccepted;
        const owner = this.deps.ownerUserId?.() ?? null;

        if (owner === null) return yield* new KinuError('unavailable', 'This app has no owner to lend its assistant');
        const payer = appAgentVisitorPayer({ mode: share.mode, subject: viewer.subject, userId: viewer.userId ?? null, owner });

        // Answered as a value: the share's page reads `needs`, and asks Kinu what its visitor must do.
        if ('needs' in payer) {
          const why = payer.needs === 'identity' ? 'Sign in, or continue anonymously, to talk to this app\'s assistant' : 'Sign in to talk to this app\'s assistant: it answers on your own models';

          return { ok: false as const, ...refusalOf(new KinuError('denied', why)), needs: 'identity' as const };
        }

        // Run only under how the share lends now as the visitor accepted it: a share whose mode changed since asks them
        // again, before anything of theirs runs or is kept.
        if (input.acknowledged !== share.mode) {
          const why = input.acknowledged === null ? 'See how this app\'s assistant answers you first' : 'This app\'s assistant changed how it answers you: see what changed first';

          return { ok: false as const, ...refusalOf(new KinuError('denied', why)), needs: 'identity' as const };
        }

        // Signed-in visitors this deployment cannot tell apart would share one conversation the owner lends.
        if (payer.kind === 'lent' && viewer.subject === SIGNED_IN_VIEWER) return yield* new KinuError('unavailable', 'This deployment cannot tell its signed-in visitors apart, so its assistant answers none of them');

        if (payer.kind === 'lent') yield* this.notPaused(share);
        const result = yield* Effect.promise(async () => viewerAnswer(await input.run(payer, share)));
        row = { ...row, ok: result.ok };

        if (result.ok) this.debit(share, undefined);

        return result;
      });

      return yield* Effect.ensuring(answered, Effect.sync(() => { this.deps.live.recordCall(viewer.request, row); }));
    }));
  }

  /**
   * A step of a share's app agent, and each call it sends: refused once the share ended or changed how it lends, and
   * where the owner lends their model, once it is paused for the day or its code moved past the revision they approved;
   * where the visitor pays, once its code moved past the one they consented to. Throws to refuse.
   */
  admitAgentStep(share: LiveShareRecord, step: { readonly lent: boolean; readonly revision: string; readonly consented: string; readonly accepted: string }): void {
    this.stillLends(share);
    this.stillAccepted(share.id, { consented: step.accepted });

    return settleSync(Effect.gen({ self: this }, function* () {
      const now = this.deps.live.live(share.id);

      if (!step.lent) {
        if (step.revision !== step.consented) return yield* new KinuError('denied', "This app's code changed since you let its assistant use your models: ask again to allow it");

        return;
      }

      yield* this.notPaused(now);

      if (now.grantRevision !== step.revision) return yield* new KinuError('denied', 'This app changed since its owner approved what My access lends: its assistant waits for them');
    }));
  }

  /** What a step of an app agent the owner lends on `share` spent of their model, counted against the share's day. */
  lentSpent(share: string, usage: Usage): void {
    this.debit(this.deps.live.live(share), usage, 0);
  }

  /**
   * A refusal the viewer's page acts on where the share's grant reaches more of its owner's than they accepted, the
   * page open since: Kinu's page shows them what, and runs nothing until they accept it; null where it does not.
   */
  private unaccepted(share: LiveShareRecord, viewer: SlateViewer): Effect.Effect<SlateCallResult | null> {
    return Effect.sync(() => (grantAccepted(shareGrantKey(share.grant), viewer.consented)
      ? null
      : { ok: false as const, ...refusalOf(new KinuError('denied', UNACCEPTED)), needs: 'consent' as const }));
  }

  /**
   * Where a call of the viewer's is sent, or reaches inside itself, and before each step of their app agent: the share's
   * grant as it stands then is the one they accepted. Throws to refuse.
   */
  stillAccepted(share: string, viewer: Pick<SlateViewer, 'consented'>): void {
    return settleSync(grantAccepted(shareGrantKey(this.deps.live.live(share).grant), viewer.consented) ? Effect.void : Effect.fail(new KinuError('denied', UNACCEPTED)));
  }

  /** S2: the per-day spend bound refuses as 'budget'. */
  private notPaused(share: LiveShareRecord): Effect.Effect<void, KinuError> {
    const governor = this.deps.budget?.();

    return governor !== undefined && governor.guard('model_call', [shareSpendLabel(share.id)]) !== null
      ? Effect.fail(new KinuError('budget', 'This share is paused for today'))
      : Effect.void;
  }

  /** The label carries the UTC day, so the bound renews without a rollover job; unparented so no turn owns it. */
  private debit(share: LiveShareRecord, usage: Usage | undefined, calls = 1): void {
    const governor = this.deps.budget?.();

    if (governor === undefined) return;
    const label = declareShareSpend(governor, share.id);

    governor.debit(usage === undefined ? 0 : usageTotal(usage) ?? 0, { labels: [label], calls, usage });
  }
}


/**
 * `share`'s spend label for today, declared on `governor` at the share's daily cap: what its viewers' calls and their
 * app agents' model calls on My access spend, one label on the workspace's one governor. Unparented, so no turn owns it.
 */
function declareShareSpend(governor: MissionGovernor, share: string): string {
  const label = shareSpendLabel(share);

  governor.declare(label, { usd: SHARE_SPEND_CAP_USD_PER_DAY }, { parent: '' });

  return label;
}
