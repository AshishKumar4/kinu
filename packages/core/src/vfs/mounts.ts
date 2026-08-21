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

import type { VFS } from '../types/primitives';
import { makeVfsError } from './errno';

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
			name: 'pc',
			files: () => {
				const laptop = provider('laptop');
				return laptop && laptop.isAvailable() ? laptop.files ?? null : null;
			},
			absentReason: () => 'no device connected',
		},
		{
			name: 'sandbox',
			files: () => provider('sandbox')?.files ?? null,
			absentReason: () => 'no Sandbox container bound',
		},
	];
}

function absentError(mount: VfsMount, path: string): Error {
	return makeVfsError('ENXIO', `/${mount.name} — ${mount.absentReason()}`, path);
}

/**
 * `base`, extended by `mounts`. Base routes pass through untouched — relative
 * paths, absolute paths, everything the workspace owns. A mount route
 * delegates with the mount prefix stripped (`/pc/home/me.txt` reads the
 * machine's `/home/me.txt`), and an absent mount refuses every reading or
 * mutating call with ENXIO carrying the stated absence, answers `exists`
 * false and `stat` null.
 */
export function withMountTable(base: VFS, mounts: readonly VfsMount[]): VFS {
	const byName = new Map(mounts.map((m) => [m.name, m]));

	/** Split a path into its mount route (`/pc/a/b` → pc, `/a/b`) or a base
	 *  route. Only a whole first segment matches, so `/pcs/x` stays base. */
	const routeOf = (path: string): { mount: VfsMount; native: string } | { base: string } => {
		if (!path.startsWith('/')) return { base: path };
		const slash = path.indexOf('/', 1);
		const head = slash === -1 ? path.slice(1) : path.slice(1, slash);
		const mount = byName.get(head);
		if (!mount) return { base: path };
		return { mount, native: slash === -1 ? '/' : path.slice(slash) };
	};

	const delegate = async <T>(path: string, op: (files: VFS, native: string) => Promise<T>): Promise<T> => {
		const routed = routeOf(path);
		if (!('mount' in routed)) return op(base, path);
		const files = routed.mount.files();
		if (!files) throw absentError(routed.mount, path);
		return op(files, routed.native);
	};

	return {
		readFile(path, opts) {
			return delegate(path, (files, native) => files.readFile(native, opts));
		},
		writeFile(path, data) {
			return delegate(path, (files, native) => files.writeFile(native, data));
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
			return files ? files.stat(routed.native) : null;
		},
		unlink(path) {
			return delegate(path, (files, native) => files.unlink(native));
		},
		mkdir(path, opts) {
			return delegate(path, (files, native) => files.mkdir(native, opts));
		},
		async exists(path) {
			const routed = routeOf(path);
			if (!('mount' in routed)) return base.exists(path);
			const files = routed.mount.files();
			return files ? files.exists(routed.native) : false;
		},
	};
}
