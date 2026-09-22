/**
 * Skill discovery: scan `/workspace/skills/` and the shared Drive, parse front
 * matter, merge with built-ins. A file claiming a built-in name is refused
 * (KINU-N028); malformed files are reported and skipped.
 *
 * Discovery holds no VFS body, reads under the `admissionBytes` ceiling (checked
 * via `stat` before reading when available), and opens at most as many files as
 * the budget could list; the rest are counted in `omitted`.
 */
import { admissionBytes, estimateTokens } from '../llm';
import { classify, diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { parseMarkdownFrontmatter } from '../utils/markdown-frontmatter';
import type { VfsEntryStat } from '../types/primitives';

import { parseSkillFile, skillNameProblem } from './parse';
import { BUILTIN_SKILLS } from './builtins';

import { SHARED_SKILLS_DIR } from '../vfs/shared-drive';
import { isVfsError } from '../vfs/errno';
import {
  SKILLS_DIR, workspaceSkillIndexLine, type DiscoveredSkill, type ParsedSkill, type SkillBodyRef, type SkillSource,
} from './types';

export interface SkillsVfs {
  exists(path: string): Promise<boolean>;
  readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
  readdir?(path: string): Promise<string[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  unlink?(path: string): Promise<void>;
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Optional; without it every `.md` file is opened every turn. */
  stat?(path: string): Promise<VfsEntryStat | null>;
}

/** A file whose size alone exceeds the turn's allocation; named, never opened. */
export interface UnreadSkillFile {
  name: string;
  path: string;
  bytes: number;
}

export interface SkillsDiscovery {
  skills: DiscoveredSkill[];
  unread: UnreadSkillFile[];
  /** Candidates beyond the header count bound, counted but not read. Absent means zero. */
  omitted: number;
}

export interface DiscoverOpts {
  /** The turn's skills allocation in tokens; a larger file is never opened. */
  admissionTokens: number;
  skillsDir?: string;
  onParseError?: (file: string, error: string) => void;
}

/** Name order by code unit, not `localeCompare`: the prompt prefix must be byte-identical across hosts. */
export function compareSkillNames(a: string, b: string): number {
  if (a < b) return -1;

  if (a > b) return 1;

  return 0;
}

/** Built-in headers; also the fallback when the VFS walk fails. */
export const BUILTIN_SKILL_HEADERS: ReadonlyArray<DiscoveredSkill> = Object.freeze(
  BUILTIN_SKILLS.map((skill) => discovered(skill, { kind: 'builtin', text: skill.body })),
);

/** Reserved names: no agent-writable file may claim one (KINU-N028). */
export const BUILTIN_SKILL_NAMES: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(BUILTIN_SKILLS.map((skill) => [skill.name, true] as const)),
);

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
  let omitted = 0;
  // Byte ceiling from `admissionBytes`; enforced on the read's result when stat is unavailable.
  const ceiling = admissionBytes(opts.admissionTokens);

  // Count bound: how many of the cheapest workspace header lines the budget could carry.
  let slots = Math.floor(
    opts.admissionTokens / estimateTokens(workspaceSkillIndexLine('a').length + 1),
  );

  // Workspace skills win name clashes over the shared Drive; the shared file is refused with a reason.
  const directories: { dir: string; source: SkillSource }[] = [{ dir, source: 'vfs' }, { dir: SHARED_SKILLS_DIR, source: 'shared' }];

  for (const { dir: scanned, source } of directories) {
    // Sort before opening: readdir order is filesystem-dependent and the bound decides what is read.
    const candidates = (await listSkillCandidates(vfs, scanned)).sort((a, b) => compareSkillNames(a.stem, b.stem));

    for (const { stem, path } of candidates) {
      // The stem is the skill's name, so an illegal stem is rejected without a read.
      const stemProblem = skillNameProblem(stem);

      if (stemProblem) { onErr(path, `filename stem ${stemProblem}`); continue; }

      if (Object.hasOwn(BUILTIN_SKILL_NAMES, stem)) {
        onErr(path, `"${stem}" is a built-in skill name and cannot be overridden by a workspace file`);
        continue;
      }

      if (source === 'shared' && byName.has(stem)) {
        onErr(path, `"${stem}" is shadowed by the workspace skill of the same name`);
        continue;
      }

      if (slots <= 0) { omitted += 1; continue; }

      try {
        const size = vfs.stat ? (await vfs.stat(path))?.size : undefined;

        if (size !== undefined && size > ceiling) {
          slots -= 1;
          unread.push({ name: stem, path, bytes: size });
          continue;
        }

        const text = await readTextFile(vfs, path, ceiling);
        // The stem is the fallback `name`; an explicit `name:` must still match it.
        const parsed = parseSkillFile(text, source, stem);

        if (!parsed.ok) { onErr(path, parsed.error); slots -= 1; continue; }

        if (parsed.skill.name !== stem) {
          onErr(path, `"${path}" does not match front-matter name "${parsed.skill.name}"`);
          slots -= 1;
          continue;
        }

        slots -= 1;
        byName.set(parsed.skill.name, discovered(parsed.skill, {
          kind: 'file',
          path,
          chars: parsed.skill.body.length,
        }));
      } catch (error) {
        slots -= 1;
        onErr(path, renderThrownChain({ cause: error }));
      }
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => compareSkillNames(a.name, b.name)),
    unread: unread.sort((a, b) => compareSkillNames(a.name, b.name)),
    omitted,
  };
}

export const SKILL_FOLDER_FILE = 'SKILL.md';

function skillFolderPath(name: string, skillsDir = SKILLS_DIR): string {
  return `${skillsDir.replace(/\/$/, '')}/${name}/${SKILL_FOLDER_FILE}`;
}

/**
 * Unopened candidates in one directory: flat `<name>.md` files and
 * `<name>/SKILL.md` folders. A missing directory or mount is an empty list.
 */
async function listSkillCandidates(vfs: SkillsVfs, dir: string): Promise<{ stem: string; path: string }[]> {
  let entries: string[] = [];

  try {
    if (vfs.readdir) entries = await vfs.readdir(dir);
  } catch (error) {
    if (classify({ cause: error }) === 'enoent') return [];

    if (isVfsError(error) && error.code === 'ENXIO') return [];
    throw error;
  }

  const candidates: { stem: string; path: string }[] = [];

  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      candidates.push({ stem: entry.replace(/\.md$/, ''), path: skillPath(entry.replace(/\.md$/, ''), dir) });
      continue;
    }

    const folderFile = skillFolderPath(entry, dir);

    if (await vfs.exists(folderFile)) candidates.push({ stem: entry, path: folderFile });
  }

  return candidates;
}

/**
 * Read a skill's complete source, truncated to `admissionBytes(admissionTokens)`.
 * Front matter is live policy, so trust decisions bind this whole raw value.
 */
export async function readSkillFile(
  vfs: SkillsVfs,
  ref: SkillBodyRef,
  admissionTokens: number,
): Promise<string> {
  return ref.kind === 'builtin'
    ? ref.text
    : readTextFile(vfs, ref.path, admissionBytes(admissionTokens));
}

/** Fetch one admitted body: a module constant or parsed from the bounded read. */
export async function readSkillBody(
  vfs: SkillsVfs,
  ref: SkillBodyRef,
  admissionTokens: number,
): Promise<string> {
  return parseMarkdownFrontmatter(await readSkillFile(vfs, ref, admissionTokens)).body;
}

export function skillPath(name: string, skillsDir = SKILLS_DIR): string {
  return `${skillsDir.replace(/\/$/, '')}/${name}.md`;
}

/** Admission derives every active policy field from its own raw snapshot. */
function discovered(skill: ParsedSkill, bodyRef: SkillBodyRef): DiscoveredSkill {
  const { body: _body, ...header } = skill;

  return { ...header, bodyRef };
}

async function readTextFile(vfs: SkillsVfs, path: string, ceiling: number): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;

  // No ranged read exists, so the bound applies to what the read returns.
  return text.length <= ceiling ? text : text.slice(0, ceiling);
}
