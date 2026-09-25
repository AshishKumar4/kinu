/**
 * Workspace plane mount table: the durable workspace tree extended by `/pc` (device tunnel) and `/sandbox`
 * (container), each read through that executor's own `files` VFS so its boundaries still apply.
 * Mount points are absolute; relative paths stay in the workspace, so `pc/x` is a workspace file.
 */

import type { VFS, VfsEntryStat } from '../types/primitives';
import type { FilesOwner } from '../safety/approval-gate';
import { renderThrownChain } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { isVfsError, makeVfsError } from './errno';

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

function absentError(mount: VfsMount, path: string): Error {
	return makeVfsError('ENXIO', `/${mount.name} — ${mount.absentReason()}`, path);
}

/** Native mutations the composite plane forwards where the routed tree has them. */
export interface VfsNativeMutations {
	rename(oldPath: string, newPath: string): Promise<void>;
	removeRecursive(path: string): Promise<void>;
}

/** `stat` is null for an entry that vanished between the listing and its metadata. */
export interface VfsListedEntry {
	readonly name: string;
	readonly stat: VfsEntryStat | null;
}

/**
 * `readRange` is a prefix read from `offset` without materializing the file.
 * `readdirStats` returns type and size in one call; the container's `stat` derives from the parent listing.
 */
export interface VfsNativeReads {
	readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
	readdirStats(path: string): Promise<VfsListedEntry[]>;
}

function nativeOps(files: VFS): Partial<VfsNativeMutations & VfsNativeReads> {
	const probed: VFS & Partial<VfsNativeMutations & VfsNativeReads> = files;

	return probed;
}

/** Most text held in memory for a bounded view on a plane with no ranged read (viewer preview, tools/file-scan.ts). */
export const RESIDENT_TEXT_MAX_BYTES = 512 * 1024;

/**
 * A plane without a prefix read is read whole only when `size` fits `limit`; otherwise EPERM with a stated
 * reason, never a whole-file fallback.
 */
export async function readBoundedWithVfsOps(
	files: VFS, path: string, limit: number, size: number | null,
): Promise<Uint8Array> {
	if (limit <= 0) return new Uint8Array(0);
	const native = nativeOps(files).readRange;

	if (native) return native.call(files, path, 0, limit);

	if (size === null || size > limit) {
		throw makeVfsError(
			'EPERM',
			`this file plane has no ranged read, so ${size === null ? 'a file of unknown size' : `${String(size)} bytes`}`
			+ ` cannot be previewed within ${String(limit)} — download it instead`,
			path,
		);
	}

	const raw = await files.readFile(path);

	return raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
}

/**
 * A file's trailing `bytes` as text via the plane's ranged read; `null` for an absent file.
 * A window opening mid-sequence drops the continuation bytes.
 */
export async function readTailWithVfsOps(
	files: VFS & Pick<VfsNativeReads, 'readRange'>, path: string, bytes: number,
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
export async function listWithVfsOps(files: VFS, dir: string): Promise<VfsListedEntry[]> {
	const native = nativeOps(files).readdirStats;

	if (native) return native.call(files, dir);
	const names = await files.readdir(dir);

	return Promise.all(names.map(async (name) => {
		const child = dir === '/' ? `/${name}` : `${dir}/${name}`;

		try {
			return { name, stat: await files.stat(child) };
		} catch (cause) {
			// The plane's own code, never prose matching.
			if (isVfsError(cause) && cause.code === 'ENOENT') return { name, stat: null };
			throw cause;
		}
	}));
}

/** `removed` and `remaining` partition the enumeration exactly. */
export type TreeRemoval =
	| { readonly ok: true; readonly removed: readonly string[]; readonly remaining: readonly string[] }
	| {
		readonly ok: false;
		readonly removed: readonly string[];
		readonly remaining: readonly string[];
		readonly failed: { readonly path: string; readonly cause: unknown };
	};

/**
 * Depth-first removal in base VFS ops: enumerate first, then delete children before parents.
 * The first failed unlink ends the pass; an entry that vanished before its unlink counts as removed.
 */
export async function removeTreeWithVfsOps(files: VFS, path: string): Promise<TreeRemoval> {
	const st = await files.stat(path);

	if (!st) throw makeVfsError('ENOENT', 'no such file or directory', path);

	const pending: string[] = [path];
	const order: string[] = [];

	while (pending.length > 0) {
		const current = pending.pop();

		if (current === undefined) break;
		const currentStat = current === path ? st : await files.stat(current);

		if (currentStat === null) continue;

		order.push(current);

		if (currentStat.isDir) {
			for (const name of await files.readdir(current)) {
				pending.push(current === '/' ? `/${name}` : `${current}/${name}`);
			}
		}
	}

	// Deepest first: a directory unlinks after everything beneath it.
	order.sort((a, b) => b.split('/').length - a.split('/').length);

	const removed: string[] = [];

	for (const entry of order) {
		try {
			await files.unlink(entry);
			removed.push(entry);
		} catch (cause) {
			if (isVfsError(cause) && cause.code === 'ENOENT') {
				removed.push(entry);
				continue;
			}

			return {
				ok: false,
				removed,
				remaining: order.slice(removed.length),
				failed: { path: entry, cause },
			};
		}
	}

	return { ok: true, removed, remaining: [] };
}

/** Shared by the composite plane's throw and the file manager's error value. */
export function partialTreeRemovalMessage(path: string, removal: Extract<TreeRemoval, { ok: false }>): string {
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
export async function carryFileWithVfsOps(from: CarrySide, to: CarrySide): Promise<void> {
	const sourceStat = await from.files.stat(from.path);

	if (!sourceStat) throw makeVfsError('ENOENT', 'no such file or directory', from.path);

	if (sourceStat.isDir) {
		throw makeVfsError(
			'EPERM',
			'a directory cannot be renamed here — this plane has no native rename, and only a file\'s bytes can be carried',
			from.path,
		);
	}

	const payload = await from.files.readFile(from.path);
	const temp = siblingPath(to.path, 'carry', nanoid(10));
	const destinationExisted = await to.files.exists(to.path);
	const native = nativeOps(to.files).rename;
	// Without native rename the destination is overwritten in place, so it must be read first to be restorable.
	const destinationBytes = destinationExisted && !native ? await to.files.readFile(to.path) : null;

	await to.files.writeFile(temp, payload);

	if (!(await to.files.exists(temp))) {
		throw makeVfsError('EIO', `the staged copy at ${temp} is not there after writing it`, from.path);
	}

	try {
		// The destination keeps its bytes until one final rename over it; never moved aside first.
		await from.files.unlink(from.path);

		if (native) await native.call(to.files, temp, to.path);
		else {
			await to.files.writeFile(to.path, payload);

			// The staged copy is the last witness, so the destination is confirmed before it goes.
			if (!(await to.files.exists(to.path))) {
				throw makeVfsError('EIO', `the copy at ${to.path} is not there after writing it`, to.path);
			}

			await to.files.unlink(temp);
		}
	} catch (cause) {
		try {
			if (destinationBytes !== null) await to.files.writeFile(to.path, destinationBytes);
			else if (!destinationExisted && await to.files.exists(to.path)) await to.files.unlink(to.path);

			if (!(await from.files.exists(from.path))) await from.files.writeFile(from.path, payload);

			if (await to.files.exists(temp)) await to.files.unlink(temp);
		} catch (rollback) {
			throw makeVfsError('EIO', `the rename failed (${renderThrownChain({ cause })}) and rollback failed (${renderThrownChain({ cause: rollback })})`, to.path);
		}

		throw cause;
	}
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
	/** The user's writable mount roots, connected or not. */
	userRoots(): readonly string[];
}

export type MountedVfs = VFS & VfsNativeMutations & VfsNativeReads & VfsMountRouting;

/**
 * `base` extended by `mounts`. Mount routes delegate with the prefix stripped; an absent mount refuses with
 * ENXIO (`exists` false, `stat` null). Rename stays within one namespace; mount points reject every mutation.
 */
export function withMountTable(base: VFS, mounts: readonly VfsMount[]): MountedVfs {
	const byName = new Map<string, VfsMount>();

	for (const mount of mounts) {
		if (
			mount.name.length === 0
			|| mount.name === '.'
			|| mount.name === '..'
			|| mount.name.includes('/')
		) {
			throw new Error(`'${mount.name}' is not a usable VFS mount name`);
		}

		if (byName.has(mount.name)) {
			throw new Error(`duplicate VFS mount name '${mount.name}'`);
		}

		byName.set(mount.name, mount);
	}

	const mountNamed = (path: string): VfsMount | undefined => {
		if (!path.startsWith('/')) return undefined;
		const slash = path.indexOf('/', 1);

		return byName.get(slash === -1 ? path.slice(1) : path.slice(1, slash));
	};

	const mountPoints = (): string[] => [...byName.values()].filter((m) => m.files() !== null).map((m) => m.name);
	const userRoots = [...byName.values()].filter((m) => m.filesOwner === 'user' && m.readOnly !== true).map((m) => `/${m.name}`);

	/** `..` may never climb out of a mounted tree's root. */
	const routeOf = (path: string): { mount: VfsMount; native: string } | { base: string } => {
		const mount = mountNamed(path);

		if (!mount) return { base: path };
		const slash = path.indexOf('/', 1);

		if (slash === -1) return { mount, native: '/' };

		const segments: string[] = [];

		for (const segment of path.slice(slash).split('/')) {
			if (segment === '' || segment === '.') continue;

			if (segment === '..') {
				if (segments.length === 0) {
					throw makeVfsError(
						'EPERM',
						'a mounted path cannot traverse outside its mount point',
						path,
					);
				}

				segments.pop();
				continue;
			}

			segments.push(segment);
		}

		return { mount, native: segments.length === 0 ? '/' : `/${segments.join('/')}` };
	};

	const delegate = async <T>(path: string, op: (files: VFS, native: string) => Promise<T>): Promise<T> => {
		const routed = routeOf(path);

		if (!('mount' in routed)) return op(base, path);
		const files = routed.mount.files();

		if (!files) throw absentError(routed.mount, path);

		return op(files, routed.native);
	};

	const filesForMount = (mount: VfsMount, path: string): VFS => {
		const files = mount.files();

		if (!files) throw absentError(mount, path);

		return files;
	};

	/** Mutating a mount point is EPERM, which outranks an absent mount. */
	const mutate = async <T>(
		path: string, operation: string, op: (files: VFS, native: string) => Promise<T>,
	): Promise<T> => {
		const routed = routeOf(path);

		if (!('mount' in routed)) return op(base, path);

		if (routed.native === '/') {
			throw makeVfsError('EPERM', `a mount point cannot be ${operation}`, path);
		}

		const files = routed.mount.files();

		if (!files) throw absentError(routed.mount, path);

		return op(files, routed.native);
	};

	const table: MountedVfs = {
		mountOf: (path) => mountNamed(path)?.name ?? null,
		mountPoints,
		userRoots: () => userRoots,
		readFile(path, opts) {
			return delegate(path, (files, native) => files.readFile(native, opts));
		},
		readFileAtRevision(path, revision, range) {
			return delegate(path, (files, native) => {
				if (!files.readFileAtRevision) throw makeVfsError('ENOTSUP', 'this file plane does not retain file revisions', path);

				return files.readFileAtRevision(native, revision, range);
			});
		},
		writeFile(path, data) {
			return mutate(path, 'written', (files, native) => files.writeFile(native, data));
		},
		writeFileIfRevision(path, data, expectedRevision) {
			return mutate(path, 'written', (files, native) => {
				if (!files.writeFileIfRevision) {
					throw makeVfsError(
						'ENOTSUP',
						'this file plane does not support revision-checked writes',
						path,
					);
				}

				return files.writeFileIfRevision(native, data, expectedRevision);
			});
		},
		readdir(path) {
			return delegate(path, async (files, native) => {
				const entries = await files.readdir(native);

				// Only the true root lists mount points, and only live ones.
				return path === '/' ? [...new Set([...entries, ...mountPoints()])] : entries;
			});
		},
		async stat(path) {
			const routed = routeOf(path);

			if (!('mount' in routed)) return base.stat(path);
			const files = routed.mount.files();

			// Null, not an error, so an existence probe does not fail.
			if (!files) return null;

			// Some trees cannot stat their own root (the container derives stat from the parent listing).
			if (routed.native === '/') return MOUNT_POINT_STAT;

			return files.stat(routed.native);
		},
		unlink(path) {
			return mutate(path, 'unlinked', (files, native) => files.unlink(native));
		},
		async mkdir(path, opts) {
			// `mkdir -p` of a live mount point succeeds (`ensureDir`); plain mkdir stays EPERM.
			const routed = routeOf(path);

			if ('mount' in routed && routed.native === '/' && opts?.recursive === true) {
				if (routed.mount.files() !== null) return;
				throw absentError(routed.mount, path);
			}

			return mutate(path, 'created', (files, native) => files.mkdir(native, opts));
		},
		async exists(path) {
			const routed = routeOf(path);

			if (!('mount' in routed)) return base.exists(path);
			const files = routed.mount.files();

			return files ? files.exists(routed.native) : false;
		},
		async rename(oldPath, newPath) {
			const from = routeOf(oldPath);
			const to = routeOf(newPath);

			if (('mount' in from && from.native === '/') || ('mount' in to && to.native === '/')) {
				throw makeVfsError('EPERM', 'a mount point cannot be renamed', oldPath);
			}

			if ('mount' in from && 'mount' in to) {
				if (from.mount !== to.mount) {
					filesForMount(from.mount, oldPath);
					filesForMount(to.mount, newPath);
					throw makeVfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath);
				}

				const files = filesForMount(from.mount, oldPath);
				const native = nativeOps(files).rename;

				if (native) return native.call(files, from.native, to.native);
				await carryFileWithVfsOps(
					{ files, path: from.native },
					{ files, path: to.native },
				);

				return;
			}

			if ('mount' in from) {
				filesForMount(from.mount, oldPath);
				throw makeVfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath);
			}

			if ('mount' in to) {
				filesForMount(to.mount, newPath);
				throw makeVfsError('EPERM', 'cannot rename across VFS mount boundaries', oldPath);
			}

			const native = nativeOps(base).rename;

			if (native) return native.call(base, oldPath, newPath);
			const st = await base.stat(oldPath);

			if (!st) throw makeVfsError('ENOENT', 'no such file or directory', oldPath);

			if (st.isDir) {
				throw makeVfsError('EPERM', 'a directory cannot be renamed here — this route has no native rename, and only a file\'s bytes can be carried', oldPath);
			}

			await carryFileWithVfsOps(
				{ files: base, path: oldPath },
				{ files: base, path: newPath },
			);
		},
		removeRecursive(path) {
			return mutate(path, 'removed', async (files, native) => {
				const remove = nativeOps(files).removeRecursive;

				if (remove) return remove.call(files, native);

				const removal = await removeTreeWithVfsOps(files, native);

				// The partial-removal record rides the error; the failing entry keeps its code.
				if (!removal.ok) {
					throw makeVfsError(
						isVfsError(removal.failed.cause) ? removal.failed.cause.code : 'EIO',
						partialTreeRemovalMessage(native, removal),
						native,
					);
				}
			});
		},
		// A plane with no ranged read refuses rather than whole-reading; only `readBoundedWithVfsOps` may whole-read.
		readRange(path, offset, length) {
			return delegate(path, (files, native) => {
				const range = nativeOps(files).readRange;

				// ENOTSUP, not EPERM: callers like the `file` scan fall back on this code.
				if (!range) throw makeVfsError('ENOTSUP', 'this plane serves no ranged read', path);

				return range.call(files, native, offset, length);
			});
		},
		readdirStats(path) {
			return delegate(path, async (files, native) => {
				const listed = await listWithVfsOps(files, native);

				if (path !== '/') return listed;
				const named = new Set(listed.map((entry) => entry.name));

				return [
					...listed,
					...mountPoints().filter((name) => !named.has(name)).map((name) => ({ name, stat: MOUNT_POINT_STAT })),
				];
			});
		},
	};

	const baseLstat = base.lstat?.bind(base);

	// Only a base that tells a link from its target gives the table an lstat.
	if (baseLstat !== undefined) {
		table.lstat = async (path) => {
			const routed = routeOf(path);

			if (!('mount' in routed)) return baseLstat(path);
			const files = routed.mount.files();

			if (!files) return null;

			if (routed.native === '/') return { ...MOUNT_POINT_STAT, isSymlink: false };

			if (files.lstat) return files.lstat(routed.native);
			const stat = await files.stat(routed.native);

			return stat && { ...stat, isSymlink: false };
		};
	}

	return table;
}

const MOUNT_POINT_STAT: VfsEntryStat = { size: 0, mtimeMs: 0, isDir: true };
