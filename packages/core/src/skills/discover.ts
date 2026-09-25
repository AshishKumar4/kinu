/**
 * Skill discovery over the roots `/skills` views, merged by `SKILL_ROOTS`. Malformed files are
 * skipped; reads stay under the `admissionBytes` ceiling and the budget's file count.
 */
import { admissionBytes, estimateTokens } from '../llm';
import { classify, diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import type { VfsEntryStat } from '../types/primitives';

import { parseSkillFile, skillNameProblem } from './parse';
import { BUILTIN_SKILLS } from './builtins';

import { SHARED_SKILLS_DIR } from '../vfs/shared-drive';
import { isVfsError } from '../vfs/errno';
import {
  SKILL_FOLDER_FILE, WORKSPACE_SKILLS_DIR, workspaceSkillIndexLine,
  type DiscoveredSkill, type ParsedSkill, type SkillBodyRef,
} from './types';

export interface SkillsVfs {
  exists(path: string): Promise<boolean>;
  readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
  readdir(path: string): Promise<string[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  unlink?(path: string): Promise<void>;
  mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Optional; without it every candidate file is opened every turn. */
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
  onParseError?: (file: string, error: string) => void;
}

/** The file a skill name loads from; `folder` is set for a `<name>/SKILL.md` folder. */
export interface SkillFile {
  readonly name: string;
  readonly source: 'vfs' | 'shared';
  readonly path: string;
  readonly folder: string | null;
}

/** Name precedence after the reserved built-ins (KINU-N028); in a root, a folder beats `<name>.md`. */
const SKILL_ROOTS = [
  { dir: WORKSPACE_SKILLS_DIR, source: 'vfs' },
  { dir: SHARED_SKILLS_DIR, source: 'shared' },
] as const;

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

export type SkillFileRefusal =
  | { readonly reason: 'name'; readonly problem: string }
  | { readonly reason: 'builtin' }
  | { readonly reason: 'shadowed'; readonly by: string };

function skillFileRefusal(name: string, held: Pick<SkillFile, 'path'> | undefined): SkillFileRefusal | null {
  // The stem is the skill's name, so an illegal stem is rejected without a read.
  const problem = skillNameProblem(name);

  if (problem !== null) return { reason: 'name', problem };

  if (Object.hasOwn(BUILTIN_SKILL_NAMES, name)) return { reason: 'builtin' };

  return held === undefined ? null : { reason: 'shadowed', by: held.path };
}

function refusalText(name: string, refusal: SkillFileRefusal): string {
  if (refusal.reason === 'name') return `filename stem ${refusal.problem}`;

  if (refusal.reason === 'builtin') return `"${name}" is a built-in skill name and cannot be overridden by a file`;

  return `"${name}" is shadowed by ${refusal.by}`;
}

async function takeSkillFiles(
  vfs: SkillsVfs,
  root: { readonly dir: string; readonly source: SkillFile['source'] },
  taken: Map<string, SkillFile>,
  refuse: (file: { readonly name: string; readonly path: string }, refusal: SkillFileRefusal) => void,
): Promise<void> {
  for (const { name, path, folder } of await listSkillCandidates(vfs, root.dir)) {
    const refusal = skillFileRefusal(name, taken.get(name));

    if (refusal === null) taken.set(name, { name, source: root.source, path, folder });
    else refuse({ name, path }, refusal);
  }
}

/** Every file-backed skill in precedence order; each refused candidate goes to `refuse`. */
export async function listSkillFiles(
  vfs: SkillsVfs,
  refuse?: (path: string, reason: string) => void,
): Promise<SkillFile[]> {
  const winners = new Map<string, SkillFile>();

  for (const root of SKILL_ROOTS) {
    await takeSkillFiles(vfs, root, winners, (file, refusal) => refuse?.(file.path, refusalText(file.name, refusal)));
  }

  return [...winners.values()];
}

export async function refusedSkillFiles(vfs: SkillsVfs, dir: string): Promise<ReadonlyMap<string, SkillFileRefusal>> {
  const refused = new Map<string, SkillFileRefusal>();

  await takeSkillFiles(vfs, { dir, source: 'shared' }, new Map(), (file, refusal) => refused.set(file.path, refusal));

  return refused;
}

/** One name's file by the same precedence; null for a built-in. */
export async function resolveSkillFile(vfs: SkillsVfs, name: string): Promise<SkillFile | null> {
  if (skillFileRefusal(name, undefined) !== null) return null;

  for (const { dir, source } of SKILL_ROOTS) {
    const folder = `${dir}/${name}`;

    if (await vfs.exists(`${folder}/${SKILL_FOLDER_FILE}`)) {
      return { name, source, path: `${folder}/${SKILL_FOLDER_FILE}`, folder };
    }

    if (await vfs.exists(`${dir}/${name}.md`)) return { name, source, path: `${dir}/${name}.md`, folder: null };
  }

  return null;
}

export async function discoverSkills(
  vfs: SkillsVfs,
  opts: DiscoverOpts,
): Promise<SkillsDiscovery> {
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

  for (const { name, source, path } of await listSkillFiles(vfs, onErr)) {
    if (slots <= 0) { omitted += 1; continue; }

    slots -= 1;

    try {
      const size = vfs.stat ? (await vfs.stat(path))?.size : undefined;

      if (size !== undefined && size > ceiling) {
        unread.push({ name, path, bytes: size });
        continue;
      }

      const text = await readTextFile(vfs, path, ceiling);
      // The stem is the fallback `name`; an explicit `name:` must still match it.
      const parsed = parseSkillFile(text, source, name);

      if (!parsed.ok) { onErr(path, parsed.error); continue; }

      if (parsed.skill.name !== name) {
        onErr(path, `"${path}" does not match front-matter name "${parsed.skill.name}"`);
        continue;
      }

      byName.set(name, discovered(parsed.skill, { kind: 'file', path, chars: parsed.skill.body.length }));
    } catch (error) {
      onErr(path, renderThrownChain({ cause: error }));
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => compareSkillNames(a.name, b.name)),
    unread: unread.sort((a, b) => compareSkillNames(a.name, b.name)),
    omitted,
  };
}

/** One root's unopened candidates in name order; a missing directory or mount is empty. */
async function listSkillCandidates(vfs: SkillsVfs, dir: string): Promise<Omit<SkillFile, 'source'>[]> {
  let entries: string[] = [];

  try {
    entries = await vfs.readdir(dir);
  } catch (error) {
    if (classify({ cause: error }) === 'enoent') return [];

    if (isVfsError(error) && error.code === 'ENXIO') return [];
    throw error;
  }

  const candidates: Omit<SkillFile, 'source'>[] = [];

  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      candidates.push({ name: entry.slice(0, -'.md'.length), path: `${dir}/${entry}`, folder: null });
      continue;
    }

    const folder = `${dir}/${entry}`;

    if (await vfs.exists(`${folder}/${SKILL_FOLDER_FILE}`)) {
      candidates.push({ name: entry, path: `${folder}/${SKILL_FOLDER_FILE}`, folder });
    }
  }

  // Sorted before anything opens: the bound decides what is read.
  return candidates.sort((a, b) => compareSkillNames(a.name, b.name) || Number(a.folder === null) - Number(b.folder === null));
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

/** Where the workspace writes its own skill of this name. */
export function workspaceSkillPath(name: string): string {
  return `${WORKSPACE_SKILLS_DIR}/${name}/${SKILL_FOLDER_FILE}`;
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
