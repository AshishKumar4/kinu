import { fileToolOver } from './helpers';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { sha256Hex } from '../src/safety/argument-digest';
/**
 * The `/computer` mount end to end: `file` tool and codemode `computer.*` over one container view.
 * The double follows the native file boundary: a miss carries its errno in `Error.cause`, an empty
 * path is refused as the SDK's `Files` refuses it, and relative paths resolve against `/workspace`.
 */

import { describe, test, expect } from 'bun:test';
import { present, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { executorNamespace } from '../src/tools/executor-operations';
import { FILE } from '../src/operations/file';
import type { ExecutorCapability, ExecutorProviderSurface } from '../src/execution/types';
import { namespaceDeclaration } from '../src/tools/operation-surfaces';
import { renderCodemodeDescription } from '../src/index';
import { TurnContextBudget } from '../src/context-budget';
import { createSandboxExecutor, sandboxFiles, WORKSPACE_BACKUP_DIR, type SandboxHandle } from '../src/execution/sandbox';
import { nativeFileRead } from './helpers/sandbox-handle-lifecycle';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { serveFile, type FileDeps } from '../src/tools/file-operations';

type FileToolInput = JsonObject & { readonly op: string };

import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { standardMounts, withMountTable } from '../src/vfs/mounts';
import { bytesToBase64 } from '../src/utils/base64';

import { JsonValueSchema, type JsonValue, type JsonObject } from '../src/utils/json';
import type { VfsDigestWrite } from '../src/types/primitives';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { cloudPlanes } from '../src/vfs/resolve';

/** A native file failure as it reaches core: the errno travels in `Error.cause`, which Worker RPC keeps. */
const nativeFileError = (code: string, path: string): Error =>
	new Error(`${code}: ${path}`, { cause: { kind: 'devbox.file', code, path, operation: 'readFile' } });

const notFound = (path: string): Error => nativeFileError('ENOENT', path);

class ContainerFs {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>(['/', WORKSPACE_BACKUP_DIR]);
	readonly calls: string[] = [];

	resolve(path: string): string {
		if (path === '') throw new TypeError('path must not be empty');

		const absolute = path.startsWith('/') ? path : `${WORKSPACE_BACKUP_DIR}/${path}`;
		const out: string[] = [];

		for (const segment of absolute.split('/')) {
			if (segment === '' || segment === '.') continue;

			if (segment === '..') {
				out.pop();
				continue;
			}

			out.push(segment);
		}

		return `/${out.join('/')}`;
	}
}

function container(fs: ContainerFs): SandboxHandle {
	const handle: SandboxHandle = {
		...sandboxHandleLifecycle,
		async readFile(path, opts) {
			const resolved = fs.resolve(path);

			if (fs.dirs.has(resolved)) {
				throw nativeFileError('EISDIR', resolved);
			}

			const bytes = fs.files.get(resolved);

			if (bytes === undefined) throw notFound(resolved);

			return nativeFileRead(bytes, opts);
		},
		async writeFile(path, content, opts) {
			const resolved = fs.resolve(path);
			const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';

			if (!fs.dirs.has(parent)) throw notFound(parent);

			fs.files.set(resolved, opts?.encoding === 'base64'
				? new Uint8Array(Buffer.from(content, 'base64'))
				: new TextEncoder().encode(content));
		},
		// The guest compares what it holds against the digest named, then replaces, as the devbox's guest process does.
		async writeFileIfDigest({ path, contentBase64, expected }) {
			const resolved = fs.resolve(path);
			const held = fs.files.get(resolved);
			const found = held === undefined ? null : sha256Hex(held);

			if (found !== expected) return { ok: false, sha256: found };
			await handle.writeFile(path, contentBase64, { encoding: 'base64' });

			return { ok: true, sha256: sha256Hex(Buffer.from(contentBase64, 'base64')) };
		},
		async listFiles(path) {
			const resolved = fs.resolve(path);
			fs.calls.push(`listFiles:${resolved}`);

			if (fs.files.has(resolved)) {
				throw nativeFileError('ENOTDIR', resolved);
			}

			if (!fs.dirs.has(resolved)) throw notFound(resolved);

			const names = new Set<string>();
			const prefix = resolved === '/' ? '/' : `${resolved}/`;

			for (const key of [...fs.files.keys(), ...fs.dirs]) {
				if (key !== resolved && key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);

					if (!rest.includes('/')) names.add(rest);
				}
			}

			return {
				files: [...names].map((name) => {
					const full = `${prefix}${name}`;
					const bytes = fs.files.get(full);

					return bytes !== undefined
						? { name, type: 'file', size: bytes.length, mode: 0o100644, mtimeMs: 1 }
						: { name, type: 'directory', size: 0, mode: 0o40755, mtimeMs: 1 };
				}),
			};
		},
		async deleteFile(path) {
			const resolved = fs.resolve(path);

			if (!fs.files.delete(resolved)) throw notFound(resolved);
		},
		async exec(command) {
			const quoted = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
			const target = quoted.at(-1) ?? '';

			if (command.startsWith('mkdir')) {
				fs.dirs.add(target);

				return { exitCode: 0, stdout: '', stderr: '' };
			}

			if (command.startsWith('test -e')) {
				return { exitCode: 0, stdout: fs.files.has(target) || fs.dirs.has(target) ? 'true' : 'false', stderr: '' };
			}

			// The adapter's ranged read (`dd`); an empty answer would make windowed reads see empty files.
			const window = /\bdd if='[^']*' bs=1 skip=(\d+) count=(\d+)/.exec(command);

			if (window) {
				const bytes = fs.files.get(target);

				if (!bytes) {
					return { exitCode: 1, stdout: '', stderr: `dd: failed to open '${target}': No such file or directory` };
				}

				const from = Number(window[1]);

				return { exitCode: 0, stdout: bytesToBase64(bytes.subarray(from, from + Number(window[2]))), stderr: '' };
			}

			return { exitCode: 0, stdout: '', stderr: '' };
		},
		async exposePort(port) { return { url: `https://preview.invalid/${port}`, port, route: { reached: true } }; },
		async unexposePort() {},
		async getExposedPorts() { return []; },
		async statFile(path) {
			const resolved = fs.resolve(path);
			const bytes = fs.files.get(resolved);

			if (bytes !== undefined) return { type: 'file', size: bytes.length, mode: 0o100644, mtimeMs: 1 };

			if (fs.dirs.has(resolved)) return { type: 'directory', size: 0, mode: 0o40755, mtimeMs: 1 };

			throw notFound(resolved);
		},
	};

	return handle;
}

/** The mount table only asks the base for non-`/computer` paths. */
function basePlane(): VFS {
	return {
		readFile: async (path) => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); },
		writeFile: async () => { throw new Error('the base plane in this test holds nothing'); },
		readdir: async () => [],
		stat: async () => null,
		unlink: async () => {},
		mkdir: async () => {},
	};
}

function rig(fs: ContainerFs) {
	const executor = createSandboxExecutor(container(fs));

	const mounted = withMountTable(basePlane(), standardMounts((name) =>
		name === 'computer' ? executor : undefined));

	const deps = {
		home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT),
		vfs: mounted, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
	};

	const file = toolExecute<FileToolInput, JsonValue>(fileToolOver(deps));
	const namespace = executorNamespace(executor, serveFile(() => deps));

	return { executor, mounted, file, namespace };
}

describe('the file tool across the /computer mount', () => {
	test('write of a NEW file creates it, and a read returns the bytes', async () => {
		const fs = new ContainerFs();
		const { file } = rig(fs);

		const written = await file({
			op: 'write', path: '/computer/workspace/broken.mjs', content: 'export const x = 1;\n',
		});

		expect(written).toMatchObject({ action: 'created' });
		expect(new TextDecoder().decode(fs.files.get('/workspace/broken.mjs'))).toBe('export const x = 1;\n');
		expect(await file({ op: 'read', path: '/computer/workspace/broken.mjs' }))
			.toStartWith('1\texport const x = 1;\n');
	});

	test('write of an existing file replaces it', async () => {
		const fs = new ContainerFs();
		const { file } = rig(fs);

		await file({ op: 'write', path: '/computer/workspace/broken.mjs', content: 'v1\n' });

		const replaced = await file({
			op: 'write', path: '/computer/workspace/broken.mjs', content: 'v2\n',
		});

		expect(replaced).toMatchObject({ action: 'replaced' });
		expect(await file({ op: 'read', path: '/computer/workspace/broken.mjs' })).toStartWith('1\tv2\n');
	});

	test('a write under a directory the container does not have fails ENOENT, not io', async () => {
		const { mounted } = rig(new ContainerFs());

		let error: unknown;

		try { await mounted.readFile('/computer/nowhere/x.txt'); } catch (cause) { error = cause; }

		expect(isVfsError(error) && error.code === 'ENOENT').toBe(true);
	});
});

describe('a digest-checked write to the sandbox', () => {
	const digest = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

	/**
	 * A container whose guest answers a repeated operation what it answered first, as the devbox's guest program
	 * does, and whose first reply is lost after the guest acted; `meanwhile` runs between the two sends.
	 */
	function lossy(fs: ContainerFs, meanwhile: () => void) {
		const box = container(fs);
		const answered = new Map<string, VfsDigestWrite>();

		const handle: SandboxHandle = {
			...box,
			async writeFileIfDigest(write) {
				const first = answered.get(write.operation);

				if (first !== undefined) return first;
				const answer = await box.writeFileIfDigest(write);

				answered.set(write.operation, answer);
				meanwhile();

				throw new Error('Network connection lost.');
			},
		};

		// Sent once more after a failure, as the executor's retry of a dropped connection does.
		return sandboxFiles(handle, async (call) => {
			const [first] = await Promise.allSettled([call()]);

			return first.status === 'fulfilled' ? first.value : call();
		});
	}

	// Only a resend under the first send's operation is answered what the guest did: a new one would be refused here.
	test('a landed write whose reply was lost stays landed, though the file moved before the resend', async () => {
		const fs = new ContainerFs();
		fs.files.set('/workspace/a.txt', new TextEncoder().encode('v1'));
		const files = lossy(fs, () => { fs.files.set('/workspace/a.txt', new TextEncoder().encode('the owner\'s save')); });

		expect(await files.writeFileIfDigest('/workspace/a.txt', new TextEncoder().encode('v2'), digest('v1')))
			.toEqual({ ok: true, sha256: digest('v2') });
		expect(new TextDecoder().decode(fs.files.get('/workspace/a.txt'))).toBe('the owner\'s save');
	});
});

describe('the codemode sandbox namespace', () => {
  test('the listing has one name on the declared and runtime surfaces', () => {
    const { executor, namespace } = rig(new ContainerFs());

    expect(executor.tools['listFiles']).toBeUndefined();
    expect(namespace.tools['listFiles']).toBeUndefined();
    expect(namespace.tools['fs.list']).toBeDefined();
    expect(namespace.declarations).toHaveProperty(['fs.list']);
    expect(namespace.declarations).not.toHaveProperty('listFiles');
  });

	test("computer.fs.list('.') and computer.fs.list('./') list the machine's home", async () => {
		const fs = new ContainerFs();
		const { namespace, file } = rig(fs);

		await file({ op: 'write', path: '/computer/workspace/a.mjs', content: 'a\n' });

		const readDirectory = present(namespace.tools['fs.list'], 'computer.fs.list');

		const [trailing, dot] = await Promise.all([
			readDirectory.execute('./'), readDirectory.execute('.'),
		]);

		for (const listing of [trailing, dot]) {
			expect(listing).toMatchObject({ entries: ['a.mjs'] });
		}

		expect(fs.calls).toEqual([
			`listFiles:${WORKSPACE_BACKUP_DIR}`, `listFiles:${WORKSPACE_BACKUP_DIR}`,
		]);

		const root = await file({ op: 'list', path: '/computer/workspace' });

		expect(root).toMatchObject({ path: '/computer/workspace', entries: ['a.mjs'] });
	});

	test('computer.fs.list refuses a missing path before touching the machine', async () => {
		const fs = new ContainerFs();
		const { namespace } = rig(fs);
		expect(await present(namespace.tools['fs.list'], 'computer.fs.list').execute()).toMatchObject({ success: false, reason: 'bad_input' });
		expect(fs.calls).toEqual([]);
	});

	// rc22 release evals: a program's binary read came back re-encoded. The computer's plane moves bytes as base64.
	test("computer.fs reads a file's bytes and writes them back exactly, through base64", async () => {
		const fs = new ContainerFs();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xc3, 0x28, 0x80]);

		fs.files.set('/workspace/chart.png', png);
		const { namespace } = rig(fs);
		const read = await present(namespace.tools['fs.text'], 'computer.fs.text').execute('chart.png', { encoding: 'base64' });

		expect(await present(namespace.tools['fs.write'], 'computer.fs.write').execute('copy.png', read, { encoding: 'base64' })).toMatchObject({ action: 'created', bytes: png.length });
		expect(Array.from(fs.files.get('/workspace/copy.png') ?? [])).toEqual(Array.from(png));
	});

	test('computer.fs reads its root and home, and refuses a path spelled above its root', async () => {
		const fs = new ContainerFs();

		for (const [path, body] of [['/x', 'root bytes'], ['/workspace/relative.md', 'home bytes'], ['/etc/hosts', 'machine hosts']]) {
			fs.files.set(path, new TextEncoder().encode(body));
		}

		fs.dirs.add('/etc');
		const { namespace } = rig(fs);

		expect(await present(namespace.tools['fs.read'], 'computer.fs.read').execute('/x')).toContain('root bytes');
		expect(await present(namespace.tools['fs.text'], 'computer.fs.text').execute('relative.md')).toBe('home bytes');
		expect(await present(namespace.tools['fs.text'], 'computer.fs.text').execute('/../etc/hosts')).toMatchObject({ success: false, reason: 'denied' });
		expect(fs.calls.some((call) => call.includes('hosts'))).toBe(false);
	});

	test('computer.fs and file share reads, writes and edits in both directions', async () => {
		const fs = new ContainerFs();

		for (const path of ['/x', '/edit', '/write-back', '/edit-back']) {
			fs.files.set(path, new TextEncoder().encode('original bytes'));
		}

		const { namespace, file } = rig(fs);
		const read = present(namespace.tools['fs.read'], 'computer.fs.read');
		const write = present(namespace.tools['fs.write'], 'computer.fs.write');
		const edit = present(namespace.tools['fs.edit'], 'computer.fs.edit');

		await expect(file({ op: 'write', path: '/computer/x', content: 'blind' })).rejects.toMatchObject({ verdict: 'unread' });
		await read.execute('/x');
		expect(await file({ op: 'write', path: '/computer/x', content: 'changed bytes' })).toMatchObject({ action: 'replaced' });
		await read.execute('/edit');
		expect(await file({ op: 'edit', path: '/computer/edit', edits: [{ old_text: 'original', new_text: 'edited' }] })).toMatchObject({ path: '/computer/edit' });
		await file({ op: 'read', path: '/computer/write-back' });
		expect(await write.execute('/write-back', 'back through fs')).toMatchObject({ action: 'replaced' });
		await file({ op: 'read', path: '/computer/edit-back' });
		expect(await edit.execute('/edit-back', [{ old_text: 'original', new_text: 'again' }])).toMatchObject({ path: '/computer/edit-back' });
		expect(new TextDecoder().decode(fs.files.get('/x'))).toBe('changed bytes');
		expect(new TextDecoder().decode(fs.files.get('/edit'))).toBe('edited bytes');
		expect(new TextDecoder().decode(fs.files.get('/write-back'))).toBe('back through fs');
		expect(new TextDecoder().decode(fs.files.get('/edit-back'))).toBe('again bytes');
	});

	test('machine declarations group fs while the description shows fs.read call forms', () => {
		const { namespace } = rig(new ContainerFs());
		const declaration = namespaceDeclaration(namespace.name, namespace.declarations ?? {});
		expect(declaration).toContain('fs: {');
		expect(declaration).toContain('read(');
		expect(declaration).not.toContain('fs.read(');
		expect(renderCodemodeDescription([namespace])).toContain('fs.read(');
	});
});

describe("a machine path reaches the plane as written; one spelled above the machine's root is refused", () => {
	const cases = [
		{ name: 'relative with home', home: '/workspace', path: 'x', expected: '/computer/workspace/x' },
		{ name: "relative without home starts at the machine's root", home: undefined, path: 'x', expected: '/computer/x' },
		{ name: 'trailing slash', home: '/workspace/', path: 'dir/', expected: '/computer/workspace/dir/' },
		{ name: 'absolute trailing slash', home: undefined, path: '/dir/', expected: '/computer/dir/' },
		{ name: 'a parent inside the machine is left to its walk', home: undefined, path: '/a/b/../x', expected: '/computer/a/b/../x' },
		{ name: 'a relative parent is left to its walk', home: '/workspace', path: '../etc/x', expected: '/computer/workspace/../etc/x' },
		{ name: 'dot component', home: undefined, path: '/a/./x', expected: '/computer/a/./x' },
		{ name: 'dot relative to home', home: '/workspace', path: '.', expected: '/computer/workspace/.' },
		{ name: 'dot without home', home: undefined, path: '.', expected: '/computer/.' },
		{ name: 'the root', home: undefined, path: '/', expected: '/computer/' },
	];

	/** The plane path `computer.fs.stat(path)` asks of the file operations, or what refused it. */
	const asked = async (home: string | undefined, path: string): Promise<string | JsonValue> => {
		const paths: string[] = [];

		const files = { stat: { op: FILE.stat, run: async (input: JsonValue) => {
			paths.push(v.parse(v.object({ path: v.string() }), input).path);

			return { value: { path: '', size: 0, mtimeMs: 0, isDir: false } };
		} } };

		const provider = {
			name: 'computer', tools: {}, positionalArgs: true, capabilities: new Set<ExecutorCapability>(),
			fileRoot: async () => (home === undefined ? { root: '/computer' } : { root: '/computer', home }),
		} satisfies ExecutorProviderSurface;

		const answered = await executorNamespace(provider, files).tools['fs.stat']?.execute(path);

		return paths[0] ?? v.parse(JsonValueSchema, answered);
	};

	for (const each of cases) {
		test(each.name, async () => { expect(await asked(each.home, each.path)).toBe(each.expected); });
	}

	// No guess at where a link leads: a spelling that climbs above the machine's root is refused, never rewritten.
	for (const [home, path] of [[undefined, '/a/../../x'], [undefined, '/../etc/hosts'], ['/workspace', '../../x'], [undefined, '..']] as const) {
		test(`${path} from ${home ?? '/'} is refused`, async () => {
			expect(await asked(home, path)).toMatchObject({ success: false, reason: 'denied', error: expect.stringContaining('above') });
		});
	}
});

test("workspace.fs and file reach the same file through a link and the parents after it, as the plane walks them", async () => {
	const tree = new CompositeVFS(new MemoryVFS());

	await tree.mkdir('/home/main/deep/inner', { recursive: true });
	await tree.writeFile('/home/main/target.txt', new TextEncoder().encode('target\n'));
	await tree.symlink('/home/main/deep/inner', '/home/main/link');

	// The workspace's plane over that tree as the cloud's is: the namespace walks every path, after a link as open(2) does.
	const vfs = withMountTable({ namespace: async () => tree, home: '/home/main' }, []);
	const deps: FileDeps = { vfs, home: '/home/main', planes: cloudPlanes('/home/main'), ledger: new TurnFileLedger(), budget: new TurnContextBudget() };
	const files = serveFile(() => deps);

	const workspace = {
		name: 'workspace', tools: {}, positionalArgs: true, capabilities: new Set<ExecutorCapability>(), fileRoot: async () => ({ root: '' }),
	} satisfies ExecutorProviderSurface;

	const through = '/home/main/link/../../../../home/main/target.txt';

	expect(await files.text.run({ path: through }, { callId: 'file-text' })).toMatchObject({ value: 'target\n' });
	expect(await present(executorNamespace(workspace, files).tools['fs.text'], 'workspace.fs.text').execute(through)).toBe('target\n');
});

