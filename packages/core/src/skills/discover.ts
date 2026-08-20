/**
 * Skill discovery — scan the VFS for `.md` files under `/workspace/skills/`,
 * parse each, merge with built-ins. VFS skills shadow built-ins of the
 * same name (the operator and the agent can override us).
 *
 * Malformed files are skipped with a warning so one broken skill doesn't
 * stop the rest from loading.
 */

import { parseSkillFile } from './parse';
import { BUILTIN_SKILLS } from './builtins';
import { SKILLS_DIR, type ParsedSkill } from './types';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** Minimal VFS shape — duck-typed against any file view. */
export interface SkillsVfs {
  exists(path: string): Promise<boolean>;
  readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
  readdir?(path: string): Promise<string[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  unlink?(path: string): Promise<void>;
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface DiscoverOpts {
  skillsDir?: string;
  onParseError?: (file: string, error: string) => void;
}


/** Discover every valid skill — built-ins + VFS, with VFS taking precedence. */
export async function discoverSkills(
  vfs: SkillsVfs,
  opts: DiscoverOpts = {},
): Promise<ParsedSkill[]> {
  const dir = opts.skillsDir ?? SKILLS_DIR;
  const onErr = opts.onParseError ?? ((file, err) => diagnostics.failure(
    'skills.parse_failed',
    toKinuError({ doing: 'parse a skill file', cause: err, otherwise: 'bad_input' }),
    { file },
  ));

  const byName = new Map<string, ParsedSkill>();
  for (const s of BUILTIN_SKILLS) byName.set(s.name, s);

  let entries: string[] = [];
  try {
    if (vfs.readdir) entries = await vfs.readdir(dir);
  } catch {
    // No directory yet — return just built-ins.
    return Array.from(byName.values());
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const path = `${dir.replace(/\/$/, '')}/${entry}`;
    const stem = entry.replace(/\.md$/, '');
    try {
      const raw = await vfs.readFile(path, { encoding: 'utf8' });
      const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
      // Filename stem doubles as the fallback `name` so Claude-Code skills
      // authored without a `name:` line still parse (Anthropic spec lets
      // the directory name supply it). If frontmatter DOES specify name,
      // we still require it to match the filename to avoid drift.
      const parsed = parseSkillFile(text, 'vfs', stem);
      if (!parsed.ok) { onErr(path, parsed.error); continue; }
      if (parsed.skill.name !== stem) {
        onErr(path, `filename "${entry}" does not match front-matter name "${parsed.skill.name}"`);
        continue;
      }
      byName.set(parsed.skill.name, parsed.skill);
    } catch (error) {
      onErr(path, renderThrownChain({ cause: error }));
    }
  }

  return Array.from(byName.values());
}

/** Filename-safe path for a skill name. */
export function skillPath(name: string, skillsDir = SKILLS_DIR): string {
  return `${skillsDir.replace(/\/$/, '')}/${name}.md`;
}
