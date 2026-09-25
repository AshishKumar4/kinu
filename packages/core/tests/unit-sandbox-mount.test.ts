/**
 * The `/sandbox` mount end to end: `file` tool and codemode `sandbox.*` over one container view.
 * The double follows the SDK: misses and empty paths throw typed errors, and relative paths
 * resolve against `/workspace`.
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { TurnContextBudget } from '../src/context-budget';
import { createSandboxExecutor, WORKSPACE_BACKUP_DIR, type SandboxHandle } from '../src/execution/sandbox';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { createFileTool, type FileToolInput } from '../src/tools/file-tool';
import { isVfsError } from '../src/vfs/errno';
import { standardMounts, withMountTable } from '../src/vfs/mounts';
import { bytesToBase64 } from '../src/utils/base64';
import type { VFS } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

/** SDK error as carried across the DO hop: own properties only; the `code` getter is lost. */
function sdkError(name: string, code: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	Object.defineProperty(error, 'errorResponse', { value: { code }, enumerable: true });

	return error;
}

const sdkNotFound = (path: string): Error =>
	sdkError('FileNotFoundError', 'FILE_NOT_FOUND', `File not found: ${path}`);

class ContainerFs {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>(['/', WORKSPACE_BACKUP_DIR]);
	readonly calls: string[] = [];

	resolve(path: string): string {
		if (path === '') {
			throw sdkError('ValidationFailedError', 'VALIDATION_FAILED',
				`Invalid path format for '': Path must be a non-empty string`);
		}

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
		async readFile(path) {
			const resolved = fs.resolve(path);

			if (fs.dirs.has(resolved)) {
				throw sdkError('FileSystemError', 'IS_DIRECTORY', `Is a directory: ${resolved}`);
			}

			const bytes = fs.files.get(resolved);

			if (bytes === undefined) throw sdkNotFound(resolved);

			return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', exitCode: 0 };
		},
		async writeFile(path, content, opts) {
			const resolved = fs.resolve(path);
			const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';

			if (!fs.dirs.has(parent)) throw sdkNotFound(parent);

			fs.files.set(resolved, opts?.encoding === 'base64'
				? new Uint8Array(Buffer.from(content, 'base64'))
				: new TextEncoder().encode(content));
		},
		async listFiles(path) {
			const resolved = fs.resolve(path);
			fs.calls.push(`listFiles:${resolved}`);

			if (fs.files.has(resolved)) {
				throw sdkError('FileSystemError', 'NOT_DIRECTORY', `Not a directory: ${resolved}`);
			}

			if (!fs.dirs.has(resolved)) throw sdkNotFound(resolved);

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
						? { name, type: 'file', size: bytes.length }
						: { name, type: 'directory', size: 0 };
				}),
			};
		},
		async deleteFile(path) {
			const resolved = fs.resolve(path);

			if (!fs.files.delete(resolved)) throw sdkNotFound(resolved);
		},
		async exec(command) {
			const quoted = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
			const target = quoted.at(-1) ?? '';

			if (command.startsWith('mkdir')) {
				fs.dirs.add(target);

				return { exitCode: 0, stdout: '' };
			}

			if (command.startsWith('test -e')) {
				return { exitCode: 0, stdout: fs.files.has(target) || fs.dirs.has(target) ? 'true' : 'false' };
			}

			// The adapter's ranged read (`dd`); an empty answer would make windowed reads see empty files.
			const window = /\bdd if='[^']*' bs=1 skip=(\d+) count=(\d+)/.exec(command);

			if (window) {
				const bytes = fs.files.get(target);

				if (!bytes) {
					return { exitCode: 1, stdout: '', stderr: `dd: failed to open '${target}': No such file or directory` };
				}

				const from = Number(window[1]);

				return { exitCode: 0, stdout: bytesToBase64(bytes.subarray(from, from + Number(window[2]))) };
			}

			return { exitCode: 0, stdout: '' };
		},
		async exposePort(port) { return { url: `https://preview.invalid/${port}`, port, route: { reached: true } }; },
		async unexposePort() {},
		async getExposedPorts() { return []; },
		...sandboxHandleLifecycle,
	};

	return handle;
}

/** The mount table only asks the base for non-`/sandbox` paths. */
function basePlane(): VFS {
	return {
		readFile: async (path) => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); },
		writeFile: async () => { throw new Error('the base plane in this test holds nothing'); },
		readdir: async () => [],
		stat: async () => null,
		unlink: async () => {},
		mkdir: async () => {},
		exists: async () => false,
	};
}

function rig(fs: ContainerFs) {
	const executor = createSandboxExecutor(container(fs));

	const mounted = withMountTable(basePlane(), standardMounts((name) =>
		name === 'sandbox' ? executor : undefined));

	const file = toolExecute<FileToolInput, JsonValue>(createFileTool({
		vfs: mounted, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
	}));

	return { executor, mounted, file };
}

describe('the file tool across the /sandbox mount', () => {
	test('write of a NEW file creates it, and a read returns the bytes', async () => {
		const fs = new ContainerFs();
		const { file } = rig(fs);

		const written = await file({
			action: 'write', path: '/sandbox/workspace/broken.mjs', content: 'export const x = 1;\n',
		});

		expect(written).toMatchObject({ ok: true, action: 'created' });
		expect(new TextDecoder().decode(fs.files.get('/workspace/broken.mjs'))).toBe('export const x = 1;\n');
		expect(await file({ action: 'read', path: '/sandbox/workspace/broken.mjs' }))
			.toBe('export const x = 1;\n');
	});

	test('write of an existing file replaces it', async () => {
		const fs = new ContainerFs();
		const { file } = rig(fs);

		await file({ action: 'write', path: '/sandbox/workspace/broken.mjs', content: 'v1\n' });

		const replaced = await file({
			action: 'write', path: '/sandbox/workspace/broken.mjs', content: 'v2\n',
		});

		expect(replaced).toMatchObject({ ok: true, action: 'replaced' });
		expect(await file({ action: 'read', path: '/sandbox/workspace/broken.mjs' })).toBe('v2\n');
	});

	test('a write under a directory the container does not have fails ENOENT, not io', async () => {
		const { mounted } = rig(new ContainerFs());

		let error: unknown;

		try { await mounted.readFile('/sandbox/nowhere/x.txt'); } catch (cause) { error = cause; }

		expect(isVfsError(error) && error.code === 'ENOENT').toBe(true);
	});
});

describe('the codemode sandbox namespace', () => {
	test("listFiles('') and listFiles('.') list the working directory — the mount's /workspace view", async () => {
		const fs = new ContainerFs();
		const { executor, file } = rig(fs);

		await file({ action: 'write', path: '/sandbox/workspace/a.mjs', content: 'a\n' });

		const listFiles = executor.tools.listFiles;

		const [empty, dot, absent] = await Promise.all([
			listFiles.execute(''), listFiles.execute('.'), listFiles.execute(),
		]);

		for (const listing of [empty, dot, absent]) {
			expect(listing).toContain('- a.mjs');
		}

		expect(empty).toBe(dot);
		expect(fs.calls).toEqual([
			`listFiles:${WORKSPACE_BACKUP_DIR}`, `listFiles:${WORKSPACE_BACKUP_DIR}`, `listFiles:${WORKSPACE_BACKUP_DIR}`,
		]);

		const root = await file({ action: 'list', path: '/sandbox/workspace' });

		expect(root).toMatchObject({ path: '/sandbox/workspace', entries: ['a.mjs'] });
	});

	test('readdir answers what listFiles answers', async () => {
		const fs = new ContainerFs();
		const { executor, file } = rig(fs);

		await file({ action: 'write', path: '/sandbox/workspace/a.mjs', content: 'a\n' });

		expect(await executor.tools.readdir.execute(''))
			.toBe(await executor.tools.listFiles.execute(''));
	});
});
