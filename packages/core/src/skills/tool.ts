/**
 * The single LLM-facing `skills` tool. One slot in the catalogue,
 * discriminated by `action`:
 *
 *   skills({action: "list"})                  → catalogue (names + briefs)
 *   skills({action: "read", name})            → full body + frontmatter
 *   skills({action: "invoke", name})          → activate for this turn
 *   skills({action: "create", name, ...})     → author + write to VFS
 *   skills({action: "edit", name, ...})       → patch existing
 *   skills({action: "delete", name})          → remove from VFS
 *
 * The `invoke` outcome is consumed by the turn runner: the skill's body
 * is prepended to the system prompt and its `allowed_tools` joins the
 * active restriction set. The other actions are pure CRUD against the
 * VFS — built-ins are immutable from the tool surface (delete on a
 * built-in returns a `forbidden_action` error).
 */

import { discoverSkills, skillPath, type SkillsVfs } from './discover.js';
import { parseSkillFile, stringifySkillFile, validateSkillName } from './parse.js';
import { BUILTIN_SKILLS } from './builtins.js';
import {
  SkillError, SKILLS_DIR,
  type ParsedSkill, type SkillIndexEntry, type SkillsAction,
} from './types.js';

const BUILTIN_NAMES = new Set(BUILTIN_SKILLS.map(s => s.name));

export interface SkillsToolDeps {
  vfs: SkillsVfs;
  /** Called when the agent uses `invoke`. The turn runner records the
   *  name; the next system-prompt rebuild activates it. */
  recordInvoke(name: string): void;
  /** Optional: list of skills currently invoked this turn (for `list`
   *  output). */
  currentlyInvoked?: () => string[];
  skillsDir?: string;
}

export type SkillsToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code: string };

/** The single typed entry point. Inputs are already JSON; this routes
 *  to the per-action handler. */
export async function runSkillsAction(
  deps: SkillsToolDeps,
  input: SkillsAction,
): Promise<SkillsToolOutcome> {
  const dir = deps.skillsDir ?? SKILLS_DIR;
  try {
    switch (input.action) {
      case 'list': {
        const all = await discoverSkills(deps.vfs, { skillsDir: dir });
        const invoked = new Set(deps.currentlyInvoked?.() ?? []);
        const result: Array<SkillIndexEntry & { invoked: boolean }> = all.map((s) => ({
          name: s.name,
          description: s.description,
          allowed_tools: s.allowed_tools,
          keywords: s.keywords,
          auto_activate: s.auto_activate,
          disable_model_invocation: s.disable_model_invocation,
          user_invocable: s.user_invocable,
          source: s.source,
          body_size: s.body.length,
          invoked: invoked.has(s.name),
        }));
        return { ok: true, result };
      }

      case 'read': {
        validateSkillName(input.name);
        const skill = await readSkill(deps.vfs, input.name, dir);
        return { ok: true, result: skill };
      }

      case 'invoke': {
        validateSkillName(input.name);
        // Existence check — invoking a non-existent skill is a hard error
        // rather than silently no-op (so the LLM gets feedback to choose a
        // different one).
        const skill = await readSkill(deps.vfs, input.name, dir);
        deps.recordInvoke(skill.name);
        return {
          ok: true,
          result: {
            invoked: skill.name,
            description: skill.description,
            allowed_tools: skill.allowed_tools,
            body_preview: skill.body.slice(0, 200),
          },
        };
      }

      case 'create': {
        validateSkillName(input.name);
        // Refuse to overwrite an existing skill via create — the agent
        // should use `edit` for that. Avoids accidental clobbers.
        const existing = await maybeReadSkill(deps.vfs, input.name, dir);
        if (existing) {
          throw new SkillError('duplicate',
            `skill "${input.name}" already exists; use action=edit to modify it`);
        }
        const disableModelInvocation = input.disable_model_invocation ?? false;
        const skill: ParsedSkill = {
          name: input.name,
          description: input.description,
          allowed_tools: input.allowed_tools ?? [],
          keywords: (input.keywords ?? []).map(k => k.toLowerCase()),
          // `disable_model_invocation` forces keyword auto-fire off, mirroring
          // the parser's coercion so the two paths agree.
          auto_activate: disableModelInvocation ? false : (input.auto_activate ?? false),
          disable_model_invocation: disableModelInvocation,
          user_invocable: input.user_invocable ?? true,
          body: input.body,
          ext: {},
          source: 'agent',
        };
        await writeSkill(deps.vfs, skill, dir);
        return { ok: true, result: { created: skill.name, path: skillPath(skill.name, dir) } };
      }

      case 'edit': {
        // Editing a built-in writes a VFS override (the loader shadows
        // built-ins with VFS) — a sanctioned "fork the builtin", not forbidden.
        validateSkillName(input.name);
        const current = await readSkill(deps.vfs, input.name, dir);
        const disableModelInvocation = input.disable_model_invocation ?? current.disable_model_invocation;
        const next: ParsedSkill = {
          ...current,
          source: 'agent',
          description: input.description ?? current.description,
          allowed_tools: input.allowed_tools ?? current.allowed_tools,
          keywords: input.keywords
            ? input.keywords.map(k => k.toLowerCase())
            : current.keywords,
          disable_model_invocation: disableModelInvocation,
          auto_activate: disableModelInvocation
            ? false
            : (input.auto_activate ?? current.auto_activate),
          user_invocable: input.user_invocable ?? current.user_invocable,
          body: input.body ?? current.body,
        };
        await writeSkill(deps.vfs, next, dir);
        return { ok: true, result: { edited: next.name, path: skillPath(next.name, dir) } };
      }

      case 'delete': {
        validateSkillName(input.name);
        if (BUILTIN_NAMES.has(input.name)) {
          // Check whether there's a VFS override; deleting the override is fine.
          const path = skillPath(input.name, dir);
          const exists = await deps.vfs.exists(path);
          if (!exists) {
            throw new SkillError('forbidden_action',
              `cannot delete built-in skill "${input.name}" (it lives in core/src/skills/builtins.ts). ` +
              `If you previously edited it, the override has already been removed.`);
          }
          await deps.vfs.unlink?.(path);
          return { ok: true, result: { deleted: input.name, restored: 'builtin' } };
        }
        const path = skillPath(input.name, dir);
        if (!(await deps.vfs.exists(path))) {
          throw new SkillError('not_found', `no skill named "${input.name}"`);
        }
        await deps.vfs.unlink?.(path);
        return { ok: true, result: { deleted: input.name } };
      }
    }
  } catch (err) {
    if (err instanceof SkillError) {
      return { ok: false, error: err.message, code: err.code };
    }
    return { ok: false, error: (err as Error).message, code: 'vfs_error' };
  }
}

// ── VFS helpers ──────────────────────────────────────────────────

async function readSkill(vfs: SkillsVfs, name: string, dir: string): Promise<ParsedSkill> {
  // VFS first.
  const path = skillPath(name, dir);
  if (await vfs.exists(path)) {
    const raw = await vfs.readFile(path, { encoding: 'utf8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = parseSkillFile(text, 'vfs');
    if (!parsed.ok) {
      throw new SkillError('invalid_frontmatter', `skill "${name}" failed to parse: ${parsed.error}`);
    }
    return parsed.skill;
  }
  // Built-in fallback.
  const builtin = BUILTIN_SKILLS.find(s => s.name === name);
  if (builtin) return builtin;
  throw new SkillError('not_found', `no skill named "${name}"`);
}

async function maybeReadSkill(vfs: SkillsVfs, name: string, dir: string): Promise<ParsedSkill | null> {
  try { return await readSkill(vfs, name, dir); }
  catch (err) {
    if (err instanceof SkillError && err.code === 'not_found') return null;
    throw err;
  }
}

async function writeSkill(vfs: SkillsVfs, skill: ParsedSkill, dir: string): Promise<void> {
  if (vfs.mkdir) await vfs.mkdir(dir, { recursive: true });
  const path = skillPath(skill.name, dir);
  await vfs.writeFile(path, stringifySkillFile(skill));
}
