import type { VFS, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/** `/skills`: one read-only `<name>/SKILL.md` folder per skill, resolved per call by `discover.ts`. */


import type { VfsMount } from '../vfs/mounts';
import { syscallError, type VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settle } from '../obs/effect';
import { SHARED_SKILLS_DIR } from '../vfs/shared-drive';
import { BUILTIN_SKILL_FILES } from './builtins';
import { compareSkillNames, listSkillFiles, resolveSkillFile, type SkillFile } from './discover';
import { SKILL_FOLDER_FILE, SKILLS_VIEW, WORKSPACE_SKILLS_DIR } from './types';

const FOLDER_STAT: VfsStat = { size: 0, mtimeMs: 0, type: 'directory' };

type Located =
  | { readonly kind: 'builtin'; readonly text: string; readonly rest: string }
  | { readonly kind: 'file'; readonly file: SkillFile; readonly rest: string };

/** `plane` is the agent's whole file plane, read per call. */
export function skillsMount(plane: () => VFS): VfsMount {
  const encoder = new TextEncoder();
  const absent = (path: string, syscall: string) => syscallError('ENOENT', syscall, `${SKILLS_VIEW}${path}`);

  const readOnly = (path: string, syscall: string) => syscallError('EROFS', syscall, `${SKILLS_VIEW}${path}`, {
    detail: `${SKILLS_VIEW} is a read-only view of every skill; write one at ${WORKSPACE_SKILLS_DIR}/<name>/${SKILL_FOLDER_FILE}, `
      + `or under ${SHARED_SKILLS_DIR} for the owner's Drive`,
  });

  /** The skill a path names and the rest of the path; null for the root or an unknown name. */
  const locate = async (path: string): Promise<Located | null> => {
    const [name, ...rest] = path.split('/').filter((segment) => segment !== '');

    if (name === undefined) return null;
    const text = Object.hasOwn(BUILTIN_SKILL_FILES, name) ? BUILTIN_SKILL_FILES[name] : undefined;

    if (text !== undefined) return { kind: 'builtin', text, rest: rest.join('/') };
    const file = await resolveSkillFile(plane(), name);

    return file === null ? null : { kind: 'file', file, rest: rest.join('/') };
  };

  /** The real path behind a file-backed skill's path, or null. */
  const source = (located: Extract<Located, { kind: 'file' }>): string | null => {
    if (located.rest === SKILL_FOLDER_FILE) return located.file.path;

    return located.file.folder === null || located.rest === '' ? null : `${located.file.folder}/${located.rest}`;
  };

  const stat = async (path: string): Promise<VfsStat | null> => {
    const located = await locate(path);

    if (located === null) return path.split('/').some((segment) => segment !== '') ? null : FOLDER_STAT;

    if (located.rest === '') return FOLDER_STAT;

    if (located.kind === 'builtin') {
      return located.rest === SKILL_FOLDER_FILE ? { size: encoder.encode(located.text).byteLength, mtimeMs: 0, type: 'file' } : null;
    }

    const real = source(located);

    return real === null ? null : plane().stat(real);
  };

  const contents = (path: string): Effect.Effect<{ readonly text: Uint8Array } | { readonly real: string }, VfsError> => Effect.gen(function* () {
    const located = yield* Effect.promise(() => locate(path));

    if (located?.kind === 'builtin' && located.rest === SKILL_FOLDER_FILE) return { text: encoder.encode(located.text) };
    const real = located?.kind === 'file' ? source(located) : null;

    if (real === null) return yield* Effect.fail(absent(path, 'open'));

    return { real };
  });

  const files: VFS = {
    readFile(path) {
      return settle(Effect.gen(function* () {
        const at = yield* contents(path);

        return 'text' in at ? at.text : yield* Effect.promise(async () => plane().readFile(at.real));
      }));
    },
    // `cat` reads in ranges.
    readRange(path, offset, length) {
      return settle(Effect.gen(function* () {
        const at = yield* contents(path);
        const whole = plane();

        if ('text' in at) return at.text.slice(offset, offset + length);

        return yield* Effect.promise(async () => whole.readRange ? whole.readRange(at.real, offset, length) : (await whole.readFile(at.real)).slice(offset, offset + length));
      }));
    },
    readdir(path) {
      return settle(Effect.gen(function* () {
        const located = yield* Effect.promise(() => locate(path));

        if (located === null) {
          if (path.split('/').some((segment) => segment !== '')) return yield* Effect.fail(absent(path, 'scandir'));
          const names = [...Object.keys(BUILTIN_SKILL_FILES), ...(yield* Effect.promise(() => listSkillFiles(plane()))).map((file) => file.name)];

          return names.sort(compareSkillNames).map((name) => ({ name, type: 'directory' }));
        }

        if (located.rest === '' && (located.kind === 'builtin' || located.file.folder === null)) return [{ name: SKILL_FOLDER_FILE, type: 'file' }];

        if (located.kind === 'builtin' || located.file.folder === null) return yield* Effect.fail(absent(path, 'scandir'));
        const folder = located.file.folder;

        return yield* Effect.promise(async () => plane().readdir(located.rest === '' ? folder : `${folder}/${located.rest}`));
      }));
    },
    stat,
    writeFile(path) { return settle(Effect.fail(readOnly(path, 'open'))); },
    unlink(path) { return settle(Effect.fail(readOnly(path, 'unlink'))); },
    mkdir(path) { return settle(Effect.fail(readOnly(path, 'mkdir'))); },
  };

  // Skills live in the owner's Drive too.
  return {
    name: SKILLS_VIEW.slice(1), files: () => files, absentReason: () => 'the skills view is always mounted', filesOwner: 'user', readOnly: true,
    storeView: true,
  };
}
