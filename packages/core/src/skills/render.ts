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

/** Char cap shared by all active skill bodies in one prompt. Skill bodies are
 *  agent-authored and uncapped at the store, so without this a single big
 *  SKILL.md could dominate the context (same budget pattern as AGENTS.md —
 *  see prompting/agents-md.ts). */
export const ACTIVE_SKILLS_MAX_CHARS = 16_000;

/** Minimum budget worth spending on a truncated body — below this the body is
 *  omitted with a read pointer instead of contributing a useless fragment. */
const MIN_TRUNCATED_CHARS = 500;

export function renderActiveSkillsSection(
  activeSet: ActiveSkillSet,
  maxChars = ACTIVE_SKILLS_MAX_CHARS,
): string {
  if (activeSet.active.length === 0) return '';

  const restriction = unionAllowedTools(activeSet.active);
  const restrictionLine = restriction.length === 0
    ? 'These skills do not restrict your tool surface.'
    : `Your tool surface for this turn is restricted to: ${restriction.join(', ')}`;

  const reasonByName = new Map<string, ActivationReason>();
  for (const r of activeSet.reasons) reasonByName.set(r.name, r.reason);

  // Spend the budget in activation order (the resolver's precedence order),
  // so earlier-activated skills can never be crowded out by a later giant one.
  // A cut body keeps its header + tool restriction and points at skills read.
  let remaining = Math.max(0, maxChars);
  const blocks = activeSet.active.map((s) => {
    const r = reasonByName.get(s.name);
    const header = `### ${s.name} (${describeReason(r)})`;
    const body = s.body.trimEnd();
    const readPointer = `read the full body with skills({action:"read", name:"${s.name}"})`;
    if (body.length <= remaining) {
      remaining -= body.length;
      return `${header}\n\n${body}`;
    }
    if (remaining >= MIN_TRUNCATED_CHARS) {
      const head = body.slice(0, remaining);
      remaining = 0;
      return `${header}\n\n${head}\n… [truncated: ${body.length - head.length} more chars — ${readPointer}]`;
    }
    return `${header}\n\n(body omitted by the size cap — ${readPointer})`;
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
