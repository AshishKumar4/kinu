import { type Awaitable, type VFS, type VfsCred, type VfsRemoval, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Workspace plane mount table: the durable workspace tree extended by `/pc` (device tunnel) and `/sandbox`
 * (container), each read through that executor's own `files` VFS so its boundaries still apply.
 */


import type { CheckpointFiles } from '../types/primitives';
import { Effect } from 'effect';
import type { FilesOwner } from '../safety/command-review';
import type { ExecutorStatus } from '../execution/types';
import { KinuError, renderThrownChain, settle, settleSync } from '../obs/index';
import { isVfsError, syscallError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { CompositeVFS, normalizePath, type MountRoute, type Principal } from '@nimbus-sh/core/vfs/composite.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { observeNamespace, type WriteObserver } from './write-events';
import { move, type MoveFs } from '@nimbus-sh/core/vfs/move.js';
import { workspacePath } from './workspace-path';

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
	/** Its mount point where that is not `/<name>`: locally a view sits in the workspace's space. */
	readonly at?: string;
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

/** Read whole only when `size` fits `limit`; otherwise EPERM with a stated reason. */
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

/** Enumerate, then delete children before parents; the first failed unlink ends the pass. */
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
export function partialTreeRemovalMessage(path: string, removal: PartialRemoval): string {
	const gone = removal.removed.length === 0 ? 'none' : removal.removed.join(', ');
	const left = removal.remaining.join(', ');

	return `removing ${removal.failed.path} failed (${renderThrownChain({ cause: removal.failed.cause })}), `
		+ `so ${path} was only partly removed: gone [${gone}]; still present [${left}]`;
}

export type PartialRemoval = Omit<Extract<TreeRemoval, { ok: false }>, 'ok'>;

/** What a removal kept, walked or reported (Nimbus reports, never throws); null: all of it went. */
export function keptByRemoval(removal: TreeRemoval | VfsRemoval | void): PartialRemoval | null {
	if (removal === undefined || 'ok' in removal) return removal?.ok === false ? removal : null;
	const failed = removal.failures[0];

	return failed === undefined ? null : { removed: removal.removed, remaining: removal.kept, failed: { path: failed.path, cause: failed.error } };
}

function refuseKept(path: string, kept: PartialRemoval | null): void {
	if (kept !== null) throw new VfsError(isVfsError(kept.failed.cause) ? kept.failed.cause.code : 'EIO', partialTreeRemovalMessage(path, kept), path);
}

/** What the workspace shell reads to serve this table. */
export interface VfsMountRouting {
	mountOf(path: string): string | null;
	mountPoints(): readonly string[];
	/** Every mount, connected or not: each is a mount point on the workspace shell's namespace. */
	mounts(): readonly VfsMount[];
	/** The user's writable mount roots, connected or not. */
	userRoots(): readonly string[];
	/**
	 * `path` as the namespace's own lookup resolves it, links followed (the last one unless `follow` is false): the one
	 * path a gate decides on and the operation then reaches. A path whose directories are not there yet passes as named.
	 */
	resolve(path: string, options?: { follow?: boolean }): Promise<string>;
}

export type MountedVfs = VFS & Required<Pick<VFS, 'rename' | 'removeRecursive' | 'readRange'>> & VfsMountRouting & CheckpointFiles;

export interface WorkspacePrincipal {
	readonly cred?: Readonly<VfsCred>;
	readonly actor?: string;
}

export interface NamespaceBox {
	mountTable?(mounts: readonly VfsMount[], principal?: WorkspacePrincipal): () => void;
	namespace?(principal?: WorkspacePrincipal): Promise<CompositeVFS>;
}

/** The file tool's plane on the workspace's own namespace, whose `principal` view its shells share. */
export function workspaceFilePlane(box: NamespaceBox, input: {
	readonly mounts: readonly VfsMount[];
	readonly principal: WorkspacePrincipal;
	readonly home: string;
	readonly observer?: WriteObserver;
}): { readonly files: MountedVfs; readonly unmount: () => void } {
	return settleSync(Effect.gen(function* () {
		if (box.mountTable === undefined || box.namespace === undefined) {
			return yield* Effect.fail(new KinuError('unsupported', 'this workspace box has no namespace of its own, so the file tool cannot read what its shell reads'));
		}

		const { principal, observer } = input;
		const uid = (principal.cred ?? CRED_SESSION_USER).uid;
		const mine = (writer: Principal): boolean => writer.cred?.uid === uid && writer.actor === principal.actor;
		const unmount = box.mountTable(input.mounts, principal);

		let view: Promise<CompositeVFS> | undefined;
		let unobserve = (): void => {};

		const namespace = box.namespace.bind(box);

		const opened = (): Promise<CompositeVFS> => view ??= namespace(principal).then((ready) => {
			if (observer !== undefined) unobserve = observeNamespace(ready, observer, mine);

			return ready;
		});

		const files = withMountTable({ namespace: opened, home: input.home }, input.mounts);

		return { files, unmount: () => { unobserve(); unmount(); } };
	}));
}

function ownNamespace(base: VFS, mounts: readonly VfsMount[]): Pick<MountedNamespace, 'namespace'> {
	const own = new CompositeVFS(base, { resolvesPaths: true });

	mountOnto(own, checkedMounts(mounts));

	return { namespace: async () => own };
}

function mountOnto(composite: CompositeVFS, mounts: readonly VfsMount[]): void {
	for (const mount of mounts) {
		composite.mount(mount.at ?? `/${mount.name}`, () => mount.files(), {
			resolvesPaths: true, absentReason: () => mount.absentReason(), ...(mount.readOnly === true && { readOnly: true }),
		});
	}
}

function checkedMounts(mounts: readonly VfsMount[]): readonly VfsMount[] {
	const names = new Set<string>();

	for (const mount of mounts) {
		if (mount.name.length === 0 || mount.name === '.' || mount.name === '..' || mount.name.includes('/')) {
			throw new Error(`'${mount.name}' is not a usable VFS mount name`);
		}

		if (names.has(mount.name)) throw new Error(`duplicate VFS mount name '${mount.name}'`);
		names.add(mount.name);
	}

	return mounts;
}

/** A VFS `move` walks, whose links on an asynchronous mount are awaited (the composite's own realpath is synchronous). */
function movable(files: VFS): MoveFs {
	if (!(files instanceof CompositeVFS)) return files;

	return {
		readFile: files.readFile.bind(files),
		writeFile: files.writeFile.bind(files),
		readdir: files.readdir.bind(files),
		stat: files.stat.bind(files),
		unlink: files.unlink.bind(files),
		mkdir: files.mkdir.bind(files),
		rmdir: files.rmdir.bind(files),
		rename: files.rename.bind(files),
		readlink: files.readlink.bind(files),
		symlink: files.symlink.bind(files),
		chmod: files.chmod.bind(files),
		utimes: files.utimes.bind(files),
		realpath: (path) => files.realpathAsync(path),
	};
}

interface Landing {
	readonly files: VFS;
	readonly path: string;
	readonly resolved: string;
	readonly route: MountRoute | null;
}

/** A namespace holding a table's mounts already (the workspace's own), and where a relative path starts on it. */
export interface MountedNamespace {
	readonly namespace: () => Promise<CompositeVFS>;
	readonly home: string;
	/** A write makes its missing directories, as a host's file tool does. */
	readonly writesParents?: true;
}

/** `base` extended by `mounts`, a relative path staying in `base`; or a namespace already holding them. */
export function withMountTable(base: VFS | MountedNamespace, mounts: readonly VfsMount[]): MountedVfs {
	const plane = 'namespace' in base ? base : ownNamespace(base, mounts);
	const parents = 'namespace' in base && base.writesParents === true;
	const relative: VFS | { readonly home: string } = 'namespace' in base ? { home: base.home } : base;
	const byName = new Map(checkedMounts(mounts).map((mount) => [mount.name, mount]));

	const nameOf = (path: string): string | null => {
		if (!path.startsWith('/')) return null;
		const name = normalizePath(path).split('/')[1] ?? '';

		return byName.has(name) ? name : null;
	};

	/**
	 * Where `path` lands: the VFS that serves it and the path it takes, and, on the namespace, the path its links resolve
	 * to and that path's route, which every decision here reads, so a link cannot carry an op past the mount it reaches.
	 */
	const landing = async (path: string, follow = true): Promise<Landing> => {
		let absolute = path;

		if (!path.startsWith('/')) {
			if (!('home' in relative)) return { files: relative, path, resolved: path, route: null };
			absolute = workspacePath(path, relative.home);
		}

		const namespace = await plane.namespace();
		// Lexical, as the approval gate reads the path it decides on.
		const normal = normalizePath(absolute);
		const resolved = await namespace.resolvePath(normal, { follow, creating: true });

		return { files: namespace, path: normal, resolved, route: namespace.routeOf(resolved) };
	};

	const via = async <T>(path: string, op: (files: VFS, at: string) => Awaitable<T>, follow = true): Promise<T> => {
		const target = await landing(path, follow);

		return op(target.files, target.path);
	};

	/** The plane's optional operation as `ask` starts it, or ENOTSUP with `reason` where the plane has none. */
	const optional = <T>(path: string, reason: string, ask: (files: VFS, path: string, route: MountRoute | null) => Awaitable<T> | undefined, follow = true): Effect.Effect<T, VfsError> => Effect.gen(function* () {
		const target = yield* Effect.promise(async () => landing(path, follow));
		const answer = ask(target.files, target.path, target.route);

		return answer === undefined ? yield* Effect.fail(new VfsError('ENOTSUP', reason, path)) : yield* Effect.promise(async () => answer);
	});

	const userRoots = mounts.filter((m) => m.filesOwner === 'user' && m.readOnly !== true).map((m) => `/${m.name}`);

	const mounted = (route: MountRoute | null): (VFS & CheckpointFiles) | null => (route === null || route.point === '/' ? null : route.source);

	return {
		mountOf: nameOf,
		mountPoints: () => mounts.filter((m) => m.files() !== null).map((m) => m.name),
		mounts: () => [...mounts],
		userRoots: () => userRoots,
		stat: async (path, options) => {
			const target = await landing(path, options?.follow !== false);

			if (target.route !== null && target.route.source === null) {
				return settle(Effect.fail(new VfsError('ENXIO', target.route.absentReason ?? target.route.point, path)));
			}

			return target.files.stat(target.path, options);
		},
		readFile: (path) => via(path, (files, at) => files.readFile(at)),
		writeFile: (path, data) => via(path, (files, at) => (parents && files instanceof CompositeVFS ? files.writeFile(at, data, { parents: true }) : files.writeFile(at, data))),
		readdir: (path) => via(path, (files, at) => files.readdir(at)),
		mkdir: (path, options) => via(path, (files, at) => files.mkdir(at, options)),
		// The last link is the entry an unlink or a readlink is of, never where it points.
		unlink: (path) => via(path, (files, at) => files.unlink(at), false),
		async rename(from, to) {
			const [source, target] = await Promise.all([landing(from, false), landing(to, false)]);

			if (source.route === null && target.route === null) return move(source.files, source.path, target.path);

			// One tree whose backend moves nothing in place: the bytes move as `mv` moves them, by the namespace's own rules.
			if (source.route?.point === target.route?.point && source.route?.source !== null && source.route?.source.rename === undefined) {
				return move(movable(source.files), source.path, target.path);
			}

			return source.files.rename?.(source.path, target.path);
		},
		async removeRecursive(path) {
			const { files, path: at } = await landing(path, false);

			refuseKept(at, keptByRemoval(await (files.removeRecursive === undefined ? removeTreeWithVfsOps(files, at) : files.removeRecursive(at))));
		},
		resolve: async (path, options) => (await landing(path, options?.follow ?? true)).resolved,
		// A plane with no ranged read refuses rather than whole-reading; only `readBoundedWithVfsOps` may whole-read.
		// ENOTSUP, not EPERM: callers like the `file` scan fall back on this code.
		readRange: (path, offset, length) => settle(optional(path, 'this plane serves no ranged read', (files, at, route) => (
			mounted(route) !== null && mounted(route)?.readRange === undefined ? undefined : files.readRange?.(at, offset, length)
		))),
		readlink: (path) => settle(optional(path, 'this plane serves no readlink', (files, at) => files.readlink?.(at), false)),
		readFileAtRevision: (path, revision, range) => settle(optional(path, 'this file plane does not retain file revisions',
			(files, at) => files.readFileAtRevision?.(at, revision, range))),
		writeFileIfRevision: (path, data, expected) => settle(optional(path, 'this file plane does not support revision-checked writes',
			(files, at) => files.writeFileIfRevision?.(at, data, expected))),
		// A device's own write report.
		async writeFileWithReport(path, data) {
			const target = await landing(path);
			const own = mounted(target.route);

			if (own?.writeFileWithReport !== undefined && target.route !== null && target.route.path !== '/' && !target.route.readOnly) {
				return own.writeFileWithReport(target.route.path, data);
			}

			await target.files.writeFile(target.path, data);

			return null;
		},
	};
}
