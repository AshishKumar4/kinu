/** `/skills`: one read-only `<name>/SKILL.md` folder per skill, resolved per call by `discover.ts`. */

import type { VFS, VfsEntryStat } from '../types/primitives';
import type { VfsMount } from '../vfs/mounts';
import { makeVfsError } from '../vfs/errno';
import { SHARED_SKILLS_DIR } from '../vfs/shared-drive';
import { BUILTIN_SKILL_FILES } from './builtins';
import { compareSkillNames, listSkillFiles, resolveSkillFile, type SkillFile } from './discover';
import { SKILL_FOLDER_FILE, SKILLS_VIEW, WORKSPACE_SKILLS_DIR } from './types';

const FOLDER_STAT: VfsEntryStat = { size: 0, mtimeMs: 0, isDir: true };

type Located =
  | { readonly kind: 'builtin'; readonly text: string; readonly rest: string }
  | { readonly kind: 'file'; readonly file: SkillFile; readonly rest: string };

/** `plane` is the agent's whole file plane, read per call. */
export function skillsMount(plane: () => VFS): VfsMount {
  const encoder = new TextEncoder();
  const absent = (path: string) => makeVfsError('ENOENT', `no such file or directory, '${SKILLS_VIEW}${path}'`, `${SKILLS_VIEW}${path}`);

  const readOnly = (path: string) => makeVfsError(
    'EROFS',
    `${SKILLS_VIEW} is a read-only view of every skill; write one at ${WORKSPACE_SKILLS_DIR}/<name>/${SKILL_FOLDER_FILE}, `
      + `or under ${SHARED_SKILLS_DIR} for the owner's Drive`,
    `${SKILLS_VIEW}${path}`,
  );

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

  const stat = async (path: string): Promise<VfsEntryStat | null> => {
    const located = await locate(path);

    if (located === null) return path.split('/').some((segment) => segment !== '') ? null : FOLDER_STAT;

    if (located.rest === '') return FOLDER_STAT;

    if (located.kind === 'builtin') {
      return located.rest === SKILL_FOLDER_FILE ? { size: encoder.encode(located.text).byteLength, mtimeMs: 0, isDir: false } : null;
    }

    const real = source(located);

    return real === null ? null : plane().stat(real);
  };

  const files: VFS = {
    async readFile(path, opts) {
      const located = await locate(path);

      if (located?.kind === 'builtin' && located.rest === SKILL_FOLDER_FILE) {
        return opts?.encoding === 'utf8' ? located.text : encoder.encode(located.text);
      }

      const real = located?.kind === 'file' ? source(located) : null;

      if (real === null) throw absent(path);

      return plane().readFile(real, opts);
    },
    async readdir(path) {
      const located = await locate(path);

      if (located === null) {
        if (path.split('/').some((segment) => segment !== '')) throw absent(path);
        const names = [...Object.keys(BUILTIN_SKILL_FILES), ...(await listSkillFiles(plane())).map((file) => file.name)];

        return names.sort(compareSkillNames);
      }

      if (located.rest === '' && (located.kind === 'builtin' || located.file.folder === null)) return [SKILL_FOLDER_FILE];

      if (located.kind === 'builtin' || located.file.folder === null) throw absent(path);

      return plane().readdir(located.rest === '' ? located.file.folder : `${located.file.folder}/${located.rest}`);
    },
    stat,
    async exists(path) { return (await stat(path)) !== null; },
    async writeFile(path) { throw readOnly(path); },
    async unlink(path) { throw readOnly(path); },
    async mkdir(path) { throw readOnly(path); },
  };

  return { name: SKILLS_VIEW.slice(1), files: () => files, absentReason: () => 'the skills view is always mounted' };
}
