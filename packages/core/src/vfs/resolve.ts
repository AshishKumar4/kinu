/** The one reading of a written path, on both backends: `root://path`, `~`, relative and absolute. */
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { EXECUTOR_MOUNTS } from './mounts';
import { workspacePath } from './workspace-path';

export interface PlaneRoot {
  /** The name before `://`. */
  readonly root: string;
  /** Where the plane's tree sits on this machine. */
  readonly at: string;
}

/** Fixed per runtime: a plane absent now still names its path, and its mount says why it is absent. */
export interface PathPlanes {
  /** Where a relative path starts. */
  readonly cwd: string;
  /** What `~` names, as the shell's `HOME` does. */
  readonly home: string;
  readonly roots: readonly PlaneRoot[];
  /** Where `<device>://` lands, by the device's segment; null where no device is mounted. */
  readonly devices: string | null;
  /** The own space's top-level names only the file tools serve, with no path on the machine: the CLI's views. */
  readonly views: readonly string[];
}

export interface ResolvedPath {
  /** The root whose tree holds it; null for a machine path under none. */
  readonly plane: string | null;
  /** The path on this machine. */
  readonly absolute: string;
}

/** Never a device's root: the fixed planes, `pc` (a device is named by its own root), and URL schemes. */
export const RESERVED_ROOTS: readonly string[] = [
  'vfs', 'local', 'sandbox', 'pc', 'http', 'https', 'file', 'ftp', 'ssh', 'git', 'ws', 'wss', 'data', 'mailto',
];

/** The cloud's planes over one home: the Nimbus tree, its container and its devices. */
export function cloudPlanes(home: string): PathPlanes {
  return {
    cwd: home,
    home,
    roots: [{ root: 'vfs', at: '/' }, { root: 'sandbox', at: EXECUTOR_MOUNTS.sandbox }],
    devices: EXECUTOR_MOUNTS.device,
    // The workspace shell mounts every view.
    views: [],
  };
}

const REFERENCE = /^([^\s/:]+):\/\/(.*)$/su;

export function resolvePath(path: string, planes: PathPlanes): ResolvedPath {
  return settleSync(resolvedPath(path, planes));
}

/** {@link resolvePath} for a caller composing effects. */
export function resolvedPath(path: string, planes: PathPlanes): Effect.Effect<ResolvedPath, VfsError> {
  const reference = REFERENCE.exec(path);
  const absolute = reference === null ? Effect.succeed(machinePath(path, planes)) : rootedPath(reference[1] ?? '', reference[2] ?? '', planes, path);

  return Effect.map(absolute, (at) => ({ plane: servingRoot(at, planes)?.root ?? null, absolute: at }));
}

/** A plain path as this machine's shell names it: `~` is the home, a relative path starts at `cwd`. */
export function machinePath(path: string, at: Pick<PathPlanes, 'cwd' | 'home'>): string {
  if (path === '~' || path.startsWith('~/')) return workspacePath(`.${path.slice(1)}`, at.home);

  return workspacePath(path, at.cwd);
}

/**
 * Why a shell refuses `word`, a reference to one of this workspace's planes, or null for any other word. The shell
 * takes only its machine's paths, so the refusal gives the real one; a view has none, and only the file tools read it.
 */
export function shellReference(word: string, planes: PathPlanes): string | null {
  const reference = REFERENCE.exec(word);
  const root = planes.roots.find((candidate) => candidate.root === reference?.[1]);

  if (reference === null || root === undefined) return null;

  return settleSync(Effect.match(resolvedPath(word, planes), {
    onFailure: (refused) => `${word} names no file: ${refused.message}`,
    onSuccess: ({ absolute }) => {
      const under = (name: string) => (root.at === '/' ? `/${name}` : `${root.at}/${name}`);
      const view = root.root === 'vfs' ? planes.views.find((name) => absolute === under(name) || absolute.startsWith(`${under(name)}/`)) : undefined;

      return view === undefined
        ? `the shell takes this machine's paths: ${word} is ${absolute} here`
        : `${word} is in the ${view} view, which the file tool and workspace.* read; the shell has no path for it`;
    },
  }));
}

/** The reference a person reads: the deepest root holding it. A machine path under none stays as it is. */
export function formatPath(absolute: string, planes: PathPlanes): string {
  const served = servingRoot(absolute, planes);

  if (served === undefined) return absolute;
  const rest = served.at === '/' ? absolute : absolute.slice(served.at.length);

  return `${served.root}://${rest.replace(/^\/+/u, '')}`;
}

function rootedPath(name: string, rest: string, planes: PathPlanes, written: string): Effect.Effect<string, VfsError> {
  const root = planes.roots.find((candidate) => candidate.root === name)
    ?? (planes.devices === null || RESERVED_ROOTS.includes(name) ? undefined : { root: name, at: `${planes.devices}/${name}` });

  if (root === undefined) {
    const named = [...planes.roots.map((candidate) => `${candidate.root}://`), ...(planes.devices === null ? [] : ['<device>://'])];

    return Effect.fail(new VfsError('ENOENT', `${name}:// is no plane here; this workspace's are ${named.join(', ')}`, written));
  }

  const segments: string[] = [];

  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment !== '..') {
      segments.push(segment);
      continue;
    }

    if (segments.length === 0) return Effect.fail(new VfsError('EPERM', `${written} climbs above ${name}://`, written));

    segments.pop();
  }

  return Effect.succeed(segments.length === 0 ? root.at : `${root.at === '/' ? '' : root.at}/${segments.join('/')}`);
}

function servingRoot(absolute: string, planes: PathPlanes): PlaneRoot | undefined {
  const holds = (at: string) => at === '/' || absolute === at || absolute.startsWith(`${at}/`);

  const device = planes.devices !== null && absolute.startsWith(`${planes.devices}/`)
    ? absolute.slice(planes.devices.length + 1).split('/')[0]
    : undefined;

  const roots = device === undefined || device === '' || RESERVED_ROOTS.includes(device)
    ? planes.roots
    : [...planes.roots, { root: device, at: `${planes.devices}/${device}` }];

  return roots.filter((root) => holds(root.at)).sort((a, b) => b.at.length - a.at.length)[0];
}
