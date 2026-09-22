/**
 * KINU-N028. Workspace instruction files (AGENTS.md chain, skills) get system force only when an owner
 * approved this exact path and content digest; otherwise they render as unverified reference material.
 * Any rewrite changes the digest and demotes on the next turn. Revocations are kept, not deleted.
 */

import { argumentDigest } from './argument-digest';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import * as v from 'valibot';

export type {
  InstructionTrust, VerifiedInstructionTrust, InstructionTrustResolver,
} from '../types/instruction-trust';

import type { VerifiedInstructionTrust } from '../types/instruction-trust';

/** `grandfathered` is read like `approved` but no code writes it. `revoked` is kept so nothing re-grants it. */
export type InstructionDecision = 'approved' | 'grandfathered' | 'revoked';

const DECISION = v.picklist(['approved', 'grandfathered', 'revoked']);

export interface InstructionApproval {
  readonly path: string;
  readonly digest: string;
  readonly decision: InstructionDecision;
}

/** SHA-256 (not fnv1a64: the adversary writes the file). `v` guards the shape against silent format drift. */
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
    // An unparsable decision is a corrupt row; read it as `revoked` to fail closed.
    decision: decision.success ? decision.output : 'revoked',
  };
}

/**
 * Trust needs a decision for this path and a stored digest equal to the content's digest. The only
 * implementation of that rule; `InstructionApprovalStore` delegates here.
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
 * Keyed by (actor, scope, path): `scope` isolates workspaces (forks start unapproved) and each actor,
 * subordinates included, starts with no decisions.
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

  /** The standing decision for this path, regardless of digest. */
  get(path: string): InstructionApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE actor_id = ${this.actorId} AND scope = ${this.scope} AND path = ${path} LIMIT 1`;

    return rows[0] ? toApproval(rows[0]) : null;
  }

  trustOf(path: string, content: string): VerifiedInstructionTrust {
    const row = this.get(path);

    return trustOfInstructionApprovals(row === null ? [] : [row], path, content);
  }

  /** Re-approving a changed file moves the digest. */
  approve(path: string, digest: string): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO instruction_approvals (actor_id, scope, path, digest, decision)
      VALUES (${this.actorId}, ${this.scope}, ${path}, ${digest}, 'approved')
      ON CONFLICT (actor_id, scope, path)
        DO UPDATE SET digest = ${digest}, decision = 'approved'`;
  }

  /** The row stays, holding the refusal; only a fresh approval re-grants. */
  revoke(path: string): void {
    this.actor.assertCurrent();
    void this.sql`
      INSERT INTO instruction_approvals (actor_id, scope, path, digest, decision)
      VALUES (${this.actorId}, ${this.scope}, ${path}, '', 'revoked')
      ON CONFLICT (actor_id, scope, path) DO UPDATE SET decision = 'revoked'`;
  }

  list(): InstructionApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT path, digest, decision FROM instruction_approvals
      WHERE actor_id = ${this.actorId} AND scope = ${this.scope} ORDER BY path`.map(toApproval);
  }
}

export type AdmittedInstructionDecision =
  | { readonly ok: true; readonly path: string; readonly digest: string }
  | { readonly ok: false; readonly error: string };

/** Admit an owner's approve/revoke request (the one rule for both backends). Omit `digest` to revoke. */
export function admitInstructionDecision(path: string, digest?: string): AdmittedInstructionDecision {
  const clean = path.trim();

  if (clean === '') return { ok: false, error: 'path is required' };

  if (digest === undefined) return { ok: true, path: clean, digest: '' };

  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, error: 'digest must be the 64-character SHA-256 the surface displayed' };
  }

  return { ok: true, path: clean, digest };
}
