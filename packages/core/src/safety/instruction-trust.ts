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
 * answer, so a one-time grandfather can never resurrect a file the owner has
 * already refused.
 */

import { argumentDigest } from './argument-digest';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import * as v from 'valibot';

export type {
  InstructionTrust, VerifiedInstructionTrust, InstructionTrustResolver,
} from '../types/instruction-trust';
import type { VerifiedInstructionTrust } from '../types/instruction-trust';

/** The owner's standing answer for one path. `grandfathered` is a migration
 *  decision, read exactly like `approved` and written only by the one-time
 *  carry-over; `revoked` is kept on purpose so nothing can re-grant it. */
export type InstructionDecision = 'approved' | 'grandfathered' | 'revoked';

const DECISION = v.picklist(['approved', 'grandfathered', 'revoked']);

/** A decision as stored: the bytes it was made about, and what it said. */
export interface InstructionApproval {
  readonly path: string;
  readonly digest: string;
  readonly decision: InstructionDecision;
}

/** One migration-time content address. Raw source bytes are hashed while read,
 * then released before the atomic baseline write. */
export interface InstructionMigrationEntry {
  readonly path: string;
  readonly digest: string;
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
    scope    TEXT NOT NULL,
    path     TEXT NOT NULL,
    digest   TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'grandfathered', 'revoked')),
    PRIMARY KEY (scope, path)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS instruction_approval_migrations (
    scope TEXT PRIMARY KEY
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

/** Resolve trust from the one workspace authority's rows. Facets use this
 * snapshot rather than a private actor database, so every agent sharing the
 * workspace sees the same approvals and revocations. */
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
 */
export class InstructionApprovalStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly scope: string,
    private readonly transaction: <T>(body: () => T) => T,
  ) {}

  /** The standing decision for this path, whatever bytes it was made about. */
  get(path: string): InstructionApproval | null {
    const rows = this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE scope = ${this.scope} AND path = ${path} LIMIT 1`;
    return rows[0] ? toApproval(rows[0]) : null;
  }

  /**
   * The trust these exact bytes have earned at this exact path.
   *
   * Both halves have to hold: a decision that names this path, AND a stored
   * digest equal to the digest of the bytes about to be rendered. That
   * conjunction is the whole invalidation story — nothing else has to notice
   * that a file changed, so there is no sweep or watcher to forget to run.
   */
  trustOf(path: string, content: string): VerifiedInstructionTrust {
    const row = this.get(path);
    if (!row || row.digest !== instructionDigest(content)) return 'unverified';
    return row.decision === 'revoked' ? 'unverified' : 'approved';
  }

  /** The owner approves these exact bytes at this exact path. Re-approving a
   *  changed file moves the digest, which is what makes an edit re-approvable
   *  without first clearing the old answer. */
  approve(path: string, digest: string): void {
    void this.sql`
      INSERT INTO instruction_approvals (scope, path, digest, decision)
      VALUES (${this.scope}, ${path}, ${digest}, 'approved')
      ON CONFLICT (scope, path)
        DO UPDATE SET digest = ${digest}, decision = 'approved'`;
  }

  /**
   * Carry the workspace's pre-trust instruction files over exactly once.
   *
   * This is deliberately NOT a discovery-time fallback. A first-seen fallback
   * lets an agent create a new path after upgrade and have its own bytes enter
   * system placement as "grandfathered". Call this once before the first turn,
   * snapshotting the paths that exist at migration time, then persist the marker.
   * Every path discovered after that marker starts unverified until the owner
   * approves its exact digest.
   *
   * Existing approval rows win. The migration may resume after a process dies
   * between rows, so inserts are idempotent; the marker is written last, after
   * every baseline row has landed.
   */
  grandfatherExisting(entries: ReadonlyArray<InstructionMigrationEntry>): void {
    this.transaction(() => {
      const migrated = this.sql<{ scope: string }>`
        SELECT scope FROM instruction_approval_migrations WHERE scope = ${this.scope} LIMIT 1`;
      if (migrated.length > 0) return;

      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        void this.sql`
          INSERT INTO instruction_approvals (scope, path, digest, decision)
          VALUES (${this.scope}, ${entry.path}, ${entry.digest}, 'grandfathered')
          ON CONFLICT (scope, path) DO NOTHING`;
      }
      void this.sql`
        INSERT INTO instruction_approval_migrations (scope)
        VALUES (${this.scope})
        ON CONFLICT (scope) DO NOTHING`;
    });
  }

  /** A fork copies writable files but not the owner's approval authority. Mark
   * the target migrated with no rows before it is published, so copied paths
   * start unverified instead of being mistaken for a legacy baseline. */
  markMigratedEmpty(): void {
    this.transaction(() => {
      void this.sql`
        INSERT INTO instruction_approval_migrations (scope)
        VALUES (${this.scope})
        ON CONFLICT (scope) DO NOTHING`;
    });
  }


  /** The owner withdraws trust from a path. The row STAYS, holding the refusal,
   *  so the file drops to `unverified` and no later carry-over can re-grant it
   *  without the owner saying so again. */
  revoke(path: string): void {
    void this.sql`
      INSERT INTO instruction_approvals (scope, path, digest, decision)
      VALUES (${this.scope}, ${path}, '', 'revoked')
      ON CONFLICT (scope, path) DO UPDATE SET decision = 'revoked'`;
  }

  /** Every standing decision in this scope — what the owner's approval surface
   *  lists beside the files discovery actually found. */
  list(): InstructionApproval[] {
    return this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE scope = ${this.scope} ORDER BY path`.map(toApproval);
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
