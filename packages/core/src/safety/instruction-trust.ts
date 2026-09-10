/**
 * KINU-N028. Who is allowed to write a system instruction.
 *
 * Workspace instruction files — the AGENTS.md chain and `/workspace/skills/*.md`
 * — are read every turn and were rendered straight into the system prompt with
 * instruction force. The agent's own `file` tool, its `execute_tools` codemode
 * and its shell all write the very same bytes on the very same plane, and
 * nothing in discovery recorded who wrote them. So an agent could author its
 * own future system instructions, and a poisoned skill could bound the next
 * turn's tool surface (`skills/render.ts` unionAllowedTools feeds the real
 * gating in `orchestrator/turn-surface.ts`).
 *
 * A delimiter is not a boundary and neither is a path: the agent can rewrite
 * whatever sits at a trusted path. The only thing an owner can actually approve
 * is BYTES. So trust here is content-addressed:
 *
 *   - `builtin`    — module constants. Never digested, never approved, never
 *                    demoted, and never per-workspace approvable.
 *   - `approved`   — an owner decision naming THIS path and THIS digest.
 *                    System placement, unchanged force.
 *   - `unverified` — everything else. Reference material in a labelled,
 *                    sealed, user-role block; it carries no tool policy.
 *
 * Invalidation is a property of the key, not a mechanism. A lookup matches only
 * when the stored digest equals the digest of the bytes about to be rendered, so
 * a rewrite by the file tool, by the shell, by `git checkout`, by a snapshot
 * restore or by any out-of-band edit demotes on the very next turn. There is no
 * sweep, no watcher, no mtime cache and no TTL to get wrong.
 *
 * A revocation is kept rather than deleted. `revoked` is the owner's standing
 * answer, so the refusal outlives the bytes it was made about.
 */

import { argumentDigest } from './argument-digest';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import * as v from 'valibot';

export type {
  InstructionTrust, VerifiedInstructionTrust, InstructionTrustResolver,
} from '../types/instruction-trust';

import type { VerifiedInstructionTrust } from '../types/instruction-trust';

/** The owner's standing answer for one path. `grandfathered` is a stored answer
 *  from the removed one-time carry-over, read exactly like `approved`; no code
 *  writes it. `revoked` is kept on purpose so nothing can re-grant it. */
export type InstructionDecision = 'approved' | 'grandfathered' | 'revoked';

const DECISION = v.picklist(['approved', 'grandfathered', 'revoked']);

/** A decision as stored: the bytes it was made about, and what it said. */
export interface InstructionApproval {
  readonly path: string;
  readonly digest: string;
  readonly decision: InstructionDecision;
}

/**
 * The digest an approval binds.
 *
 * SHA-256 over the exact bytes, via the same `argumentDigest` the release lane
 * binds a reviewed deploy with (`release/approval-digest.ts`). Not `fnv1a64`:
 * that one is documented as fast and non-cryptographic, and the adversary here
 * writes the file, so a forgeable digest would be no boundary at all. `v` guards
 * the shape so a format change can never silently keep matching.
 */
export function instructionDigest(content: string): string {
  return argumentDigest({ v: 1, content });
}

export function initInstructionApprovalsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS instruction_approvals (
    actor_id TEXT NOT NULL,
    scope    TEXT NOT NULL,
    path     TEXT NOT NULL,
    digest   TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'grandfathered', 'revoked')),
    PRIMARY KEY (actor_id, scope, path)
  )`);
}

interface Row {
  path: string;
  digest: string;
  decision: string;
}

function toApproval(row: Row): InstructionApproval {
  const decision = v.safeParse(DECISION, row.decision);

  return {
    path: row.path,
    digest: row.digest,
    // A value outside the CHECK cannot be stored, so an unparsable one is a
    // corrupt row rather than an older shape — read it as the refusal, which is
    // the only answer that fails closed.
    decision: decision.success ? decision.output : 'revoked',
  };
}

/**
 * Resolve trust from the one workspace authority's rows. Facets use this
 * snapshot rather than a private actor database, so every agent sharing the
 * workspace sees the same approvals and revocations.
 *
 * Both halves have to hold: a decision that names this path, AND a stored
 * digest equal to the digest of the bytes about to be rendered. That
 * conjunction is the whole invalidation story — nothing else has to notice that
 * a file changed, so there is no sweep or watcher to forget to run.
 *
 * This is the ONLY implementation of that rule. `InstructionApprovalStore`
 * feeds its own row through it rather than restating it, because a second copy
 * of a trust conjunction is a place for a future guard to land on one side
 * only.
 */
export function trustOfInstructionApprovals(
  rows: ReadonlyArray<InstructionApproval>,
  path: string,
  content: string,
): VerifiedInstructionTrust {
  const row = rows.find((candidate) => candidate.path === path);

  if (!row || row.digest !== instructionDigest(content)) return 'unverified';

  return row.decision === 'revoked' ? 'unverified' : 'approved';
}

/**
 * The one authority on instruction trust, bound to a scope for its lifetime.
 *
 * `scope` names the authority the decision belongs to — owner plus workspace in
 * the cloud, the discovery root on a local CLI. It is part of the key so a
 * database that ever serves two workspaces cannot lend one's approvals to the
 * other, and so a copied or forked workspace starts unapproved.
 *
 * The ACTOR leads that key. One physical database now holds every logical actor
 * of a workspace, and they share a scope while emphatically not sharing trust:
 * a hired subordinate reads its own instruction files, and the owner approving
 * a skill for the root is not the owner approving it for a temporary the root
 * spawned. A fresh actor therefore starts with no decisions at all: every
 * discovered file is unverified until the owner approves its exact digest.
 */
export class InstructionApprovalStore {
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly scope: string,
  ) {
    this.actorId = actor.actorId;
  }

  /** The standing decision for this path, whatever bytes it was made about. */
  get(path: string): InstructionApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE actor_id = ${this.actorId} AND scope = ${this.scope} AND path = ${path} LIMIT 1`;

    return rows[0] ? toApproval(rows[0]) : null;
  }

  /** The trust these exact bytes have earned at this exact path, decided by the
   *  one rule in {@link trustOfInstructionApprovals}. */
  trustOf(path: string, content: string): VerifiedInstructionTrust {
    const row = this.get(path);

    return trustOfInstructionApprovals(row === null ? [] : [row], path, content);
  }

  /** The owner approves these exact bytes at this exact path. Re-approving a
   *  changed file moves the digest, which is what makes an edit re-approvable
   *  without first clearing the old answer. */
  approve(path: string, digest: string): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO instruction_approvals (actor_id, scope, path, digest, decision)
      VALUES (${this.actorId}, ${this.scope}, ${path}, ${digest}, 'approved')
      ON CONFLICT (actor_id, scope, path)
        DO UPDATE SET digest = ${digest}, decision = 'approved'`;
  }

  /** The owner withdraws trust from a path. The row STAYS, holding the refusal,
   *  so the file drops to `unverified` and only a fresh owner approval can
   *  grant it again. */
  revoke(path: string): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO instruction_approvals (actor_id, scope, path, digest, decision)
      VALUES (${this.actorId}, ${this.scope}, ${path}, '', 'revoked')
      ON CONFLICT (actor_id, scope, path) DO UPDATE SET decision = 'revoked'`;
  }

  /** Every standing decision in this scope — what the owner's approval surface
   *  lists beside the files discovery actually found. */
  list(): InstructionApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE actor_id = ${this.actorId} AND scope = ${this.scope} ORDER BY path`.map(toApproval);
  }
}

/** What an owner's decision request resolves to. */
export type AdmittedInstructionDecision =
  | { readonly ok: true; readonly path: string; readonly digest: string }
  | { readonly ok: false; readonly error: string };

/**
 * Admit an owner's approve/revoke request.
 *
 * Both backends call this and nothing else, so "what counts as a valid
 * decision" is one rule rather than one per transport — which is the difference
 * between a real shared method and two that merely share a name. Omit `digest`
 * for a revocation, which names a path and no bytes.
 *
 * A malformed digest is refused rather than stored. It could never match a real
 * one, so storing it would be harmless but silent: the owner would see a row
 * that claims a decision and grants nothing.
 */
export function admitInstructionDecision(path: string, digest?: string): AdmittedInstructionDecision {
  const clean = path.trim();

  if (clean === '') return { ok: false, error: 'path is required' };

  if (digest === undefined) return { ok: true, path: clean, digest: '' };

  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, error: 'digest must be the 64-character SHA-256 the surface displayed' };
  }

  return { ok: true, path: clean, digest };
}
