/**
 * Canonical conversation seeding for the fork suites.
 *
 * A fork now carries the canonical store — `session_messages`, their parts and
 * updates, the public `conversation_entries` chain and the working context's
 * membership — so a fixture that INSERTed rows by hand would be a second,
 * hand-maintained writer of exactly the shape under test. These helpers drive
 * the production writers (`SessionMessages`, `SessionContext`,
 * `SessionTranscript`) instead, so what a fork reads is what a turn wrote.
 *
 * Shared by the four fork suites rather than copied into each: the seed IS the
 * subject's input, and four transcriptions of it would drift.
 */

import type { ModelMessage } from 'ai';
import type { TestWorkspace } from '../helpers';
import { CHAT_SESSION_ID } from '../../src/session/transcript-schema';
import { openWorkspaceMainActor, WorkspaceActorDirectory } from '../../src/identity/workspace-actors';
import type { ActorHandle } from '../../src/identity/actor-handle';
import { SessionMessages, type MessageOrigin, type MessageReference } from '../../src/session/messages';
import { SessionContext, type ContextSelection } from '../../src/session/context';
import { SessionPayloads } from '../../src/session/payload';
import { SessionTranscript, readSessionTranscript } from '../../src/session/transcript';
import { writeSoul } from '../../src/identity/soul';
import type { JsonObject } from '../../src/utils/json';
import { PLATFORM_CATALOG } from '../../src/platform-catalog';

/** Where the source actor's payload files live, in the shape the hosted main
 *  actor uses (`agentArtifactDirectory(agentHome(MAIN_AGENT))`). */
export const SOURCE_ARTIFACTS = '/home/agent/.kinu/context';

/** The TARGET's own payload plane. Deliberately a different path from the
 *  source's, so a payload reference that was never re-rooted reads a file that
 *  does not exist on the fork. */
export const TARGET_ARTIFACTS = '/home/fork/.kinu/context';

/** Larger than the payload store's inline ceiling (half of
 *  `do.sqlite.row_bytes`), so the value it is given spills to a FILE and the
 *  row carries a path and a digest instead of JSON. */
export const SPILLED_BYTES = 1_100_000;

/** The payload store's inline ceiling: a JSON payload of this many bytes stays in the row. */
export const INLINE_PAYLOAD_BYTES = Math.floor(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 2);

/** One seeded workspace's canonical conversation, over the production writers. */
export class ForkConversation {
  readonly actor: ActorHandle;
  readonly payloads: SessionPayloads;
  readonly messages: SessionMessages;
  readonly context: SessionContext;
  readonly transcript: SessionTranscript;

  constructor(readonly workspace: TestWorkspace, readonly artifactDirectory: string) {
    this.actor = openWorkspaceMainActor(workspace.sql);
    this.payloads = new SessionPayloads(async () => ({ vfs: workspace.vfs, artifactDirectory }));
    this.messages = new SessionMessages(workspace.sql, this.actor, this.payloads);
    this.context = new SessionContext(workspace.sql, this.actor, (write) => this.atomic(write));

    this.transcript = new SessionTranscript({
      sql: workspace.sql, actor: this.actor, sessionId: CHAT_SESSION_ID, messages: this.messages, payloads: this.payloads,
      atomic: (write) => this.atomic(write), selection: () => this.context.selected(),
    });
  }

  atomic<T>(write: () => T): T {
    return this.workspace.db.transaction(write)();
  }

  selection(): ContextSelection {
    return this.context.selected() ?? this.context.initialize();
  }

  /**
   * One message, published the way a turn publishes it.
   *
   * `chain` puts it in the public transcript; `working` puts it in the model's
   * context. They are independent on purpose — that split is what a fork has to
   * carry — so a caller can seed a message the operator sees and the model does
   * not, or the reverse.
   */
  async publish(input: {
    readonly id: string;
    readonly message: ModelMessage;
    readonly origin?: MessageOrigin;
    /** Omitted means "continue the chain" — the transcript parents the entry on
     *  its current leaf, exactly as a turn does. `null` makes it a root. */
    readonly parentId?: string | null;
    readonly chain?: boolean;
    readonly working?: boolean;
    readonly metadata?: JsonObject;
    readonly calls?: ReadonlyMap<string, { messageId: string; part: number }>;
  }): Promise<MessageReference> {
    const origin = input.origin ?? (input.message.role === 'user' ? 'input' : 'output');
    const prepared = await this.messages.prepare(input.message, input.id, input.calls ?? new Map());
    const metadata = input.metadata === undefined ? null : await this.payloads.prepare(input.metadata);
    let reference: MessageReference | null = null;

    if (input.working ?? true) {
      this.context.commit(this.selection(), { cause: origin, turnId: null, assertEpoch: () => this.actor.assertCurrent(), mutate: (entries) => {
        reference = this.messages.insert(prepared, origin);

        return [...entries, { ...reference, entryId: input.id, position: entries.length }];
      } });
    } else {
      reference = this.atomic(() => this.messages.insert(prepared, origin));
    }

    if (reference === null) throw new Error('seeded message did not return its identity');
    const published: MessageReference = reference;

    if (input.chain ?? true) {
      this.transcript.record({
        id: input.id, parentId: input.parentId, role: input.message.role,
        turnId: null, runId: null, metadata,
        parts: prepared.content.parts.map((part) => ({ messageId: published.messageId, partNo: part.partNo })),
      });
    }

    return published;
  }

  /** Plain text, as a user or assistant turn — the common case. */
  async say(input: {
    readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string;
    readonly parentId?: string | null; readonly chain?: boolean; readonly working?: boolean;
    readonly metadata?: JsonObject;
  }): Promise<MessageReference> {
    return this.publish({
      id: input.id, message: { role: input.role, content: input.text },
      parentId: input.parentId, chain: input.chain, working: input.working, metadata: input.metadata,
    });
  }

  /** A tool call and the result that answers it; the result's part records
   *  `replyTo` against the call's part. */
  async toolExchange(input: {
    readonly callId: string; readonly resultId: string; readonly toolName: string;
    readonly toolCallId: string; readonly output: JsonObject;
    readonly chain?: boolean; readonly working?: boolean;
  }): Promise<void> {
    await this.publish({
      id: input.callId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: input.toolCallId, toolName: input.toolName, input: {} }],
      },
      chain: input.chain, working: input.working,
    });

    await this.publish({
      id: input.resultId,
      message: {
        role: 'tool',
        content: [{
          type: 'tool-result', toolCallId: input.toolCallId, toolName: input.toolName,
          output: { type: 'json', value: input.output },
        }],
      },
      calls: new Map([[input.toolCallId, { messageId: input.callId, part: 0 }]]),
      chain: input.chain, working: input.working,
    });
  }

  /** Drop one entry out of the working context — a prune. The public chain is
   *  untouched, which is exactly the divergence a fork has to carry. */
  prune(entryId: string): ContextSelection {
    return this.context.commit(this.selection(), {
      cause: 'context_transform', turnId: null,
      mutate: (entries) => entries.filter((entry) => entry.entryId !== entryId)
        .map((entry, position) => ({ ...entry, position })),
      assertEpoch: () => this.actor.assertCurrent(),
    });
  }
}

/** A source workspace with an identity, a main actor, a SOUL and the
 *  non-conversation rows a fork also carries. */
export async function seedForkSource(workspace: TestWorkspace, opts: {
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly purpose?: string;
  readonly artifactDirectory?: string;
  readonly craftedTools?: readonly { name: string; description: string; code: string }[];
  readonly memory?: readonly { path: string; text: string }[];
} = {}): Promise<ForkConversation> {
  const workspaceId = opts.workspaceId ?? 'SRC';
  const workspaceName = opts.workspaceName ?? 'origin';
  void workspace.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${workspaceName}, ${100})`;
  const actor = new WorkspaceActorDirectory(workspace.sql, { workspaceId, ownerUserId: '' }).createMain({ name: workspaceName });
  await writeSoul(workspace.vfs, workspace.sql, opts.purpose ?? 'help with testing');
  actor.config.setModel('@cf/moonshotai/kimi-k2.6');

  for (const tool of opts.craftedTools ?? []) {
    void workspace.sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
      VALUES (${tool.name}, ${tool.description}, ${null}, ${tool.code}, ${'local'}, ${500}, ${500})`;
  }

  const memory = opts.memory ?? [{ path: 'memory/MEMORY.md', text: 'key insight' }];

  if (memory.length > 0) await workspace.vfs.mkdir('memory', { recursive: true });

  for (const [index, file] of memory.entries()) {
    await workspace.vfs.writeFile(file.path, file.text);
    void workspace.sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
      VALUES (${`chunk-${index}`}, ${file.path}, ${1}, ${2}, ${`hash-${index}`}, ${file.text}, ${700})`;
  }

  return new ForkConversation(workspace, opts.artifactDirectory ?? SOURCE_ARTIFACTS);
}

/** A target workspace as the boot path leaves it: an identity, a main actor and
 *  a default SOUL the fork overwrites. */
export async function seedForkTarget(workspace: TestWorkspace, opts: {
  readonly workspaceId?: string; readonly workspaceName?: string;
} = {}): Promise<void> {
  const workspaceId = opts.workspaceId ?? 'TGT';
  const workspaceName = opts.workspaceName ?? 'target-bootstrap';
  void workspace.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${workspaceName}, ${200})`;
  new WorkspaceActorDirectory(workspace.sql, { workspaceId, ownerUserId: '' }).createMain({ name: workspaceName });
  await writeSoul(workspace.vfs, workspace.sql, 'default bootstrap purpose');
}

/** The public chain a workspace holds, read through the production transcript
 *  reader — so a carried payload file is resolved and digest-checked exactly as
 *  a turn would resolve it. */
export async function readChain(workspace: TestWorkspace): Promise<{
  readonly ids: readonly string[];
  readonly text: readonly string[];
}> {
  const reader = readSessionTranscript(
    workspace.sql, openWorkspaceMainActor(workspace.sql), CHAT_SESSION_ID, async () => workspace.vfs,
  );

  const chain = reader.ancestry();
  const text: string[] = [];

  for (const entry of chain) {
    const projected = await reader.project(entry.id);

    if (projected === null) throw new Error(`entry ${entry.id} disappeared while reading the chain`);
    text.push(projected.content);
  }

  return { ids: chain.map((entry) => entry.id), text };
}

/** The working context a workspace holds, materialized as the model would read
 *  it: one native message per member, in position order. */
export async function readWorkingContext(workspace: TestWorkspace, artifactDirectory: string): Promise<{
  readonly entryIds: readonly string[];
  readonly messages: readonly ModelMessage[];
}> {
  const actor = openWorkspaceMainActor(workspace.sql);
  const payloads = new SessionPayloads(async () => ({ vfs: workspace.vfs, artifactDirectory }));
  const messages = new SessionMessages(workspace.sql, actor, payloads);
  const context = new SessionContext(workspace.sql, actor, (write) => workspace.db.transaction(write)());
  const selected = context.selected();

  if (selected === null) return { entryIds: [], messages: [] };
  const members = context.entries(selected);
  const native: ModelMessage[] = [];

  for (const member of members) native.push(await messages.materialize(member));

  return { entryIds: members.map((member) => member.entryId), messages: native };
}
