/**
 * The Drive's rules — what the hosted Drive UI does when a user lists a
 * folder, uploads into it, marks a folder as a skill, or adds one.
 *
 * Every rule here is stated against the TENANT-relative tree (`/skills`, not
 * `/shared/skills`): the Drive UI reads the tenant directly, and the same
 * folder is `/shared/skills` on every workspace plane (vfs/shared-drive.ts).
 *
 * Indexing needs no action: discovery scans `/shared/skills` every turn, so
 * anything landing under it — an upload, a pasted SKILL.md, a symlink — is a
 * skill in every workspace from the next turn. A skill added ANYWHERE ELSE on
 * the Drive is symlinked into `/skills` when the user marks it, so the
 * folder the user organises stays where they put it.
 *
 * Failures leave as values: the Durable Object that hosts these rules answers
 * over an RPC boundary that carries no error class, so {@link driveFailure}
 * folds a thrown Kinu or VFS error into the closed `code` the route maps to a
 * status and the UI shows as the reason.
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

/** One Drive entry as the UI lists it. */
export interface DriveEntry {
  readonly name: string;
  readonly kind: 'file' | 'folder' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  /** A symlink's target, tenant-relative. */
  readonly target?: string;
  /** True for a folder that is a skill: it carries `SKILL.md` and its name is legal. */
  readonly skill: boolean;
  /** Why a folder is not a skill, for the UI to say beside a disabled "Mark as skill". */
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

/** Where marking `folder` as a skill puts its link, and what it is called. */
export interface MarkedSkill {
  readonly name: string;
  /** The link under `/skills`, or the folder itself when it already lives there. */
  readonly linked: string;
}

export const MarkedSkillSchema = v.object({ name: v.string(), linked: v.string() });

/** A refusal or failure as the Drive answers it over the wire. */
export interface DriveFailure {
  readonly code: ErrorCode;
  readonly error: string;
}

/** What one upload's bytes become once assembled: a file, an unpacked
 *  folder, or a skill. */
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

/** A thrown Drive failure as the value the wire carries. */
export function driveFailure(input: { cause: unknown }): DriveFailure {
  if (isVfsError(input.cause)) return { code: VFS_FAILURE_CODES[input.cause.code], error: input.cause.message };
  const code = classifyErrorCode(input);

  return { code: code ?? 'io', error: renderThrownChain(input) };
}

/** Does this segment hold a C0 control, which no path a UI can spell does?
 *  Read by code unit: a surrogate pair's halves are both far above the control
 *  range, so a name holding an emoji is never refused for one. */
function hasControlCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    if (segment.charCodeAt(i) < 0x20) return true;
  }

  return false;
}

/**
 * A tenant path as the Drive accepts it: absolute, no `.`/`..` segments, no
 * empty segments, no control characters. `/` is the root. Refused rather than
 * repaired — a path the UI cannot spell is a bug there, not a request here.
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

/** True for `/skills`, `/blueprints` and the root: never renamed or deleted from the UI. */
function isReservedDrivePath(path: string): boolean {
  return path === '/' || DRIVE_RESERVED_DIRS.includes(path);
}

/** The folder name at the end of a path. */
function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder a path sits in; `/` for a root entry. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');

  return cut <= 0 ? '/' : path.slice(0, cut);
}

/**
 * Whether a folder is a skill: it carries `SKILL.md` whose front matter parses
 * and names the folder (or names nothing, in which case the folder's name is
 * the skill's). The problem is the reason it is not, for the UI to show.
 */
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

/** A link's target, or undefined for an entry that is not a link. */
async function linkTarget(drive: MossaicVfs, path: string): Promise<string | undefined> {
  try {
    return await drive.readlink(path);
  } catch (cause) {
    if (isVfsError(cause) && (cause.code === 'EIO' || cause.code === 'ENOENT')) return undefined;
    throw cause;
  }
}

/** A reserved folder's stats listing: empty until something lands in it,
 *  never absent — the folder exists by definition, and the root shows it. */
async function reservedTolerant(drive: MossaicVfs, path: string): Promise<VfsListedEntry[]> {
  try {
    return await drive.readdirStats(path);
  } catch (cause) {
    if (isReservedDrivePath(path) && isVfsError(cause) && cause.code === 'ENOENT') return [];
    throw cause;
  }
}

/** One folder of the tenant, every entry with its stat, skills flagged. The
 *  root always lists the reserved folders, present on the tenant or not. */
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
    // `readdirStats` follows a link for its stat; the link itself is what the
    // UI shows, so the kind comes from `readlink` answering at all.
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

/** One listed entry's kind: a link is shown as the link it is, whatever it
 *  points at, because that is what the user put there. */
function listedKind(isDir: boolean, target: string | undefined): DriveEntry['kind'] {
  if (target !== undefined) return 'symlink';

  if (isDir) return 'folder';

  return 'file';
}

/** Why a listed entry is not a skill, or null when it is one. A link is a skill
 *  when what it points at is one UNDER THE LINK'S NAME — the name discovery
 *  will read it by. */
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

/** A new, empty folder; an existing entry of that name is refused, never reused. */
export async function makeDriveFolder(drive: MossaicVfs, rawPath: string): Promise<void> {
  const path = normalizeDrivePath(rawPath);

  if (path === '/') throw new KinuError('bad_input', 'the root already exists');

  if (await drive.exists(path)) throw new KinuError('bad_input', `${path} already exists`);
  await drive.mkdir(path, { recursive: true });
}

/**
 * Move an entry. A reserved folder never moves, nothing is overwritten, and
 * the destination's folder must already exist: a rename that silently created
 * a tree would be a mkdir the user did not ask for.
 */
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

/** Remove a file, a link, or a whole folder. A reserved folder stays. */
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
 * Make a folder anywhere on the Drive a user-level skill.
 *
 * A folder already under `/skills` is a skill by position; anything else gets
 * a symlink `/skills/<name>` → folder, so discovery finds it without the
 * user moving it. The folder must BE a skill first (`skillFolderProblem`), and
 * a name already taken under `/skills` is refused rather than replaced: two
 * skills with one name is exactly the ambiguity discovery's clash rule exists
 * to prevent.
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

/** Land `files` (archive-relative names) under `folder`, creating each parent. */
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
 * Add a skill from its files: a pasted `SKILL.md`, or a folder/zip the UI
 * unpacked into `(relative path, bytes)` pairs. The name is what the front
 * matter says — or, absent one, `fallbackName` (the uploaded folder's name) —
 * and the files land under `/skills/<name>/`. An existing skill of that name
 * is refused, never overwritten.
 */
export async function addSkill(
  drive: MossaicVfs,
  files: readonly ZipEntry[],
  fallbackName: string | null,
): Promise<MarkedSkill> {
  const skillFile = files.find((file) => file.path === SKILL_FOLDER_FILE || file.path.endsWith(`/${SKILL_FOLDER_FILE}`));

  if (skillFile === undefined) throw new KinuError('bad_input', `a skill needs a ${SKILL_FOLDER_FILE}`);
  // Files are rooted at the SKILL.md's own folder: an uploaded folder `deploy/`
  // arrives as `deploy/SKILL.md`, `deploy/scripts/x`, and lands as `/skills/deploy/…`.
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

/** What an upload became once its bytes were assembled and landed. */
export type DriveUploadOutcome = { readonly ok: true; readonly skill?: MarkedSkill };

/** Land one assembled upload where its target says. A skill arrives as a zip
 *  (a folder the browser packed) or as the bare text of one `SKILL.md`. */
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

/** A folder and everything under it, as one stored zip named from the folder. */
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
