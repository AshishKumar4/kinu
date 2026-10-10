import { Effect } from 'effect';
import * as v from 'valibot';
import { settleSync, settle } from '../obs/effect';
import { markStoreChanged } from '@kinu.run/agent-utils';
/** Workspace fork write and its accounting. The target DB must already be initialized (initWorkspaceSchema). */

import type { SqlExecutor } from '../types/primitives';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { ForkStagingState } from './fork-staging';
import { invalidateConversationSearchIndex } from '../memory/conversation-search';
import { openWorkspaceMainActor, WorkspaceActorDirectory } from './workspace-actors';
import { KinuError } from '../obs/error';
import { forkArtifactPath } from './fork-plan';
import type { ForkSnapshotHead } from './fork-rows';
import { FORK_WRITE_RESETS, type ForkReset } from './fork-policy';
import {
  FORK_CONTEXT_REVISION, FORK_ROW_SECTIONS, FORK_SECTIONS, perSection,
  type ForkAppData, type ForkRows, type ForkRowSection, type ForkSectionTarget,
} from './fork-sections';


export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

export interface ForkWriteTarget {
  workspaceId: string;
  workspaceName: string;
  /** Target actor payload directory; carried payload references and files are re-rooted here. */
  artifactDirectory: string;
  now?: number;
  /** Hosted owner, carried through the identity rewrite so row and file namespace cannot diverge. Local backends omit it. */
  ownerUserId?: string;
  /** Runs the publication atomically. Staging happens outside it: a host transaction is
     *  synchronous and the filesystem is not. */
  transaction?: (rows: () => void) => void;
  /** The `db` tool's store as the target's main actor writes it (`AppDataStore.fork`), opened once `begin` has made
   *  that actor. */
  appData: () => ForkAppData;
}

/** How much a source declares it sends, and a writer has taken: each section's rows, and the files. Checked against
 *  each other before publishing. */
export const ForkSectionCountsSchema = v.object({ ...perSection(() => v.number()), files: v.number() });

export type ForkStagedCounts = v.InferOutput<typeof ForkSectionCountsSchema>;

/**
 * The fork write: `begin`, a `stage` per batch, then `publish`; the target is not a fork until publish.
 * Stage order is foreign-key order (messages, entries, parts, context) since no transaction spans a hosted transfer.
 */
export class ForkTargetWriter {
  private readonly now: number;
  /** Transfer state, read back from the target since frames arrive on several DO activations ({@link ForkStagingState}). */
  readonly staging: ForkStagingState;

  constructor(
    private readonly target: SqlExecutor,
    private readonly opts: ForkWriteTarget,
  ) {
    this.now = opts.now ?? Date.now();
    this.staging = new ForkStagingState(target);
  }

  /** The target's main actor, resolved on demand: {@link begin} creates it on a target with no identity yet. */
  private get actorId(): string {
    return openWorkspaceMainActor(this.target).actorId;
  }

  /** Target-side destination of one carried payload file, shared by staging list, sink and SQL references. */
  artifactPath(relative: string): string {
    return forkArtifactPath(relative, this.opts.artifactDirectory);
  }

  /** Record which fork this is and reset accounting. Separate from {@link clearStagedRows} so row
     *  deletion can run where the caller's transaction can roll it back. */
  begin(head: ForkSnapshotHead): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const current = this.target<{ id: string; owner_user_id: string }>`SELECT id, owner_user_id FROM workspace_identity`[0];

      if (!current) {
        void this.target`INSERT INTO workspace_identity(id,name,owner_user_id,created_at) VALUES (${this.opts.workspaceId},${this.opts.workspaceName},${this.opts.ownerUserId ?? ''},${this.now})`;
        new WorkspaceActorDirectory(this.target, { workspaceId: this.opts.workspaceId, ownerUserId: this.opts.ownerUserId ?? '' }).createMain({ name: this.opts.workspaceName });
      } else {
        if (current.id !== this.opts.workspaceId) return yield* new KinuError('denied', 'The fork target does not match its durable workspace identity.');
        openWorkspaceMainActor(this.target);
      }

      this.staging.begin(head);
    }));
  }

  /**
   * Empty what an abandoned attempt left, so a retry self-heals: every table fork-policy.ts names, children first. `workspace_identity` stays: a hosted target's file namespace derives from it.
   */
  clearStagedRows(): void {
    const actorId = this.actorId;

    for (const reset of FORK_WRITE_RESETS) emptied(this.target, reset, actorId);
    const target = this.sectionTarget;

    for (const kind of FORK_ROW_SECTIONS) FORK_SECTIONS[kind].reset?.(target);
    markStoreChanged(this.target);
  }

  /** One batch of one section, where the section's declaration lands it. */
  stage<K extends ForkRowSection>(kind: K, rows: readonly ForkRows[K][]): void {
    FORK_SECTIONS[kind].stage(this.sectionTarget, rows);
    this.staging.count(kind, rows.length);
  }

  private get sectionTarget(): ForkSectionTarget {
    const actorId = this.actorId;

    return {
      sql: this.target,
      actorId,
      artifactPath: (relative) => this.artifactPath(relative),
      context: () => this.forkContext(actorId),
      appData: this.opts.appData,
    };
  }

  publish(): Promise<ForkResult> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.opts.transaction) return this.publishRows();
      let result: ForkResult | null = null;
      this.opts.transaction(() => { result = this.publishRows(); });

      if (result === null) return yield* Effect.die(new Error('fork publication transaction produced no result'));

      return result;
    }));
  }

  /** The publication as one synchronous unit, for a caller's host transaction. */
  publishRows(): ForkResult {
    return settleSync(Effect.gen({ self: this }, function* () {
      const staged = this.staging.read();
      const head = staged?.head ?? null;

      if (staged === null || head === null) {
        return yield* Effect.die(new Error('fork publication attempted before the transfer declared its head'));
      }

      const forkPointMs = head.cut.createdAtMs;
      const actorId = this.actorId;

      // A target without the cut entry got an incomplete transfer; refuse before the first write.
      const cut = this.target<{ position: number }>`
        SELECT position FROM conversation_entries
        WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
      `[0]?.position;

      if (cut === undefined) {
        return yield* new KinuError('missing', `fork publication has no cut entry ${JSON.stringify(head.cut.messageId)} in the transferred chain`);
      }

      // Identity: new id, name, created_at; owner carries through.
      void this.target`DELETE FROM workspace_identity`;

      if (this.opts.ownerUserId) {
        void this.target`
          INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
          VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.opts.ownerUserId}, ${this.now})
        `;
      } else {
        void this.target`
          INSERT INTO workspace_identity (id, name, created_at)
          VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.now})
        `;
      }

      // The search index keyed on old rows is stale (equal counts evade its rowid watermark); invalidate it.
      invalidateConversationSearchIndex(this.target, actorId);

      openWorkspaceMainActor(this.target).config.setDisplayName(this.opts.workspaceName);

      // Lineage: what makes this workspace a fork.
      void this.target`
        INSERT INTO fork_lineage
        (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
        VALUES
        (1, ${head.source.workspaceId}, ${head.source.workspaceName},
         ${head.cut.messageId}, ${forkPointMs}, ${this.now})
      `;

      // The fork's working context; always present, empty if the cut recorded none.
      const contextId = this.forkContext(actorId);

      // The cut entry names the fork's context so a later fork at this boundary restores the same membership.
      void this.target`
        UPDATE conversation_entries SET context_id = ${contextId}, context_revision = ${FORK_CONTEXT_REVISION}
        WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
      `;

      // Staged files are the fork's now. The transfer row stays to answer re-delivered frames until the next `begin`.
      this.staging.dropFiles();
      this.staging.markPublished();

      return forkResultOf(head, staged.staged);
    }));
  }

  /** The fork's own context, created once and read back (membership and publication may run on different
     *  activations). An existing selection is adopted so the target never has two. */
  private forkContext(actorId: string): string {
    const selected = this.target<{ context_id: string }>`
      SELECT context_id FROM actor_context_selection WHERE actor_id = ${actorId}
    `[0]?.context_id;

    const contextId = selected ?? crypto.randomUUID();

    if (selected === undefined) {
      void this.target`
        INSERT INTO actor_contexts (actor_id, context_id)
        VALUES (${actorId}, ${contextId})
      `;
    }

    const revision = this.target<{ revision: number }>`
      SELECT revision FROM context_revisions
      WHERE actor_id = ${actorId} AND context_id = ${contextId} AND revision = ${FORK_CONTEXT_REVISION}
    `[0];

    if (revision === undefined) {
      void this.target`
        INSERT INTO context_revisions (actor_id, context_id, revision, author, cause, turn_id, proposal_id, recorded_at)
        VALUES (${actorId}, ${contextId}, ${FORK_CONTEXT_REVISION}, ${actorId}, ${'fork'}, ${null}, ${null}, ${this.now})
      `;
    }

    if (selected === undefined) {
      void this.target`INSERT INTO actor_context_selection (actor_id, context_id) VALUES (${actorId}, ${contextId})`;
    }

    return contextId;
  }
}

/** Empties one declared table. A table name cannot be bound, so it is written into the statement: the declaration's
 *  name, never a frame's. */
function emptied(sql: SqlExecutor, { table, scope }: ForkReset, actorId: string): void {
  const strings = scope === 'actor' ? [`DELETE FROM ${table} WHERE actor_id = `, ''] : [`DELETE FROM ${table}`];

  sql(Object.assign(strings, { raw: strings }), ...(scope === 'actor' ? [actorId] : []));
}

/** One transfer's result from stored state; returned at publication and for every re-delivered frame. */
export function forkResultOf(head: ForkSnapshotHead, counts: ForkStagedCounts): ForkResult {
  return {
    forkPointMs: head.cut.createdAtMs,
    messagesCopied: counts.conversationEntries,
    craftedToolsCopied: counts.craftedTools,
  };
}
