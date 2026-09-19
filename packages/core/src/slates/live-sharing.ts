/**
 * Live sharing: the owner's side of sharing a RUNNING slate.
 *
 * `share` is the one place a grant is cut: the graph is drawn against the
 * workspace's own catalog, the owner's approved mutating members are named on
 * top of every read member, and the handle the share answers at is ten
 * lowercase hex characters — the address half a `slate-share-host` label
 * carries beside its token and the workspace name. Everything else is the
 * store re-read per call, so a revoked share stops answering wherever it is
 * asked from.
 */
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
  /** The workspace's live executors, MCP servers, crafted tools, model tiers
   *  and slates — what a binding can actually reach right now. */
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

  /** What sharing `slate` would grant: every binding member classified, every
   *  problem the workspace would have honouring it named on its row. */
  async graph(slate: string): Promise<SlateCapabilityGraph> {
    return v.parse(SlateCapabilityGraphSchema, slateCapabilityGraph({ slate, workspace: this.deps.workspace, catalog: await this.deps.catalog() }));
  }

  /** Cut the grant the dialog approved and open the share it admits. `fork`
   *  carries the owner's choice on whether viewers may copy the skeleton. */
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

  /** The row a viewer may act on — re-read now, so a revoked share refuses. */
  read(share: string): LiveShareRecord {
    return this.deps.shares.live(share);
  }

  byHandle(handle: string): LiveShareRecord | undefined {
    return this.deps.shares.byHandle(handle);
  }

  /** Whether the share names this account — a `users` share's admission test. */
  admitsUser(share: string, userId: string): boolean {
    return this.deps.shares.hasUser(share, userId);
  }

  requests(share: string): ViewerRequestRecord[] {
    return v.parse(v.array(ViewerRequestRecordSchema), this.deps.shares.requests(share));
  }
}
