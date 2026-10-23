/**
 * An `eval` program that imports from the workspace runs as a Node program there (`node-program.ts`), as one command
 * of its own `workspace.exec`. Here that command runs in a real directory under a real Node (Bun where none is
 * installed), and the egress is this test's server: it answers the program's namespace calls through
 * `serveNodeProgramCall` as the actor's egress would. Defends: a relative import or a node_modules package that does
 * not resolve, a namespace call that reaches another caller's program, files the run leaves behind, and a native
 * addon's failure left unexplained.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedProvider } from '@cloudflare/codemode';
import { programPlace, type EgressPrincipal, type JsonValue, type ProgramImport } from '@kinu.run/core';
import { NODE_PROGRAM_HOST, runNodeProgram, serveNodeProgramCall } from '../src/node-program';

const OWNER: EgressPrincipal = { as: 'owner', workspace: 'kinu-test', actorId: 'actor-1', ownerUserId: 'user-1' };

let cwd = '';

let egress: ReturnType<typeof Bun.serve> | null = null;

/** Who the test's egress says is calling, as Kinu's says the principal it was minted for. */
let caller: EgressPrincipal = OWNER;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'kinu-node-program-'));
  await writeFile(join(cwd, 'lib.mjs'), 'export const x = 41;\n');
  await mkdir(join(cwd, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(cwd, 'node_modules', 'left-pad', 'package.json'), '{ "name": "left-pad", "main": "index.js" }\n');
  await writeFile(join(cwd, 'node_modules', 'left-pad', 'index.js'), "module.exports = (text, width) => String(text).padStart(width, '.');\n");
  await writeFile(join(cwd, 'addon.node'), 'not a shared object');
  egress = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const answer = await serveNodeProgramCall(caller, request.headers.get('x-kinu-program'), await request.json());

      return Response.json(answer.body, { status: answer.status });
    },
  });
});

afterAll(async () => {
  await egress?.stop(true);
  await rm(cwd, { recursive: true, force: true });
});

/** The workspace's `exec` with `parts`, run by bash in `cwd`, its namespace calls sent to the test's egress. */
function workspace(calls: JsonValue[][]): ResolvedProvider {
  return {
    name: 'workspace',
    fns: {
      exec: async (...args) => {
        const [command, options] = args;
        const at = typeof options === 'object' && options !== null && 'cwd' in options && typeof options.cwd === 'string' ? options.cwd : cwd;

        // As the workspace's shell refuses a word naming one of its planes (`shellReference`).
        if (/\b(?:vfs|local):\/\//u.test(String(command))) return { success: false, error: "the shell takes this machine's paths" };

        // The egress's part: a call to the program host reaches this test's server. Each module rides as base64.
        const routed = String(command).replace(/printf '%s' '([A-Za-z0-9+/=]*)'/gu, (_, encoded: string) => {
          const module = Buffer.from(encoded, 'base64').toString('utf8').replaceAll(`https://${NODE_PROGRAM_HOST}/`, `http://127.0.0.1:${String(egress?.port)}/`);

          return `printf '%s' '${Buffer.from(module, 'utf8').toString('base64')}'`;
        });

        const ran = Bun.spawn(['bash', '-c', `command -v node >/dev/null || node() { ${JSON.stringify(process.execPath)} "$@"; }\n${routed}`], { cwd: at, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(ran.stdout).text(), new Response(ran.stderr).text(), ran.exited]);

        return { stdout, stderr, exitCode };
      },
      read: async (...args) => {
        calls.push(args.map((arg) => (typeof arg === 'string' ? arg : null)));

        return `read ${String(args[0])}`;
      },
      fail: async () => { throw new Error('the file plane refused it'); },
    },
  };
}

async function run(code: string, calls: JsonValue[][] = []) {
  const place = programPlace(code);
  const imports: readonly ProgramImport[] = place.kind === 'node' ? place.imports : [];

  return await runNodeProgram({
    code, imports, providers: [workspace(calls)], principal: { workspace: OWNER.workspace, actorId: OWNER.actorId, as: 'owner' }, cwd, crafted: [], prelude: '',
  });
}

describe('an eval program that imports from the workspace runs there as Node', () => {
  test('its relative imports and node_modules packages resolve from its directory, and its namespaces answer', async () => {
    const calls: JsonValue[][] = [];

    const answer = await run([
      '// Join a workspace module, a package and a namespace call',
      "import { x } from './lib.mjs';",
      "const pad = require('left-pad');",
      "console.log('working');",
      "return { sum: x + 1, padded: pad('a', 3), read: await workspace.read('notes.md'), cwd: process.cwd() === " + JSON.stringify(cwd) + ' };',
    ].join('\n'), calls);

    expect(answer).toEqual({ result: { sum: 42, padded: '..a', read: 'read notes.md', cwd: true }, logs: ['working'] });
    expect(calls).toEqual([['notes.md']]);
    expect((await readdir(cwd)).filter((name) => name.startsWith('.kinu-eval-'))).toEqual([]);
  });

  // staging d56a6f234: the shell refuses a command that names a plane (`vfs://…`), and the program's source rode in its
  // command as text; it rides as base64 now, which names nothing.
  test("a program whose source names one of the workspace's planes runs as written", async () => {
    const answer = await run("import { x } from './lib.mjs';\nreturn 'vfs://notes/a.md and local://src/b.ts ' + x;");

    expect(answer).toEqual({ result: 'vfs://notes/a.md and local://src/b.ts 41', logs: [] });
  });

  test('a namespace call that throws throws in the program, and an uncaught error is its answer', async () => {
    const caught = await run("import { x } from './lib.mjs';\ntry { await workspace.fail(); } catch (error) { return String(error.message); }");
    const thrown = await run("import { x } from './lib.mjs';\nthrow new Error('the program gave up at ' + x);");

    expect(caught.result).toContain('the file plane refused it');
    expect(thrown.error).toContain('the program gave up at 41');
  });

  test("a call made as another caller, or with another program's token, is refused", async () => {
    caller = { as: 'viewer', workspace: OWNER.workspace, actorId: null };

    try {
      const answer = await run("import { x } from './lib.mjs';\ntry { await workspace.read('a'); } catch (error) { return String(error.message); }");

      expect(answer.result).toContain('not running, or not as this caller');
    } finally {
      caller = OWNER;
    }

    expect(await serveNodeProgramCall(OWNER, 'no-such-program', { namespace: 'workspace', member: 'read', args: [] }))
      .toEqual({ status: 403, body: { thrown: 'This program is not running, or not as this caller.' } });
  });

  test("a native addon's failure says that native addons don't load", async () => {
    const answer = await run("const addon = require('./addon.node');\nreturn addon;");

    expect(answer.error).toContain("Native addons (compiled .node files) don't load here");
  });
});
