import { type Awaitable, type VFS, type VfsCred, type VfsRemoval, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Workspace plane mount table: the durable workspace tree extended by `/pc` (device tunnel) and `/sandbox`
 * (container), each read through that executor's own `files` VFS so its boundaries still apply. Nimbus's
 * CompositeVFS does the namespace (lookup, links, read-only, parents, EXDEV, recursive removal); this file holds
 * Kinu's policy over it: the declarations, whose principal's view a plane is, the move rule and bounded views.
 */


import type { CheckpointFiles } from '../types/primitives';
import { Cause, Effect, Exit, Result } from 'effect';
import type { FilesOwner } from '../safety/command-review';
import type { ExecutorStatus } from '../execution/types';
import { attempt, hold, KinuError, renderThrownChain, settle, settleSync, tolerateAsync } from '../obs/index';
import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { CompositeVFS, normalizePath, type Principal, type VfsRoute } from '@nimbus-sh/core/vfs/composite.js';
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
			absentReason: () => 'this workspace has no computer bound',
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

/** What a recursive removal left: what went, what stayed, and the first failure. */
export interface PartialRemoval {
	readonly removed: readonly string[];
	readonly remaining: readonly string[];
	readonly failed: { readonly path: string; readonly cause: unknown };
}

/** `files` named from `/`, each call handed back the relative spelling a bare base keeps as its own. */
function relativeSpelling(files: VFS): VFS {
	const own = (path: string): string => path.slice(1);

	return {
		readFile: (path) => files.readFile(own(path)),
		writeFile: (path, data) => files.writeFile(own(path), data),
		readdir: (path) => files.readdir(own(path)),
		stat: (path, options) => files.stat(own(path), options),
		unlink: (path) => files.unlink(own(path)),
		mkdir: (path, options) => files.mkdir(own(path), options),
		...(files.rmdir !== undefined && { rmdir: (path: string) => files.rmdir?.(own(path)) }),
	};
}

/** Removes `path` and what is under it by the plane's own removal, or Nimbus's walk where it has none; null: all of it went. */
export async function removeTree(files: VFS, path: string): Promise<PartialRemoval | null> {
	if (files.removeRecursive !== undefined) return partial(await files.removeRecursive(path), (at) => at);
	const relative = path[0] !== '/';
	const walked = new CompositeVFS(relative ? relativeSpelling(files) : files, { resolvesPaths: true });

	return partial(await walked.removeRecursive(relative ? `/${path}` : path), (at) => (relative ? at.slice(1) : at));
}

function partial(removal: VfsRemoval | void, spelled: (path: string) => string): PartialRemoval | null {
	const failed = removal?.failures[0];

	if (removal === undefined || failed === undefined) return null;

	return { removed: removal.removed.map(spelled), remaining: removal.kept.map(spelled), failed: { path: spelled(failed.path), cause: failed.error } };
}

/** Shared by the composite plane's throw and the file manager's error value. */
export function partialTreeRemovalMessage(path: string, removal: PartialRemoval): string {
	const gone = removal.removed.length === 0 ? 'none' : removal.removed.join(', ');
	const left = removal.remaining.join(', ');

	return `removing ${removal.failed.path} failed (${renderThrownChain({ cause: removal.failed.cause })}), `
		+ `so ${path} was only partly removed: gone [${gone}]; still present [${left}]`;
}

/** What the workspace shell reads to serve this table. */
interface VfsMountRouting {
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
		// The store reports every commit as its writer, a shell's and its installs' too; an observed file tool writes as an
		// actor of its own, under the same mounts, so what it hears is its own writes.
		const writer: WorkspacePrincipal = observer === undefined ? principal : { ...principal, actor: `${principal.actor ?? ''}#files` };
		const mine = (made: Principal): boolean => made.cred?.uid === uid && made.actor === writer.actor;
		const unmountShell = box.mountTable(input.mounts, principal);
		const unmountWriter = writer === principal ? () => {} : box.mountTable(input.mounts, writer);

		let view: Promise<CompositeVFS> | undefined;
		let unobserve = (): void => {};

		const namespace = box.namespace.bind(box);

		const opened = (): Promise<CompositeVFS> => view ??= namespace(writer).then((ready) => {
			if (observer !== undefined) unobserve = observeNamespace(ready, observer, mine);

			return ready;
		});

		// The workspace's own files made a write's missing directories; its namespace does so as the principal.
		const files = withMountTable({ namespace: opened, home: input.home, writesParents: true, ...(observer !== undefined && { observer }) }, input.mounts);

		return { files, unmount: () => { unobserve(); unmountWriter(); unmountShell(); } };
	}));
}

function ownNamespace(base: VFS, mounts: readonly VfsMount[]): Pick<MountedNamespace, 'namespace'> {
	const own = new CompositeVFS(base, { resolvesPaths: true });

	mountOnto(own, mounts);

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
function movable(files: CompositeVFS): MoveFs {
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

/**
 * Where an operation on `at` lands, the directories a write would make passing as named: Nimbus's lookup for
 * writeFile({ parents }), links and `..` included (`creating`, patched in until NIMBUS-ASKS #32 ships).
 */
function routeCreating(namespace: CompositeVFS, at: string, follow: boolean): Promise<VfsRoute> {
	return namespace.route(at, { follow, creating: true });
}

/** Whether `from` and `to` are on one mount, the directories a move would make passing as named. */
async function sameMount(namespace: CompositeVFS, from: string, to: string): Promise<boolean> {
	const [left, right] = await Promise.all([routeCreating(namespace, from, false), routeCreating(namespace, to, false)]);

	return left.point === right.point;
}

/** A route's path in the namespace. */
function namespacePath(route: VfsRoute): string {
	if (route.point === '/') return route.path;

	return route.path === '/' ? route.point : `${route.point}${route.path}`;
}

/** A namespace holding a table's mounts already (the workspace's own), and where a relative path starts on it. */
export interface MountedNamespace {
	readonly namespace: () => Promise<CompositeVFS>;
	readonly home: string;
	/** A write makes its missing directories, as a host's file tool does. */
	readonly writesParents?: true;
	/** Hears a write a routed extra makes on a source that reports none itself; the namespace reports its own. */
	readonly observer?: WriteObserver;
}

/** Where a call lands: the namespace and its absolute path there, or a bare base's own relative path. */
type Target =
	| { readonly namespace: CompositeVFS; readonly files: VFS; readonly at: string }
	| { readonly namespace: null; readonly files: VFS; readonly at: string };

/** `base` extended by `mounts`, a relative path staying in `base`; or a namespace already holding them. */
export function withMountTable(base: VFS | MountedNamespace, mounts: readonly VfsMount[]): MountedVfs {
	const declared = checkedMounts(mounts);
	const plane = 'namespace' in base ? base : ownNamespace(base, declared);
	const parents = 'namespace' in base && base.writesParents === true;
	const relative: VFS | { readonly home: string } = 'namespace' in base ? { home: base.home } : base;
	const userRoots = declared.filter((m) => m.filesOwner === 'user' && m.readOnly !== true).map((m) => m.at ?? `/${m.name}`);

	const on = async (path: string): Promise<Target> => {
		if (path.startsWith('/') || 'home' in relative) {
			const namespace = await plane.namespace();

			return { namespace, files: namespace, at: normalizePath('home' in relative ? workspacePath(path, relative.home) : path) };
		}

		return { namespace: null, files: relative, at: path };
	};

	const write = (target: Target, data: Uint8Array) => (parents && target.namespace !== null
		? target.namespace.writeFile(target.at, data, { parents: true })
		: target.files.writeFile(target.at, data));

	const observer = 'namespace' in base ? base.observer : undefined;

	/**
	 * A routed extra's write of `data` to `at`, landed on `landing.source` at `landing.rel`; told to the plane's observer,
	 * since that source reports none. `landed` says whether a conditional write was made.
	 */
	const heard = <T>(
		landing: { readonly source: VFS; readonly rel: string; readonly at: string }, data: Uint8Array, writing: () => Promise<T>,
		landed: (result: T) => boolean = () => true,
	): Effect.Effect<T> => Effect.gen(function* () {
		if (observer === undefined || landing.source.observeWrites !== undefined) return yield* Effect.promise(writing);

		const baseline = observer.needsBaseline(landing.at)
			? yield* Effect.result(attempt({ doing: `reading ${landing.at} before a write`, otherwise: 'io' },
				async () => tolerateAsync(() => Promise.resolve(landing.source.readFile(landing.rel)), 'enoent')))
			: null;

		const result = yield* Effect.promise(writing);

		if (!landed(result)) return result;

		if (baseline === null) observer.record({ path: landing.at, after: data });
		else if (Result.isSuccess(baseline)) observer.record({ path: landing.at, before: baseline.success ?? null, after: data });
		else observer.record({ path: landing.at, unread: 'unreadable', after: data });

		return result;
	});

	const via = async <T>(path: string, op: (files: VFS, at: string) => Awaitable<T>): Promise<T> => {
		const { files, at } = await on(path);

		return op(files, at);
	};

	/** ENOTSUP with `reason`: a bare base without the optional operation (the namespace answers its own). */
	const unsupported = (path: string, reason: string): Effect.Effect<never, VfsError> => Effect.fail(new VfsError('ENOTSUP', reason, path));

	return {
		mounts: () => [...mounts],
		userRoots: () => userRoots,
		async stat(path, options) {
			const target = await on(path);
			const stat = await target.files.stat(target.at, options);

			if (stat !== null || target.namespace === null) return stat;
			const { namespace } = target;
			// Nimbus answers a path on an absent mount as nothing there; Kinu refuses it with the mount's reason.
			const route = await tolerateAsync(() => namespace.route(target.at, { follow: options?.follow !== false }), 'enoent');

			if (route?.source === null) return settle(Effect.fail(new VfsError('ENXIO', route.absentReason ?? route.point, path)));

			return null;
		},
		readFile: (path) => via(path, (files, at) => files.readFile(at)),
		writeFile: async (path, data) => write(await on(path), data),
		readdir: (path) => via(path, (files, at) => files.readdir(at)),
		mkdir: (path, options) => via(path, (files, at) => files.mkdir(at, options)),
		unlink: (path) => via(path, (files, at) => files.unlink(at)),
		async rename(from, to) {
			const [source, target] = await Promise.all([on(from), on(to)]);

			if (source.namespace === null || target.namespace === null) return move(source.files, source.at, target.at);
			const { namespace } = source;
			const renamed = await hold(Effect.promise(() => namespace.rename(source.at, target.at)));

			if (Exit.isSuccess(renamed)) return;

			// Kinu's move rule: within one mount, mv's move (Nimbus's carry where the backend cannot rename in place); across
			// mounts EXDEV stands, so nothing crosses into or out of /pc or /sandbox as a side effect.
			if (!isVfsError(Cause.squash(renamed.cause), 'EXDEV') || !await sameMount(namespace, source.at, target.at)) {
				return settle(Effect.failCause(renamed.cause));
			}

			return move(movable(namespace), source.at, target.at);
		},
		async removeRecursive(path) {
			const { files, at } = await on(path);
			const kept = await removeTree(files, at);

			if (kept !== null) throw new VfsError(isVfsError(kept.failed.cause) ? kept.failed.cause.code : 'EIO', partialTreeRemovalMessage(at, kept), at);
		},
		async resolve(path, options) {
			const target = await on(path);

			return target.namespace === null ? target.at : namespacePath(await routeCreating(target.namespace, target.at, options?.follow ?? true));
		},
		// ENOTSUP, not EPERM: callers like the `file` scan fall back on this code; only `readBoundedWithVfsOps` may whole-read.
		async readRange(path, offset, length) {
			const answer = await via(path, (files, at) => files.readRange?.(at, offset, length));

			if (answer !== undefined) return answer;

			return settle(unsupported(path, 'this plane serves no ranged read'));
		},
		async readlink(path) {
			const answer = await via(path, (files, at) => files.readlink?.(at));

			if (answer !== undefined) return answer;

			return settle(unsupported(path, 'this plane serves no readlink'));
		},
		async readFileAtRevision(path, revision, range) {
			const answer = await via(path, (files, at) => files.readFileAtRevision?.(at, revision, range));

			if (answer !== undefined) return answer;

			return settle(unsupported(path, 'this file plane does not retain file revisions'));
		},
		async writeFileIfRevision(path, data, expected) {
			const answer = await via(path, (files, at) => files.writeFileIfRevision?.(at, data, expected));

			if (answer !== undefined) return answer;

			return settle(unsupported(path, 'this file plane does not support revision-checked writes'));
		},
		// A device's own write report, from the backend the write lands on; elsewhere the namespace writes and reports nothing.
		async writeFileWithReport(path, data) {
			const target = await on(path);
			const route = target.namespace === null ? null : await routeCreating(target.namespace, target.at, true);
			const own: (VFS & CheckpointFiles) | null = route === null || route.point === '/' || route.path === '/' ? null : route.source;
			const readOnly = target.namespace?.mounts().find((mount) => mount.point === route?.point)?.options.readOnly === true;

			if (own?.writeFileWithReport !== undefined && route !== null && !readOnly) {
				const report = own.writeFileWithReport.bind(own);

				return settle(heard({ source: own, rel: route.path, at: target.at }, data, () => report(route.path, data)));
			}

			await write(target, data);

			return null;
		},
		// The plane the path lands on compares and replaces in its own process; a plane that versions its files
		// answers revision-checked writes instead. Heard as any routed write is, when it landed.
		async writeFileIfDigest(path, data, expected) {
			const target = await on(path);
			const route = target.namespace === null ? null : await routeCreating(target.namespace, target.at, true);
			// The root's own source too: the CLI's folder plane compares there (its host adapter); a store that cannot answers ENOTSUP.
			const own: (VFS & CheckpointFiles) | null = route === null || route.path === '/' ? null : route.source;
			const readOnly = target.namespace?.mounts().find((mount) => mount.point === route?.point)?.options.readOnly === true;
			const replace = own?.writeFileIfDigest?.bind(own);

			if (readOnly) return settle(Effect.fail(new VfsError('EROFS', 'read-only file system', path)));

			if (own === null || route === null || replace === undefined) {
				return settle(Effect.fail(new VfsError('ENOTSUP', 'this file plane does not support digest-checked writes', path)));
			}

			return settle(heard({ source: own, rel: route.path, at: target.at }, data, () => replace(route.path, data, expected), (answer) => answer.ok));
		},
	};
}
