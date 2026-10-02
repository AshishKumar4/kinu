import { exists, type Awaitable, type VFS, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Workspace plane mount table: the durable workspace tree extended by `/pc` (device tunnel) and `/sandbox`
 * (container), each read through that executor's own `files` VFS so its boundaries still apply.
 * Mount points are absolute; relative paths stay in the workspace, so `pc/x` is a workspace file.
 */


import type { CheckpointFiles } from '../types/primitives';
import { Cause, Effect, Result } from 'effect';
import type { FilesOwner } from '../safety/approval-gate';
import { renderThrownChain, settle, settleSync } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';

export interface VfsMount {
	readonly name: string;
	/** Read live at every call: a device connects and disconnects mid-session. */
	readonly files: () => VFS | null;
	/** Stated verbatim in every refusal; an absent mount is never an empty directory. */
	readonly absentReason: () => string;
	/** Whose files it holds; a shell over the table reads it. */
	readonly filesOwner: FilesOwner;
	/** Refuses every write: nothing through it is harmed. */
	readonly readOnly?: true;
	/** A view over the workspace's own store: `df` gives it the store's figures, as Linux does a bind mount. */
	readonly storeView?: true;
}

export const EXECUTOR_MOUNTS = {
	device: '/pc',
	sandbox: '/sandbox',
} as const satisfies Record<string, string>;

/** Never a machine's mount segment, so no device name shadows `local` or a fixed plane. */
export const RESERVED_REFERENCE_ROOTS: readonly string[] = ['vfs', 'sandbox', 'local'];

export const MOUNT_EXECUTORS: Record<string, string> = Object.fromEntries(
	Object.entries(EXECUTOR_MOUNTS).map(([executor, mount]) => [mount, executor]),
);

/** Structurally `ExecutionRouter.getProvider`'s answer, without importing the router. */
export interface MountableProvider {
	files?: VFS;
	isAvailable(): boolean;
}

/** A device mount is gated on presence (answering now); a container mount on its binding, so a first call boots it. */
export function standardMounts(provider: (name: string) => MountableProvider | undefined): VfsMount[] {
	return [
		{
			name: EXECUTOR_MOUNTS.device.slice(1),
			files: () => {
				const device = provider('device');

				return device && device.isAvailable() ? device.files ?? null : null;
			},
			absentReason: () => 'no device connected',
			filesOwner: 'user',
		},
		{
			name: EXECUTOR_MOUNTS.sandbox.slice(1),
			files: () => provider('sandbox')?.files ?? null,
			absentReason: () => 'no Sandbox container bound',
			filesOwner: 'agent',
		},
	];
}

function absentError(mount: VfsMount, path: string): VfsError {
	return new VfsError('ENXIO', `/${mount.name}: ${mount.absentReason()}`, path);
}

/** `stat` is null for an entry that vanished between the listing and its metadata. */
export interface VfsListedEntry {
	readonly name: string;
	readonly stat: VfsStat | null;
}

/** Most text held in memory for a bounded view on a plane with no ranged read (viewer preview, tools/file-scan.ts). */
export const RESIDENT_TEXT_MAX_BYTES = 512 * 1024;

function awaited<T>(run: () => Awaitable<T>): Effect.Effect<T> {
	return Effect.promise(async () => run());
}

/**
 * A plane without a prefix read is read whole only when `size` fits `limit`; otherwise EPERM with a stated
 * reason, never a whole-file fallback.
 */
export function readBoundedWithVfsOps(
	files: VFS, path: string, limit: number, size: number | null,
): Promise<Uint8Array> {
	return settle(Effect.suspend(() => {
		if (limit <= 0) return Effect.succeed(new Uint8Array(0));
		const native = files.readRange?.bind(files);

		if (native) return awaited(() => native.call(files, path, 0, limit));

		if (size === null || size > limit) {
			return Effect.fail(new VfsError('EPERM',
				`this file plane has no ranged read, so ${size === null ? 'a file of unknown size' : `${String(size)} bytes`}`
				+ ` cannot be previewed within ${String(limit)}: download it instead`,
				path,));
		}

		return awaited(() => files.readFile(path));
	}));
}

/**
 * A file's trailing `bytes` as text via the plane's ranged read; `null` for an absent file.
 * A window opening mid-sequence drops the continuation bytes.
 */
export async function readTailWithVfsOps(
	files: VFS & Required<Pick<VFS, 'readRange'>>, path: string, bytes: number,
): Promise<string | null> {
	const stat = await files.stat(path);

	if (!stat) return null;
	const offset = Math.max(0, stat.size - bytes);
	const length = stat.size - offset;

	if (length === 0) return '';
	const window = await files.readRange(path, offset, length);
	let start = 0;

	if (offset > 0) while (start < window.length && (window[start] & 0xc0) === 0x80) start++;

	return new TextDecoder().decode(start === 0 ? window : window.subarray(start));
}

/**
 * Stats run concurrently; ENOENT on a child answers `stat: null`, any other error propagates.
 */
export function listWithVfsOps(files: VFS, dir: string): Promise<VfsListedEntry[]> {
	return settle(Effect.flatMap(awaited(() => files.readdir(dir)), (entries) => Effect.forEach(entries, (entry) => {
		const child = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;

		return Effect.tryPromise({ try: async () => ({ name: entry.name, stat: entry.stat ?? await files.stat(child) }), catch: (cause) => ({ cause }) }).pipe(
			// The plane's own code, never prose matching.
			Effect.catch((failed) => (isVfsError(failed.cause) && failed.cause.code === 'ENOENT'
				? Effect.succeed({ name: entry.name, stat: null })
				: Effect.die(failed.cause))),
		);
	}, { concurrency: 'unbounded' })));
}

/** `removed` and `remaining` partition the enumeration exactly. */
interface TreeRemoved { readonly removed: readonly string[]; readonly remaining: readonly string[] }

export interface PartialRemoval extends TreeRemoved { readonly failed: { readonly path: string; readonly cause: unknown } }

export type TreeRemoval = Result.Result<TreeRemoved, PartialRemoval>;

/**
 * Depth-first removal in base VFS ops: enumerate first, then delete children before parents.
 * The first failed unlink ends the pass; an entry that vanished before its unlink counts as removed.
 */
export function removeTreeWithVfsOps(files: VFS, path: string): Promise<TreeRemoval> {
	return settle(treeRemoval(files, path));
}

function treeRemoval(files: VFS, path: string): Effect.Effect<TreeRemoval, VfsError> {
	return Effect.gen(function* () {
		const st = yield* awaited(() => files.stat(path));

		if (!st) return yield* Effect.fail(new VfsError('ENOENT', 'no such file or directory', path));

		const pending: string[] = [path];
		const order: string[] = [];

		while (pending.length > 0) {
			const current = pending.pop();

			if (current === undefined) break;
			const currentStat = current === path ? st : yield* awaited(() => files.stat(current));

			if (currentStat === null) continue;

			order.push(current);

			if ((currentStat.type === 'directory')) {
				for (const entry of yield* awaited(() => files.readdir(current))) {
					pending.push(current === '/' ? `/${entry.name}` : `${current}/${entry.name}`);
				}
			}
		}

		// Deepest first: a directory unlinks after everything beneath it.
		order.sort((a, b) => b.split('/').length - a.split('/').length);

		const removed: string[] = [];

		for (const entry of order) {
			const unlinked = yield* Effect.result(Effect.tryPromise({ try: async () => files.unlink(entry), catch: (cause) => ({ cause }) }));

			if (Result.isSuccess(unlinked) || (isVfsError(unlinked.failure.cause) && unlinked.failure.cause.code === 'ENOENT')) {
				removed.push(entry);
				continue;
			}

			const partial: TreeRemoval = Result.fail({ removed, remaining: order.slice(removed.length), failed: { path: entry, cause: unlinked.failure.cause } });

			return partial;
		}

		return Result.succeed({ removed, remaining: [] });
	});
}

/** Shared by the composite plane's throw and the file manager's error value. */
export function partialTreeRemovalMessage(path: string, removal: PartialRemoval): string {
	const gone = removal.removed.length === 0 ? 'none' : removal.removed.join(', ');
	const left = removal.remaining.join(', ');

	return `removing ${removal.failed.path} failed (${renderThrownChain({ cause: removal.failed.cause })}), `
		+ `so ${path} was only partly removed: gone [${gone}]; still present [${left}]`;
}

/** A carry can cross planes, so the two sides are not interchangeable. */
export interface CarrySide {
	readonly files: VFS;
	readonly path: string;
}

/**
 * Fallback rename in base VFS ops. Directories refuse with EPERM before any I/O.
 * The copy is confirmed before the source goes, and a failed carry removes its copy: a rename happens or not.
 */
export function carryFileWithVfsOps(from: CarrySide, to: CarrySide): Promise<void> {
	return settle(carried(from, to));
}

function carried(from: CarrySide, to: CarrySide): Effect.Effect<void, VfsError> {
	return Effect.gen(function* () {
		const sourceStat = yield* awaited(() => from.files.stat(from.path));

		if (!sourceStat) return yield* Effect.fail(new VfsError('ENOENT', 'no such file or directory', from.path));

		if ((sourceStat.type === 'directory')) {
			return yield* Effect.fail(new VfsError('EPERM',
				'a directory cannot be renamed here: this plane has no native rename, and only a file\'s bytes can be carried',
				from.path,));
		}

		const payload = yield* awaited(() => from.files.readFile(from.path));
		const temp = siblingPath(to.path, 'carry', nanoid(10));
		const destinationExisted = yield* awaited(() => exists(to.files, to.path));
		const native = to.files.rename?.bind(to.files);
		// Without native rename the destination is overwritten in place, so it must be read first to be restorable.
		const destinationBytes = destinationExisted && !native ? yield* awaited(() => to.files.readFile(to.path)) : null;

		yield* awaited(() => to.files.writeFile(temp, payload));

		if (!(yield* awaited(() => exists(to.files, temp)))) {
			return yield* Effect.fail(new VfsError('EIO', `the staged copy at ${temp} is not there after writing it`, from.path));
		}

		// The destination keeps its bytes until one final rename over it; never moved aside first.
		const swap = Effect.gen(function* () {
			yield* awaited(() => from.files.unlink(from.path));

			if (native) return yield* awaited(() => native.call(to.files, temp, to.path));
			yield* awaited(() => to.files.writeFile(to.path, payload));

			// The staged copy is the last witness, so the destination is confirmed before it goes.
			if (!(yield* awaited(() => exists(to.files, to.path)))) {
				return yield* Effect.fail(new VfsError('EIO', `the copy at ${to.path} is not there after writing it`, to.path));
			}

			yield* awaited(() => to.files.unlink(temp));
		});

		const rollback = awaited(async () => {
			if (destinationBytes !== null) await to.files.writeFile(to.path, destinationBytes);
			else if (!destinationExisted && await exists(to.files, to.path)) await to.files.unlink(to.path);

			if (!(await exists(from.files, from.path))) await from.files.writeFile(from.path, payload);

			if (await exists(to.files, temp)) await to.files.unlink(temp);
		});

		yield* Effect.catchCause(swap, (failed) => {
			const cause = Cause.squash(failed);

			return Effect.andThen(
				Effect.catchCause(rollback, (rollbackFailed) => {
					const rollbackCause = Cause.squash(rollbackFailed);

					return Effect.fail(new VfsError('EIO', `the rename failed (${renderThrownChain({ cause })}) and rollback failed (${renderThrownChain({ cause: rollbackCause })})`, to.path, { cause: rollbackCause }));
				}),
				Effect.failCause(failed),
			);
		});
	});
}

/** Never interprets user path segments and cannot escape the destination parent. */
function siblingPath(path: string, purpose: string, nonce: string): string {
	const slash = path.lastIndexOf('/');
	const parent = slash < 0 ? '' : path.slice(0, slash + 1);
	const name = slash < 0 ? path : path.slice(slash + 1);

	return `${parent}.${name}.kinu-${purpose}-${nonce}`;
}

/** What the workspace shell reads to serve this table. */
export interface VfsMountRouting {
	mountOf(path: string): string | null;
	mountPoints(): readonly string[];
	/** Every mount, connected or not: each is a mount point on the workspace shell's namespace. */
	mounts(): readonly VfsMount[];
	/** The user's writable mount roots, connected or not. */
	userRoots(): readonly string[];
}

export type MountedVfs = VFS & Required<Pick<VFS, 'rename' | 'removeRecursive' | 'readRange'>> & VfsMountRouting & CheckpointFiles;

/**
 * `base` extended by `mounts`. Mount routes delegate with the prefix stripped; an absent mount refuses with
 * ENXIO (`exists` false, `stat` null). Rename stays within one namespace; mount points reject every mutation.
 */
export function withMountTable(base: VFS, mounts: readonly VfsMount[]): MountedVfs {
	return settleSync(Effect.map(mountIndex(mounts), (byName) => {
		const mountNamed = (path: string): VfsMount | undefined => {
			if (!path.startsWith('/')) return undefined;
			const slash = path.indexOf('/', 1);

			return byName.get(slash === -1 ? path.slice(1) : path.slice(1, slash));
		};

		const mountPoints = (): string[] => [...byName.values()].filter((m) => m.files() !== null).map((m) => m.name);
		const userRoots = [...byName.values()].filter((m) => m.filesOwner === 'user' && m.readOnly !== true).map((m) => `/${m.name}`);

		/** `..` may never climb out of a mounted tree's root. */
		const routeOf = (path: string): Effect.Effect<Route, VfsError> => {
			const mount = mountNamed(path);

			if (!mount) return Effect.succeed({ base: path });
			const slash = path.indexOf('/', 1);

			if (slash === -1) return Effect.succeed({ mount, native: '/' });

			const segments: string[] = [];

			for (const segment of path.slice(slash).split('/')) {
				if (segment === '' || segment === '.') continue;

				if (segment === '..') {
					if (segments.length === 0) {
						return Effect.fail(new VfsError('EPERM',
							'a mounted path cannot traverse outside its mount point',
							path,));
					}

					segments.pop();
					continue;
				}

				segments.push(segment);
			}

			return Effect.succeed({ mount, native: segments.length === 0 ? '/' : `/${segments.join('/')}` });
		};

		const filesForMount = (mount: VfsMount, path: string): Effect.Effect<VFS, VfsError> => {
			const files = mount.files();

			return files ? Effect.succeed(files) : Effect.fail(absentError(mount, path));
		};

		const routed = (path: string): Effect.Effect<Plane, VfsError> => Effect.flatMap(routeOf(path), (route) => ('mount' in route
			? Effect.map(filesForMount(route.mount, path), (files) => ({ files, native: route.native, path }))
			: Effect.succeed({ files: base, native: path, path })));

		/** Mutating a mount point is EPERM, which outranks an absent mount. */
		const mutable = (path: string, operation: string): Effect.Effect<Plane, VfsError> => Effect.flatMap(routeOf(path), (route) => {
			if (!('mount' in route)) return Effect.succeed({ files: base, native: path, path });

			if (route.native === '/') return Effect.fail(new VfsError('EPERM', `a mount point cannot be ${operation}`, path));

			return Effect.map(filesForMount(route.mount, path), (files) => ({ files, native: route.native, path }));
		});

		const delegate = <T>(path: string, op: (files: VFS, native: string) => Effect.Effect<T, VfsError>): Effect.Effect<T, VfsError> =>
			Effect.flatMap(routed(path), ({ files, native }) => op(files, native));

		const mutate = <T>(path: string, operation: string, op: (files: VFS, native: string) => Effect.Effect<T, VfsError>): Effect.Effect<T, VfsError> =>
			Effect.flatMap(mutable(path, operation), ({ files, native }) => op(files, native));

		const optional = <K extends OptionalOperation, T>(
			plane: Effect.Effect<Plane, VfsError>, key: K, run: (files: VFS & Required<Pick<VFS, K>>, native: string) => Awaitable<T>,
		): Effect.Effect<T, VfsError> => Effect.flatMap(plane, ({ files, native, path }) => (serves(files, key)
			? awaited(() => run(files, native))
			: Effect.fail(new VfsError('ENOTSUP', LACKS[key], path))));

		const table: MountedVfs = {
			mountOf: (path) => mountNamed(path)?.name ?? null,
			mountPoints,
			mounts: () => [...byName.values()],
			userRoots: () => userRoots,
			readFile(path) {
				return settle(delegate(path, (files, native) => awaited(() => files.readFile(native))));
			},
			readFileAtRevision(path, revision, range) {
				return settle(optional(routed(path), 'readFileAtRevision', (files, native) => files.readFileAtRevision(native, revision, range)));
			},
			writeFile(path, data) {
				return settle(mutate(path, 'written', (files, native) => awaited(() => files.writeFile(native, data))));
			},
			writeFileWithReport(path, data) {
				return settle(mutate(path, 'written', (files, native) => {
					const reporting: VFS & CheckpointFiles = files;
					const report = reporting.writeFileWithReport?.bind(reporting);

					return report ? awaited(() => report(native, data)) : Effect.as(awaited(() => files.writeFile(native, data)), null);
				}));
			},
			writeFileIfRevision(path, data, expectedRevision) {
				return settle(optional(mutable(path, 'written'), 'writeFileIfRevision', (files, native) => files.writeFileIfRevision(native, data, expectedRevision)));
			},
			readdir(path) {
				return settle(delegate(path, (files, native) => Effect.map(awaited(() => files.readdir(native)), (entries) => {
					if (path !== '/') return entries;
					const named = new Set(entries.map((entry) => entry.name));

					return [...entries, ...mountPoints().filter((name) => !named.has(name)).map((name) => ({ name, type: 'directory' as const, stat: MOUNT_POINT_STAT }))];
				})));
			},
			stat(path, options) {
				return settle(Effect.flatMap(routeOf(path), (route) => {
					if (!('mount' in route)) return awaited(() => base.stat(path, options));

					// Some trees cannot stat their own root (the container derives stat from the parent listing).
					return Effect.flatMap(filesForMount(route.mount, path), (files) => (route.native === '/'
						? Effect.succeed(MOUNT_POINT_STAT)
						: awaited(() => files.stat(route.native, options))));
				}));
			},
			unlink(path) {
				return settle(mutate(path, 'unlinked', (files, native) => awaited(() => files.unlink(native))));
			},
			mkdir(path, opts) {
				// `mkdir -p` of a live mount point succeeds (`ensureDir`); plain mkdir stays EPERM.
				return settle(Effect.flatMap(routeOf(path), (route) => ('mount' in route && route.native === '/' && opts?.recursive === true
					? Effect.asVoid(filesForMount(route.mount, path))
					: mutate(path, 'created', (files, native) => awaited(() => files.mkdir(native, opts))))));
			},
			rename(oldPath, newPath) {
				return settle(Effect.gen(function* () {
					const from = yield* routeOf(oldPath);
					const to = yield* routeOf(newPath);

					if (('mount' in from && from.native === '/') || ('mount' in to && to.native === '/')) {
						return yield* Effect.fail(new VfsError('EPERM', 'a mount point cannot be renamed', oldPath));
					}

					if ('mount' in from && 'mount' in to) {
						if (from.mount !== to.mount) {
							yield* filesForMount(from.mount, oldPath);
							yield* filesForMount(to.mount, newPath);

							return yield* Effect.fail(new VfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath));
						}

						const files = yield* filesForMount(from.mount, oldPath);
						const native = files.rename?.bind(files);

						if (native) return yield* awaited(() => native.call(files, from.native, to.native));

						return yield* carried({ files, path: from.native }, { files, path: to.native });
					}

					if ('mount' in from) {
						yield* filesForMount(from.mount, oldPath);

						return yield* Effect.fail(new VfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath));
					}

					if ('mount' in to) {
						yield* filesForMount(to.mount, newPath);

						return yield* Effect.fail(new VfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath));
					}

					const native = base.rename?.bind(base);

					if (native) return yield* awaited(() => native.call(base, oldPath, newPath));
					const st = yield* awaited(() => base.stat(oldPath));

					if (!st) return yield* Effect.fail(new VfsError('ENOENT', 'no such file or directory', oldPath));

					if ((st.type === 'directory')) {
						return yield* Effect.fail(new VfsError('EPERM', 'a directory cannot be renamed here: this route has no native rename, and only a file\'s bytes can be carried', oldPath));
					}

					yield* carried(
						{ files: base, path: oldPath },
						{ files: base, path: newPath },
					);
				}));
			},
			removeRecursive(path) {
				return settle(mutate(path, 'removed', (files, native) => {
					const remove = files.removeRecursive?.bind(files);

					if (remove) return awaited(() => remove.call(files, native));

					// The partial-removal record rides the error; the failing entry keeps its code.
					return Effect.flatMap(treeRemoval(files, native), (removal) => (Result.isSuccess(removal)
						? Effect.void
						: Effect.fail(new VfsError(isVfsError(removal.failure.failed.cause) ? removal.failure.failed.cause.code : 'EIO',
							partialTreeRemovalMessage(native, removal.failure),
							native,))));
				}));
			},
			// A plane with no ranged read refuses rather than whole-reading; only `readBoundedWithVfsOps` may whole-read.
			readRange(path, offset, length) {
				// ENOTSUP, not EPERM: callers like the `file` scan fall back on this code.
				return settle(optional(routed(path), 'readRange', (files, native) => files.readRange(native, offset, length)));
			},
		};

		table.readlink = (path) => settle(optional(routed(path), 'readlink', (files, native) => files.readlink(native)));

		return table;
	}));
}

type Route = { readonly mount: VfsMount; readonly native: string } | { readonly base: string };

interface Plane { readonly files: VFS; readonly native: string; readonly path: string }

type OptionalOperation = 'readFileAtRevision' | 'writeFileIfRevision' | 'readRange' | 'readlink';

function serves<K extends OptionalOperation>(files: VFS, key: K): files is VFS & Required<Pick<VFS, K>> {
	return files[key] !== undefined;
}

const LACKS: Record<OptionalOperation, string> = {
	readFileAtRevision: 'this file plane does not retain file revisions',
	writeFileIfRevision: 'this file plane does not support revision-checked writes',
	readRange: 'this plane serves no ranged read',
	readlink: 'this plane serves no readlink',
};



function mountIndex(mounts: readonly VfsMount[]): Effect.Effect<Map<string, VfsMount>> {
	return Effect.gen(function* () {
		const byName = new Map<string, VfsMount>();

		for (const mount of mounts) {
			if (
				mount.name.length === 0
				|| mount.name === '.'
				|| mount.name === '..'
				|| mount.name.includes('/')
			) {
				return yield* Effect.die(new Error(`'${mount.name}' is not a usable VFS mount name`));
			}

			if (byName.has(mount.name)) {
				return yield* Effect.die(new Error(`duplicate VFS mount name '${mount.name}'`));
			}

			byName.set(mount.name, mount);
		}

		return byName;
	});
}

const MOUNT_POINT_STAT: VfsStat = { size: 0, mtimeMs: 0, type: 'directory' };
