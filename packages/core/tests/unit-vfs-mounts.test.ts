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
import { EXECUTOR_MOUNTS, standardMounts, withMountTable, type VfsMount } from '../src/vfs/mounts';
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
		unlink: async (path) => { files.delete(path); },
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
		// Existence probes answer honestly rather than throwing.
		expect(await mounted.stat('/pc')).toBeNull();
		expect(await mounted.exists('/pc/x')).toBe(false);
	});

	test('device consent still governs reads under /pc, by its classified reason', async () => {
		const machine: Map<string, string> = new Map([
			['/home/dev/notes.txt', 'consented'],
			['/etc/secrets.key', 'outside'],
		]);
		const transport: DeviceTransport = {
			status: () => ({ connected: true, registered: true, toolchain: null }),
			refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
			rpc: async (method, params) => {
				const path = String(params[0]);
				if (method === 'readFile') return machine.get(path) ?? (() => { throw new Error(`ENOENT: ${path}`); })();
				if (method === 'listFiles') return [...machine.keys()].filter((p) => p.startsWith(`${path}/`));
				if (method === 'exists') return machine.has(path);
				throw new Error(`unexpected rpc ${method}`);
			},
		};
		const view = deviceFiles(transport, {
			consentedRoot: () => '/home/dev',
			hasFullFilesystem: async () => false,
		});
		const mounted = withMountTable(fakeTree({}), [mountOf('pc', view)]);

		expect(await mounted.readFile('/pc/home/dev/notes.txt', { encoding: 'utf8' })).toBe('consented');
		let error: unknown;
		try { await mounted.readFile('/pc/etc/secrets.key'); } catch (caught) { error = caught; }
		if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);
		expect(error.code).toBe('EACCES');
		expect(error.path).toBe('/etc/secrets.key');
		expect(error.message).toContain('outside the consented device directory');
	});

	test('the root listing carries live mounts and omits absent ones; the canonical tree stays canonical', async () => {
		const base = fakeTree({ '/notes.md': 'workspace', '/memory/MEMORY.md': 'lessons' });
		const mounted = withMountTable(base, [
			mountOf('pc', fakeTree({ '/home/dev/a.txt': 'x' })),
			mountOf('sandbox', null, 'no Sandbox container bound'),
		]);

		expect(await mounted.readdir('/')).toEqual(expect.arrayContaining(['notes.md', 'memory', 'pc']));
		expect(await mounted.readdir('/')).not.toContain('sandbox');

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
