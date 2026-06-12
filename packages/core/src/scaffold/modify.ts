/**
 * Scaffold modification — 4-gate validation pipeline.
 *
 * Architecture reference: final-architecture.md §4
 * Formal spec: Evolution/Scaffold.lean — append_increases_length (version history
 * only grows); Safety/CapabilitySafety.lean — scaffoldwrite_not_grantable.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { DEFAULT_CONFIG } from '../config.js';
import { nowMs, today } from '../utils/date.js';
import {
  SCAFFOLD_FORBIDDEN_PATTERNS as FORBIDDEN_PATTERNS,
  SCAFFOLD_REQUIRED_SIGNATURE as REQUIRED_SIGNATURE,
} from './safety-patterns.js';
import { checkMisevolution, recordMisevolutionVeto } from './misevolution.js';

interface ModifyResult {
  ok: boolean;
  version?: number;
  error?: string;
  stage?: number;
}

export interface ModifyScaffoldOpts {
  /** The archive version this proposal branches from (DGM stepping stone).
   *  Recorded as the new row's parent_version. Default: the live current. */
  baseVersion?: number;
}

export async function modifyScaffold(
  rt: AgentRuntime,
  rationale: string,
  code: string,
  opts?: ModifyScaffoldOpts,
): Promise<ModifyResult> {
  const minRationaleLength = DEFAULT_CONFIG.scaffold.minRationaleLength;

  // Gate 1: structural validation
  if (rationale.length < minRationaleLength) {
    return { ok: false, stage: 1, error: `Rationale must be ≥${minRationaleLength} chars` };
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { ok: false, stage: 1, error: `Forbidden pattern: ${pattern.source}` };
    }
  }
  if (!REQUIRED_SIGNATURE.test(code)) {
    return { ok: false, stage: 1, error: 'Must export async function* run(rt, task)' };
  }
  // Misevolution gate (fixed criteria, hardcoded in core): a proposal that
  // touches the safety machinery, opens raw egress, or weakens consent paths
  // is a hard veto with a recorded reason. Re-checked at promotion time in
  // applyPromotionDecision against the on-disk pending file.
  const misevolution = checkMisevolution(code);
  if (!misevolution.ok) {
    recordMisevolutionVeto(rt.storage.sql, {
      surface: 'scaffold', violation: misevolution, detail: rationale,
    });
    return { ok: false, stage: 1, error: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
  }

  // Gate 2: parse check
  const { error: parseError } = await rt.executor.execute(
    `async () => { new Function(${JSON.stringify(`"use strict";\n${code}`)}); return true; }`,
    [],
  );
  if (parseError) {
    return { ok: false, stage: 2, error: `Parse error: ${parseError}` };
  }

  // Gate 3: version checkpoint.
  //
  // Single-pending invariant: shadow rollout scores ONE pending at a time
  // (getPendingScaffold returns the single status='pending' row). Refuse to
  // stack a second pending — doing so would back up the live content over the
  // first pending's versioned file and corrupt it.
  const pendingRows = rt.storage.sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE status = 'pending' ORDER BY version DESC LIMIT 1`;
  if (pendingRows.length > 0) {
    return {
      ok: false, stage: 3,
      error: `a scaffold rollout (v${pendingRows[0].version}) is already pending; resolve it before proposing another`,
    };
  }

  // Base the rollout on the live ('current') version — NOT MAX(version), which
  // can point at a higher-numbered rolled_back/historical row after a rollback
  // cycle. Number the new pending above any existing row so its PK never
  // collides with a stale row.
  const currentRows = rt.storage.sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE status = 'current' ORDER BY version DESC LIMIT 1`;
  const currentVersion = currentRows[0]?.version ?? await rt.identity.scaffold.version();
  const maxRows = rt.storage.sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions`;
  const newVersion = (maxRows[0]?.v ?? currentVersion) + 1;

  // Lineage: a proposal may branch from ANY archived version (DGM stepping
  // stones), not only the current. The base must be a real archive row.
  const baseVersion = opts?.baseVersion ?? currentVersion;
  if (baseVersion !== currentVersion) {
    const baseRows = rt.storage.sql<{ version: number }>`
      SELECT version FROM scaffold_versions WHERE version = ${baseVersion} LIMIT 1`;
    if (baseRows.length === 0) {
      return { ok: false, stage: 3, error: `base version v${baseVersion} not found in the scaffold archive` };
    }
  }

  // Ensure the current content is backed up at its own version file so
  // rollback can restore it.
  const current = await rt.identity.scaffold.read();
  await rt.storage.vfs.writeFile(`scaffold/agent.js.v${currentVersion}`, current);
  rt.storage.sql`
    INSERT INTO scaffold_versions (version, written_at, rationale, status, parent_version)
    VALUES (${newVersion}, ${nowMs()}, ${rationale}, 'pending', ${baseVersion})
  `;

  // Gate 4: write the pending code to the VERSIONED file, NOT the live file.
  //
  // Why: shadow rollout (auto-judge.ts) reads pending via readScaffoldVersion,
  // which prefers `scaffold/agent.js.v{N}` over the live file when version != current.
  // If we wrote the pending into `scaffold/agent.js` here, the live and pending
  // files would be identical during the entire shadow window — the judge would
  // be comparing the new code to itself. Promotion in that world was a flag
  // flip with no on-disk consequence. Now the live `scaffold/agent.js` stays
  // on the current version's content throughout shadow eval; promotion is a
  // genuine file swap. See applyPromotionDecision in shadow.ts.
  await rt.storage.vfs.writeFile(`scaffold/agent.js.v${newVersion}`, code);
  await rt.memory.append(
    `memory/logs/${today()}.md`,
    `\n## Scaffold v${newVersion} (pending)\n${rationale}\n`,
  );

  return { ok: true, version: newVersion };
}
