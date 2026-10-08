/** Owner side of sharing a running slate: the one place a grant is cut. Reads go to the store, so a revoked share stops answering everywhere. */
import { cutShareGrant } from './capability-graph';
import type { SlateLiveShareStore } from './live-shares';
import type { LiveShareCreated, LiveShareVisibility, SlateCapabilityGraph } from './sharing';
import { nanoid } from '../utils/nanoid';

/** Ten lowercase hex characters — the handle half of the share-host label. */
function shareHandle(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `url` answers the public address a handle serves, or null where no share host is wired; a share forks unless told not to. */
export async function shareLiveSlate(input: {
  readonly shares: SlateLiveShareStore;
  readonly graph: SlateCapabilityGraph;
  readonly visibility: LiveShareVisibility;
  readonly approved: readonly { slate: string; namespace: string; member: string }[];
  readonly fork?: boolean;
  readonly url: (handle: string) => Promise<string | null>;
}): Promise<LiveShareCreated> {
  const grant = { ...cutShareGrant(input.graph, input.approved), fork: input.fork ?? true };
  const handle = shareHandle();
  const share = input.shares.add({ id: nanoid(), slate: input.graph.slate, visibility: input.visibility, handle, grant });

  return { share, url: await input.url(handle) };
}
