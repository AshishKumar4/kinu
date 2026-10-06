/** The one reading of a written path, on both backends: `root://path`, `~`, relative and absolute. */
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { EXECUTOR_MOUNTS } from './mounts';
import { workspacePath } from './workspace-path';

/** A prefix: the name before `://`, and the subtree of `vfs://`, the one tree an agent sees, that it names. */
export interface PathPrefix {
  readonly prefix: string;
  readonly subtree: string;
}

/** Where one subtree of the VFS sits on this machine. */
export interface VfsSubtree {
  readonly subtree: string;
  readonly at: string;
}

/** Fixed per runtime: a plane absent now still names its path, and its mount says why it is absent. */
export interface PathPlanes {
  /** Where a relative path starts. */
  readonly cwd: string;
  /** What `~` names, as the shell's `HOME` does. */
  readonly home: string;
  /** This backend's rows of {@link PATH_PREFIXES}. */
  readonly prefixes: readonly PathPrefix[];
  /** Where each subtree of the VFS sits on this machine: the deepest subtree holding a path serves it. */
  readonly mounts: readonly VfsSubtree[];
  /** The own space's top-level names only the file tools serve, with no path on the machine: the CLI's views. */
  readonly views: readonly string[];
}

export interface ResolvedPath {
  /** The prefix of the reference a person reads for it; null for a machine path under no subtree. */
  readonly plane: string | null;
  /** The path on this machine. */
  readonly absolute: string;
}

/** The tree itself: every other prefix names a subtree of it. */
export const VFS_PREFIX = 'vfs';

/** A workspace path as its `vfs://` reference: the one spelling every backend's file tool resolves. */
export function vfsReference(path: string): string {
  return `${VFS_PREFIX}://${path.replace(/^\/+/u, '')}`;
}

/** A machine's own name is its prefix, under this row's subtree: `<device>://x` is `/pc/<device>/x`. */
export const DEVICE_PREFIX = '<device>';

/** Where a local workspace's folder sits in its VFS. */
export const FOLDER_SUBTREE = '/local';

/**
 * Every prefix on each backend, each an alias for a subtree of `vfs://`; a backend without a row has no such prefix.
 * Adding or rewiring a prefix is one row: resolving, printing, links, the shell's refusal, the prompt and the names a
 * machine may not take all read this table.
 */
const PATH_PREFIXES = {
  cloud: [
    { prefix: VFS_PREFIX, subtree: '/' },
    { prefix: 'local', subtree: '/' },
    { prefix: 'sandbox', subtree: EXECUTOR_MOUNTS.sandbox },
    { prefix: DEVICE_PREFIX, subtree: EXECUTOR_MOUNTS.device },
  ],
  local: [
    { prefix: VFS_PREFIX, subtree: '/' },
    { prefix: 'local', subtree: FOLDER_SUBTREE },
  ],
} as const satisfies Record<string, readonly PathPrefix[]>;

const URL_SCHEMES = ['http', 'https', 'file', 'ftp', 'ssh', 'git', 'ws', 'wss', 'data', 'mailto'];

/** Never a machine's name: every prefix, the subtree machines mount under (`pc`), and URL schemes. */
export const RESERVED_ROOTS: readonly string[] = [...new Set([
  ...Object.values(PATH_PREFIXES).flat().map((row) => (row.prefix === DEVICE_PREFIX ? row.subtree.split('/')[1] ?? '' : row.prefix)),
  ...URL_SCHEMES,
])];

/** The cloud's planes over one home: Nimbus is the machine, so every subtree sits where the VFS names it. */
export function cloudPlanes(home: string): PathPlanes {
  return {
    cwd: home,
    home,
    prefixes: PATH_PREFIXES.cloud,
    mounts: [{ subtree: '/', at: '/' }],
    // The workspace shell mounts every view.
    views: [],
  };
}

/** A local workspace's planes: its own space is the VFS root and its folder the `/local` subtree, both real directories. */
export function localPlanes(input: { readonly space: string; readonly folder: string; readonly home: string; readonly views: readonly string[] }): PathPlanes {
  return {
    cwd: input.folder,
    home: input.home,
    prefixes: PATH_PREFIXES.local,
    mounts: [{ subtree: '/', at: input.space }, { subtree: FOLDER_SUBTREE, at: input.folder }],
    views: input.views,
  };
}

/** What a prefix's name may hold, as references are read: no whitespace, `/` or `:`. */
const PREFIX_NAME = String.raw`[^\s/:]+`;

const REFERENCE = new RegExp(String.raw`^(${PREFIX_NAME}):\/\/(.*)$`, 'su');

/** Whether `name` can stand before `://`: a machine's own name is its prefix only when it can. */
export function isPrefixName(name: string): boolean {
  return new RegExp(String.raw`^${PREFIX_NAME}$`, 'u').test(name);
}

export function resolvePath(path: string, planes: PathPlanes): ResolvedPath {
  return settleSync(resolvedPath(path, planes));
}

/** {@link resolvePath} for a caller composing effects. */
export function resolvedPath(path: string, planes: PathPlanes): Effect.Effect<ResolvedPath, VfsError> {
  const reference = REFERENCE.exec(path);

  const absolute = reference === null
    ? Effect.succeed(machinePath(path, planes))
    : Effect.map(vfsPath(reference[1] ?? '', reference[2] ?? '', planes, path), (vfs) => onMachine(vfs, planes));

  return Effect.map(absolute, (at) => ({ plane: shortestReference(at, planes)?.prefix ?? null, absolute: at }));
}

/** The path a link's reference names, or null where it names none: a plane this workspace lacks, or a climb out of one. */
export function referencedPath(reference: string, planes: PathPlanes): string | null {
  return settleSync(Effect.catchIf(
    Effect.map(resolvedPath(reference, planes), (resolved): string | null => resolved.absolute),
    (refused: VfsError) => refused.code === 'ENOENT' || refused.code === 'EPERM',
    () => Effect.succeed(null),
  ));
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

  // Only a row's own name: a machine's, like `postgres://db`, is any scheme to the shell.
  if (reference === null || !planes.prefixes.some((row) => row.prefix !== DEVICE_PREFIX && row.prefix === reference[1])) return null;

  return settleSync(Effect.match(vfsPath(reference[1] ?? '', reference[2] ?? '', planes, word), {
    onFailure: (refused) => `${word} names no file: ${refused.message}`,
    onSuccess: (vfs) => {
      const view = planes.views.find((name) => holds(`/${name}`, vfs));

      return view === undefined
        ? `the shell takes this machine's paths: ${word} is ${onMachine(vfs, planes)} here`
        : `${word} is in the ${view} view, which the file tool and workspace.* read; the shell has no path for it`;
    },
  }));
}

/** The prefixes a reference in prose starts with here: every row's name, and each given machine's where machines mount. */
export function referencePrefixes(planes: PathPlanes, machines: readonly string[] = []): string[] {
  const named = planes.prefixes.filter((row) => row.prefix !== DEVICE_PREFIX).map((row) => row.prefix);
  const mounted = planes.prefixes.some((row) => row.prefix === DEVICE_PREFIX) ? machines : [];

  return [...named, ...mounted.filter((name) => !RESERVED_ROOTS.includes(name) && !named.includes(name))];
}

/** A reference's path stops at whitespace, a quote or a bracket; sentence punctuation after it is prose. */
const REFERENCE_PATH = String.raw`[^\s<>()[\]{}"'\x60]*`;

/** What a reference's path cannot hold raw: what ends it in prose, `%`, and a URL's `#` and `?`. */
const ESCAPED = /[\s<>()[\]{}"'`%#?]/gu;

/** Sentence punctuation prose drops from a reference's end, so a path ending in it escapes it. */
const TRAILING = /[.,;:!]+$/u;

const percentEscaped = (text: string): string => [...new TextEncoder().encode(text)]
  .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');

/** A path as a reference writes it: every character prose or a URL would split it at is %-escaped, as a URL escapes it. */
function referencePath(path: string): string {
  return path.replace(ESCAPED, percentEscaped).replace(TRAILING, percentEscaped);
}

/** A reference's path as written: its %-escapes, the formatter's or a URL's, read back to what they name. */
function writtenPath(path: string): string {
  return path.replace(/(?:%[\dA-Fa-f]{2})+/gu, (run) => new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))));
}

/** Whether `text`, whole, is one reference to one of `roots`: a link's target or an inline code span, spaces and all. */
export function isWholeReference(text: string, roots: readonly string[]): boolean {
  const reference = REFERENCE.exec(text);

  return reference !== null && !text.includes('\n') && roots.includes(reference[1] ?? '');
}

/** Every reference to one of `roots` in prose, in order: what a chat surface links. */
export function findPlaneReferences(text: string, roots: readonly string[]): Array<{ readonly index: number; readonly reference: string }> {
  if (roots.length === 0) return [];
  const names = roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('|');
  const pattern = new RegExp(String.raw`(?<![\w@.+-])(?:${names}):\/\/${REFERENCE_PATH}`, 'gu');

  return [...text.matchAll(pattern)].map((hit) => ({ index: hit.index, reference: hit[0].replace(/[.,;:!?]+$/u, '') }));
}

/** The reference a person reads: the shortest prefix naming it. A machine path under no subtree stays as it is. */
export function formatPath(absolute: string, planes: PathPlanes): string {
  return shortestReference(absolute, planes)?.text ?? absolute;
}

/** The shortest reference to a machine path: its VFS path is under the mount whose machine root holds it deepest. */
function shortestReference(absolute: string, planes: PathPlanes): { readonly prefix: string; readonly text: string } | undefined {
  const mount = deepest(planes.mounts.filter((candidate) => holds(candidate.at, absolute)), (candidate) => candidate.at);

  if (mount === undefined) return undefined;
  const vfs = under(mount.subtree, relativeTo(mount.at, absolute));

  const references = planes.prefixes.flatMap((row) => {
    if (!holds(row.subtree, vfs)) return [];

    if (row.prefix !== DEVICE_PREFIX) return [{ prefix: row.prefix, text: `${row.prefix}://${referencePath(relativeTo(row.subtree, vfs))}` }];
    const [machine = '', ...path] = relativeTo(row.subtree, vfs).split('/');
    const taken = !isPrefixName(machine) || RESERVED_ROOTS.includes(machine) || planes.prefixes.some((other) => other.prefix === machine);

    return taken ? [] : [{ prefix: machine, text: `${machine}://${referencePath(path.join('/'))}` }];
  });

  return references.reduce<{ readonly prefix: string; readonly text: string } | undefined>(
    (best, candidate) => (best === undefined || candidate.text.length < best.text.length ? candidate : best),
    undefined,
  );
}

/** The VFS path `name://rest` names: its row's subtree, or a machine's under the machines' row, never above it. */
function vfsPath(name: string, rest: string, planes: PathPlanes, written: string): Effect.Effect<string, VfsError> {
  const subtree = subtreeOf(name, planes);

  if (subtree === undefined) {
    const named = planes.prefixes.map((row) => `${row.prefix}://`);

    return Effect.fail(new VfsError('ENOENT', `${name}:// is no prefix here; this workspace's are ${named.join(', ')}`, written));
  }

  const segments: string[] = [];

  // Read back before the walk, so an escaped `/` or `..` climbs no further than a written one.
  for (const segment of writtenPath(rest).split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment !== '..') {
      segments.push(segment);
      continue;
    }

    if (segments.length === 0) return Effect.fail(new VfsError('EPERM', `${written} climbs above ${name}://`, written));

    segments.pop();
  }

  return Effect.succeed(under(subtree, segments.join('/')));
}

/** The subtree `name://` names here: its own row's, else a machine's under the machines' row. */
function subtreeOf(name: string, planes: PathPlanes): string | undefined {
  const row = planes.prefixes.find((candidate) => candidate.prefix === name);

  if (row !== undefined) return name === DEVICE_PREFIX ? undefined : row.subtree;
  const machines = planes.prefixes.find((candidate) => candidate.prefix === DEVICE_PREFIX);

  return machines === undefined || RESERVED_ROOTS.includes(name) ? undefined : under(machines.subtree, name);
}

/** Where a VFS path is on this machine: under the deepest subtree holding it. */
/** Where a `vfs://` path is on this machine: its deepest mount's real directory, or the path itself on the cloud. */
export function realPath(vfs: string, planes: PathPlanes): string {
  return onMachine(vfs, planes);
}

function onMachine(vfs: string, planes: PathPlanes): string {
  const mount = deepest(planes.mounts.filter((candidate) => holds(candidate.subtree, vfs)), (candidate) => candidate.subtree);

  return mount === undefined ? vfs : under(mount.at, relativeTo(mount.subtree, vfs));
}

function holds(root: string, path: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

/** `path` below `root`, with no leading slash: empty for the root itself. */
function relativeTo(root: string, path: string): string {
  return (root === '/' ? path : path.slice(root.length)).replace(/^\/+/u, '');
}

function under(root: string, relative: string): string {
  if (relative === '') return root;

  return root === '/' ? `/${relative}` : `${root}/${relative}`;
}

function deepest<T>(items: readonly T[], root: (item: T) => string): T | undefined {
  return [...items].sort((a, b) => root(b).length - root(a).length)[0];
}
