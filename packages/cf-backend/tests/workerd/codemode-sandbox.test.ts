/**
 * The `execute_tools` sandbox, run for real: the @cloudflare/codemode
 * DynamicWorkerExecutor over `env.LOADER`, loading Kinu's `kinu-node.js`
 * module beside the program, with the `tools` prelude defining crafted tools.
 *
 * `bun test` cannot host this: the loader, the child isolate, the `nodejs_compat`
 * builtins the shim imports (`node:path`, `node:crypto`, …) and the RPC hop
 * between the sandbox proxy and the host dispatcher are all platform. What the
 * unit tier checks is the prelude TEXT and the shim's functions in isolation;
 * this file checks that the whole thing loads and runs under workerd.
 */
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { decodeJsonValue, type JsonValue } from '@kinu.run/core';
import { KinuSandboxExecutor, renderToolsPrelude } from '../../src/codemode-sandbox';
import { codemodeEgress } from '../../src/codemode-egress';

const files = new Map<string, string>([['notes.md', 'hello from the workspace']]);

/** A host function's arguments arrive positionally over the sandbox RPC, the
 * same shape every production provider parses at its own boundary. */
const text = (args: unknown[], at: number): string => v.parse(v.string(), args[at]);

/** A `workspace` namespace with the members the fs shim reaches. */
const workspace = {
  name: 'workspace',
  fns: {
    readFile: async (...args: unknown[]) => {
      const path = text(args, 0);
      const stored = files.get(path);
      if (stored === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return stored;
    },
    writeFile: async (...args: unknown[]) => {
      files.set(text(args, 0), text(args, 1));
      return 'ok';
    },
    readdir: async () => [...files.keys()],
    exists: async (...args: unknown[]) => files.has(text(args, 0)),
    exec: async (...args: unknown[]) => `ran: ${text(args, 0)}`,
  },
};

function toolsProvider(crafted: Array<{ name: string; code: string; description: string }>) {
  return {
    name: 'tools',
    fns: {
      file: async (...args: unknown[]) => ({ echoed: decodeJsonValue({ value: args[0] }) }),
    },
    prelude: renderToolsPrelude(crafted, { workspace: 'probe' }),
  };
}

const state = new Map<string, JsonValue>();
const stateProvider = {
  name: 'state',
  fns: {
    get: async (...args: unknown[]) => state.get(text(args, 0)) ?? null,
    set: async (...args: unknown[]) => {
      state.set(text(args, 0), decodeJsonValue({ value: args[1] }));
      return { ok: true };
    },
  },
};

describe('the execute_tools sandbox under workerd', () => {
  const executor = new KinuSandboxExecutor({ loader: env.LOADER, egress: null });

  test('require("fs/promises") and require("path") work over the workspace, and console output comes back', async () => {
    const program = [
      '// Read a note through the Node fs shim',
      "const fs = require('fs/promises');",
      "const path = require('node:path');",
      "const text = await fs.readFile('notes.md', 'utf8');",
      "await fs.writeFile(path.join('out', 'copy.md'), text.toUpperCase());",
      "console.log('read', text.length, 'bytes');",
      "return { text, listing: await fs.readdir('.'), workspace: env.workspace };",
    ].join('\n');
    const result = await executor.execute(program, [toolsProvider([]), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      text: 'hello from the workspace',
      listing: ['notes.md', 'out/copy.md'],
      workspace: 'probe',
    });
    expect(result.logs).toEqual(['read 24 bytes']);
    expect(files.get('out/copy.md')).toBe('HELLO FROM THE WORKSPACE');
  });

  test('a native tool is tools.<name>(input), a crafted tool is defined by the prelude and sees its siblings', async () => {
    const crafted = [
      { name: 'double', code: 'async (n) => n * 2', description: 'doubles' },
      { name: 'quad', code: 'async (n) => (await tools.double(n)) * 2', description: 'quadruples' },
    ];
    const program = [
      '// Call a native tool and two crafted tools',
      "const native = await tools.file({ action: 'read', path: 'notes.md' });",
      'return { native, quad: await tools.quad(3) };',
    ].join('\n');
    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ native: { echoed: { action: 'read', path: 'notes.md' } }, quad: 12 });
  });

  test('a crafted tool that does not parse breaks only itself, with the parse error on call', async () => {
    const crafted = [
      { name: 'broken', code: 'const broken = async () => 1', description: '' },
      { name: 'fine', code: 'async () => 2', description: '' },
    ];
    const program = [
      '// One broken tool must not take the sandbox down',
      'let failure = null;',
      'try { await tools.broken(); } catch (e) { failure = e.message; }',
      'return { fine: await tools.fine(), failure };',
    ].join('\n');
    const result = await executor.execute(program, [toolsProvider(crafted), stateProvider, workspace]);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      fine: 2,
      failure: expect.stringContaining('[crafted:broken] failed to load: stored source does not parse'),
    });
  });

  test('state survives between two programs, and a host failure is attributed to its namespace member', async () => {
    const first = await executor.execute("// save\nawait state.set('n', 41); return 'saved'", [toolsProvider([]), stateProvider, workspace]);
    expect(first.result).toBe('saved');
    const second = await executor.execute("// load\nreturn (await state.get('n')) + 1", [toolsProvider([]), stateProvider, workspace]);
    expect(second.result).toBe(42);

    const failed = await executor.execute(
      "// read a file that is not there\nreturn await workspace.readFile('absent.md')",
      [toolsProvider([]), stateProvider, workspace],
    );
    expect(failed.result).toBeUndefined();
    expect(failed.error).toContain('workspace.readFile: ');
    expect(failed.error).toContain('ENOENT');
  });

  test('fetch is absent without egress and reaches the network stack through the loopback entrypoint', async () => {
    const program = "// probe the network\ntry { await fetch('https://example.invalid/'); return 'reached'; } catch (e) { return 'threw: ' + e.message; }";
    const offline = await executor.execute(program, [toolsProvider([]), stateProvider, workspace]);
    expect(String(offline.result)).toContain('threw: ');

    // `exports.CodemodeEgress` is the loopback stub `enable_ctx_exports` mints
    // for the class the test worker exports beside its probes.
    const egress = codemodeEgress();
    expect(egress).not.toBeNull();
    const online = new KinuSandboxExecutor({ loader: env.LOADER, egress });
    const result = await online.execute(program, [toolsProvider([]), stateProvider, workspace]);
    // A `.invalid` host resolves for nobody, so what differs from the offline
    // arm is the message: the network stack's own failure, carried back through
    // the egress entrypoint's marked 502 and rethrown by the program's `fetch`,
    // instead of the sandbox refusing the call outright.
    expect(String(offline.result)).toContain('not permitted to access the internet');
    expect(String(result.result)).toContain('threw: fetch failed: ');
    expect(String(result.result)).not.toContain('not permitted to access the internet');
  });

  test('a program cannot reach cloud metadata, and is told why', async () => {
    // The seam's whole point, inside the real runtime: the same address the
    // approval gate denies as a shell command and `web.fetch` refuses as a URL
    // is refused here too, by the one shared classifier — before any DNS
    // lookup or socket, so nothing leaves the isolate.
    const egress = codemodeEgress();
    expect(egress).not.toBeNull();
    const online = new KinuSandboxExecutor({ loader: env.LOADER, egress });
    const program = "// probe the metadata service\ntry { await fetch('http://169.254.169.254/latest/meta-data/'); return 'reached'; } catch (e) { return 'threw: ' + e.message; }";

    const result = await online.execute(program, [toolsProvider([]), stateProvider, workspace]);

    expect(String(result.result)).toContain('threw: fetch failed: ');
    expect(String(result.result)).toContain('blocked private/internal address');
    expect(String(result.result)).not.toContain('reached');
  });

  test('a bare native tool name is corrected toward tools.<name>', async () => {
    const result = await executor.execute("// misuse\nreturn await run({ command: 'ls' })", [toolsProvider([]), stateProvider, workspace]);
    expect(result.error).toContain('"run" is a native Kinu tool');
    expect(result.error).toContain('`tools.run(input)`');
  });
});
