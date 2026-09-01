/**
 * The workspace plane's mount table.
 *
 * One filesystem view for the agent: its own durable workspace tree, EXTENDED
 * by the machines it can reach. `/pc` serves the device tunnel's files (only
 * while a device is connected), `/sandbox` the container's (only while the
 * Sandbox binding exists). A read under a mount point crosses to the owning
 * executor's transport — device WebSocket, container HTTP — through that
 * executor's own `files` VFS, so every boundary the executor enforces
 * (device consent, path scoping) is enforced on the mounted path too.
 *
 * The workspace tree stays the canonical plane. Mounts are reserved root
 * names, never a second copy of workspace bytes, and memory indexing, fork
 * snapshots and identity provisioning keep addressing the base tree alone.
 * Like a POSIX mount, a mount point is ABSOLUTE: relative paths resolve in
 * the workspace, so `pc/x` is still a workspace file.
 */

import type { VFS, VfsEntryStat } from '../types/primitives';
import { renderThrownChain } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { isVfsError, makeVfsError } from './errno';

/** One entry of the mount table. */
export interface VfsMount {
	/** Reserved root name: the mount point is `/${name}`. */
	readonly name: string;
	/** The mounted tree while its environment is live, null while absent.
	 *  Read live at every call — a device connects and disconnects mid-session
	 *  without this plane being rebuilt. */
	readonly files: () => VFS | null;
	/** Why it is absent right now, stated verbatim in every refusal — an
	 *  absent mount is a stated absence, never an empty directory. */
	readonly absentReason: () => string;
}

/** The mount point each executor namespace's files are served under. One
 *  table so prompt text and documentation cannot drift from routing. */
export const EXECUTOR_MOUNTS = {
	laptop: '/pc',
	sandbox: '/sandbox',
} as const satisfies Record<string, string>;

/** The same table read the other way: mount point → the executor serving it.
 *  Here rather than at each reader, because three readers had each inverted it
 *  themselves — one keyed by mount point, one by bare entry name — and a fourth
 *  spelling is how they start disagreeing about which mount is which. */
export const MOUNT_EXECUTORS: Record<string, string> = Object.fromEntries(
	Object.entries(EXECUTOR_MOUNTS).map(([executor, mount]) => [mount, executor]),
);

/** The provider surface a standard mount resolves against — structurally
 *  `ExecutionRouter.getProvider`'s answer, without importing the router. */
export interface MountableProvider {
	files?: VFS;
	isAvailable(): boolean;
}

/**
 * The two mounts every backend declares off its executor registry.
 *
 * Different environments gate differently, because they come and go
 * differently. A device tunnel is a PRESENCE: gated on the executor answering
 * right now, so a mid-session disconnect states absence instead of serving a
 * dead-socket error through the file plane. A container is a BINDING: the SDK
 * provisions it on first touch, so the mount exists whenever the binding does
 * and lets the first file call pay the cold start.
 */
export function standardMounts(provider: (name: string) => MountableProvider | undefined): VfsMount[] {
	return [
		{
			name: EXECUTOR_MOUNTS.laptop.slice(1),
			files: () => {
				const laptop = provider('laptop');
				return laptop && laptop.isAvailable() ? laptop.files ?? null : null;
			},
			absentReason: () => 'no device connected',
		},
		{
			name: EXECUTOR_MOUNTS.sandbox.slice(1),
			files: () => provider('sandbox')?.files ?? null,
			absentReason: () => 'no Sandbox container bound',
		},
	];
}

function absentError(mount: VfsMount, path: string): Error {
	return makeVfsError('ENXIO', `/${mount.name} — ${mount.absentReason()}`, path);
}

/**
 * Mutations some planes implement natively past the base VFS contract: Nimbus
 * renames without reading the bytes and removes a tree in one bounded
 * statement. The composite plane forwards them where the routed tree has
 * them, so a workspace rename through the mount table stays free.
 */
export interface VfsNativeMutations {
	rename(oldPath: string, newPath: string): Promise<void>;
	removeRecursive(path: string): Promise<void>;
}

/** One directory entry with the metadata a listing needs, as the plane itself
 *  reports it. `stat` is null for an entry that vanished between the listing
 *  and its own metadata — a gap, not a failure of the directory. */
export interface VfsListedEntry {
	readonly name: string;
	readonly stat: VfsEntryStat | null;
}

/**
 * Reads some planes serve better than the base contract can express.
 *
 * `readRange` is a PREFIX read: the plane hands back the first `length` bytes
 * from `offset` without materializing the file. Only planes whose transport has
 * an offset/length read declare it — the credentialed session protocol does
 * (execution/nimbus-agent-files.ts) — and the viewer's bounded preview is the
 * caller that needs it, because reading a gigabyte to show half a megabyte is
 * the cost, not the clipping.
 *
 * `readdirStats` is a listing that already carries type and size. Two planes
 * return both from ONE call and used to throw them away, after which the
 * listing statted every child separately — and the container's `stat` derives
 * itself from the PARENT LISTING, so an N-child directory cost N+1 full
 * listings of the same directory.
 */
export interface VfsNativeReads {
	readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
	readdirStats(path: string): Promise<VfsListedEntry[]>;
}

/** The routed tree's native operations, where it declares them. A widening
 *  assignment, not a cast: the extras are optional, and vfs/nimbus-workspace.ts
 *  and execution/{nimbus,sandbox,nimbus-agent-files}.ts are the producers whose
 *  members carry exactly these signatures. */
function nativeOps(files: VFS): Partial<VfsNativeMutations & VfsNativeReads> {
	const probed: VFS & Partial<VfsNativeMutations & VfsNativeReads> = files;
	return probed;
}

/**
 * A file's leading `limit` bytes, off the plane's own prefix read.
 *
 * `size` is what the plane's stat said, and it decides whether a plane WITHOUT
 * a prefix read may be asked at all: a file that already fits the limit is one
 * whole read of a bounded file, and a file that does not is REFUSED here rather
 * than fetched and sliced. There is deliberately no whole-file fallback for the
 * over-budget case — that fallback is exactly the allocation the bound exists
 * to prevent, and dressing it as a bound would be a lie the caller cannot see.
 *
 * The refusal is EPERM with a stated reason, so the viewer can offer the raw
 * route (which streams to a response body and never makes the file resident)
 * instead of pretending the file is unreadable.
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
 * A directory's entries with their metadata, off the plane's stat-inclusive
 * listing where it has one and off concurrent per-child stats where it does
 * not.
 *
 * The stats run together rather than one after another, and a child that is
 * GONE is isolated to that child: ENOENT answers `stat: null`, because a file
 * removed between the listing and its own metadata is a gap in the listing and
 * not a failure of the directory. Anything else — a permission refusal, an I/O
 * fault, a plane that stopped answering — PROPAGATES. Those are the plane
 * failing, and a listing that reported them as sizeless files would hide an
 * outage behind a plausible directory.
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
			// The plane's OWN code, never prose matching. A tree that reports
			// absence by throwing rather than by answering null is the only case
			// this absorbs.
			if (isVfsError(cause) && cause.code === 'ENOENT') return { name, stat: null };
			throw cause;
		}
	}));
}

/**
 * Depth-first tree removal spelled in base VFS ops, for planes with no native
 * removal. Children first, the directory itself last via `unlink`, so a plane
 * whose unlink refuses directories fails naming its own refusal instead of
 * half-working silently.
 */
export async function removeTreeWithVfsOps(files: VFS, path: string): Promise<void> {
	const st = await files.stat(path);
	if (!st) throw makeVfsError('ENOENT', 'no such file or directory', path);
	if (st.isDir) {
		for (const name of await files.readdir(path)) {
			await removeTreeWithVfsOps(files, path === '/' ? `/${name}` : `${path}/${name}`);
		}
	}
	await files.unlink(path);
}

/** One side of a carry: the plane that holds the bytes, and the path inside
 *  it. Named because a carry can cross planes, so the two sides are not
 *  interchangeable and neither is "the VFS". */
export interface CarrySide {
	readonly files: VFS;
	readonly path: string;
}

/**
 * Fallback rename spelled in base VFS ops, for a plane with no native rename
 * and for a move that crosses planes, where no native rename can exist.
 *
 * Only a file can ride a carry, and the carry itself holds that line: a
 * directory source refuses with EPERM before the payload read, the staged
 * write, or the source unlink — so a tree is never half-copied under a
 * rename's name.
 *
 * A byte carry is not atomic, so its completion boundary is explicit: the copy
 * must be confirmed present before the source is destroyed, and a carry that
 * cannot finish removes the copy it made. Both halves exist for one invariant
 * — a rename either happened or it did not. Without them a failed unlink left
 * the file under BOTH names and reported failure, so the caller could not tell
 * which name to trust.
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
	// A plane without a native rename overwrites its destination in place, so
	// the only way to put back what was there is to have read it first.
	const destinationBytes = destinationExisted && !native ? await to.files.readFile(to.path) : null;

	await to.files.writeFile(temp, payload);
	if (!(await to.files.exists(temp))) {
		throw makeVfsError('EIO', `the staged copy at ${temp} is not there after writing it`, from.path);
	}

	try {
		// An existing destination keeps its own bytes until the LAST step. The
		// source goes once the copy is staged beside the destination, and the
		// destination is then replaced by one rename over it — never by moving it
		// aside first, which would leave the name missing in between.
		await from.files.unlink(from.path);
		if (native) await native.call(to.files, temp, to.path);
		else {
			await to.files.writeFile(to.path, payload);
			// The staged copy is the only remaining witness of these bytes, so the
			// destination has to be confirmed before it goes — the same check the
			// staged copy itself got, for the same reason.
			if (!(await to.files.exists(to.path))) {
				throw makeVfsError('EIO', `the copy at ${to.path} is not there after writing it`, to.path);
			}
			await to.files.unlink(temp);
		}
	} catch (cause) {
		try {
			// Whatever the destination was before this carry is what it must be
			// again: its old bytes if it had any, and no file at all if it did not.
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
/** Containment-preserving temporary sibling. It never interprets user path
 * segments and cannot escape the destination parent. */
function siblingPath(path: string, purpose: string, nonce: string): string {
	const slash = path.lastIndexOf('/');
	const parent = slash < 0 ? '' : path.slice(0, slash + 1);
	const name = slash < 0 ? path : path.slice(slash + 1);
	return `${parent}.${name}.kinu-${purpose}-${nonce}`;
}


/**
 * `base`, extended by `mounts`. Base routes pass through untouched — relative
 * paths, absolute paths, everything the workspace owns. A mount route
 * delegates with the mount prefix stripped (`/pc/home/me.txt` reads the
 * machine's `/home/me.txt`), and an absent mount refuses every reading or
 * mutating call with ENXIO carrying the stated absence, answers `exists`
 * false and `stat` null.
 *
 * The operation matrix has one router: read, write, conditional write, list,
 * stat, existence, mkdir, unlink, bounded reads and stat-inclusive listings
 * all dispatch through the same first-segment decision. `rename` and
 * `removeRecursive` extend that matrix: native where the routed tree has them,
 * spelled in base operations where it does not. Rename stays in its source
 * namespace: a base↔mount or mount↔mount move refuses before either tree
 * changes, while a fallback carry is allowed only inside one tree. A mount
 * point itself is an entry of THIS plane and rejects every mutation.
 */
export function withMountTable(
	base: VFS, mounts: readonly VfsMount[],
): VFS & VfsNativeMutations & VfsNativeReads {
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

	/** Split a path into its mount route (`/pc/a/b` → pc, `/a/b`) or a base
	 * route. Only a whole first segment matches, so `/pcs/x` stays base. A
	 * `..` may simplify inside a mounted tree, but may never climb through its
	 * root into the composite namespace. */
	const routeOf = (path: string): { mount: VfsMount; native: string } | { base: string } => {
		if (!path.startsWith('/')) return { base: path };
		const slash = path.indexOf('/', 1);
		const head = slash === -1 ? path.slice(1) : path.slice(1, slash);
		const mount = byName.get(head);
		if (!mount) return { base: path };
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

	/**
	 * A mutating call's route, resolved ONCE.
	 *
	 * A mount point is an entry of THIS plane, so mutating it is EPERM — and that
	 * refusal outranks an absent mount, because the path names something no tree
	 * behind the table owns either way. The reject used to be its own pass over
	 * the path, so every write, unlink and mkdir parsed its argument twice and
	 * two readers had to agree about which answer came first.
	 */
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

	return {
		readFile(path, opts) {
			return delegate(path, (files, native) => files.readFile(native, opts));
		},
		writeFile(path, data) {
			return mutate(path, 'written', (files, native) => files.writeFile(native, data));
		},
		writeFileIfRevision(path, data, expectedRevision) {
			return mutate(path, 'written', (files, native) => {
				const conditional = files.writeFileIfRevision;
				if (!conditional) {
					throw makeVfsError(
						'ENOTSUP',
						'this file plane does not support revision-checked writes',
						path,
					);
				}
				return conditional.call(files, native, data, expectedRevision);
			});
		},
		readdir(path) {
			return delegate(path, async (files, native) => {
				const entries = await files.readdir(native);
				// Only the true root carries the mount points themselves, and only
				// LIVE ones: they are entries of THIS plane, not of any one tree
				// behind it, and an absent mount is no entry at all.
				if (path !== '/') return entries;
				const mounted = [...byName.values()].filter((m) => m.files() !== null).map((m) => m.name);
				return [...new Set([...entries, ...mounted])];
			});
		},
		async stat(path) {
			const routed = routeOf(path);
			if (!('mount' in routed)) return base.stat(path);
			const files = routed.mount.files();
			// An absent mount names nothing: null, the VFS contract for absent,
			// rather than an error that would fail a mere existence probe.
			if (!files) return null;
			// The mount point itself is a directory of this plane by construction.
			// Some trees cannot stat their own root (the container derives stat
			// from the parent listing, and '/' has no parent entry), which typed
			// /sandbox as a file in the root listing.
			if (routed.native === '/') return MOUNT_POINT_STAT;
			return files.stat(routed.native);
		},
		unlink(path) {
			return mutate(path, 'unlinked', (files, native) => files.unlink(native));
		},
		mkdir(path, opts) {
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
			return mutate(path, 'removed', (files, native) => {
				const remove = nativeOps(files).removeRecursive;
				return remove ? remove.call(files, native) : removeTreeWithVfsOps(files, native);
			});
		},
		// Routed, for the reason the mutations are: the workspace tree and a
		// mounted machine answer differently, and no caller should have to know
		// which plane a path landed on.
		//
		// The plane's own operation or a stated refusal, never a whole-file read
		// behind a range's name: a plane with no ranged read cannot serve ANY
		// window without fetching the file to slice it, which is the cost a range
		// exists to avoid. `readBoundedWithVfsOps` is the one place allowed to
		// whole-read, and only for a file its stat already proved fits.
		readRange(path, offset, length) {
			return delegate(path, (files, native) => {
				const range = nativeOps(files).readRange;
				if (!range) throw makeVfsError('EPERM', 'this plane serves no ranged read', path);
				return range.call(files, native, offset, length);
			});
		},
		readdirStats(path) {
			return delegate(path, async (files, native) => {
				const listed = await listWithVfsOps(files, native);
				// The rule `readdir` above states, once: only the true root carries
				// the mount points themselves, and only the live ones.
				if (path !== '/') return listed;
				const named = new Set(listed.map((entry) => entry.name));
				return [
					...listed,
					...[...byName.values()]
						.filter((mount) => mount.files() !== null && !named.has(mount.name))
						.map((mount) => ({ name: mount.name, stat: MOUNT_POINT_STAT })),
				];
			});
		},
	};
}

/** A mount point is a directory of the composite plane by construction — the
 *  same answer `stat` gives it above, for the same reason: some trees cannot
 *  stat their own root. */
const MOUNT_POINT_STAT: VfsEntryStat = { size: 0, mtimeMs: 0, isDir: true };
