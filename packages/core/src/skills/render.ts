/**
 * Render the active-skills section that gets prepended to the system
 * prompt.
 *
 * Format:
 *
 *   ## Active skills
 *
 *   The following workflow skills are active for this turn. While they
 *   are active, your tool surface is restricted to: <intersection>.
 *
 *   ### <skill-name> (<reason>)
 *   <body>
 *
 *   ### <skill-name> (<reason>)
 *   <body>
 *
 * `restriction` is the explicit `allowed_tools` lists of every active
 * skill UNIONed together. Empty list = no restriction. The actual tool
 * gating happens at the runtime layer (see `tools/builtins.ts`), the
 * prompt just announces it so the LLM doesn't get confused about why a
 * tool is suddenly missing.
 */

import type { ParsedSkill, ActiveSkillSet, ActivationReason } from './types.js';

export function renderActiveSkillsSection(activeSet: ActiveSkillSet): string {
  if (activeSet.active.length === 0) return '';

  const restriction = unionAllowedTools(activeSet.active);
  const restrictionLine = restriction.length === 0
    ? 'These skills do not restrict your tool surface.'
    : `Your tool surface for this turn is restricted to: ${restriction.join(', ')}`;

  const reasonByName = new Map<string, ActivationReason>();
  for (const r of activeSet.reasons) reasonByName.set(r.name, r.reason);

  const blocks = activeSet.active.map((s) => {
    const r = reasonByName.get(s.name);
    return `### ${s.name} (${describeReason(r)})\n\n${s.body.trimEnd()}`;
  });

  return [
    '',
    '## Active skills',
    '',
    restrictionLine,
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

/** Union of each active skill's allowed_tools, deduplicated, sorted.
 *  Used both in the prompt header and as the input to runtime tool gating. */
export function unionAllowedTools(skills: ReadonlyArray<ParsedSkill>): string[] {
  const set = new Set<string>();
  for (const s of skills) {
    for (const t of s.allowed_tools) set.add(t);
  }
  return Array.from(set).sort();
}

function describeReason(r?: ActivationReason): string {
  if (!r) return 'active';
  switch (r.kind) {
    case 'explicit':      return `explicit /${r.matched_token}`;
    case 'keyword':       return `keyword "${r.matched_keyword}"`;
    case 'always_active': return `pinned via ${r.via}`;
  }
}

/** True iff a tool name passes the active skills' allow-set. Empty allow-
 *  set in the active skills = no restriction (every tool passes). */
export function toolAllowedBySkills(
  toolName: string,
  allowedUnion: ReadonlyArray<string>,
): boolean {
  if (allowedUnion.length === 0) return true;
  for (const pattern of allowedUnion) {
    if (matchesToolPattern(toolName, pattern)) return true;
  }
  return false;
}

/** Glob-suffix match: `workspace.*` matches `workspace.readFile`; exact
 *  otherwise. */
function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    return toolName.startsWith(prefix);
  }
  // Allow a bare namespace `workspace` to match `workspace.*` too.
  if (!pattern.includes('.') && toolName.startsWith(pattern + '.')) return true;
  return false;
}
