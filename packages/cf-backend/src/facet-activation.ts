/**
 * FacetActivation — what this facet was initialized to RUN, durably.
 *
 * `FacetIdentity` answers "who am I and whose workspace do I fork"; this store
 * answers "what work was I handed". `initHead(input)` and `initNode(spec)` are
 * bootstrap RPCs on the same footing as `setOwner`/`setSharedParent`, and the
 * contract those honour (facet-spawn.ts's header) applies to them too: a parent
 * and its facets are evicted JOINTLY after a couple of minutes idle, so
 * "it was set on the instance a moment ago" is never safe to assume between the
 * init RPC and the run RPC. An activation input that lived only on the instance
 * turned a hibernation in exactly that window into `runAsHead()` throwing
 * "called before initHead()" — and one head's throw rejected the WHOLE split's
 * `Promise.all`, discarding the work every sibling had already paid for.
 *
 * So the input is written to the facet's own SQLite at init and re-read after a
 * cold activation, exactly like the identity. The row is single: a facet runs
 * one head OR one node OR one MCTS branch, and a re-init is a re-drive of the
 * same work, which overwrites.
 *
 * The write side is typed by the DOMAIN contract — `HeadInput`/`NodeRunSpec`,
 * what the spawn RPC acknowledged — and the read side re-validates against a
 * schema, because a row was written by an earlier activation of an earlier
 * build and the honest shape at that boundary is a parse that can refuse by
 * name, not a cast that assumes it matched. `strictObject` is that refusal for
 * a shape this build does not know. Corruption is a broken facet, not an
 * uninitialized one. `NodeRunSpec` crosses the spawn RPC as data — its own
 * contract ("everything here is a field") says it must — so the value stored is
 * exactly the value acknowledged, and the reader rebuilds the run's spec with
 * no second transcription of the wire shape.
 *
 * No repair path, no sweeper. The unactivated state this store prevents — an
 * acked facet that cannot answer "what do I run" — is unreachable by
 * construction: the write happens inside the init RPC, BEFORE its ack, so an
 * acked bootstrap is a durable bootstrap.
 */

import * as v from 'valibot';
import type { SqlStorage } from '@cloudflare/workers-types';
import { ModelMessagesSchema, WorkModeSchema } from '@kinu.run/core';
import type { HeadId, HeadInput, NodeRunSpec } from '@kinu.run/core';

/** The domain payload a HEAD facet is initialized with. Typed by core's
 *  contract, not by the storage schema — the schema below governs the READ. */
export interface StoredHeadActivation {
  kind: 'head';
  input: HeadInput;
}

/** The domain payload a NODE facet is initialized with. */
export interface StoredNodeActivation {
  kind: 'node';
  spec: NodeRunSpec;
}

export type StoredActivationInput = StoredHeadActivation | StoredNodeActivation;

/** `SerializedMessage` as the fork RPC carries it. Closed, like the interface:
 *  a role outside the four is a malformed inheritance and refuses here. */
const StoredInheritedMessageSchema = v.strictObject({
  id: v.string(),
  role: v.picklist(['system', 'user', 'assistant', 'tool']),
  content: v.string(),
  createdAt: v.number(),
  toolName: v.optional(v.string()),
});

/** `HeadBudget` as the fork RPC carries it. `maxWallClockMs` is opt-in by the
 *  interface's own contract — absent means run to completion — so optional
 *  here is the wire shape, not leniency. */
const StoredHeadBudgetSchema = v.strictObject({
  maxDepth: v.number(),
  maxWallClockMs: v.optional(v.number()),
  spawnedAt: v.number(),
});

/** The serialized work spec of a HEAD facet. Every field the run path reads
 *  unconditionally — `task`, `mode`, `budget`, `inheritedContext`,
 *  `mergeStrategy` — is required; the interface's own optionals stay optional. */
const StoredHeadInputSchema = v.strictObject({
  id: v.string(),
  rootId: v.string(),
  parentId: v.nullable(v.string()),
  depth: v.number(),
  task: v.string(),
  mode: WorkModeSchema,
  rationale: v.string(),
  inheritedContext: v.array(StoredInheritedMessageSchema),
  budget: StoredHeadBudgetSchema,
  model: v.optional(v.string()),
  allowedTools: v.optional(v.array(v.string())),
  missionLabels: v.optional(v.array(v.string())),
  mergeStrategy: v.picklist(['synthesize', 'best_of', 'consensus']),
});

/** The serialized work spec of a NODE facet: `NodeRunSpec` as the RPC carried
 *  it. `messages` is the engine's assembled conversation, validated by core's
 *  reuse of the AI SDK's own message predicate; `isolation` is the
 *  node-workspace discriminator. `runNodeLoop` reads both unconditionally. */
const StoredNodeSpecSchema = v.strictObject({
  headInput: StoredHeadInputSchema,
  base: v.string(),
  messages: ModelMessagesSchema,
  isolation: v.picklist(['shared-origin-plane', 'private-home']),
  home: v.string(),
  canPropose: v.boolean(),
});

/** Either mode's row, discriminated — the same shape `initHead`/`initNode`
 *  hand over, stored as one JSON blob per row. */
const StoredActivationSchema = v.variant('kind', [
  v.object({ kind: v.literal('head'), input: StoredHeadInputSchema }),
  v.object({ kind: v.literal('node'), spec: StoredNodeSpecSchema }),
]);

export type StoredActivation = v.InferOutput<typeof StoredActivationSchema>;

export class FacetActivation {
  private schemaReady = false;
  private cached: StoredActivation | null = null;

  constructor(private readonly sql: SqlStorage) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS facet_activation (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    )`);
    this.schemaReady = true;
  }

  /** Persist what this facet was initialized to run, overwriting any previous
   *  mode. The write is the point of the class: it happens INSIDE the init RPC,
   *  before its ack, so an acked bootstrap is a durable bootstrap. The cache is
   *  dropped, so the next read round-trips the row back through the schema —
   *  the write proving itself, once, at the only moment it is cheap. */
  store(activation: StoredActivationInput): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT INTO facet_activation (id, payload) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      JSON.stringify(activation),
    );
    this.cached = null;
  }

  /** What this facet was initialized to run, or null when it never was. Reads
   *  are memoized like the identity's: the run path asks once per activation.
   *
   *  PARSED, not asserted: the row was written by an earlier activation, and a
   *  shape that no longer matches is a real condition on the cold-activation
   *  path — it must fail by name here rather than reach the run path. */
  read(): StoredActivation | null {
    if (this.cached) return this.cached;
    this.ensureSchema();
    const rows = this.sql
      .exec<{ payload: string }>(`SELECT payload FROM facet_activation WHERE id = 1`)
      .toArray();
    const row = rows[0];
    if (!row) return null;
    let blob: unknown;
    try {
      blob = JSON.parse(row.payload);
    } catch (cause) {
      throw new Error(`facet_activation row is not valid JSON`, { cause });
    }
    const parsed = v.safeParse(StoredActivationSchema, blob);
    if (!parsed.success) {
      throw new Error(
        `facet_activation row does not match the stored work spec: ${v.summarize(parsed.issues)}`,
      );
    }
    this.cached = parsed.output;
    return this.cached;
  }

  /** The head this facet was initialized as, by whatever path recorded it. */
  headInput(): HeadInput | null {
    const stored = this.read();
    return stored?.kind === 'head' ? stored.input : null;
  }

  /** The node spec this facet was initialized with, or null. */
  nodeSpec(): NodeRunSpec | null {
    const stored = this.read();
    return stored?.kind === 'node' ? stored.spec : null;
  }

  /** The head id a stored activation names, for the tracing attributes. */
  headId(): HeadId | null {
    const stored = this.read();
    if (!stored) return null;
    return stored.kind === 'head' ? stored.input.id : stored.spec.headInput.id;
  }

  /** Retire the row, so a facet re-used for a different mode cannot read a
   *  stale activation — though the normal terminal path wipes the storage
   *  whole (`runOnceAndReclaim`). */
  clear(): void {
    this.ensureSchema();
    this.sql.exec(`DELETE FROM facet_activation WHERE id = 1`);
    this.cached = null;
  }
}
