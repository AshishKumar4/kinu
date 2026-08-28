/**
 * Skill discovery — the VFS side of the skills store: scan `/workspace/skills/`
 * for `.md` files, read each file's front matter, merge with the built-ins. A
 * built-in's name is reserved and a file claiming one is refused, never merged
 * over (KINU-N028; see `builtins.ts`). Malformed files are reported and skipped
 * so one broken skill doesn't take the turn's whole catalogue with it.
 *
 * Discovery holds NO VFS body. The ambient index needs a name and a
 * description; only a skill that actually activates needs its instructions, and
 * only if the turn can pay for them (loader.ts). So each file yields a
 * `DiscoveredSkill`: the header, plus where the body is and what admitting it
 * would cost. `readSkillBody` fetches one, later, for the few that were
 * admitted.
 *
 * Front matter cannot be fetched without its tail: `SkillsVfs.readFile` — like
 * the workspace `VFS` behind it — reads whole files, and there is no ranged read
 * to borrow. `stat` is what keeps that honest: a file whose reported size alone
 * cannot fit the turn's whole skills allocation could never contribute a body,
 * so it is named from its filename and never opened at all.
 *
 * Order is a single total order — by name, code-unit ascending — decided here
 * and nowhere else. `readdir` order is filesystem- and backend-dependent, and
 * for a corpus that overflows the allocation it used to decide which skills the
 * model got to see.
 */
import { estimateTokens } from '../llm';
import { classify, diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { parseMarkdownFrontmatter } from '../utils/markdown-frontmatter';
import type { VfsEntryStat } from '../types/primitives';

import { parseSkillFile, skillNameProblem } from './parse';
import { BUILTIN_SKILLS } from './builtins';
import { SKILLS_DIR, type DiscoveredSkill, type ParsedSkill, type SkillBodyRef } from './types';

/** Minimal VFS shape — duck-typed against any file view. */
export interface SkillsVfs {
  exists(path: string): Promise<boolean>;
  readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
  readdir?(path: string): Promise<string[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  unlink?(path: string): Promise<void>;
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Size before bytes. Optional because a file view may not offer it; without
   *  it every `.md` file is opened — which is what discovery did for every
   *  file, every turn, before this. */
  stat?(path: string): Promise<VfsEntryStat | null>;
}

/** A skill file discovery deliberately did not open: one body of that size
 *  cannot fit the turn's whole allocation. Named, never dropped. */
export interface UnreadSkillFile {
  name: string;
  path: string;
  /** What `stat` reported, in bytes. */
  bytes: number;
}

/** Everything under the skills dir, in one stable total order. */
export interface SkillsDiscovery {
  /** Skills whose front matter parsed, by name, code-unit ascending. */
  skills: DiscoveredSkill[];
  /** Files too big to open, by name, code-unit ascending. */
  unread: UnreadSkillFile[];
}

export interface DiscoverOpts {
  /** The turn's whole skills allocation, in tokens (turn-surface.ts derives it
   *  from the model window). A file whose size alone exceeds it is never
   *  opened. */
  admissionTokens: number;
  skillsDir?: string;
  onParseError?: (file: string, error: string) => void;
}

/** The one total order for skills: by name, code-unit ascending.
 *
 *  Not `localeCompare`: that answer depends on the host's locale and ICU build,
 *  and these names sit in a prompt prefix that must be byte-identical across
 *  every machine serving the same agent. */
export function compareSkillNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Built-ins as discovery sees them: headers whose bodies are module constants
 *  already in memory, so admitting one costs no read. Also the floor a turn
 *  falls back to when the VFS walk fails. */
export const BUILTIN_SKILL_HEADERS: ReadonlyArray<DiscoveredSkill> = Object.freeze(
  BUILTIN_SKILLS.map((skill) => discovered(skill, { kind: 'builtin', text: skill.body })),
);

/** The reserved names. A built-in is shipped doctrine, so no file on a plane the
 *  agent can write may claim one (KINU-N028). */
export const BUILTIN_SKILL_NAMES: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(BUILTIN_SKILLS.map((skill) => [skill.name, true] as const)),
);

/** Discover every valid skill — the built-ins, plus every workspace file that
 *  does not collide with one. */
export async function discoverSkills(
  vfs: SkillsVfs,
  opts: DiscoverOpts,
): Promise<SkillsDiscovery> {
  const dir = opts.skillsDir ?? SKILLS_DIR;
  const onErr = opts.onParseError ?? ((file, err) => diagnostics.failure(
    'skills.parse_failed',
    toKinuError({ doing: 'parse a skill file', cause: err, otherwise: 'bad_input' }),
    { file },
  ));

  const byName = new Map<string, DiscoveredSkill>();
  for (const s of BUILTIN_SKILL_HEADERS) byName.set(s.name, s);
  const unread: UnreadSkillFile[] = [];

  let entries: string[] = [];
  try {
    if (vfs.readdir) entries = await vfs.readdir(dir);
  } catch (error) {
    if (classify({ cause: error }) !== 'enoent') throw error;
    // No directory yet — just the built-ins.
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const stem = entry.replace(/\.md$/, '');
    const path = skillPath(stem, dir);
    // The filename stem IS the skill's name (Anthropic's spec lets the
    // directory name supply it), so an illegal stem is not a skill at all —
    // and learning that costs no read.
    const stemProblem = skillNameProblem(stem);
    if (stemProblem) { onErr(path, `filename stem ${stemProblem}`); continue; }
    // A built-in name is RESERVED (KINU-N028). This directory is writable by
    // the agent's own `file` tool and shell, so letting a file here take a
    // built-in's name would let the agent replace shipped doctrine — including
    // the `allowed_tools` a built-in declares — by choosing a filename. The
    // file is refused rather than silently ignored, so the author is told why.
    if (Object.hasOwn(BUILTIN_SKILL_NAMES, stem)) {
      onErr(path, `"${stem}" is a built-in skill name and cannot be overridden by a workspace file`);
      continue;
    }
    try {
      const size = vfs.stat ? (await vfs.stat(path))?.size : undefined;
      if (size !== undefined && estimateTokens(size) > opts.admissionTokens) {
        unread.push({ name: stem, path, bytes: size });
        continue;
      }
      const text = await readTextFile(vfs, path);
      // The stem doubles as the fallback `name` so Claude-Code skills authored
      // without a `name:` line still parse. If frontmatter DOES specify a name,
      // we still require it to match the filename to avoid drift.
      const parsed = parseSkillFile(text, 'vfs', stem);
      if (!parsed.ok) { onErr(path, parsed.error); continue; }
      if (parsed.skill.name !== stem) {
        onErr(path, `filename "${entry}" does not match front-matter name "${parsed.skill.name}"`);
        continue;
      }
      byName.set(parsed.skill.name, discovered(parsed.skill, {
        kind: 'file',
        path,
        chars: parsed.skill.body.length,
      }));
    } catch (error) {
      onErr(path, renderThrownChain({ cause: error }));
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => compareSkillNames(a.name, b.name)),
    unread: unread.sort((a, b) => compareSkillNames(a.name, b.name)),
  };
}

/**
 * Read a skill's complete source file.
 *
 * The front matter is live policy (`allowed_tools`, activation, invocation and
 * unknown extension fields), not decoration. Any trust decision therefore
 * binds this complete raw value, while a caller that renders instructions may
 * parse the body from the same bytes afterwards.
 */
export async function readSkillFile(vfs: SkillsVfs, ref: SkillBodyRef): Promise<string> {
  return ref.kind === 'builtin' ? ref.text : readTextFile(vfs, ref.path);
}

/** Fetch one admitted body. A built-in body is a module constant and a VFS body
 * is parsed from the complete source file it came from. */
export async function readSkillBody(vfs: SkillsVfs, ref: SkillBodyRef): Promise<string> {
  return parseMarkdownFrontmatter(await readSkillFile(vfs, ref)).body;
}

/** Filename-safe path for a skill name. */
export function skillPath(name: string, skillsDir = SKILLS_DIR): string {
  return `${skillsDir.replace(/\/$/, '')}/${name}.md`;
}

/** A discovered skill is a parsed file minus its body, plus where the body
 * lives. Admission derives every active policy field from its own raw snapshot. */
function discovered(skill: ParsedSkill, bodyRef: SkillBodyRef): DiscoveredSkill {
  const { body: _body, ...header } = skill;
  return { ...header, bodyRef };
}

async function readTextFile(vfs: SkillsVfs, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  return raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
}
