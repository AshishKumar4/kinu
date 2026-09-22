/** Owner side of sharing a running slate. `share` is the one place a grant is cut; the rest re-reads the store, so a revoked share stops answering everywhere. */
import { cutShareGrant, slateCapabilityGraph, type SlateBindingCatalog } from './capability-graph';
import type { SlateLiveShareStore } from './live-shares';
import type { ShareUser } from './shares';
import * as v from 'valibot';
import {
  SlateCapabilityGraphSchema, ViewerRequestRecordSchema,
  type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility, type SlateCapabilityGraph, type ViewerRequestRecord,
} from './sharing';
import { nanoid } from '../utils/nanoid';

export interface WorkspaceLiveSharesDeps {
  readonly workspace: string;
  readonly shares: SlateLiveShareStore;
  catalog(): Promise<SlateBindingCatalog>;
  /** The public URL a handle serves, or null where no share host is wired. */
  shareUrl(handle: string): Promise<string | null>;
}

/** Ten lowercase hex characters — the handle half of the share-host label. */
function shareHandle(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class WorkspaceLiveShares {
  constructor(private readonly deps: WorkspaceLiveSharesDeps) {}

  async graph(slate: string): Promise<SlateCapabilityGraph> {
    return v.parse(SlateCapabilityGraphSchema, slateCapabilityGraph({ slate, workspace: this.deps.workspace, catalog: await this.deps.catalog() }));
  }

  async share(
    slate: string,
    visibility: LiveShareVisibility,
    approved: readonly { slate: string; binding: string; member: string }[],
    fork = true,
  ): Promise<LiveShareCreated> {
    const grant = { ...cutShareGrant(await this.graph(slate), approved), fork };
    const handle = shareHandle();
    const share = this.deps.shares.add({ id: nanoid(), slate, visibility, handle, grant });

    return { share, url: await this.deps.shareUrl(handle) };
  }

  revoke(share: string): LiveShareRecord {
    return this.deps.shares.revoke(share);
  }

  shareWith(share: string, users: readonly ShareUser[]): LiveShareRecord {
    return this.deps.shares.addUsers(share, users);
  }

  list(): LiveShareRecord[] {
    return this.deps.shares.list();
  }

  /** Re-read now, so a revoked share refuses. */
  read(share: string): LiveShareRecord {
    return this.deps.shares.live(share);
  }

  byHandle(handle: string): LiveShareRecord | undefined {
    return this.deps.shares.byHandle(handle);
  }

  admitsUser(share: string, userId: string): boolean {
    return this.deps.shares.hasUser(share, userId);
  }

  requests(share: string): ViewerRequestRecord[] {
    return v.parse(v.array(ViewerRequestRecordSchema), this.deps.shares.requests(share));
  }
}
