/**
 * Hosted Drive rules: listing, uploads, marking and adding skills. Paths are
 * tenant-relative (`/skills` is `/shared/skills` on every workspace plane).
 *
 * Discovery scans `/shared/skills` every turn, so anything landing there is a
 * skill from the next turn; skills elsewhere are symlinked in when marked.
 * Failures are values: the DO's RPC boundary carries no error class, so
 * {@link driveFailure} folds errors into a closed `code`.
 */
import * as v from 'valibot';
import { classifyErrorCode, KinuError, renderThrownChain, type ErrorCode } from '../obs/error';
import { DRIVE_RESERVED_DIRS, DRIVE_SKILLS_DIR } from '../vfs/shared-drive';
import { isVfsError, type VfsErrorCode } from '../vfs/errno';
import type { MossaicVfs } from '../vfs/mossaic-vfs';
import type { VfsListedEntry } from '../vfs/mounts';
import { looksLikeZip, packZip, unpackZip, type ZipEntry } from '../utils/zip';
import { SKILL_FOLDER_FILE } from './discover';
import { parseSkillFile, skillNameProblem } from './parse';

export interface DriveEntry {
  readonly name: string;
  readonly kind: 'file' | 'folder' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  readonly target?: string;
  readonly skill: boolean;
  readonly skillProblem?: string;
}

export interface DriveListing {
  readonly path: string;
  readonly entries: readonly DriveEntry[];
}

const DriveEntrySchema = v.object({
  name: v.string(),
  kind: v.picklist(['file', 'folder', 'symlink']),
  size: v.number(),
  mtimeMs: v.number(),
  target: v.optional(v.string()),
  skill: v.boolean(),
  skillProblem: v.optional(v.string()),
});

export const DriveListingSchema = v.object({ path: v.string(), entries: v.array(DriveEntrySchema) });

export interface MarkedSkill {
  readonly name: string;
  /** The link under `/skills`, or the folder itself when it already lives there. */
  readonly linked: string;
}

export const MarkedSkillSchema = v.object({ name: v.string(), linked: v.string() });

export interface DriveFailure {
  readonly code: ErrorCode;
  readonly error: string;
}

export type DriveUploadTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'zip'; readonly folder: string }
  | { readonly kind: 'skill'; readonly name: string | null };

export const DriveUploadTargetSchema: v.GenericSchema<DriveUploadTarget> = v.variant('kind', [
  v.strictObject({ kind: v.literal('file'), path: v.string() }),
  v.strictObject({ kind: v.literal('zip'), folder: v.string() }),
  v.strictObject({ kind: v.literal('skill'), name: v.nullable(v.string()) }),
]);

const VFS_FAILURE_CODES: Readonly<Record<VfsErrorCode, ErrorCode>> = {
  ENOENT: 'missing',
  EEXIST: 'bad_input',
  EISDIR: 'bad_input',
  ENOTDIR: 'bad_input',
  ENOTEMPTY: 'bad_input',
  EACCES: 'denied',
  EPERM: 'denied',
  ENOTSUP: 'unsupported',
  ENXIO: 'unavailable',
  EIO: 'io',
  EROFS: 'denied',
};

export function driveFailure(input: { cause: unknown }): DriveFailure {
  if (isVfsError(input.cause)) return { code: VFS_FAILURE_CODES[input.cause.code], error: input.cause.message };
  const code = classifyErrorCode(input);

  return { code: code ?? 'io', error: renderThrownChain(input) };
}

/** Checked by code unit: surrogate halves are above the control range, so emoji pass. */
function hasControlCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    if (segment.charCodeAt(i) < 0x20) return true;
  }

  return false;
}

/**
 * Absolute, no `.`/`..`/empty segments, no control characters. Refused rather
 * than repaired: a path the UI cannot spell is a UI bug.
 */
export function normalizeDrivePath(raw: string): string {
  if (!raw.startsWith('/')) throw new KinuError('bad_input', `drive path must be absolute: ${JSON.stringify(raw)}`);
  const segments = raw.split('/').slice(1);

  if (segments.length === 1 && segments[0] === '') return '/';

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || hasControlCharacter(segment)) {
      throw new KinuError('bad_input', `drive path has an illegal segment: ${JSON.stringify(raw)}`);
    }
  }

  return `/${segments.join('/')}`;
}

/** `/skills`, `/blueprints` and the root are never renamed or deleted from the UI. */
function isReservedDrivePath(path: string): boolean {
  return path === '/' || DRIVE_RESERVED_DIRS.includes(path);
}

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');

  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** A folder is a skill when its `SKILL.md` parses and names the folder or nothing. */
async function skillFolderProblem(drive: MossaicVfs, folder: string, name = leafOf(folder)): Promise<string | null> {
  const problem = skillNameProblem(name);

  if (problem !== null) return `folder name ${problem}`;
  const file = `${folder}/${SKILL_FOLDER_FILE}`;

  if (!await drive.exists(file)) return `no ${SKILL_FOLDER_FILE} in ${folder}`;
  const text = await drive.readFile(file, { encoding: 'utf8' });
  const parsed = parseSkillFile(text instanceof Uint8Array ? new TextDecoder().decode(text) : text, 'shared', name);

  if (!parsed.ok) return parsed.error;

  if (parsed.skill.name !== name) return `folder "${name}" does not match front-matter name "${parsed.skill.name}"`;

  return null;
}

async function linkTarget(drive: MossaicVfs, path: string): Promise<string | undefined> {
  try {
    return await drive.readlink(path);
  } catch (cause) {
    if (isVfsError(cause) && (cause.code === 'EIO' || cause.code === 'ENOENT')) return undefined;
    throw cause;
  }
}

/** A reserved folder lists as empty until something lands, never absent. */
async function reservedTolerant(drive: MossaicVfs, path: string): Promise<VfsListedEntry[]> {
  try {
    return await drive.readdirStats(path);
  } catch (cause) {
    if (isReservedDrivePath(path) && isVfsError(cause) && cause.code === 'ENOENT') return [];
    throw cause;
  }
}

/** The root always lists the reserved folders, whether present on the tenant or not. */
export async function listDrive(drive: MossaicVfs, rawPath: string): Promise<DriveListing> {
  const path = normalizeDrivePath(rawPath);
  const listed = await reservedTolerant(drive, path);
  const entries: DriveEntry[] = [];

  if (path === '/') {
    for (const reserved of DRIVE_RESERVED_DIRS) {
      const name = reserved.slice(1);

      if (!listed.some((entry) => entry.name === name)) listed.push({ name, stat: { size: 0, mtimeMs: 0, isDir: true } });
    }
  }

  for (const { name, stat } of listed) {
    const full = path === '/' ? `/${name}` : `${path}/${name}`;
    // `readdirStats` follows links; the kind comes from whether `readlink` answers.
    const target = await linkTarget(drive, full);
    const isDir = stat?.isDir ?? false;

    const skillProblem = await listedSkillProblem(drive, { path: full, name, isDir, target });
    const kind = listedKind(isDir, target);

    const entry: DriveEntry = {
      name,
      kind,
      size: stat?.size ?? 0,
      mtimeMs: stat?.mtimeMs ?? 0,
      skill: skillProblem === null,
      target,
      skillProblem: skillProblem === null || kind === 'file' ? undefined : skillProblem,
    };

    entries.push(entry);
  }

  entries.sort((a, b) => {
    const aDir = a.kind !== 'file' ? 0 : 1;
    const bDir = b.kind !== 'file' ? 0 : 1;

    if (aDir !== bDir) return aDir - bDir;

    if (a.name < b.name) return -1;

    return a.name > b.name ? 1 : 0;
  });

  return { path, entries };
}

/** A link shows as a link whatever it points at. */
function listedKind(isDir: boolean, target: string | undefined): DriveEntry['kind'] {
  if (target !== undefined) return 'symlink';

  if (isDir) return 'folder';

  return 'file';
}

/** A link is a skill when its target is one under the link's name. */
async function listedSkillProblem(
  drive: MossaicVfs,
  entry: { path: string; name: string; isDir: boolean; target: string | undefined },
): Promise<string | null> {
  if (isReservedDrivePath(entry.path)) return `${entry.path} is a reserved Drive folder`;

  if (entry.isDir || entry.target !== undefined) {
    return await skillFolderProblem(drive, entry.target ?? entry.path, entry.name);
  }

  return 'not a folder';
}

/** An existing entry of that name is refused, never reused. */
export async function makeDriveFolder(drive: MossaicVfs, rawPath: string): Promise<void> {
  const path = normalizeDrivePath(rawPath);

  if (path === '/') throw new KinuError('bad_input', 'the root already exists');

  if (await drive.exists(path)) throw new KinuError('bad_input', `${path} already exists`);
  await drive.mkdir(path, { recursive: true });
}

/** Reserved folders never move, nothing is overwritten, and the destination folder must exist. */
export async function renameDriveEntry(drive: MossaicVfs, rawFrom: string, rawTo: string): Promise<void> {
  const from = normalizeDrivePath(rawFrom);
  const to = normalizeDrivePath(rawTo);

  if (isReservedDrivePath(from)) throw new KinuError('denied', `${from} is a reserved Drive folder`);

  if (isReservedDrivePath(to)) throw new KinuError('denied', `${to} is a reserved Drive folder`);

  if (to === from || to.startsWith(`${from}/`)) throw new KinuError('bad_input', `cannot move ${from} into itself`);

  if (await drive.exists(to)) throw new KinuError('bad_input', `${to} already exists`);
  const parent = parentOf(to);

  if (parent !== '/' && !(await drive.stat(parent))?.isDir) throw new KinuError('missing', `${parent} is not a folder`);
  await drive.rename(from, to);
}

/** Remove a file, link, or folder; reserved folders stay. */
export async function deleteDriveEntry(drive: MossaicVfs, rawPath: string): Promise<void> {
  const path = normalizeDrivePath(rawPath);

  if (isReservedDrivePath(path)) throw new KinuError('denied', `${path} is a reserved Drive folder`);

  if (await linkTarget(drive, path) !== undefined) {
    await drive.unlink(path);

    return;
  }

  const stat = await drive.stat(path);

  if (stat === null) throw new KinuError('missing', `no such entry: ${path}`);

  if (stat.isDir) await drive.removeRecursive(path);
  else await drive.unlink(path);
}

/**
 * Mark a folder as a skill: under `/skills` by position, otherwise via a
 * `/skills/<name>` symlink. A taken name is refused, not replaced.
 */
export async function markAsSkill(drive: MossaicVfs, rawPath: string): Promise<MarkedSkill> {
  const folder = normalizeDrivePath(rawPath);

  if (isReservedDrivePath(folder)) throw new KinuError('denied', `${folder} is a reserved Drive folder, not a skill`);
  const problem = await skillFolderProblem(drive, folder);

  if (problem !== null) throw new KinuError('bad_input', `${folder} is not a skill: ${problem}`);
  const name = leafOf(folder);

  if (folder.startsWith(`${DRIVE_SKILLS_DIR}/`)) return { name, linked: folder };
  const linked = `${DRIVE_SKILLS_DIR}/${name}`;

  if (await drive.exists(linked)) throw new KinuError('denied', `a skill named "${name}" already exists at ${linked}`);
  await drive.mkdir(DRIVE_SKILLS_DIR, { recursive: true });
  await drive.symlink(folder, linked);

  return { name, linked };
}

async function putDriveFiles(drive: MossaicVfs, folder: string, files: readonly ZipEntry[]): Promise<void> {
  await drive.mkdir(folder, { recursive: true });

  for (const file of files) {
    const relative = normalizeDrivePath(`/${file.path}`);
    const parent = parentOf(relative);

    if (parent !== '/') await drive.mkdir(`${folder}${parent}`, { recursive: true });
    await drive.writeFile(`${folder}${relative}`, file.bytes);
  }
}

/**
 * Add a skill from a pasted `SKILL.md` or unpacked folder/zip, under
 * `/skills/<name>/`. Name from front matter, else `fallbackName`; an existing
 * skill is refused.
 */
export async function addSkill(
  drive: MossaicVfs,
  files: readonly ZipEntry[],
  fallbackName: string | null,
): Promise<MarkedSkill> {
  const skillFile = files.find((file) => file.path === SKILL_FOLDER_FILE || file.path.endsWith(`/${SKILL_FOLDER_FILE}`));

  if (skillFile === undefined) throw new KinuError('bad_input', `a skill needs a ${SKILL_FOLDER_FILE}`);
  // Files are rooted at the SKILL.md's own folder.
  const root = skillFile.path.slice(0, skillFile.path.length - SKILL_FOLDER_FILE.length);
  const parsed = parseSkillFile(new TextDecoder().decode(skillFile.bytes), 'shared', fallbackName ?? undefined);

  if (!parsed.ok) throw new KinuError('bad_input', `${SKILL_FOLDER_FILE}: ${parsed.error}`);
  const name = parsed.skill.name;
  const folder = `${DRIVE_SKILLS_DIR}/${name}`;

  if (await drive.exists(folder)) throw new KinuError('denied', `a skill named "${name}" already exists at ${folder}`);
  await putDriveFiles(drive, folder, files
    .filter((file) => file.path.startsWith(root))
    .map((file) => ({ path: file.path.slice(root.length), bytes: file.bytes })));

  return { name, linked: folder };
}

export type DriveUploadOutcome = { readonly ok: true; readonly skill?: MarkedSkill };

/** A skill arrives as a zip or as the bare text of one `SKILL.md`. */
export async function receiveDriveUpload(drive: MossaicVfs, target: DriveUploadTarget, bytes: Uint8Array): Promise<DriveUploadOutcome> {
  switch (target.kind) {
    case 'file': {
      const path = normalizeDrivePath(target.path);

      if (isReservedDrivePath(path)) throw new KinuError('denied', `${path} is a reserved Drive folder`);
      const parent = parentOf(path);

      if (parent !== '/') await drive.mkdir(parent, { recursive: true });
      await drive.writeFile(path, bytes);

      return { ok: true };
    }

    case 'zip': {
      if (!looksLikeZip(bytes)) throw new KinuError('bad_input', 'the upload is not a zip archive');
      const folder = normalizeDrivePath(target.folder);
      await putDriveFiles(drive, folder, await unpackZip(bytes));

      return { ok: true };
    }

    case 'skill': {
      const files = looksLikeZip(bytes) ? await unpackZip(bytes) : [{ path: SKILL_FOLDER_FILE, bytes }];

      return { ok: true, skill: await addSkill(drive, files, target.name) };
    }
  }
}

export async function packDriveFolder(drive: MossaicVfs, rawPath: string, limit: number): Promise<Uint8Array> {
  const folder = normalizeDrivePath(rawPath);
  const files: ZipEntry[] = [];
  let total = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const { name, stat } of await drive.readdirStats(dir)) {
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`;

      if (stat?.isDir === true) {
        await walk(full, `${prefix}${name}/`);
        continue;
      }

      const raw = await drive.readFile(full);
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
      total += bytes.byteLength;

      if (total > limit) throw new KinuError('budget', `${folder} exceeds the ${String(Math.floor(limit / (1024 * 1024)))} MiB transfer limit`);
      files.push({ path: `${prefix}${name}`, bytes });
    }
  };

  await walk(folder, '');

  return packZip(files);
}
