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
 * Front matter is read under the byte ceiling `admissionBytes` derives from
 * the turn's allocation — with `stat` the ceiling is consulted BEFORE the
 * read (a file whose size alone cannot fit is named, never opened); without
 * it the read itself is truncated to the same ceiling, so no file plane can
 * hand discovery an unbounded body. Discovery also ends: at most as many
 * files are opened as the prompt budget could list headers for, taken in the
 * sorted order — and the rest are counted in `omitted`, never read.
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

/** Minimal VFS shape — duck-typed against any file view. */
export interface SkillsVfs {
  exists(path: string): Promise<boolean>;
  readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
  readdir?(path: string): Promise<string[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  unlink?(path: string): Promise<void>;
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Size before bytes. Optional because a file view may not offer it; without
   *  it every `.md` file is opened, every turn. */
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
  /** Candidates discovery did not open because the header count bound was
   *  already spent — they are neither skills nor unread, just beyond what the
   *  turn's index could ever list. Counted, not read. Absent means zero for
   *  hand-built fixtures. */
  omitted: number;
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
  if (a < b) return -1;

  if (a > b) return 1;

  return 0;
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
  let omitted = 0;
  // The byte ceiling the whole allocation implies — `admissionBytes`, the one
  // derivation agents-md also reads. With stat it is consulted before the
  // read; without stat it is enforced on what the read returns, so a plane
  // that cannot answer size cannot hand discovery an unbounded body either.
  const ceiling = admissionBytes(opts.admissionTokens);

  // And the count bound: the index prices every header against the same
  // allocation, so the most skills discovery may open is the number of the
  // CHEAPEST workspace header line the budget could carry — priced off the
  // same string the admission renders (render.ts), newline included, exactly
  // as admitSkillsIndex charges it.
  let slots = Math.floor(
    opts.admissionTokens / estimateTokens(workspaceSkillIndexLine('a').length + 1),
  );

  // Two directories, one order: the workspace's own skills first, then the
  // owner's shared Drive. THE WORKSPACE WINS A NAME CLASH — a shared skill is
  // the owner's default for every workspace, and a workspace that carries the
  // same name has overridden it on purpose. The shared file is refused with
  // that reason rather than silently skipped, so the author is told.
  const directories: { dir: string; source: SkillSource }[] = [{ dir, source: 'vfs' }, { dir: SHARED_SKILLS_DIR, source: 'shared' }];

  for (const { dir: scanned, source } of directories) {
    // Candidates in the one total order BEFORE any are opened: readdir order is
    // filesystem-dependent, and the bound below decides which names are ever
    // read at all.
    const candidates = (await listSkillCandidates(vfs, scanned)).sort((a, b) => compareSkillNames(a.stem, b.stem));

    for (const { stem, path } of candidates) {
      // The filename stem (or the folder name) IS the skill's name (Anthropic's
      // spec lets the directory name supply it), so an illegal stem is not a
      // skill at all — and learning that costs no read.
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
        // The stem doubles as the fallback `name` so Claude-Code skills authored
        // without a `name:` line still parse. If frontmatter DOES specify a name,
        // we still require it to match the filename to avoid drift.
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

/** The file a skill FOLDER carries its front matter and body in (Anthropic's layout). */
export const SKILL_FOLDER_FILE = 'SKILL.md';

/** The skill file that names `name` inside a skills directory, in folder form. */
function skillFolderPath(name: string, skillsDir = SKILLS_DIR): string {
  return `${skillsDir.replace(/\/$/, '')}/${name}/${SKILL_FOLDER_FILE}`;
}

/**
 * Every candidate skill in one directory, unopened: the flat `<name>.md`
 * files Kinu has always read, and the `<name>/SKILL.md` folders the Drive
 * adds (a folder skill can carry scripts and references beside its
 * instructions). Both forms yield the same `stem`; the caller decides which
 * names are legal and how many are ever read. An absent directory — or an
 * absent MOUNT, which is how an unclaimed workspace's `/shared` answers — is
 * an empty list, never a failure.
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
 * Read a skill's complete source file, under the byte ceiling the caller's
 * token allocation implies.
 *
 * The front matter is live policy (`allowed_tools`, activation, invocation and
 * unknown extension fields), not decoration. Any trust decision therefore
 * binds this complete raw value, while a caller that renders instructions may
 * parse the body from the same bytes afterwards. `admissionTokens` is the
 * budget this read is for (admission's remaining allocation, the owner
 * preview's full one); a body past `admissionBytes(admissionTokens)` is read
 * truncated to it, so the bytes a digest binds are the bytes the budget could
 * carry — never more.
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

/** Fetch one admitted body. A built-in body is a module constant and a VFS body
 * is parsed from the bounded source file read. */
export async function readSkillBody(
  vfs: SkillsVfs,
  ref: SkillBodyRef,
  admissionTokens: number,
): Promise<string> {
  return parseMarkdownFrontmatter(await readSkillFile(vfs, ref, admissionTokens)).body;
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

async function readTextFile(vfs: SkillsVfs, path: string, ceiling: number): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;

  // The plane has no ranged read, so the bound lands on what the read hands
  return text.length <= ceiling ? text : text.slice(0, ceiling);
}
