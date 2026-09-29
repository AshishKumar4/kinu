/**
 * Hosted Drive rules: listing, uploads, marking and adding skills. Paths are
 * tenant-relative (`/skills` is `/shared/skills` on every workspace plane).
 *
 * Discovery scans `/shared/skills` every turn, so anything landing there is a
 * skill from the next turn; skills elsewhere are symlinked in when marked.
 * Failures are values: the DO's RPC boundary carries no error class, so
 * {@link driveFailure} folds errors into a closed `code`.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { classifyErrorCode, KinuError, renderThrownChain, type ErrorCode } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { DRIVE_RESERVED_DIRS, DRIVE_SKILLS_DIR } from '../vfs/shared-drive';
import { isVfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import type { MossaicVfs } from '../vfs/mossaic-vfs';
import type { VfsListedEntry } from '../vfs/mounts';
import { looksLikeZip, packZip, unpackZip, type ZipEntry } from '../utils/zip';
import { vfsBasename } from '../utils/vfs-helpers';
import { SKILL_FOLDER_FILE } from './types';
import { parseSkillFile, skillNameProblem } from './parse';
import { refusedSkillFiles, type SkillFileRefusal } from './discover';

export interface DriveEntry {
  readonly name: string;
  readonly kind: 'file' | 'folder' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  readonly target?: string;
  readonly skill: boolean;
  readonly skillProblem?: string;
  readonly unused?: SkillFileRefusal;
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
  unused: v.optional(v.variant('reason', [
    v.object({ reason: v.literal('name'), problem: v.string() }),
    v.object({ reason: v.literal('builtin') }),
    v.object({ reason: v.literal('shadowed'), by: v.string() }),
  ])),
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

/** Drive's refusal vocabulary; adopting Nimbus's errno class does not change it. */
const VFS_FAILURE_CODES: Partial<Record<VfsErrorCode, ErrorCode>> = {
  ENOENT: 'missing',
  ENOTSUP: 'unsupported',
  EROFS: 'denied',
  EEXIST: 'bad_input',
  EISDIR: 'bad_input',
  ENOTDIR: 'bad_input',
  ENOTEMPTY: 'bad_input',
  ENXIO: 'unavailable',
  EIO: 'io',
  EACCES: 'denied',
  EPERM: 'denied',
};

export function driveFailure(input: { cause: unknown }): DriveFailure {
  if (isVfsError(input.cause)) return { code: VFS_FAILURE_CODES[input.cause.code] ?? 'io', error: input.cause.message };
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
  return settleSync(drivePath(raw));
}

function drivePath(raw: string): Effect.Effect<string, KinuError> {
  if (!raw.startsWith('/')) return Effect.fail(new KinuError('bad_input', `drive path must be absolute: ${JSON.stringify(raw)}`));
  const segments = raw.split('/').slice(1);

  if (segments.length === 1 && segments[0] === '') return Effect.succeed('/');

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || hasControlCharacter(segment)) {
      return Effect.fail(new KinuError('bad_input', `drive path has an illegal segment: ${JSON.stringify(raw)}`));
    }
  }

  return Effect.succeed(`/${segments.join('/')}`);
}

/** `/skills` and the root are never renamed or deleted from the UI. */
function isReservedDrivePath(path: string): boolean {
  return path === '/' || DRIVE_RESERVED_DIRS.includes(path);
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');

  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** A folder is a skill when its `SKILL.md` parses and names the folder or nothing. */
async function skillFolderProblem(drive: MossaicVfs, folder: string, name = vfsBasename(folder)): Promise<string | null> {
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

function linkTarget(drive: MossaicVfs, path: string): Effect.Effect<string | undefined> {
  return Effect.tryPromise({ try: () => drive.readlink(path), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => (isVfsError(failed.cause) && (failed.cause.code === 'EIO' || failed.cause.code === 'ENOENT')
      ? Effect.succeed(undefined)
      : Effect.die(failed.cause))),
  );
}

/** A reserved folder lists as empty until something lands, never absent. */
function reservedTolerant(drive: MossaicVfs, path: string): Effect.Effect<VfsListedEntry[]> {
  return Effect.tryPromise({ try: () => drive.readdirStats(path), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => (isReservedDrivePath(path) && isVfsError(failed.cause) && failed.cause.code === 'ENOENT'
      ? Effect.succeed<VfsListedEntry[]>([])
      : Effect.die(failed.cause))),
  );
}

/** The root always lists the reserved folders, whether present on the tenant or not. */
export function listDrive(drive: MossaicVfs, rawPath: string): Promise<DriveListing> {
  return settle(Effect.gen(function* () {
    const path = yield* drivePath(rawPath);
    const listed = yield* reservedTolerant(drive, path);
    const entries: DriveEntry[] = [];

    const refused = path === DRIVE_SKILLS_DIR ? yield* Effect.promise(() => refusedSkillFiles(drive, path)) : new Map<string, SkillFileRefusal>();

    if (path === '/') {
      for (const reserved of DRIVE_RESERVED_DIRS) {
        const name = reserved.slice(1);

        if (!listed.some((entry) => entry.name === name)) listed.push({ name, stat: { size: 0, mtimeMs: 0, isDir: true } });
      }
    }

    for (const { name, stat } of listed) {
      const full = path === '/' ? `/${name}` : `${path}/${name}`;
      // `readdirStats` follows links; the kind comes from whether `readlink` answers.
      const target = yield* linkTarget(drive, full);
      const isDir = stat?.isDir ?? false;

      const skillProblem = yield* Effect.promise(() => listedSkillProblem(drive, { path: full, name, isDir, target }));
      const kind = listedKind(isDir, target);
      const unused = refused.get(kind === 'file' ? full : `${full}/${SKILL_FOLDER_FILE}`);

      const entry: DriveEntry = {
        name,
        kind,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
        skill: skillProblem === null,
        target,
        skillProblem: skillProblem === null || kind === 'file' ? undefined : skillProblem,
        ...(unused !== undefined && { unused }),
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

    const listing: DriveListing = { path, entries };

    return listing;
  }));
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
export function makeDriveFolder(drive: MossaicVfs, rawPath: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const path = yield* drivePath(rawPath);

    if (path === '/') return yield* new KinuError('bad_input', 'the root already exists');

    if (yield* Effect.promise(() => drive.exists(path))) return yield* new KinuError('bad_input', `${path} already exists`);
    yield* Effect.promise(() => drive.mkdir(path, { recursive: true }));
  }));
}

/** Reserved folders never move, nothing is overwritten, and the destination folder must exist. */
export function renameDriveEntry(drive: MossaicVfs, rawFrom: string, rawTo: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const from = yield* drivePath(rawFrom);
    const to = yield* drivePath(rawTo);

    if (isReservedDrivePath(from)) return yield* reservedRefusal(from);

    if (isReservedDrivePath(to)) return yield* reservedRefusal(to);

    if (to === from || to.startsWith(`${from}/`)) return yield* new KinuError('bad_input', `cannot move ${from} into itself`);

    if (yield* Effect.promise(() => drive.exists(to))) return yield* new KinuError('bad_input', `${to} already exists`);
    const parent = parentOf(to);

    if (parent !== '/' && !(yield* Effect.promise(() => drive.stat(parent)))?.isDir) return yield* new KinuError('missing', `${parent} is not a folder`);
    yield* Effect.promise(() => drive.rename(from, to));
  }));
}

/** Remove a file, link, or folder; reserved folders stay. */
export function deleteDriveEntry(drive: MossaicVfs, rawPath: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const path = yield* drivePath(rawPath);

    if (isReservedDrivePath(path)) return yield* reservedRefusal(path);

    if ((yield* linkTarget(drive, path)) !== undefined) return yield* Effect.promise(() => drive.unlink(path));
    const stat = yield* Effect.promise(() => drive.stat(path));

    if (stat === null) return yield* new KinuError('missing', `no such entry: ${path}`);

    yield* Effect.promise(() => (stat.isDir ? drive.removeRecursive(path) : drive.unlink(path)));
  }));
}

function reservedRefusal(path: string): KinuError {
  return new KinuError('denied', `${path} is a reserved Drive folder`);
}

/**
 * Mark a folder as a skill: under `/skills` by position, otherwise via a
 * `/skills/<name>` symlink. A taken name is refused, not replaced.
 */
export function markAsSkill(drive: MossaicVfs, rawPath: string): Promise<MarkedSkill> {
  return settle(Effect.gen(function* () {
    const folder = yield* drivePath(rawPath);

    if (isReservedDrivePath(folder)) return yield* new KinuError('denied', `${folder} is a reserved Drive folder, not a skill`);
    const problem = yield* Effect.promise(() => skillFolderProblem(drive, folder));

    if (problem !== null) return yield* new KinuError('bad_input', `${folder} is not a skill: ${problem}`);
    const name = vfsBasename(folder);

    if (folder.startsWith(`${DRIVE_SKILLS_DIR}/`)) return { name, linked: folder };
    const linked = `${DRIVE_SKILLS_DIR}/${name}`;

    if (yield* Effect.promise(() => drive.exists(linked))) return yield* skillTaken(name, linked);
    yield* Effect.promise(() => drive.mkdir(DRIVE_SKILLS_DIR, { recursive: true }));
    yield* Effect.promise(() => drive.symlink(folder, linked));

    const marked: MarkedSkill = { name, linked };

    return marked;
  }));
}

function skillTaken(name: string, at: string): KinuError {
  return new KinuError('denied', `a skill named "${name}" already exists at ${at}`);
}

function putDriveFiles(drive: MossaicVfs, folder: string, files: readonly ZipEntry[]): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    yield* Effect.promise(() => drive.mkdir(folder, { recursive: true }));

    for (const file of files) {
      const relative = yield* drivePath(`/${file.path}`);
      const parent = parentOf(relative);

      if (parent !== '/') yield* Effect.promise(() => drive.mkdir(`${folder}${parent}`, { recursive: true }));
      yield* Effect.promise(() => drive.writeFile(`${folder}${relative}`, file.bytes));
    }
  });
}

/**
 * Add a skill from a pasted `SKILL.md` or unpacked folder/zip, under
 * `/skills/<name>/`. Name from front matter, else `fallbackName`; an existing
 * skill is refused.
 */
export function addSkill(
  drive: MossaicVfs,
  files: readonly ZipEntry[],
  fallbackName: string | null,
): Promise<MarkedSkill> {
  return settle(skillAdded(drive, files, fallbackName));
}

function skillAdded(drive: MossaicVfs, files: readonly ZipEntry[], fallbackName: string | null): Effect.Effect<MarkedSkill, KinuError> {
  return Effect.gen(function* () {
    const skillFile = files.find((file) => file.path === SKILL_FOLDER_FILE || file.path.endsWith(`/${SKILL_FOLDER_FILE}`));

    if (skillFile === undefined) return yield* new KinuError('bad_input', `a skill needs a ${SKILL_FOLDER_FILE}`);
    // Files are rooted at the SKILL.md's own folder.
    const root = skillFile.path.slice(0, skillFile.path.length - SKILL_FOLDER_FILE.length);
    const parsed = parseSkillFile(new TextDecoder().decode(skillFile.bytes), 'shared', fallbackName ?? undefined);

    if (!parsed.ok) return yield* new KinuError('bad_input', `${SKILL_FOLDER_FILE}: ${parsed.error}`);
    const name = parsed.skill.name;
    const folder = `${DRIVE_SKILLS_DIR}/${name}`;

    if (yield* Effect.promise(() => drive.exists(folder))) return yield* skillTaken(name, folder);
    yield* putDriveFiles(drive, folder, files
      .filter((file) => file.path.startsWith(root))
      .map((file) => ({ path: file.path.slice(root.length), bytes: file.bytes })));

    const added: MarkedSkill = { name, linked: folder };

    return added;
  });
}

export type DriveUploadOutcome = { readonly ok: true; readonly skill?: MarkedSkill };

/** A skill arrives as a zip or as the bare text of one `SKILL.md`. */
export function receiveDriveUpload(drive: MossaicVfs, target: DriveUploadTarget, bytes: Uint8Array): Promise<DriveUploadOutcome> {
  return settle(Effect.gen(function* () {
    const received: DriveUploadOutcome = { ok: true };

    switch (target.kind) {
      case 'file': {
        const path = yield* drivePath(target.path);

        if (isReservedDrivePath(path)) return yield* reservedRefusal(path);
        const parent = parentOf(path);

        if (parent !== '/') yield* Effect.promise(() => drive.mkdir(parent, { recursive: true }));
        yield* Effect.promise(() => drive.writeFile(path, bytes));

        return received;
      }

      case 'zip': {
        if (!looksLikeZip(bytes)) return yield* new KinuError('bad_input', 'the upload is not a zip archive');
        const folder = yield* drivePath(target.folder);
        yield* putDriveFiles(drive, folder, yield* Effect.promise(() => unpackZip(bytes)));

        return received;
      }

      case 'skill': {
        const files = looksLikeZip(bytes) ? yield* Effect.promise(() => unpackZip(bytes)) : [{ path: SKILL_FOLDER_FILE, bytes }];

        return { ...received, skill: yield* skillAdded(drive, files, target.name) };
      }
    }
  }));
}

export function packDriveFolder(drive: MossaicVfs, rawPath: string, limit: number): Promise<Uint8Array> {
  return settle(Effect.gen(function* () {
    const folder = yield* drivePath(rawPath);
    const files: ZipEntry[] = [];
    let total = 0;

    const walk = (dir: string, prefix: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
      for (const { name, stat } of yield* Effect.promise(() => drive.readdirStats(dir))) {
        const full = dir === '/' ? `/${name}` : `${dir}/${name}`;

        if (stat?.isDir === true) {
          yield* walk(full, `${prefix}${name}/`);
          continue;
        }

        const raw = yield* Effect.promise(() => drive.readFile(full));
        const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
        total += bytes.byteLength;

        if (total > limit) return yield* new KinuError('budget', `${folder} exceeds the ${String(Math.floor(limit / (1024 * 1024)))} MiB transfer limit`);
        files.push({ path: `${prefix}${name}`, bytes });
      }
    });

    yield* walk(folder, '');

    return packZip(files);
  }));
}
