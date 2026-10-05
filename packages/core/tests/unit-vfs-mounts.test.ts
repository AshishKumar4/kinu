import { exists, readText, type Awaitable, type VFS, type VfsRevision, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// The workspace mount table: /pc and /sandbox extend one view (#36/#142/#143); an absent mount
// is stated as absent, and device consent is still enforced on mounted paths. The workspace shell
// serves the same table (#22).
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { fakeMossaic } from '@kinu.run/test-utils/mossaic';

import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { EXECUTOR_MOUNTS, removeTreeWithVfsOps, standardMounts, withMountTable, type VfsMount } from '../src/vfs/mounts';
import { mossaicVfs } from '../src/vfs/mossaic-vfs';
import { deviceFiles, type DeviceFileScope, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import { observeWrites } from '../src/vfs/observe';
import { createWorkspaceBundle } from './helpers';
import { agentCred, agentHome, agentTmpRoot, confineAgentTmp, provisionAgentHome } from '../src/vfs/agent-home';

/** Dirents and stats distinguish directories; a miss throws the VfsError the real backends throw. */
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

			if (content === undefined) throw new VfsError('ENOENT', 'no such file or directory', path);

			return new TextEncoder().encode(content);
		},
		writeFile: async (path, data) => { files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data); },
		readdir: async (path) => {
			if (path !== '/' && !dirs.has(path)) throw new VfsError('ENOENT', 'no such directory', path);
			const names = new Set<string>();
			const prefix = path === '/' ? '/' : `${path}/`;

			for (const key of [...files.keys(), ...dirs]) {
				if (!key.startsWith(prefix)) continue;
				names.add(key.slice(prefix.length).split('/')[0]);
			}

			return [...names].map((name) => ({ name, type: dirs.has(`${prefix}${name}`) ? 'directory' : 'file' }));
		},
		stat: async (path) => {
			const content = files.get(path);

			if (content !== undefined) return { size: new TextEncoder().encode(content).byteLength, mtimeMs: 0, type: 'file' };

			return dirs.has(path) ? { size: 0, mtimeMs: 0, type: 'directory' } : null;
		},
		unlink: async (path) => { files.delete(path); dirs.delete(path); },
		mkdir: async (path) => { dirs.add(path); },
	};
}

function mountOf(name: string, files: VFS | null, reason = 'not live'): VfsMount {
	return { name, files: () => files, absentReason: () => reason, filesOwner: 'user' };
}

describe('the workspace plane mount table', () => {
	test('/pc lists and stats the device tree at every depth', async () => {
		const device = fakeTree({
			'/home/dev/report.txt': 'from the machine',
			'/home/dev/src/app.ts': 'export {};',
		});

		const mounted = withMountTable(fakeTree({ 'notes.md': 'workspace' }), [mountOf('pc', device)]);

		expect(((await mounted.readdir('/pc/home/dev')).map(({ name }) => name)).sort()).toEqual(['report.txt', 'src']);
		expect((await mounted.readdir('/pc/home/dev/src')).map(({ name }) => name)).toEqual(['app.ts']);
		expect((await mounted.stat('/pc/home/dev/src'))?.type).toBe('directory');
		expect((await mounted.stat('/pc/home/dev/report.txt'))?.type).toBe('file');
	});

	test('/sandbox lists the container tree', async () => {
		const container = fakeTree({ '/workspace/build.log': 'ok' });
		const mounted = withMountTable(fakeTree({}), [mountOf('sandbox', container)]);

		expect((await mounted.readdir('/sandbox/workspace')).map(({ name }) => name)).toEqual(['build.log']);
	});

	test('reads and writes under a live mount cross to the owning machine', async () => {
		const device = fakeTree({ '/home/dev/notes.txt': 'native bytes' });
		const base = fakeTree({});
		const mounted = withMountTable(base, [mountOf('pc', device)]);

		expect(await readText(mounted, '/pc/home/dev/notes.txt')).toBe('native bytes');
		await writeText(mounted, '/pc/home/dev/out.txt', 'written through the plane');
		expect(await readText(device, '/home/dev/out.txt')).toBe('written through the plane');
	});

	test('routes mkdir, stat, exists, unlink, and revision writes through a live mount', async () => {
		const backing = fakeTree({ '/home/dev/remove.txt': 'remove me' });
		const revisionWrites: Array<[string, VfsRevision]> = [];

		const device: VFS = {
			...backing,
			writeFileIfRevision: async (path, data, expectedRevision) => {
				revisionWrites.push([path, expectedRevision]);
				await backing.writeFile(path, data);

				return { ok: true, revision: v.parse(v.number(), expectedRevision) + 1 };
			},
		};

		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.mkdir('/pc/home/dev/build', { recursive: true });
		expect(await mounted.stat('/pc/home/dev/build')).toMatchObject({ type: 'directory' });
		await writeText(mounted, '/pc/home/dev/build/output.txt', 'built');
		expect(await exists(mounted, '/pc/home/dev/build/output.txt')).toBe(true);

		const conditional = mounted.writeFileIfRevision?.bind(mounted);

		if (conditional === undefined) throw new Error('the mounted VFS must expose conditional writes');
		expect(await conditional(
			'/pc/home/dev/build/revision.txt',
			new TextEncoder().encode('revisioned'),
			4,
		)).toEqual({ ok: true, revision: 5 });
		expect(revisionWrites).toEqual([['/home/dev/build/revision.txt', 4]]);

		await mounted.unlink('/pc/home/dev/remove.txt');
		expect(await exists(mounted, '/pc/home/dev/remove.txt')).toBe(false);
	});
	test('classifies unsupported conditional writes on base and mounted trees', async () => {
		const base = fakeTree({ '/workspace/base.txt': 'base before' });
		const device = fakeTree({ '/home/dev/mounted.txt': 'mounted before' });
		const mounted = withMountTable(base, [mountOf('pc', device)]);
		const conditional = mounted.writeFileIfRevision?.bind(mounted);

		if (conditional === undefined) throw new Error('the composite VFS must expose conditional writes');

		for (const [path, before] of [
			['/workspace/base.txt', 'base before'],
			['/pc/home/dev/mounted.txt', 'mounted before'],
		] as const) {
			let error: unknown;

			try {
				await conditional(path, new TextEncoder().encode('after'), 1);
			} catch (caught) {
				error = caught;
			}

			if (!isVfsError(error)) throw new Error(`expected a classified unsupported error, got ${String(error)}`);
			expect(error.code).toBe('ENOTSUP');
			expect(error.errno).toBe(-95);
			expect(error.path).toBe(path);
			expect(await readText(mounted, path)).toBe(before);
		}
	});

	test('an absent mount states its absence instead of serving an empty tree', async () => {
		const mounted = withMountTable(fakeTree({ 'notes.md': 'workspace' }), [
			mountOf('pc', null, 'no device connected'),
		]);

		const refused: Array<Awaitable<unknown>> = [
			Promise.resolve(mounted.readdir('/pc')).then(entries => entries.map(({ name }) => name)),
			mounted.readFile('/pc/x'),
			writeText(mounted, '/pc/x', 'data'),
			mounted.unlink('/pc/x'),
			mounted.mkdir('/pc/x'),
		];

		for (const attempt of refused) {
			let error: unknown;

			try { await attempt; } catch (caught) { error = caught; }

			if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);
			expect(error.code).toBe('ENXIO');
			expect(error.message).toContain('/pc: no device connected');
		}

		const conditional = mounted.writeFileIfRevision?.bind(mounted);

		if (conditional === undefined) throw new Error('the mounted VFS must expose conditional writes');
		await expect(conditional('/pc/x', new Uint8Array(), 1)).rejects.toMatchObject({ code: 'ENXIO' });

		await expect(mounted.stat('/pc')).rejects.toMatchObject({ code: 'ENXIO' });
		await expect(exists(mounted, '/pc/x')).rejects.toMatchObject({ code: 'ENXIO' });
	});

	test('device consent and revocation still govern reads under /pc', async () => {
		const machine = {
			'/home/dev/notes.txt': 'consented',
			'/etc/secrets.key': 'outside',
			'/tmp/kinu-tool-output/device-rpc-1.stdout.log': 'spilled',
		};

		let scope: DeviceFileScope = 'root';

		const transport: DeviceTransport = {
			status: () => ({ connected: true, registered: true, toolchain: null }),
			refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
			rpc: async (method, params) => {
				const path = v.parse(v.string(), params[0]);
				const content = Object.entries(machine).find(([file]) => file === path)?.[1];

				if (method === 'readRange') {
					if (content === undefined) throw new Error(`ENOENT: ${path}`);

					return { encoding: 'base64', content: Buffer.from(content).toString('base64') };
				}

				if (method === 'listFiles') return Object.keys(machine).filter((p) => p.startsWith(`${path}/`));

				if (method === 'exists') return content !== undefined;
				throw new Error(`unexpected rpc ${method}`);
			},
		};

		const view = deviceFiles(transport, {
			consentedRoot: async () => '/home/dev',
			deviceHome: async () => '/home/dev',
			scope: async () => scope,
		});

		const mounted = withMountTable(fakeTree({}), [mountOf('pc', view)]);
		const spill = '/pc/tmp/kinu-tool-output/device-rpc-1.stdout.log';

		expect(await readText(mounted, '/pc/home/dev/notes.txt')).toBe('consented');
		await expect(mounted.readFile('/pc/etc/secrets.key')).rejects.toMatchObject({
			code: 'EACCES',
			path: '/etc/secrets.key',
		});
		await expect(mounted.readFile(spill)).rejects.toMatchObject({ code: 'EACCES' });

		// Sandboxed, the daemon maps /tmp to the agent's own temp directory, where a long command's
		// whole output is saved, so the view reaches it too; nothing else outside the folder.
		scope = 'sandboxed';
		expect(await readText(mounted, spill)).toBe('spilled');
		await expect(mounted.readFile('/pc/etc/secrets.key')).rejects.toThrow(/outside the consented device directory/);

		scope = 'unconfined';
		expect(await readText(mounted, '/pc/etc/secrets.key')).toBe('outside');

		scope = 'root';
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

		expect((await mounted.readdir('/')).map(({ name }) => name)).toEqual(expect.arrayContaining(['notes.md', 'memory', 'pc']));
		expect((await mounted.readdir('/')).map(({ name }) => name)).not.toContain('sandbox');
		// Snapshots, index services and the real shell use the base plane; none enumerate a VFS-only mount.
		expect((await mounted.readdir('')).map(({ name }) => name)).not.toContain('pc');
		expect((await base.readdir('/')).map(({ name }) => name)).not.toContain('pc');
		expect(await base.stat('/pc')).toBeNull();

		await writeText(mounted, 'workspace-file.txt', 'canonical');
		expect(await readText(mounted, 'workspace-file.txt')).toBe('canonical');
		// Mounts are reserved names, not a rewrite of host paths into the tree.
		expect(await exists(mounted, '/etc/secrets.key')).toBe(false);
	});

	test('only a whole first segment routes: /pcs/x and relative pc/x stay in the workspace', async () => {
		const base = fakeTree({ 'pc/ordinary.txt': 'workspace file' });
		const mounted = withMountTable(base, [mountOf('pc', fakeTree({ '/a.txt': 'device' }))]);

		let pcsOutcome = 'mounted';

		try { await mounted.readFile('/pcs/x'); } catch (caught) {
			pcsOutcome = isVfsError(caught) ? caught.code : 'unclassified';
		}

		expect(pcsOutcome).not.toBe('ENXIO');
		expect(await readText(mounted, 'pc/ordinary.txt')).toBe('workspace file');
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
		expect(await readText(base, '/workspace-only.txt')).toBe('workspace bytes');
	});

	test('standardMounts gate per environment kind', async () => {
		const deviceTree = fakeTree({ '/home/dev/a.txt': 'x' });
		const sandboxFiles = fakeTree({ '/workspace/b.txt': 'y' });

		const mounts = standardMounts((name) => {
			if (name === "device") return { files: deviceTree, isAvailable: () => false };

			if (name === "sandbox") return { files: sandboxFiles, isAvailable: () => false };

			return undefined;
		});

		const mounted = withMountTable(fakeTree({}), mounts);

		// A device tunnel is a presence: unavailable means absent.
		await expect(Promise.resolve(mounted.readdir('/pc')).then(entries => entries.map(({ name }) => name))).rejects.toMatchObject({ code: 'ENXIO' });
		await expect(Promise.resolve(mounted.readdir('/pc')).then(entries => entries.map(({ name }) => name))).rejects.toThrow('/pc: no device connected');
		// A container is a binding: it provisions on first touch.
		expect(await readText(mounted, '/sandbox/workspace/b.txt')).toBe('y');
		expect(EXECUTOR_MOUNTS.device).toBe('/pc');
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
			readFile: async (path: string) => {
				bytesRead += 1;

				return base.readFile(path);
			},
			rename: async (oldPath: string, newPath: string) => { renames.push([oldPath, newPath]); },
		};

		const mounted = withMountTable(native, [mountOf('pc', fakeTree({}))]);

		await mounted.rename('/big.bin', '/renamed.bin');
		expect(renames).toEqual([['/big.bin', '/renamed.bin']]);
		expect(bytesRead).toBe(0);
	});
	test('an observed plane keeps its native rename (no byte-carry fallback)', async () => {
		const base = fakeTree({ '/big.bin': 'gigabytes, notionally' });
		const renames: Array<[string, string]> = [];
		let bytesRead = 0;

		const native = {
			...base,
			readFile: async (path: string) => {
				bytesRead += 1;

				return base.readFile(path);
			},
			rename: async (oldPath: string, newPath: string) => { renames.push([oldPath, newPath]); },
		};

		const observer = { needsBaseline: () => false, record: () => {} };
		const mounted = withMountTable(observeWrites(native, observer), [mountOf('pc', fakeTree({}))]);

		await mounted.rename('/big.bin', '/renamed.bin');
		expect(renames).toEqual([['/big.bin', '/renamed.bin']]);
		expect(bytesRead).toBe(0);
	});

	test('a file rename inside a mount without native rename moves the bytes and drops the source', async () => {
		const device = fakeTree({ '/home/dev/notes.txt': 'from the machine' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.rename('/pc/home/dev/notes.txt', '/pc/home/dev/renamed.txt');
		expect(await readText(device, '/home/dev/renamed.txt')).toBe('from the machine');
	});
	test('a base-plane directory without a native rename moves whole, as mv moves it, and leaves nothing staged', async () => {
		const base = fakeTree({ '/work/src/app.ts': 'export {};' });
		const mounted = withMountTable(base, [mountOf('pc', fakeTree({}))]);

		await mounted.rename('/work/src', '/work/moved');

		expect(await exists(base, '/work/src')).toBe(false);
		expect(await readText(base, '/work/moved/app.ts')).toBe('export {};');
		expect((await base.readdir('/work')).map((entry) => entry.name)).toEqual(['moved']);
	});

	test('an absent directory source refuses the carry with ENOENT, and the destination keeps its bytes', async () => {
		const device = fakeTree({ '/home/dev/keeper.txt': 'untouched' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await expect(mounted.rename('/pc/home/dev/ghost.txt', '/pc/home/dev/keeper.txt'))
			.rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readText(device, '/home/dev/keeper.txt')).toBe('untouched');
	});


	test('a base-to-mount rename refuses before either tree changes', async () => {
		const base = fakeTree({ '/report.txt': 'workspace copy' });
		const device = fakeTree({ '/home/dev/report.txt': 'device copy' });
		const mounted = withMountTable(base, [mountOf('pc', device)]);

		await expect(mounted.rename('/report.txt', '/pc/home/dev/report.txt')).rejects.toMatchObject({
			code: 'EPERM',
			path: '/report.txt',
		});
		expect(await readText(base, '/report.txt')).toBe('workspace copy');
		expect(await readText(device, '/home/dev/report.txt')).toBe('device copy');
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
		expect(await readText(pc, '/home/dev/report.txt')).toBe('device copy');
		expect(await readText(sandbox, '/workspace/report.txt')).toBe('container copy');
	});

	test('a directory on a plane without a native rename moves whole, as mv moves it, and leaves nothing staged', async () => {
		const device = fakeTree({ '/home/dev/src/app.ts': 'export {};' });
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		await mounted.rename('/pc/home/dev/src', '/pc/home/dev/moved');

		expect(await exists(device, '/home/dev/src')).toBe(false);
		expect(await readText(device, '/home/dev/moved/app.ts')).toBe('export {};');
		expect((await device.readdir('/home/dev')).map((entry) => entry.name).sort()).toEqual(['moved']);
	});

	test('a mount point is part of this plane and cannot be mutated', async () => {
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', fakeTree({ '/a.txt': 'x' }))]);

		await expect(mounted.rename('/pc', '/device')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(mounted.removeRecursive('/pc')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(writeText(mounted, '/pc', 'x')).rejects.toMatchObject({ code: 'EPERM' });
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
		expect(await exists(device, '/home/dev/build/out.js')).toBe(false);
		expect(await exists(device, '/home/dev/build/deep/two.js')).toBe(false);
		expect(await exists(device, '/home/dev/build')).toBe(false);
	});

	test('a mid-tree unlink failure stops the pass and reports both halves', async () => {
		// KINU-013: removal stops at the first refusal and partitions the tree into removed and remaining.
		const base = fakeTree({
			'/build/out.js': 'x',
			'/build/deep/two.js': 'y',
		});

		const realUnlink = base.unlink.bind(base);
		let calls = 0;

		base.unlink = async (path) => {
			calls += 1;

			if (calls === 3) {
				throw new VfsError('EACCES', 'held open', path);
			}

			return realUnlink(path);
		};

		const removal = await removeTreeWithVfsOps(base, '/build');

		if (removal.ok) throw new Error('expected a partial removal, got a completed one');

		expect(removal.removed).toEqual(['/build/deep/two.js', '/build/deep']);
		expect(removal.remaining).toEqual(['/build/out.js', '/build']);
		expect(removal.failed.path).toBe('/build/out.js');
		expect(await exists(base, '/build/deep/two.js')).toBe(false);
		expect(await exists(base, '/build/deep')).toBe(false);
		expect(await exists(base, '/build/out.js')).toBe(true);
		expect(await exists(base, '/build')).toBe(true);
	});

	test('a mounted tree removal that stops partway throws naming both halves', async () => {
		const device = fakeTree({
			'/home/dev/build/out.js': 'x',
			'/home/dev/build/deep/two.js': 'y',
		});

		const realUnlink = device.unlink.bind(device);

		device.unlink = async (path) => {
			if (path === '/home/dev/build/deep') {
				throw new VfsError('EACCES', 'held open', path);
			}

			return realUnlink(path);
		};

		const mounted = withMountTable(fakeTree({}), [mountOf('pc', device)]);

		let error: unknown;

		try { await mounted.removeRecursive('/pc/home/dev/build'); } catch (caught) { error = caught; }

		if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);

		expect(error.code).toBe('EACCES');
		expect(error.message).toContain('/home/dev/build/deep/two.js');
		expect(error.message).toContain('/home/dev/build/out.js');
		expect(error.message).toContain('still present');
		expect(await exists(device, '/home/dev/build/deep/two.js')).toBe(false);
		expect(await exists(device, '/home/dev/build/deep')).toBe(true);
		expect(await exists(device, '/home/dev/build/out.js')).toBe(true);
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
		// The real sandbox view derives stat from the parent listing, so stat('/') is null.
		const blindRoot = { ...container, stat: async (path: string) => path === '/' ? null : container.stat(path) };
		const mounted = withMountTable(fakeTree({}), [mountOf('sandbox', blindRoot)]);

		expect(await mounted.stat('/sandbox')).toMatchObject({ type: 'directory' });
	});

});

describe('the workspace shell serves the same mount table (#22)', () => {
	/** A workspace whose session user holds `/shared` (a Drive), `/sandbox` (any ranged tree) and an absent `/pc`. */
	async function workspaceWithMounts() {
		const bundle = createWorkspaceBundle(new Database(':memory:'));
		const store = fakeMossaic();
		const drive = mossaicVfs(store.tenant('owner'));
		const container = mossaicVfs(store.tenant('container'));
		await writeText(drive, '/notes.md', 'from the Drive\n');
		await container.mkdir('/workspace', { recursive: true });
		bundle.mountTable(withMountTable(bundle.vfs, [
			mountOf('shared', drive), mountOf('sandbox', container), mountOf('pc', null, 'no device connected'),
			{ ...mountOf('context', fakeTree({ 'notes.md': 'history' })), storeView: true },
		]));

		return { shell: bundle.shell, drive, container };
	}

	test('ls / lists every live mount point, and cat reads a file through one', async () => {
		const { shell } = await workspaceWithMounts();

		const listed = await shell.exec('ls /');
		expect(listed.stdout.split(/\s+/)).toEqual(expect.arrayContaining(['home', 'shared', 'sandbox']));
		expect(listed.stdout).not.toContain('pc');
		expect(await shell.exec('cat /shared/notes.md')).toMatchObject({ stdout: 'from the Drive\n', exitCode: 0 });
	});

	test('cd enters a mount, and a redirect lands in the mounted tree', async () => {
		const { shell, drive } = await workspaceWithMounts();

		expect(await shell.exec('cd /shared && pwd && ls')).toMatchObject({ stdout: '/shared\nnotes.md\n', exitCode: 0 });
		expect(await shell.exec('echo hello > /shared/new.txt && echo more >> /shared/new.txt')).toMatchObject({ exitCode: 0 });
		expect(await readText(drive, '/new.txt')).toBe('hello\nmore\n');
	});

	/** Plain `df` leaves these out: neither Drive's client nor the sandbox executor answers a disk-usage call. */
	const SIZELESS = ['/sandbox', '/shared'];

	// A view over the root's store is sized as Linux sizes a bind mount: by the filesystem behind it.
	test('df sizes the root and its views alike; df -a, mount and /proc/mounts add the rest, and no absent mount', async () => {
		const { shell } = await workspaceWithMounts();
		const df = await shell.exec('df');
		const rows = df.stdout.split('\n').slice(1).filter((line) => line.trim() !== '').map((line) => line.split(/\s+/));
		const figures = (point: string) => rows.find((row) => row.at(-1) === point)?.slice(1, 5);

		expect({ exitCode: df.exitCode, root: figures('/') }).toEqual({ exitCode: 0, root: expect.any(Array) });
		expect(figures('/context')).toEqual(figures('/'));
		expect(rows.map((row) => row.at(-1))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/(sandbox|shared|pc)$/)]));

		for (const command of ['df -a', 'df -ah', 'mount', 'cat /proc/mounts']) {
			const listed = await shell.exec(command);

			const points = listed.stdout.split('\n').filter((line) => line.trim() !== '')
				.map((line) => line.split(/\s+/).find((field) => field.startsWith('/')));

			expect({ command, exitCode: listed.exitCode, points: points.filter((point) => point !== undefined).sort() })
				.toEqual({ command, exitCode: 0, points: expect.arrayContaining(['/', '/context', ...SIZELESS]) });
			expect({ command, stdout: listed.stdout }).not.toMatchObject({ stdout: expect.stringContaining('/pc') });
		}

		expect((await shell.exec('echo x > /proc/mounts')).exitCode).not.toBe(0);
		expect((await shell.exec('cat /proc/mounts')).stdout).toContain('/shared');
	});

	test('an agent shell lists the device mount that its own table holds', async () => {
		const bundle = createWorkspaceBundle(new Database(':memory:'));
		const { root, confiner } = await bundle.privileged();
		const cred = { uid: 2_001, gid: 2_001 };
		provisionAgentHome(root, 'agent-a', cred);
		confineAgentTmp(confiner, 'agent-a', cred);
		const fleet = fakeTree({ '/laptop/notes.md': 'a', '/studio/notes.md': 'b' });
		const table = withMountTable(bundle.vfs, [mountOf('pc', fleet)]);
		bundle.mountTable(table);
		bundle.mountTable(table, agentCred(cred));
		const agent = await bundle.asAgent({ cred: agentCred(cred), home: agentHome('agent-a'), tmp: agentTmpRoot('agent-a') });

		for (const command of ['mount', 'df -a', 'cat /proc/mounts']) {
			const listed = await agent.shell.exec(command);
			const points = listed.stdout.split(/\s+/).filter((field) => field.startsWith('/pc'));

			expect({ command, exitCode: listed.exitCode, points }).toEqual({ command, exitCode: 0, points: ['/pc'] });
		}

		// The device daemon answers no disk-usage call, so plain df leaves /pc out.
		expect((await agent.shell.exec('df')).stdout).not.toContain('/pc');

		expect((await agent.shell.exec('ls /pc')).stdout.split(/\s+/).filter(Boolean)).toEqual(['laptop', 'studio']);
	});

	test('mv between two mounts copies across, since each mount is its own device', async () => {
		const { shell, drive, container } = await workspaceWithMounts();

		expect(await shell.exec('mv /shared/notes.md /sandbox/workspace/notes.md')).toMatchObject({ exitCode: 0 });
		expect(await exists(drive, '/notes.md')).toBe(false);
		expect(await readText(container, '/workspace/notes.md')).toBe('from the Drive\n');
	});
});
