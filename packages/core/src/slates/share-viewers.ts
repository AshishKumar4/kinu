/**
 * A live share's viewers: who is let in and when, what a viewer's call may reach, the audit row each call leaves, and
 * what the share may spend in a day. The backend answers these decisions over HTTP and runs the routes they admit.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError, refusalOf } from '../obs/error';
import { settle } from '../obs/effect';
import { usageTotal, UsageSchema } from '../usage';
import type { MissionGovernor } from '../mission-budget';
import type { JsonValue } from '../utils/json';
import { shareCaller, type SlateCaller } from './caller';
import type { SlateLiveShareStore } from './live-shares';
import { slateAddressImpact } from './members';
import { isJsonAnswer, type SlateCallResult, type SlateSurfaceResult } from './rpc';
import {
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, shareSpendLabel,
  type LiveShareRecord, type ShareViewerClaim, type ViewerCall,
} from './sharing';
import { admitNestedViewerCall, routeViewerCall, slateCallAddress, type SlateCallRequest, type SlateInvocation, type SlateRoute, type SlateViewer } from './surface';

export interface SlateShareViewersDeps {
  readonly live: SlateLiveShareStore;
  /** The app's page a `users` share is entered through, or null where this deployment names no app origin. */
  shareEntry(share: string): string | null;
  /** Whether one more request under `key` fits `perMinute`; absent means no per-viewer rate bound, as at the edge. */
  admitted?(key: string, perMinute: number): Promise<boolean>;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerUserId?(): string | null;
}

/** What a request to a share's page is answered, before anything of the owner's runs. */
export type ViewerAdmission =
  | { readonly kind: 'missing' }
  /** A visitor not yet known signs in at the app, whose ticket brings them back as themselves. */
  | { readonly kind: 'sign-in'; readonly entry: string }
  | { readonly kind: 'too-many' }
  /** The connections the grant reaches, disclosed before the viewer goes on. */
  | { readonly kind: 'consent'; readonly share: LiveShareRecord; readonly namespaces: readonly string[] }
  | { readonly kind: 'admitted'; readonly caller: SlateCaller; readonly share: LiveShareRecord; readonly viewer: SlateViewer };

/** How a viewer's admitted call runs, as the caller it was admitted as, with what it reaches inside itself held to the grant. */
export type ViewerRun = (route: SlateRoute, nested: (namespace: string, member: string) => void) => Promise<SlateSurfaceResult>;

/** A viewer's answer is JSON: routing refuses a viewer every streamed member, so a stream here is a routing fault. */
function viewerAnswer(result: SlateSurfaceResult): SlateCallResult {
  if (!result.ok) return result;

  return isJsonAnswer(result.value)
    ? { ...result, value: result.value }
    : { ok: false, ...refusalOf(new KinuError('io', 'A share viewer\'s call answered a stream')) };
}

export class SlateShareViewers {
  constructor(private readonly deps: SlateShareViewersDeps) {}

  admits(share: string, userId: string): boolean {
    return userId === this.deps.ownerUserId?.() || this.deps.live.hasUser(share, userId);
  }

  /** Re-reads the share row now (S6: a revoked share refuses before a process starts). */
  async admit(input: { readonly handle: string; readonly claim: ShareViewerClaim; readonly pathname: string }): Promise<ViewerAdmission> {
    const share = this.deps.live.byHandle(input.handle);

    if (share === undefined) return { kind: 'missing' };
    const entry = share.visibility === 'users' && input.claim.userId === null ? this.deps.shareEntry(share.id) : null;

    if (entry !== null) return { kind: 'sign-in', entry };

    if (share.visibility === 'users' && (input.claim.userId === null || !this.admits(share.id, input.claim.userId))) return { kind: 'missing' };
    const subject = input.claim.userId === null ? `source:${input.claim.source}` : `user:${input.claim.userId}`;

    // S2: a viewer past the bound is refused; the share is never paused.
    if (this.deps.admitted !== undefined && !await this.deps.admitted(`${share.id}:${subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) return { kind: 'too-many' };
    const namespaces = [...new Set(share.grant.members.map((member) => member.namespace))];

    // D3: the consent page precedes anything of the owner's running, for named viewers too; a grant reaching nothing
    // of the owner's has nothing to disclose.
    if (!input.claim.consented && namespaces.length > 0) return { kind: 'consent', share, namespaces };
    const request = this.deps.live.openRequest({ share: share.id, viewer: subject, path: input.pathname });

    return { kind: 'admitted', caller: shareCaller(share.id), share, viewer: { share: share.id, subject, request } };
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
  }): Promise<SlateCallResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const { id, request, chain, issued } = input;

      if (issued?.viewer === undefined) return yield* new KinuError('denied', 'A viewer call must name the invocation it was issued under');
      const viewer = issued.viewer;
      const named = slateCallAddress(request.path);
      // What the audit row says, as far as the call got: refused until it is routed and answered.
      let row: ViewerCall = { slate: id, ...named, impact: slateAddressImpact(named) ?? 'administer', ok: false };
      const share = this.deps.live.live(input.share);
      const governor = this.deps.budget?.();

      const answered = Effect.gen({ self: this }, function* () {
        // S2: the per-day spend bound refuses as 'budget'.
        if (governor !== undefined && governor.guard('model_call', [shareSpendLabel(share.id)]) !== null) {
          return yield* new KinuError('budget', 'This share is paused for today');
        }

        const call = routeViewerCall({ id, request, chain, viewer, grant: share.grant });
        row = { slate: id, ...call.address, impact: call.impact, ok: false };

        // What the call reaches inside itself meets the grant as it stands then: a revoke mid-call ends it there.
        const nested = (namespace: string, member: string) => { admitNestedViewerCall(this.deps.live.live(input.share).grant, id, { namespace, member }); };

        const result = viewerAnswer(yield* Effect.promise(async () => input.run(call.route, nested)));
        row = { ...row, ok: result.ok };

        if (result.ok) this.debit(share, result.value);

        return result;
      });

      return yield* Effect.ensuring(answered, Effect.sync(() => { this.deps.live.recordCall(viewer.request, row); }));
    }));
  }

  /** The label carries the UTC day, so the bound renews without a rollover job; unparented so no turn owns it. */
  private debit(share: LiveShareRecord, value: JsonValue): void {
    const governor = this.deps.budget?.();

    if (governor === undefined) return;
    governor.declare(shareSpendLabel(share.id), { usd: SHARE_SPEND_CAP_USD_PER_DAY }, { parent: '' });
    const usage = v.safeParse(v.object({ usage: v.optional(UsageSchema) }), value);

    governor.debit(usage.success && usage.output.usage !== undefined ? usageTotal(usage.output.usage) ?? 0 : 0, {
      labels: [shareSpendLabel(share.id)], calls: 1,
      usage: usage.success ? usage.output.usage : undefined,
    });
  }
}
