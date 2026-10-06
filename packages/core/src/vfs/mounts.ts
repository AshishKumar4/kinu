import { type Awaitable, type VFS, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Workspace plane mount table: the durable workspace tree extended by `/pc` (device tunnel) and `/sandbox`
 * (container), each read through that executor's own `files` VFS so its boundaries still apply.
 * Mount points are absolute; relative paths stay in the workspace, so `pc/x` is a workspace file.
 */


import type { CheckpointFiles } from '../types/primitives';
import { Effect } from 'effect';
import type { FilesOwner } from '../safety/approval-gate';
import type { ExecutorStatus } from '../execution/types';
import { renderThrownChain, settle } from '../obs/index';
import { isVfsError, syscallError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { CompositeVFS, normalizePath } from '@nimbus-sh/core/vfs/composite.js';
import { move } from '@nimbus-sh/core/vfs/move.js';

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

export const MOUNT_EXECUTORS: Record<string, string> = Object.fromEntries(
	Object.entries(EXECUTOR_MOUNTS).map(([executor, mount]) => [mount, executor]),
);

/** Structurally `ExecutionRouter.getProvider`'s answer, without importing the router. */
export interface MountableProvider {
	files?: VFS;
	isAvailable(): boolean;
	getStatus?: () => Pick<ExecutorStatus, 'status' | 'label'>;
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
			absentReason: () => {
				const status = provider('device')?.getStatus?.();

				return status?.status === 'disconnected' && status.label !== undefined ? `"${status.label}" is offline` : 'no device connected';
			},
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

/** `stat` is null for an entry that vanished between the listing and its metadata. */
export interface VfsListedEntry {
	readonly name: string;
	readonly stat: VfsStat | null;
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
	const native = files.readRange?.bind(files);

	if (native) return native.call(files, path, 0, limit);

	if (size === null || size > limit) {
		throw new VfsError('EPERM',
			`this file plane has no ranged read, so ${size === null ? 'a file of unknown size' : `${String(size)} bytes`}`
			+ ` cannot be previewed within ${String(limit)}: download it instead`,
			path,);
	}

	return files.readFile(path);
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
export async function listWithVfsOps(files: VFS, dir: string): Promise<VfsListedEntry[]> {
	const entries = await files.readdir(dir);

	return Promise.all(entries.map(async (entry) => {
		const child = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;

		try {
			return { name: entry.name, stat: entry.stat ?? await files.stat(child) };
		} catch (cause) {
			// The plane's own code, never prose matching.
			if (isVfsError(cause) && cause.code === 'ENOENT') return { name: entry.name, stat: null };
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

	if (!st) throw syscallError('ENOENT', 'rm', path);

	const pending: string[] = [path];
	const order: string[] = [];

	while (pending.length > 0) {
		const current = pending.pop();

		if (current === undefined) break;
		const currentStat = current === path ? st : await files.stat(current);

		if (currentStat === null) continue;

		order.push(current);

		if ((currentStat.type === 'directory')) {
			for (const entry of await files.readdir(current)) {
				pending.push(current === '/' ? `/${entry.name}` : `${current}/${entry.name}`);
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
 * `base` extended by `mounts`, composed by Nimbus (m1960): each mount resolves its own paths, so a read under one is
 * one backend call with no walk of its ancestors. A relative path stays in `base`, so `pc/x` is a workspace file.
 */
export function withMountTable(base: VFS, mounts: readonly VfsMount[]): MountedVfs {
	const byName = new Map<string, VfsMount>();

	for (const mount of mounts) {
		if (mount.name.length === 0 || mount.name === '.' || mount.name === '..' || mount.name.includes('/')) {
			throw new Error(`'${mount.name}' is not a usable VFS mount name`);
		}

		if (byName.has(mount.name)) throw new Error(`duplicate VFS mount name '${mount.name}'`);
		byName.set(mount.name, mount);
	}

	// The workspace's own tree resolves its own paths too, as it did before it was composed: one call, no walk.
	const composite = new CompositeVFS(base, { resolvesPaths: true });

	for (const mount of mounts) {
		composite.mount(`/${mount.name}`, () => mount.files(), {
			resolvesPaths: true, absentReason: () => mount.absentReason(), ...(mount.readOnly === true && { readOnly: true }),
		});
	}

	/** The mount `path` lands on after lexical `..`, with the path its backend is asked for. */
	const routeOf = (path: string): { mount: VfsMount; native: string } | null => {
		if (!path.startsWith('/')) return null;
		const absolute = normalizePath(path);
		const mount = byName.get(absolute.split('/')[1] ?? '');

		return mount === undefined ? null : { mount, native: absolute.slice(mount.name.length + 1) || '/' };
	};

	const on = (path: string): VFS => (path.startsWith('/') ? composite : base);

	/** The plane's optional operation as `ask` starts it, or ENOTSUP with `reason` where the plane has none. */
	const optional = <T>(path: string, reason: string, ask: (plane: VFS) => Awaitable<T> | undefined): Effect.Effect<T, VfsError> => Effect.suspend(() => {
		const answer = ask(on(path));

		return answer === undefined ? Effect.fail(new VfsError('ENOTSUP', reason, path)) : Effect.promise(async () => answer);
	});

	const userRoots = mounts.filter((m) => m.filesOwner === 'user' && m.readOnly !== true).map((m) => `/${m.name}`);

	return {
		mountOf: (path) => routeOf(path)?.mount.name ?? null,
		mountPoints: () => mounts.filter((m) => m.files() !== null).map((m) => m.name),
		mounts: () => [...mounts],
		userRoots: () => userRoots,
		// Nimbus answers null for a path on an absent mount; this plane states the absence, as a read does.
		stat: (path, options) => {
			const routed = routeOf(path);

			if (routed !== null && routed.mount.files() === null) {
				return settle(Effect.fail(new VfsError('ENXIO', `/${routed.mount.name}: ${routed.mount.absentReason()}`, path)));
			}

			return on(path).stat(path, options);
		},
		readFile: (path) => on(path).readFile(path),
		writeFile: (path, data) => on(path).writeFile(path, data),
		readdir: (path) => on(path).readdir(path),
		mkdir: (path, options) => on(path).mkdir(path, options),
		unlink: (path) => on(path).unlink(path),
		async rename(from, to) {
			const [source, target] = [routeOf(from), routeOf(to)];

			if (source === null && target === null) return move(base, from, to);
			const files = source?.mount.files() ?? null;

			// Within one mounted tree without its own rename, the bytes move as `mv` moves them; across mounts Nimbus answers EXDEV.
			if (source !== null && target?.mount === source.mount && files !== null && files.rename === undefined
				&& source.native !== '/' && target.native !== '/' && source.mount.readOnly !== true) {
				return move(files, source.native, target.native);
			}

			return composite.rename(from, to);
		},
		async removeRecursive(path) {
			const routed = routeOf(path);
			const files = routed?.mount.files() ?? null;

			// A mounted tree without its own removal is removed entry by entry, its partial record on the error.
			if (routed === null || files === null || files.removeRecursive !== undefined || routed.native === '/' || routed.mount.readOnly === true) {
				await on(path).removeRecursive?.(path);

				return;
			}

			const removal = await removeTreeWithVfsOps(files, routed.native);

			if (!removal.ok) {
				throw new VfsError(isVfsError(removal.failed.cause) ? removal.failed.cause.code : 'EIO', partialTreeRemovalMessage(routed.native, removal), routed.native);
			}
		},
		// A plane with no ranged read refuses rather than whole-reading; only `readBoundedWithVfsOps` may whole-read.
		readRange: (path, offset, length) => settle(optional(path, 'this plane serves no ranged read', (plane) => {
			const files = routeOf(path)?.mount.files() ?? null;

			// ENOTSUP, not EPERM: callers like the `file` scan fall back on this code.
			return files !== null && files.readRange === undefined ? undefined : plane.readRange?.(path, offset, length);
		})),
		readlink: (path) => settle(optional(path, 'this plane serves no readlink', (plane) => plane.readlink?.(path))),
		readFileAtRevision: (path, revision, range) => settle(optional(path, 'this file plane does not retain file revisions',
			(plane) => plane.readFileAtRevision?.(path, revision, range))),
		writeFileIfRevision: (path, data, expected) => settle(optional(path, 'this file plane does not support revision-checked writes',
			(plane) => plane.writeFileIfRevision?.(path, data, expected))),
		// Nimbus's writeFile answers nothing; until it can (NIMBUS-ASKS #23) a device's write report is asked of it directly.
		async writeFileWithReport(path, data) {
			const routed = routeOf(path);
			const files: (VFS & CheckpointFiles) | null = routed?.mount.files() ?? null;

			if (routed !== null && files?.writeFileWithReport !== undefined && routed.native !== '/' && routed.mount.readOnly !== true) {
				return files.writeFileWithReport(routed.native, data);
			}

			await on(path).writeFile(path, data);

			return null;
		},
	};
}
