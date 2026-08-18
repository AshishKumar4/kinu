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

import type { ParsedSkill, ActiveSkillSet, ActivationReason } from './types';
import { skillPath } from './discover';

/** Char cap shared by all active skill bodies in one prompt. Skill bodies are
 *  agent-authored and uncapped at the store, so without this a single big
 *  SKILL.md could dominate the context (same budget pattern as AGENTS.md —
 *  see prompting/agents-md.ts). */
export const ACTIVE_SKILLS_MAX_CHARS = 16_000;

/** Minimum budget worth spending on a truncated body — below this the body is
 *  omitted with a read pointer instead of contributing a useless fragment. */
const MIN_TRUNCATED_CHARS = 500;

/** Char cap for the ambient skills index (name + description for EVERY
 *  available skill, not just active ones). Bounded the same way
 *  renderActiveSkillsSection is — an honest elision count under pressure
 *  rather than a silent cut — but the per-entry cost here is small (progressive
 *  disclosure: only name + description, never a body), so the budget is a
 *  fraction of ACTIVE_SKILLS_MAX_CHARS. */
export const SKILLS_INDEX_MAX_CHARS = 4_000;

/** Per-description clip so one verbose skill can't crowd out the rest of the
 *  index — the frontmatter cap (1024 chars) is 10x looser than what a
 *  one-line index entry needs. */
const INDEX_DESCRIPTION_MAX_CHARS = 200;

/**
 * The ambient skills catalogue: every available skill's name + description
 * (built-ins + VFS), rendered unconditionally so the model can discover what
 * exists without spending a turn on a list call. Only ACTIVE skills' bodies
 * expand below (renderActiveSkillsSection) — this section is the index, not
 * the content, matching the Agent Skills spec's progressive disclosure: name
 * + description resident at all times, body loaded on activation, nothing
 * else read until asked for.
 */
export function renderSkillsIndexSection(
  available: ReadonlyArray<ParsedSkill>,
  maxChars = SKILLS_INDEX_MAX_CHARS,
): string {
  if (available.length === 0) return '';

  const sorted = [...available].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  let spent = 0;
  let shown = 0;
  for (const skill of sorted) {
    const description = skill.description.length > INDEX_DESCRIPTION_MAX_CHARS
      ? `${skill.description.slice(0, INDEX_DESCRIPTION_MAX_CHARS)}…`
      : skill.description;
    const line = `- **${skill.name}** — ${description}`;
    if (spent + line.length + 1 > maxChars) break;
    lines.push(line);
    spent += line.length + 1;
    shown += 1;
  }
  const omitted = sorted.length - shown;

  return [
    '',
    '## Skills',
    '',
    'Workflow instructions this agent has stored. Read a full body with '
      + '`workspace.readFile` over its VFS path (agent-authored skills only — built-ins have '
      + 'none) or by letting it activate (explicit `/name`, an auto-activate keyword match, or '
      + 'an operator pin); author one with workspace.writeFile under /workspace/skills/<name>.md.',
    '',
    lines.join('\n'),
    ...(omitted > 0 ? ['', `… and ${omitted} more skill${omitted === 1 ? '' : 's'} not shown (index capped at ${maxChars} chars).`] : []),
    '',
  ].join('\n');
}

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
  // so earlier-activated skills can never be crowded out by a later giant
  // one — but RENDER the blocks in stable name order so the same active set
  // is byte-identical regardless of how it was activated. (When the set
  // overflows the budget under a different precedence order, truncation
  // shifts with it — a real priority change, hence a deliberate cache bust.)
  // A cut body keeps its header + tool restriction and points at skills read.
  let remaining = Math.max(0, maxChars);
  const blockByName = new Map<string, string>();
  for (const s of activeSet.active) {
    const r = reasonByName.get(s.name);
    const header = `### ${s.name} (${describeReason(r)})`;
    const body = s.body.trimEnd();
    const readPointer = `read the full body with workspace.readFile("${skillPath(s.name)}")`;
    if (body.length <= remaining) {
      remaining -= body.length;
      blockByName.set(s.name, `${header}\n\n${body}`);
    } else if (remaining >= MIN_TRUNCATED_CHARS) {
      const head = body.slice(0, remaining);
      remaining = 0;
      blockByName.set(s.name, `${header}\n\n${head}\n… [truncated: ${body.length - head.length} more chars — ${readPointer}]`);
    } else {
      blockByName.set(s.name, `${header}\n\n(body omitted by the size cap — ${readPointer})`);
    }
  }
  const blocks = [...blockByName.keys()].sort((a, b) => a.localeCompare(b))
    .map((name) => blockByName.get(name)!);

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
