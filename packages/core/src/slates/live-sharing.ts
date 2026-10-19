/** Owner side of sharing a running slate: the one place a grant is cut. Reads go to the store, so a revoked share stops answering everywhere. */
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { cutShareGrant } from './capability-graph';
import type { ShareAuthority, SlateLiveShareStore } from './live-shares';
import type { ShareMode } from './share-modes';
import type { SlateEffect } from '../safety/approval-kind';
import type { LiveShareCreated, LiveShareVisibility, SlateCapabilityGraph } from './sharing';
import { nanoid } from '../utils/nanoid';

/** Ten lowercase hex characters — the handle half of the share-host label. */
function shareHandle(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `url` answers the share's one link, the app's page for it, or null where no app origin is wired; a share forks unless told not to. */
export function shareLiveSlate(input: {
  readonly shares: SlateLiveShareStore;
  readonly graph: SlateCapabilityGraph;
  readonly visibility: LiveShareVisibility;
  readonly approved: readonly { slate: string; namespace: string; member: string }[];
  readonly fork?: boolean;
  /** The share's one link, by its id: the app's page for it, never its bare host. */
  readonly url: (share: string) => string | null;
}): LiveShareCreated {
  // Every share starts in `own` mode: only its owner turns on `owner`, over the share sheet's reach ({@link setShareMode}).
  const grant = { ...cutShareGrant(input.graph, input.approved), fork: input.fork ?? true };
  const handle = shareHandle();
  const share = input.shares.add({ id: nanoid(), slate: input.graph.slate, visibility: input.visibility, handle, grant });

  return { share, url: input.url(share.id) };
}

/**
 * A live share's mode set by its owner: `owner`, its reach approved again over the slate's graph now (its observing
 * members, and the acting ones they approve) at the slate's revision now, which re-arms a share an edit suspended;
 * `own`, its server acting with no one's access. A share keeps whether it forks.
 */
export function setShareMode(input: {
  readonly shares: SlateLiveShareStore;
  readonly share: string;
  readonly graph: SlateCapabilityGraph;
  readonly mode: ShareMode;
  readonly approved: readonly { slate: string; namespace: string; member: string }[];
  readonly revision: string | null;
}): void {
  return settleSync(Effect.gen(function* () {
    const held = input.shares.get(input.share);

    if (held === undefined || held.revokedAt !== null || held.slate !== input.graph.slate) return yield* new KinuError('missing', 'No such share');
    const authority = yield* authorityAt(input.mode, input.revision);
    const grant = { ...cutShareGrant(input.graph, input.mode === 'owner' ? input.approved : []), fork: held.grant.fork ?? true };

    input.shares.setAuthority(input.share, authority, grant);
  }));
}

/** `mode` as it is stored: `owner` names the revision its reach was approved at, and a slate never built has none. */
function authorityAt(mode: ShareMode, revision: string | null): Effect.Effect<ShareAuthority, KinuError> {
  if (mode === 'own') return Effect.succeed({ mode: 'own', grantRevision: null });

  if (revision === null) return Effect.fail(new KinuError('bad_input', 'This slate has not built yet, so there is no version of it to approve its reach for: build it first'));

  return Effect.succeed({ mode: 'owner', grantRevision: revision });
}

/**
 * The owner's "Always for this slate" on one effect the shared server asked of them: that tool, on that root, by the
 * slate that called it, stands on every `owner` share of the shared server at the revision it ran at. The shares it
 * stands on.
 */
export function preapproveSlateEffect(live: SlateLiveShareStore, effect: SlateEffect): string[] {
  return live.preapprove(effect.slate, { slate: effect.caller, namespace: effect.server, member: effect.tool, root: { ...effect.root }, revision: effect.revision });
}
