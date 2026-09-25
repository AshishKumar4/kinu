/**
 * Scaffold modification — 4-gate validation pipeline.
 *
 * Formal spec: Evolution/Scaffold.lean — append_increases_length (version history
 * only grows).
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { DEFAULT_CONFIG } from '../config';
import { nowMs, today } from '../utils/date';
import { scaffoldRefusal } from './safety-patterns';
import { checkMisevolution, recordMisevolutionVeto } from '../safety/misevolution';
import { parsePathologyTag } from '../evolution/pathology';
import { getCurrentScaffoldVersion, readScaffoldVersion } from './shadow';
import type { ModifyResult } from '../types/scaffold';

export type { ModifyResult } from '../types/scaffold';

export interface ModifyScaffoldOpts {
  /** Archive version to branch from; defaults to the current one. */
  baseVersion?: number;
}

export async function modifyScaffold(
  rt: AgentRuntime,
  rationale: string,
  code: string,
  opts?: ModifyScaffoldOpts,
): Promise<ModifyResult> {
  rt.actor.assertCurrent();
  const actorId = rt.actor.actorId;
  const minRationaleLength = DEFAULT_CONFIG.scaffold.minRationaleLength;

  if (rationale.length < minRationaleLength) {
    return { ok: false, stage: 1, error: `Rationale must be ≥${minRationaleLength} chars` };
  }

  const refused = scaffoldRefusal(code);

  if (refused !== null) return { ok: false, stage: 1, error: refused };

  // Misevolution veto; re-checked at promotion against the on-disk pending file.
  const misevolution = checkMisevolution(code);

  if (!misevolution.ok) {
    recordMisevolutionVeto(rt.storage.sql, rt.actor, {
      surface: 'scaffold', violation: misevolution, detail: rationale,
    });

    return { ok: false, stage: 1, error: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
  }

  const { error: parseError } = await rt.executor.execute(
    `async () => { new Function(${JSON.stringify(`"use strict";\n${code}`)}); return true; }`,
    [],
  );

  if (parseError) {
    return { ok: false, stage: 2, error: `Parse error: ${parseError}` };
  }

  // Only one pending at a time: a second would overwrite the first pending's version file.
  const pendingRows = rt.storage.sql<{ version: number }>`
    SELECT version FROM scaffold_versions
    WHERE actor_id = ${actorId} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  if (pendingRows.length > 0) {
    return {
      ok: false, stage: 3,
      error: `a scaffold rollout (v${pendingRows[0].version}) is already pending; resolve it before proposing another`,
    };
  }

  // Base on the current row, not MAX(version), which may be a rolled_back row.
  const currentVersion = getCurrentScaffoldVersion(rt.storage.sql, rt.actor) ?? 0;

  const maxRows = rt.storage.sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions
    WHERE actor_id = ${actorId}`;

  const newVersion = (maxRows[0]?.v ?? 0) + 1;

  const baseVersion = opts?.baseVersion ?? currentVersion;

  if (baseVersion !== currentVersion) {
    const baseRows = rt.storage.sql<{ version: number }>`
      SELECT version FROM scaffold_versions
      WHERE actor_id = ${actorId} AND version = ${baseVersion} LIMIT 1`;

    if (baseRows.length === 0) {
      return { ok: false, stage: 3, error: `base version v${baseVersion} not found in the scaffold archive` };
    }
  }

  // The archive file is canonical: seed it only when missing.
  const scaffoldVfs = rt.agentStateVfs ?? rt.storage.vfs;
  const currentPath = `${rt.identity.scaffold.path}.v${currentVersion}`;

  if (!(await scaffoldVfs.exists(currentPath))) {
    const current = await readScaffoldVersion(rt, currentVersion);

    if (current !== null) await scaffoldVfs.writeFile(currentPath, current);
  }

  // Source files land before the pending row, so a crash never leaves a row without source.
  await scaffoldVfs.writeFile(`${rt.identity.scaffold.path}.v${newVersion}`, code);
  void rt.storage.sql`
    INSERT INTO scaffold_versions
      (actor_id, version, written_at, rationale, status, parent_version, pathology)
    VALUES (${actorId}, ${newVersion}, ${nowMs()}, ${rationale}, 'pending', ${baseVersion},
            ${parsePathologyTag(code)})
  `;

  await rt.memory.append(
    `memory/logs/${today()}.md`,
    `\n## Scaffold v${newVersion} (pending)\n${rationale}\n`,
  );

  return { ok: true, version: newVersion };
}
