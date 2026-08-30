// The workspace plane's mount table: /pc and /sandbox extend the one view.
//
// Red-first for the owner's ruling (#36/#142/#143): the device and the
// container appear as mounts of the workspace filesystem, reached through the
// same plane the `file` tool and `workspace.*` address — with an absent mount
// stated as an absence, and every boundary the owning executor enforces
// (device consent) still enforced on the mounted path.
import { describe, expect, test } from 'bun:test';
import type { VFS } from '../src/types/primitives';
import { walkRecursive } from '@kinu.run/agent-utils/vfs';
import { isVfsError } from '../src/vfs/errno';
import { EXECUTOR_MOUNTS, removeTreeWithVfsOps, standardMounts, withMountTable, type VfsMount } from '../src/vfs/mounts';
import { deviceFiles, type DeviceTransport } from '../src/execution/device-tunnel-executor';

/** A map-backed tree with honest directory semantics: readdir returns entry
 *  NAMES, stat distinguishes dirs, so walkRecursive crosses it for real. */
function fakeTree(entries: Record<string, string>): VFS {
	const files = new Map<string, string>(Object.entries(entries));
	const dirs = new Set<string>();
	for (const path of files.keys()) {
		for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
			dirs.add(path.slice(0, at));
		}
	}
	return {
		readFile: async (path) => {
			const content = files.get(path);
			if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
			return content;
		},
		writeFile: async (path, data) => { files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data); },
		readdir: async (path) => {
			if (path !== '/' && !dirs.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
			const names = new Set<string>();
			const prefix = path === '/' ? '/' : `${path}/`;
			for (const key of [...files.keys(), ...dirs]) {
				if (!key.startsWith(prefix)) continue;
				names.add(key.slice(prefix.length).split('/')[0]);
			}
			return [...names];
		},
		stat: async (path) => {
			if (files.has(path)) return { size: files.get(path)!.length, mtimeMs: 0, isDir: false };
			return dirs.has(path) ? { size: 0, mtimeMs: 0, isDir: true } : null;
		},
		unlink: async (path) => { files.delete(path); dirs.delete(path); },
		mkdir: async (path) => { dirs.add(path); },
		exists: async (path) => files.has(path) || dirs.has(path),
	};
}

function mountOf(name: string, files: VFS | null, reason = 'not live'): VfsMount {
	return { name, files: () => files, absentReason: () => reason };
}

describe('the workspace plane mount table', () => {
	test('a walk across /pc returns the device entries', async () => {
		const device = fakeTree({
			'/home/dev/report.txt': 'from the machine',
			'/home/dev/src/app.ts': 'export {};',
		});
		const mounted = withMountTable(fakeTree({ 'notes.md': 'workspace' }), [mountOf('pc', device)]);

		const walk = await walkRecursive(mounted, '/pc', 10, 100);
		expect(walk.truncated).toBe(false);
		expect(walk.entries.map((e) => e.path).sort()).toEqual(['/pc/home', '/pc/home/dev', '/pc/home/dev/report.txt', '/pc/home/dev/src', '/pc/home/dev/src/app.ts']);
		const report = walk.entries.find((e) => e.path === '/pc/home/dev/report.txt')?.stat;
		expect(report && 'isDir' in report ? report.isDir : null).toBe(false);
	});

	test('a walk across /sandbox returns the container entries', async () => {
		const container = fakeTree({ '/workspace/build.log': 'ok' });
		const mounted = withMountTable(fakeTree({}), [mountOf('sandbox', container)]);

		const walk = await walkRecursive(mounted, '/sandbox', 10, 100);
		expect(walk.entries.map((e) => e.path).sort()).toEqual(['/sandbox/workspace', '/sandbox/workspace/build.log']);
	});

	test('reads and writes under a live mount cross to the owning machine', async () => {
		const device = fakeTree({ '/home/dev/notes.txt': 'native bytes' });
		const base = fakeTree({});
		const mounted = withMountTable(base, [mountOf('pc', device)]);

		expect(await mounted.readFile('/pc/home/dev/notes.txt', { encoding: 'utf8' })).toBe('native bytes');
		await mounted.writeFile('/pc/home/dev/out.txt', 'written through the plane');
		expect(await device.readFile('/home/dev/out.txt', { encoding: 'utf8' })).toBe('written through the plane');
	});

	test('routes mkdir, stat, exists, unlink, and revision writes through a live mount', async () => {
		const backing = fakeTree({ '/home/dev/remove.txt': 'remove me' });
		const revisionWrites: Array<[string, number]> = [];
		const device: VFS = {
			...backing,
			writeFileIfRevision: async (path, data, expectedRevision) => {
				revisionWrites.push([path, expectedRevision]);
				await backing.writeFile(path, data);
				return { ok: true, revision: expectedRevision + 1 };
			},
		};
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.mkdir('/pc/home/dev/build', { recursive: true });
		expect(await mounted.stat('/pc/home/dev/build')).toMatchObject({ isDir: true });
		await mounted.writeFile('/pc/home/dev/build/output.txt', 'built');
		expect(await mounted.exists('/pc/home/dev/build/output.txt')).toBe(true);

		const conditional = mounted.writeFileIfRevision;
		if (conditional === undefined) throw new Error('the mounted VFS must expose conditional writes');
		expect(await conditional(
			'/pc/home/dev/build/revision.txt',
			new TextEncoder().encode('revisioned'),
			4,
		)).toEqual({ ok: true, revision: 5 });
		expect(revisionWrites).toEqual([['/home/dev/build/revision.txt', 4]]);

		await mounted.unlink('/pc/home/dev/remove.txt');
		expect(await mounted.exists('/pc/home/dev/remove.txt')).toBe(false);
	});

	test('an absent mount states its absence instead of serving an empty tree', async () => {
		const mounted = withMountTable(fakeTree({ 'notes.md': 'workspace' }), [
			mountOf('pc', null, 'no device connected'),
		]);

		const refused: Array<Promise<unknown>> = [
			mounted.readdir('/pc'),
			mounted.readFile('/pc/x'),
			mounted.writeFile('/pc/x', 'data'),
			mounted.unlink('/pc/x'),
			mounted.mkdir('/pc/x'),
		];
		for (const attempt of refused) {
			let error: unknown;
			try { await attempt; } catch (caught) { error = caught; }
			if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);
			expect(error.code).toBe('ENXIO');
			expect(error.message).toContain('/pc — no device connected');
		}
		const conditional = mounted.writeFileIfRevision;
		if (conditional === undefined) throw new Error('the mounted VFS must expose conditional writes');
		await expect(conditional('/pc/x', new Uint8Array(), 1)).rejects.toMatchObject({ code: 'ENXIO' });

		// Existence probes answer honestly rather than throwing.
		expect(await mounted.stat('/pc')).toBeNull();
		expect(await mounted.exists('/pc/x')).toBe(false);
	});

	test('device consent and revocation still govern reads under /pc', async () => {
		const machine = {
			'/home/dev/notes.txt': 'consented',
			'/etc/secrets.key': 'outside',
		};
		let fullFilesystem = false;
		const transport: DeviceTransport = {
			status: () => ({ connected: true, registered: true, toolchain: null }),
			refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
			rpc: async (method, params) => {
				const path = String(params[0]);
				let content: string | undefined;
				if (path === '/home/dev/notes.txt') content = machine['/home/dev/notes.txt'];
				else if (path === '/etc/secrets.key') content = machine['/etc/secrets.key'];
				if (method === 'readFile') {
					if (content === undefined) throw new Error(`ENOENT: ${path}`);
					return content;
				}
				if (method === 'listFiles') return Object.keys(machine).filter((p) => p.startsWith(`${path}/`));
				if (method === 'exists') return content !== undefined;
				throw new Error(`unexpected rpc ${method}`);
			},
		};
		const view = deviceFiles(transport, {
			consentedRoot: () => '/home/dev',
			hasFullFilesystem: async () => fullFilesystem,
		});
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', view)]);

		expect(await mounted.readFile('/pc/home/dev/notes.txt', { encoding: 'utf8' })).toBe('consented');
		await expect(mounted.readFile('/pc/etc/secrets.key')).rejects.toMatchObject({
			code: 'EACCES',
			path: '/etc/secrets.key',
		});

		fullFilesystem = true;
		expect(await mounted.readFile('/pc/etc/secrets.key', { encoding: 'utf8' })).toBe('outside');

		fullFilesystem = false;
		await expect(mounted.readFile('/pc/etc/secrets.key')).rejects.toThrow(
			/outside the consented device directory/,
		);
	});

	test('the root listing carries live mounts and omits absent ones; the canonical tree stays canonical', async () => {
		const base = fakeTree({ '/notes.md': 'workspace', '/memory/MEMORY.md': 'lessons' });
		const mounted = withMountTable(base, [
			mountOf('pc', fakeTree({ '/home/dev/a.txt': 'x' })),
			mountOf('sandbox', null, 'no Sandbox container bound'),
		]);

		expect(await mounted.readdir('/')).toEqual(expect.arrayContaining(['notes.md', 'memory', 'pc']));
		expect(await mounted.readdir('/')).not.toContain('sandbox');
		// Snapshots start from the relative workspace root; index services and the
		// real shell retain the base plane. None can enumerate a VFS-only mount.
		expect(await mounted.readdir('')).not.toContain('pc');
		expect(await base.readdir('/')).not.toContain('pc');
		expect(await base.stat('/pc')).toBeNull();

		await mounted.writeFile('workspace-file.txt', 'canonical');
		expect(await mounted.readFile('workspace-file.txt', { encoding: 'utf8' })).toBe('canonical');
		// A host-shaped absolute path names nothing in the workspace: mounts are
		// reserved names, not a rewrite of foreign paths into the tree.
		expect(await mounted.exists('/etc/secrets.key')).toBe(false);
	});

	test('only a whole first segment routes: /pcs/x and relative pc/x stay in the workspace', async () => {
		const base = fakeTree({ 'pc/ordinary.txt': 'workspace file' });
		const mounted = withMountTable(base, [mountOf('pc', fakeTree({ '/a.txt': 'device' }))]);

		let pcsOutcome = 'mounted';
		try { await mounted.readFile('/pcs/x'); } catch (caught) {
			pcsOutcome = isVfsError(caught) ? caught.code : 'unclassified';
		}
		expect(pcsOutcome).not.toBe('ENXIO');
		expect(await mounted.readFile('pc/ordinary.txt', { encoding: 'utf8' })).toBe('workspace file');
	});

	test('requires each mount name to occupy one unique root segment', () => {
		expect(() => withMountTable(fakeTree({}), [
			mountOf('pc', fakeTree({})),
			mountOf('pc', fakeTree({})),
		])).toThrow(/duplicate VFS mount name/);
		expect(() => withMountTable(fakeTree({}), [
			mountOf('pc/files', fakeTree({})),
		])).toThrow(/not a usable VFS mount name/);
	});

	test('a mounted path cannot climb through its mount point with ..', async () => {
		const base = fakeTree({ '/workspace-only.txt': 'workspace bytes' });
		const device: VFS = {
			...fakeTree({ '/home/dev/notes.txt': 'device bytes' }),
			readFile: async () => { throw new Error('a confined path must not reach the mounted tree'); },
		};
		const mounted = withMountTable(base, [mountOf('pc', device)]);

		await expect(mounted.readFile('/pc/../workspace-only.txt')).rejects.toMatchObject({
			code: 'EPERM',
			path: '/pc/../workspace-only.txt',
		});
		expect(await base.readFile('/workspace-only.txt', { encoding: 'utf8' })).toBe('workspace bytes');
	});

	test('standardMounts gate per environment kind', async () => {
		const laptopFiles = fakeTree({ '/home/dev/a.txt': 'x' });
		const sandboxFiles = fakeTree({ '/workspace/b.txt': 'y' });
		const mounts = standardMounts((name) => {
			if (name === "laptop") return { files: laptopFiles, isAvailable: () => false };
			if (name === "sandbox") return { files: sandboxFiles, isAvailable: () => false };
			return undefined;
		});
		const mounted = withMountTable(fakeTree({}), mounts);

		// A device tunnel is a presence: unavailable means absent even though a
		// view object exists.
		await expect(mounted.readdir('/pc')).rejects.toMatchObject({ code: 'ENXIO' });
		await expect(mounted.readdir('/pc')).rejects.toThrow('/pc — no device connected');
		// A container is a binding: it provisions on first touch, so the mount
		// stands whenever the binding does.
		expect(await mounted.readFile('/sandbox/workspace/b.txt', { encoding: 'utf8' })).toBe('y');
		expect(EXECUTOR_MOUNTS.laptop).toBe('/pc');
		expect(EXECUTOR_MOUNTS.sandbox).toBe('/sandbox');
	});
});

describe('the one plane, mutated: rename and removeRecursive route like every other op', () => {
	test('a workspace rename uses the native implementation without reading the bytes', async () => {
		const base = fakeTree({ '/big.bin': 'gigabytes, notionally' });
		const renames: Array<[string, string]> = [];
		let bytesRead = 0;
		const native = {
			...base,
			readFile: async (path: string, opts?: { encoding?: string }) => { bytesRead += 1; return base.readFile(path, opts); },
			rename: async (oldPath: string, newPath: string) => { renames.push([oldPath, newPath]); },
		};
		const mounted = withMountTable(native, [mountOf('pc', fakeTree({}))]);

		await mounted.rename('/big.bin', '/renamed.bin');
		expect(renames).toEqual([['/big.bin', '/renamed.bin']]);
		expect(bytesRead).toBe(0);
	});

	test('a file rename inside a mount without native rename moves the bytes and drops the source', async () => {
		const device = fakeTree({ '/home/dev/notes.txt': 'from the machine' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.rename('/pc/home/dev/notes.txt', '/pc/home/dev/renamed.txt');
		expect(await device.readFile('/home/dev/renamed.txt', { encoding: 'utf8' })).toBe('from the machine');
		expect(await device.exists('/home/dev/notes.txt')).toBe(false);
	});

	test('a base-to-mount rename refuses before either tree changes', async () => {
		const base = fakeTree({ '/report.txt': 'workspace copy' });
		const device = fakeTree({ '/home/dev/report.txt': 'device copy' });
		const mounted = withMountTable(base, [mountOf('pc', device)]);

		await expect(mounted.rename('/report.txt', '/pc/home/dev/report.txt')).rejects.toMatchObject({
			code: 'EPERM',
			path: '/report.txt',
		});
		expect(await base.readFile('/report.txt', { encoding: 'utf8' })).toBe('workspace copy');
		expect(await device.readFile('/home/dev/report.txt', { encoding: 'utf8' })).toBe('device copy');
	});

	test('a rename between two mounted trees also refuses before either tree changes', async () => {
		const pc = fakeTree({ '/home/dev/report.txt': 'device copy' });
		const sandbox = fakeTree({ '/workspace/report.txt': 'container copy' });
		const mounted = withMountTable(fakeTree({}), [
			mountOf('pc', pc),
			mountOf('sandbox', sandbox),
		]);

		await expect(mounted.rename(
			'/pc/home/dev/report.txt',
			'/sandbox/workspace/report.txt',
		)).rejects.toMatchObject({ code: 'EPERM' });
		expect(await pc.readFile('/home/dev/report.txt', { encoding: 'utf8' })).toBe('device copy');
		expect(await sandbox.readFile('/workspace/report.txt', { encoding: 'utf8' })).toBe('container copy');
	});

	test('a directory refuses to rename where only bytes could carry it', async () => {
		const device = fakeTree({ '/home/dev/src/app.ts': 'export {};' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await expect(mounted.rename('/pc/home/dev/src', '/pc/home/dev/moved'))
			.rejects.toMatchObject({ code: 'EPERM' });
	});

	test('a mount point is part of this plane and cannot be mutated', async () => {
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', fakeTree({ '/a.txt': 'x' }))]);

		await expect(mounted.rename('/pc', '/laptop')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(mounted.removeRecursive('/pc')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(mounted.writeFile('/pc', 'x')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(mounted.unlink('/pc')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(mounted.mkdir('/pc')).rejects.toMatchObject({ code: 'EPERM' });
	});

	test('removeRecursive delegates to the native tree removal where one exists', async () => {
		const base = fakeTree({ '/node_modules/a/index.js': 'x' });
		const removed: string[] = [];
		const native = { ...base, removeRecursive: async (path: string) => { removed.push(path); } };
		const mounted = withMountTable(native, [mountOf('pc', fakeTree({}))]);

		await mounted.removeRecursive('/node_modules');
		expect(removed).toEqual(['/node_modules']);
	});

	test('removeRecursive on a mount without native support removes the tree entry by entry', async () => {
		const device = fakeTree({ '/home/dev/build/out.js': 'x', '/home/dev/build/deep/two.js': 'y' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.removeRecursive('/pc/home/dev/build');
		expect(await device.exists('/home/dev/build/out.js')).toBe(false);
		expect(await device.exists('/home/dev/build/deep/two.js')).toBe(false);
		expect(await device.exists('/home/dev/build')).toBe(false);
	});

	test('removeTreeWithVfsOps names an absent path instead of quietly succeeding', async () => {
		await expect(removeTreeWithVfsOps(fakeTree({}), '/gone')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('an absent mount names its absence before a mutation can cross into it', async () => {
		const mounted = withMountTable(
			fakeTree({ '/from.txt': 'workspace bytes' }),
			[mountOf('pc', null, 'no device connected')],
		);

		await expect(mounted.rename('/pc/a', '/pc/b')).rejects.toMatchObject({ code: 'ENXIO' });
		await expect(mounted.rename('/from.txt', '/pc/to.txt')).rejects.toMatchObject({ code: 'ENXIO' });
		await expect(mounted.removeRecursive('/pc/a')).rejects.toMatchObject({ code: 'ENXIO' });
	});
});

describe('a live mount point is a directory of this plane', () => {
	test('stat answers structurally even where the mounted tree cannot stat its own root', async () => {
		const container = fakeTree({ '/workspace/build.log': 'ok' });
		// The container's own stat('/') answers null — the real sandbox view
		// derives stat from the parent listing, and '/' has no parent entry.
		const blindRoot = { ...container, stat: async (path: string) => path === '/' ? null : container.stat(path) };
		const mounted = withMountTable(fakeTree({}), [mountOf('sandbox', blindRoot)]);

		expect(await mounted.stat('/sandbox')).toMatchObject({ isDir: true });
	});

	test('an absent mount still stats as nothing', async () => {
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', null, 'no device connected')]);
		expect(await mounted.stat('/pc')).toBeNull();
	});
});
