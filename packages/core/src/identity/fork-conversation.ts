/**
 * The main actor's conversation as a fork carries it: its sealed messages, its entries and their parts, the cut's
 * context membership, and the answered questions its calls read. Read and written apart from the workspace's state,
 * since a backend may keep it apart: Cloudflare keeps it in the actor's own isolate (D9), the CLI beside the rest.
 */

import { Effect } from 'effect';
import type * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { invalidateConversationSearchIndex } from '../memory/conversation-search';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import type { ActorHandle } from './actor-handle';
import { forkPointExists } from './conversation-store';
import { planForkConversation, type ForkConversationPlan } from './fork-plan';
import type { ForkReset } from './fork-policy';
import {
  FORK_CONTEXT_REVISION, FORK_CONVERSATION_DECLARATIONS, FORK_CONVERSATION_SECTIONS, forkContext, perSection, sectionCount,
  type ForkConversationDeclaration, type ForkConversationSection, type ForkRows, type ForkRowSection, type ForkStoreSource, type ForkStoreTarget,
} from './fork-sections';

export function isForkConversationSection(kind: ForkRowSection): kind is ForkConversationSection {
  return FORK_CONVERSATION_SECTIONS.some((section) => section === kind);
}

/**
 * Emptied in the conversation's store before a transfer stages, children first: the chat, the cut's context restored as
 * one fresh context, every sealed message the carried chat references (its streamed parts are its source run's), and
 * the closed questions its calls read.
 */
export const FORK_CONVERSATION_RESETS: readonly ForkReset[] = [
  'conversation_entry_parts', 'conversation_entries',
  'context_memberships', 'actor_context_selection', 'context_revisions', 'actor_contexts',
  'stream_parts', 'session_messages', 'owner_questions',
].map((table) => ({ table, scope: 'actor' as const }));

/** Where a fork reads the conversation it cuts. */
export interface ForkConversationSource {
  /** Whether `messageId` is an entry of the conversation, so a fork can be cut there. */
  has(messageId: string): Promise<boolean>;
  plan(untilMessageId: string, artifactDirectory: string): Promise<ForkConversationPlan>;
  count(kind: ForkConversationSection, plan: ForkConversationPlan, artifactDirectory: string): Promise<number>;
  rows<K extends ForkConversationSection>(kind: K, plan: ForkConversationPlan, artifactDirectory: string): AsyncIterable<ForkRows[K]>;
}

/** Where a fork lands the conversation it carries. */
export interface ForkConversationTarget {
  /** Empties what an abandoned attempt staged. */
  clear(): Promise<void>;
  /** One batch of a conversation section (`FORK_CONVERSATION_SECTIONS`); any other is the workspace's, refused. */
  stage<K extends ForkRowSection>(kind: K, rows: readonly ForkRows[K][]): Promise<void>;
  /** Points the cut entry at the fork's context; a chain without its cut entry is an incomplete transfer, refused. */
  publish(cutMessageId: string): Promise<void>;
}

/** Each section's conversation declaration; a workspace section has none. */
type DeclarationsBySection = { readonly [S in ForkRowSection]: ForkConversationDeclaration<ForkRows[S]> | null };

const DECLARATIONS_BY_SECTION: DeclarationsBySection = { ...perSection(() => null), ...FORK_CONVERSATION_DECLARATIONS };

/** A conversation section's declaration by its key; a workspace section has none here. */
function declarationOf<K extends ForkRowSection>(kind: K): ForkConversationDeclaration<ForkRows[K]> | null {
  return DECLARATIONS_BY_SECTION[kind];
}

/** What a conversation section's rows are, for a row carried as JSON to be checked against. */
export function forkConversationRowSchema<K extends ForkConversationSection>(kind: K): v.GenericSchema<ForkRows[K]> {
  return FORK_CONVERSATION_DECLARATIONS[kind].rows;
}

/** The actor's conversation in one SQL store: an isolate serves its own this way, and the CLI its workspace's. */
export function localForkConversationSource(sql: SqlExecutor, actor: ActorHandle): ForkConversationSource {
  const section = (plan: ForkConversationPlan, artifactDirectory: string): ForkStoreSource => ({ sql, actorId: actor.actorId, plan, artifactDirectory });

  return {
    has: async (messageId) => forkPointExists(sql, actor, messageId),
    plan: async (untilMessageId, artifactDirectory) => planForkConversation({ sql, actorId: actor.actorId, untilMessageId, artifactDirectory }),
    count: async (kind, plan, artifactDirectory) => sectionCount(FORK_CONVERSATION_DECLARATIONS[kind], section(plan, artifactDirectory)),
    rows: async function* <K extends ForkConversationSection>(kind: K, plan: ForkConversationPlan, artifactDirectory: string): AsyncIterable<ForkRows[K]> {
      yield* FORK_CONVERSATION_DECLARATIONS[kind].select(section(plan, artifactDirectory));
    },
  };
}

export interface LocalForkConversationTarget {
  /** The target's main actor, born by the transfer's `begin`. */
  readonly actorId: () => string;
  /** A carried payload, re-rooted under the target's own artifact directory. */
  readonly artifactPath: (relative: string) => string;
  readonly now: number;
  /** Lands each batch, and the publication, as one write. */
  readonly transaction?: (write: () => void) => void;
}

/** The fork's conversation landed in one SQL store. */
export function localForkConversationTarget(sql: SqlExecutor, opts: LocalForkConversationTarget): ForkConversationTarget {
  const target = (): ForkStoreTarget => ({ sql, actorId: opts.actorId(), artifactPath: opts.artifactPath, now: opts.now });

  return {
    clear: async () => {
      const actorId = opts.actorId();

      written(() => {
        for (const { table } of FORK_CONVERSATION_RESETS) {
          const strings = [`DELETE FROM ${table} WHERE actor_id = `, ''];

          sql(Object.assign(strings, { raw: strings }), actorId);
        }
      });
    },
    stage: (kind, rows) => settle(Effect.gen(function* () {
      const declared = declarationOf(kind);

      if (declared === null) return yield* new KinuError('bad_input', `fork section ${kind} is the workspace's, not the conversation's`);
      written(() => { declared.stage(target(), rows); });
    })),
    publish: (cutMessageId) => settle(Effect.gen(function* () {
      const actorId = opts.actorId();

      const cut = sql<{ position: number }>`
        SELECT position FROM conversation_entries
        WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${cutMessageId}
      `[0];

      if (cut === undefined) {
        return yield* new KinuError('missing', `fork publication has no cut entry ${JSON.stringify(cutMessageId)} in the transferred chain`);
      }

      written(() => {
        // The search index keyed on old rows is stale (equal counts evade its rowid watermark); invalidate it.
        invalidateConversationSearchIndex(sql);
        // The cut entry names the fork's context so a later fork at this boundary restores the same membership.
        void sql`
          UPDATE conversation_entries SET context_id = ${forkContext(sql, actorId, opts.now)}, context_revision = ${FORK_CONTEXT_REVISION}
          WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${cutMessageId}
        `;
      });
    })),
  };

  function written(write: () => void): void {
    if (opts.transaction === undefined) write();
    else opts.transaction(write);
  }
}
