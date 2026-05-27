/**
 * Scaffold modification — 4-gate validation pipeline.
 *
 * Architecture reference: final-architecture.md §4
 * Formal spec: ScaffoldSafety.lean — rollback_restores_code, structural_gate_no_import
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { DEFAULT_CONFIG } from '../config.js';
import { nowMs, today } from '../utils/date.js';

interface ModifyResult {
  ok: boolean;
  version?: number;
  error?: string;
  stage?: number;
}

const FORBIDDEN_PATTERNS = [
  /\b(require|import)\s*[\w("']/,
  /\bglobalThis\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

const REQUIRED_SIGNATURE = /async\s+function\s*\*\s*run\s*\(rt\s*,\s*task\s*\)/;

export async function modifyScaffold(
  rt: AgentRuntime,
  rationale: string,
  code: string,
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

  // Gate 2: parse check
  const { error: parseError } = await rt.executor.execute(
    `async () => { new Function(${JSON.stringify(`"use strict";\n${code}`)}); return true; }`,
    [],
  );
  if (parseError) {
    return { ok: false, stage: 2, error: `Parse error: ${parseError}` };
  }

  // Gate 3: version checkpoint
  //   • Back up the current code to scaffold/agent.js.v{v} (lets rollback restore)
  //   • Insert a NEW row for v+1 with status='pending' — picked up by shadow.ts
  //     (decidePromotion → applyPromotionDecision) over the next N turns.
  //
  // Bug history: this used to `INSERT OR REPLACE ... (version=v, ...)` which
  // overwrote the OLD version's rationale with the NEW one and never tracked
  // v+1 — making shadow-mode rollout impossible (getPendingScaffold always
  // returned null). Fixed by inserting v+1 explicitly with the right status.
  const v = await rt.identity.scaffold.version();
  const newVersion = v + 1;
  const current = await rt.identity.scaffold.read();
  await rt.storage.vfs.writeFile(`scaffold/agent.js.v${v}`, current);
  rt.storage.sql`
    INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (${newVersion}, ${nowMs()}, ${rationale}, 'pending')
  `;

  // Gate 4: write
  await rt.identity.scaffold.write(code);
  await rt.memory.append(
    `memory/logs/${today()}.md`,
    `\n## Scaffold v${newVersion} (pending)\n${rationale}\n`,
  );

  return { ok: true, version: newVersion };
}
