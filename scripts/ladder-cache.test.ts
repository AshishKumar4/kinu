/**
 * The cache is sound — proved red in every direction it claims, over a
 * throwaway repository with real gate scripts and a scratch store.
 *
 * Every direction from the owner's brief is one test below, and each test
 * asserts the MISS or the REFUSAL as well as the hit: a suite that only saw
 * hits could not tell a cache from a `true`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { childEnv, git, initRepo, runToExit, scratchDir } from '@kinu.run/test-utils';
import { claims, LADDER, gatesFor, testFileProofs } from './ladder';
import type { Gate, TestProof } from './ladder';
import { auditClosure } from './ladder-audit';
import {
  CACHE_BLIND_SPOTS, cacheEnabled, gateEnvironment, gateEnvNames, keyFor, planGate, recordGreen, storeAt, toolVersions,
} from './ladder-cache';
import type { Plan, Store, ToolVersions } from './ladder-cache';
import { deriveClosure, repoAt } from './ladder-closure';
import type { Derived, Inputs, Repo } from './ladder-closure';

const DERIVED: Inputs = { kind: 'derived', reads: [], env: [] };

interface Fixture {
  readonly root: string;
  readonly store: Store;
  readonly tools: ToolVersions;
  repo(): Repo;
}

/** A committed repository with an installed `typescript` manifest (so the
 *  toolchain reads a version), a scratch store beside it, and `files`. */
async function fixture(files: Record<string, string>, scripts: Record<string, string> = {}): Promise<Fixture> {
  const root = scratchDir('ladder-cache');
  await initRepo(root);

  const all = {
    'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/*'], scripts }),
    'bun.lock': '{}',
    'bunfig.toml': '[test]\npreload = ["./scripts/preload.ts"]\n',
    'scripts/preload.ts': 'export const preloaded = 1;',
    '.gitignore': 'node_modules/\n',
    ...files,
  } satisfies Record<string, string>;

  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '7.0.2' }));
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'fixture');

  return {
    root,
    store: storeAt(join(scratchDir('ladder-cache-store'), 'kinu-ladder')),
    tools: toolVersions(root, 'v24.0.0'),
    repo: () => repoAt(root, (run, tracked) => claims(run, tracked)),
  };
}

/** Run the gate the way the ladder does and record it if green. Returns the
 *  plan the run was made under and the recorder's refusal, if any. */
interface GateRun {
  readonly plan: Plan;
  readonly refused: string | undefined;
  readonly exitCode: number | null;
}

async function runGate(fx: Fixture, run: string, inputs: Inputs = DERIVED, tools = fx.tools): Promise<GateRun> {
  const repo = fx.repo();
  const plan = planGate({ run, inputs, repo, tools, store: fx.store });

  if (plan.kind === 'hit') return { plan, refused: undefined, exitCode: 0 };
  const env = plan.kind === 'miss' ? gateEnvironment(plan.closure) : undefined;
  const proc = await runToExit(run.split(' '), { cwd: fx.root, env });

  if (plan.kind === 'uncacheable' || proc.exitCode !== 0) return { plan, refused: undefined, exitCode: proc.exitCode };
  const refused = recordGreen(plan, { run, inputs, repo: fx.repo(), tools, store: fx.store }, { seconds: 0.1, revision: 'fixture' });

  return { plan, refused, exitCode: proc.exitCode };
}

const GREEN = 'process.exit(0);';

/** Entries in the store. An absent directory is a store nothing has written
 *  to, which is the property most of these tests assert. */
const entries = (store: Store): string[] => (existsSync(store.directory) ? readdirSync(store.directory) : []);

/** `body` under this process's environment with `values` applied (undefined
 *  unsets a name), restored afterwards: the key reads the process's own
 *  environment, as the ladder does. */
function withEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const saved = savedEnv(values);
  applyEnv(values);

  try {
    return body();
  } finally {
    applyEnv(saved);
  }
}

/** `withEnv` for a body that spawns: the values hold until the body settles. */
async function withEnvWhile<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = savedEnv(values);
  applyEnv(values);

  try {
    return await body();
  } finally {
    applyEnv(saved);
  }
}

function savedEnv(values: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

describe('ladder-cache — the green path', () => {
  test('an identical changed-hook retry uses the first green proof, not another run', async () => {
    const fx = await fixture({ 'scripts/a.ts': 'console.log("executed");' });
    const ran: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const enabled = cacheEnabled({ noCache: false });

      if (!enabled) {
        const run = await runToExit(['bun', 'scripts/a.ts'], { cwd: fx.root, env: childEnv() });

        expect(run.exitCode).toBe(0);
        ran.push(run.stdout.trim());
      } else if ((await runGate(fx, 'bun scripts/a.ts')).plan.kind !== 'hit') ran.push('executed');
    }

    expect(ran).toEqual(['executed']);
    expect(entries(fx.store)).toHaveLength(1);
    expect(cacheEnabled({ noCache: true })).toBe(false);
  });

  // m2081, m1912: every CI part reran its whole assigned suites, so an unchanged suite was proved again on each push.
  test('a CI row reuses an unchanged row\'s green proof with the file walls it measured; a hammer run never does', async () => {
    const fx = await fixture({ 'scripts/a.test.ts': GREEN });
    const repo = fx.repo();
    const run = 'bun scripts/a.test.ts';
    const first = planGate({ run, inputs: DERIVED, repo, tools: fx.tools, store: fx.store });

    if (first.kind !== 'miss') throw new Error(`expected a miss, got ${first.kind}`);
    recordGreen(first, { run, inputs: DERIVED, repo, tools: fx.tools, store: fx.store }, { seconds: 4, revision: 'a'.repeat(40), timings: { 'scripts/a.test.ts': 3.5 } });
    const again = planGate({ run, inputs: DERIVED, repo: fx.repo(), tools: fx.tools, store: fx.store });

    expect({
      row: cacheEnabled({ hammer: false, noCache: false }),
      hammer: cacheEnabled({ hammer: true, noCache: false }),
      reused: again.kind === 'hit' ? { revision: again.entry.revision, timings: again.entry.timings } : again.kind,
    }).toEqual({ row: true, hammer: false, reused: { revision: 'a'.repeat(40), timings: { 'scripts/a.test.ts': 3.5 } } });
  });

  test('after a green run, a rerun hits every cacheable gate and names the hash, the revision and the closure size', async () => {
    const fx = await fixture({
      'scripts/a.ts': `import { shared } from './shared';\nexport const a = shared;\n${GREEN}`,
      'scripts/b.ts': `import { shared } from './shared';\nexport const b = shared;\n${GREEN}`,
      'scripts/shared.ts': 'export const shared = 1;',
    });

    const first = [await runGate(fx, 'bun scripts/a.ts'), await runGate(fx, 'bun scripts/b.ts')];
    expect(first.map((r) => r.plan.kind)).toEqual(['miss', 'miss']);
    expect(first.map((r) => r.refused)).toEqual([undefined, undefined]);

    const second = [await runGate(fx, 'bun scripts/a.ts'), await runGate(fx, 'bun scripts/b.ts')];
    expect(second.map((r) => r.plan.kind)).toEqual(['hit', 'hit']);
    const [hit] = second;

    if (hit?.plan.kind !== 'hit') throw new Error('expected a hit');
    expect(hit.plan.key).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.plan.entry.revision).toBe('fixture');
    expect(hit.plan.entry.run).toBe('bun scripts/a.ts');
    expect(hit.plan.entry.closureSize).toBe(hit.plan.closure.files.length);
    expect(entries(fx.store)).toHaveLength(2);
  });

  test('the blind spots are declared, so the green path has something to print', () => {
    expect(CACHE_BLIND_SPOTS.length).toBeGreaterThanOrEqual(4);

    for (const spot of CACHE_BLIND_SPOTS) expect(spot.length).toBeGreaterThan(60);
  });
});

describe('ladder-cache — red in every direction it claims', () => {
  test('touching ONE file misses exactly the gates whose closure holds it and hits the rest', async () => {
    const fx = await fixture({
      'scripts/a.ts': `import { shared } from './shared';\nexport const a = shared;\n${GREEN}`,
      'scripts/b.ts': `import { shared } from './shared';\nexport const b = shared;\n${GREEN}`,
      'scripts/c.ts': `export const c = 1;\n${GREEN}`,
      'scripts/shared.ts': 'export const shared = 1;',
      'scripts/c.test.ts': "import { test } from 'bun:test';\nimport { c } from './c';\ntest('c', () => { if (c !== 1) throw new Error('c'); });",
      'tsconfig.json': '{}',
    });

    const gates = ['bun scripts/a.ts', 'bun scripts/b.ts', 'bun scripts/c.ts', 'bun test scripts/c.test.ts'];

    for (const run of gates) expect((await runGate(fx, run)).refused).toBeUndefined();

    const touch = async (file: string, text: string): Promise<string[]> => {
      writeFileSync(join(fx.root, file), text);

      const missed: string[] = [];

      for (const run of gates) {
        if ((await runGate(fx, run)).plan.kind === 'miss') missed.push(run);
      }

      return missed;
    };

    // A product file: only the gates whose graph reaches it.
    expect(await touch('scripts/shared.ts', 'export const shared = 2;')).toEqual(['bun scripts/a.ts', 'bun scripts/b.ts']);
    // A test file: only the gate that runs it.
    expect(await touch('scripts/c.test.ts', "import { test } from 'bun:test';\nimport { c } from './c';\ntest('c again', () => { if (c !== 1) throw new Error('c'); });"))
      .toEqual(['bun test scripts/c.test.ts']);
    // A gate's own script: only that gate.
    expect(await touch('scripts/c.ts', `export const c = 1;\n// touched\n${GREEN}`)).toEqual(['bun scripts/c.ts', 'bun test scripts/c.test.ts']);
    // A tsconfig on the path: every gate under it.
    expect(await touch('tsconfig.json', '{ "compilerOptions": {} }')).toEqual(gates);
    // The lock: every gate.
    expect(await touch('bun.lock', '{ "touched": 1 }')).toEqual(gates);
    // The preload: every bun test gate and nothing else.
    expect(await touch('scripts/preload.ts', 'export const preloaded = 2;')).toEqual(['bun test scripts/c.test.ts']);
  });

  test('a gate with no computable closure never hits', async () => {
    const fx = await fixture({
      'scripts/shell.sh': 'exit 0',
      'scripts/dyn.ts': `const name = 'shared';\nexport const dyn = () => import(\`./\${name}\`);\n${GREEN}`,
      'scripts/reads.ts': `import { readFileSync } from 'node:fs';\nexport const r = readFileSync('package.json');\n${GREEN}`,
    });

    for (const [run, inputs, why] of [
      ['bash scripts/shell.sh', DERIVED, 'shell gate'],
      ['bun scripts/dyn.ts', DERIVED, 'computed specifier'],
      ['bun scripts/reads.ts', { kind: 'derived' }, 'declares no `reads`'],
    ] as const) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { plan } = await runGate(fx, run, inputs);

        if (plan.kind !== 'uncacheable') throw new Error(`${run} planned as ${plan.kind}`);
        expect(plan.closure.kind).toBe('uncomputable');
        expect(plan.closure.why).toContain(why);
      }
    }

    expect(entries(fx.store)).toEqual([]);
  });

  test('another worktree reuses a green only on identical closure bytes', async () => {
    const files = { 'scripts/a.ts': 'import { value } from "../src/a"; console.log(value);', 'src/a.ts': 'export const value = 1;' };
    const recorded = await fixture(files);

    expect((await runGate(recorded, 'bun scripts/a.ts')).refused).toBeUndefined();
    expect((await runGate(recorded, 'bun scripts/a.ts')).plan.kind).toBe('hit');
    const other = await fixture(files);
    const plan = planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo: other.repo(), tools: other.tools, store: recorded.store });

    expect(plan.kind).toBe('hit');
    writeFileSync(join(other.root, 'src/a.ts'), 'export const value = 2;');
    expect(planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo: other.repo(), tools: other.tools, store: recorded.store }).kind).toBe('miss');
    writeFileSync(join(other.root, 'src/a.ts'), files['src/a.ts']);
    writeFileSync(join(other.root, 'src/no-consumer.ts'), 'export const unrelated = 2;');
    expect(planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo: other.repo(), tools: other.tools, store: recorded.store }).kind).toBe('hit');
  });

  test('a location-sensitive verdict never crosses worktrees even on identical closure bytes', async () => {
    const recorded = await fixture({ 'scripts/a.ts': 'console.log(process.cwd());' });
    const inputs = { kind: 'derived', location: 'checkout' } as const;

    expect((await runGate(recorded, 'bun scripts/a.ts', inputs)).plan.kind).toBe('miss');
    const other = await fixture({ 'scripts/a.ts': 'console.log(process.cwd());' });

    expect(planGate({ run: 'bun scripts/a.ts', inputs, repo: other.repo(), tools: other.tools, store: recorded.store }).kind).toBe('miss');
  });

  test.each(['', '/'])('root normalization changes only declared path values, never scalar environment or outside paths: root suffix %j', async (suffix) => {
    const a = await fixture({ 'scripts/a.ts': GREEN });
    const b = await fixture({ 'scripts/a.ts': GREEN });
    const inputs: Inputs = { kind: 'derived', env: ['KINU_ROOT', 'ALPHA'] };

    const key = (fx: Fixture, alpha: string, outside = '/usr/bin'): string => {
      const repo = { ...fx.repo(), root: fx.root + suffix };
      const closure = deriveClosure('bun scripts/a.ts', inputs, repo);

      if (closure.kind !== 'derived') throw new Error('fixture closure was not computed');

      return keyFor({ run: 'bun scripts/a.ts', repo, closure, tools: fx.tools, env: (name) => {
        if (name === 'PATH') return `${fx.root}/node_modules/.bin:${outside}`;

        if (name === 'KINU_ROOT') return fx.root;

        return name === 'ALPHA' ? alpha : undefined;
      } });
    };

    expect(key(a, 'same')).toBe(key(b, 'same'));
    expect(key(a, a.root)).not.toBe(key(b, b.root));
    expect(key(a, 'same', `${a.root}-other/bin`)).not.toBe(key(b, 'same', `${b.root}-other/bin`));
  });

  test('a red result leaves no cache entry, and the next run is still a miss', async () => {
    const fx = await fixture({ 'scripts/red.ts': 'process.exit(3);' });

    const first = await runGate(fx, 'bun scripts/red.ts');
    expect(first.exitCode).toBe(3);
    expect(first.plan.kind).toBe('miss');
    expect(entries(fx.store)).toEqual([]);
    expect((await runGate(fx, 'bun scripts/red.ts')).plan.kind).toBe('miss');
  });

  test('reusing parsed module summaries still rereads bytes and reaches a changed import', async () => {
    const fx = await fixture({ 'scripts/a.ts': 'import "../src/a";', 'src/a.ts': GREEN, 'src/b.ts': GREEN });
    const repo = fx.repo();
    const request = { run: 'bun scripts/a.ts', inputs: DERIVED, repo, tools: fx.tools, store: fx.store };
    const first = planGate(request);

    if (first.kind !== 'miss') throw new Error('the fixture had a proof before running');
    expect(recordGreen(first, request, { seconds: 0.1, revision: 'fixture' })).toBeUndefined();
    expect(planGate(request).kind).toBe('hit');
    writeFileSync(join(fx.root, 'scripts/a.ts'), 'import "../src/b";');
    const changed = planGate(request);

    expect(changed.kind).toBe('miss');
    expect(changed.closure.kind === 'derived' ? changed.closure.files : []).toContain('src/b.ts');
    expect(changed.closure.kind === 'derived' ? changed.closure.files : []).not.toContain('src/a.ts');
  });

  test('an entry a crash left unreadable is a miss, and the next green run replaces it', async () => {
    // The shape a crash left on 2026-09-22: the entry's name and size, and
    // nothing but NUL bytes where its JSON should be.
    const fx = await fixture({ 'scripts/a.ts': `export const a = 1;\n${GREEN}` });
    expect((await runGate(fx, 'bun scripts/a.ts')).refused).toBeUndefined();
    const [key] = entries(fx.store);

    if (key === undefined) throw new Error('the green run recorded nothing');
    const path = join(fx.store.directory, key);
    writeFileSync(path, Buffer.alloc(statSync(path).size));

    const { plan } = await runGate(fx, 'bun scripts/a.ts');

    if (plan.kind !== 'miss') throw new Error(`planned as ${plan.kind}`);
    expect(plan.unreadable).toContain('not JSON');
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('hit');
  });

  test('a tool version change misses everything', async () => {
    const fx = await fixture({
      'scripts/a.ts': `export const a = 1;\n${GREEN}`,
      'scripts/b.ts': `export const b = 1;\n${GREEN}`,
    });

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect((await runGate(fx, run)).refused).toBeUndefined();

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect((await runGate(fx, run)).plan.kind).toBe('hit');

    // The installed compiler moves: the key reads the manifest, not a list.
    writeFileSync(join(fx.root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '7.1.0' }));
    const moved = toolVersions(fx.root, fx.tools.node);
    expect(moved.typescript).toBe('7.1.0');

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect((await runGate(fx, run, DERIVED, moved)).plan.kind).toBe('miss');

    // Every field of the toolchain is a key input, not only the one that moved.
    for (const [field, value] of Object.entries(fx.tools)) {
      const other = { ...fx.tools, [field]: `${value}-other` };
      expect((await runGate(fx, 'bun scripts/a.ts', DERIVED, other)).plan.kind, `${field} is not a key input`).toBe('miss');
    }
  });

  test('a recorded green is reused only under the environment it was recorded in, name by name', async () => {
    const fx = await fixture({ 'scripts/a.ts': `export const a = process.env.ALPHA;\n${GREEN}` });
    const declaredBeta: Inputs = { kind: 'derived', env: ['BETA'] };
    const recordedUnder = { ALPHA: undefined, BETA: undefined, CI: undefined };
    // Read once, so the git it runs is found on the PATH this process started with.
    const repo = fx.repo();
    const planned = (inputs: Inputs = DERIVED): Plan['kind'] => planGate({ run: 'bun scripts/a.ts', inputs, repo, tools: fx.tools, store: fx.store }).kind;

    await withEnvWhile(recordedUnder, async () => {
      expect((await runGate(fx, 'bun scripts/a.ts')).refused).toBeUndefined();
      expect((await runGate(fx, 'bun scripts/a.ts', declaredBeta)).refused).toBeUndefined();
    });

    expect(withEnv(recordedUnder, () => planned())).toBe('hit');
    // The graph reads ALPHA, so a value for it, even an empty one, is another tree.
    expect(withEnv({ ...recordedUnder, ALPHA: 'x' }, () => planned())).toBe('miss');
    expect(withEnv({ ...recordedUnder, ALPHA: '' }, () => planned())).toBe('miss');
    // A name the gate is not given changes nothing it can see.
    expect(withEnv({ ...recordedUnder, UNRELATED: 'x' }, () => planned())).toBe('hit');
    // The base names every gate is given are keyed like the graph's own.
    expect(withEnv({ ...recordedUnder, CI: 'true' }, () => planned())).toBe('miss');
    expect(withEnv({ ...recordedUnder, PATH: '/opt/other' }, () => planned())).toBe('miss');
    // A name the graph never reads is keyed once the row declares it, and only then.
    expect(withEnv({ ...recordedUnder, BETA: 'y' }, () => planned())).toBe('hit');
    expect(withEnv({ ...recordedUnder, BETA: 'y' }, () => planned(declaredBeta))).toBe('miss');
  });

  test('a name the key does not hash never reaches the gate, however the gate reads the environment', async () => {
    // The planted input: a verdict that flips on an environment name the
    // walker cannot see, read through a computed key and by enumeration.
    const fx = await fixture({
      'scripts/planted.ts': [
        "const name = ['PLAN', 'TED'].join('');",
        'console.log(JSON.stringify(Object.keys(process.env).sort()));',
        'process.exit(process.env[name] === undefined ? 0 : 1);',
      ].join('\n'),
    });

    const planned = (): Plan => planGate({ run: 'bun scripts/planted.ts', inputs: DERIVED, repo: fx.repo(), tools: fx.tools, store: fx.store });
    const plan = planned();

    if (plan.kind === 'uncacheable') throw new Error(plan.closure.why);
    const ambient = Object.assign(childEnv(), { PLANTED: 'x' });
    const run = async (env: Record<string, string | undefined>) => runToExit(['bun', 'scripts/planted.ts'], { cwd: fx.root, env });

    // Handed the ambient environment, the planted value turns the gate red.
    expect((await run(ambient)).exitCode).toBe(1);
    // Handed its gate environment, the gate cannot see the name at all.
    const gated = await run(gateEnvironment(plan.closure, (name) => ambient[name]));
    expect(gated.exitCode).toBe(0);
    const seen = v.parse(v.array(v.string()), JSON.parse(gated.stdout));
    expect(seen.filter((name) => !gateEnvNames(plan.closure).includes(name))).toEqual([]);
    // So a green recorded without the name is reused with it set: no value of
    // it can split two runs of one key.
    await withEnvWhile({ PLANTED: undefined }, async () => { expect((await runGate(fx, 'bun scripts/planted.ts')).refused).toBeUndefined(); });
    expect(withEnv({ PLANTED: 'x' }, planned).kind).toBe('hit');
  });

  test('a closure that changes while the gate runs is not recorded', async () => {
    const fx = await fixture({ 'scripts/a.ts': `import { s } from './s';\nexport const a = s;\n${GREEN}`, 'scripts/s.ts': 'export const s = 1;' });
    const repo = fx.repo();
    const plan = planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo, tools: fx.tools, store: fx.store });

    if (plan.kind !== 'miss') throw new Error(`planned as ${plan.kind}`);
    // The gate ran green; an edit landed before the recorder looked again.
    writeFileSync(join(fx.root, 'scripts/s.ts'), 'export const s = 2;');
    const refused = recordGreen(plan, { run: 'bun scripts/a.ts', inputs: DERIVED, repo: fx.repo(), tools: fx.tools, store: fx.store }, { seconds: 1, revision: 'fixture' });
    expect(refused).toContain('changed while the gate ran');
    expect(entries(fx.store)).toEqual([]);
  });

  test('the never-cache list is read from each row\'s declaration, never matched by name', async () => {
    const fx = await fixture({ 'scripts/a.ts': `export const a = 1;\n${GREEN}` });
    const live = await runGate(fx, 'bun scripts/a.ts', { kind: 'live', why: 'talks to the account' });
    expect(live.plan.kind).toBe('uncacheable');
    expect(live.plan.kind === 'uncacheable' && live.plan.closure.kind).toBe('live');
    // The same command, declared derived, is cacheable: the declaration decided, not the name.
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('miss');
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('hit');
  });

  test('a built output\'s own files are in the key, so a green over a stale build never stands for the fresh one', async () => {
    const fx = await fixture({
      '.gitignore': 'node_modules/\nthird_party/mossaic/sdk/dist/\n',
      'third_party/mossaic/sdk/src/index.ts': 'export const sdk = 1;',
      'third_party/mossaic/upstream.json': '{}',
      'scripts/mossaic-sdk.ts': 'export const build = 1;',
      'scripts/a.ts': `import { sdk } from '../third_party/mossaic/sdk/src/index';\nexport const a = sdk;\n${GREEN}`,
    });

    const dist = join(fx.root, 'third_party/mossaic/sdk/dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'export const sdk = 0;');
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('miss');
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('hit');
    // The build the next install makes from the same tracked source: only the output moved.
    writeFileSync(join(dist, 'index.js'), 'export const sdk = 1;');
    expect((await runGate(fx, 'bun scripts/a.ts')).plan.kind).toBe('miss');
  });
});

describe('ladder-cache — the audit sees what the walker cannot', () => {
  // A `reads` declaration is a claim; strace is the measurement. The same
  // gate is a HOLE with the read undeclared and clean with it declared, so
  // the audit is red in the direction that matters and the declaration is
  // what turns it green — never an exclusion.
  test('a tracked file read by path is a hole until the row declares it', async () => {
    const fx = await fixture({
      'scripts/a.ts': `import { readFileSync } from 'node:fs';\nexport const a = readFileSync('fixtures/data.txt', 'utf8');\n${GREEN}`,
      'fixtures/data.txt': 'data',
    });

    const repo = fx.repo();
    const argv = ['bun', 'scripts/a.ts'];

    const undeclared = deriveClosure('bun scripts/a.ts', { kind: 'derived', reads: [] }, repo);

    if (undeclared.kind !== 'derived') throw new Error(undeclared.why);
    expect(auditClosure(argv, fx.root, undeclared, gateEnvironment(undeclared)).undeclared).toEqual(['fixtures/data.txt']);
    const declared = deriveClosure('bun scripts/a.ts', { kind: 'derived', reads: ['fixtures/data.txt'] }, repo);

    if (declared.kind !== 'derived') throw new Error(declared.why);
    const audit = auditClosure(argv, fx.root, declared, gateEnvironment(declared));
    expect(audit.undeclared).toEqual([]);
    expect(audit.covered).toBeGreaterThan(0);
  });

  test('a tracked file opened through its directory, or through a node_modules link, is judged where it lives', async () => {
    const fx = await fixture({
      'packages/p/package.json': JSON.stringify({ name: '@fx/p' }),
      'packages/p/tsconfig.json': '{}',
      'packages/p/src/p.ts': GREEN,
      'scripts/a.ts': `import { readFileSync } from 'node:fs';\nexport const p = readFileSync(process.argv[2] ?? '', 'utf8');\n${GREEN}`,
    });

    mkdirSync(join(fx.root, 'node_modules', '@fx'), { recursive: true });
    symlinkSync('../../packages/p', join(fx.root, 'node_modules', '@fx', 'p'));
    const repo = fx.repo();

    const without = (run: string, withheld: readonly string[]): Derived => {
      const closure = deriveClosure(run, { kind: 'derived', reads: [] }, repo);

      if (closure.kind !== 'derived') throw new Error(closure.why);

      return { ...closure, files: closure.files.filter((file) => !withheld.includes(file)) };
    };

    // Bun opens a package's own configs through a descriptor on its directory: `openat(12</…/packages/p>, "package.json")`.
    const configs = ['packages/p/package.json', 'packages/p/tsconfig.json'];
    const own = without('bun packages/p/src/p.ts', configs);
    expect(auditClosure(['bun', 'packages/p/src/p.ts'], fx.root, own, gateEnvironment(own)).undeclared).toEqual(configs);
    const linked = without('bun scripts/a.ts', ['packages/p/package.json']);
    const audit = auditClosure(['bun', 'scripts/a.ts', 'node_modules/@fx/p/package.json'], fx.root, linked, gateEnvironment(linked));
    expect(audit.undeclared).toEqual(['packages/p/package.json']);
  });
});

describe('ladder-cache — the live ladder declares what it never caches', () => {
  test('every row carries an inputs declaration, and every live row says why', () => {
    for (const gate of gatesFor('deploy')) {
      expect(gate.inputs, `${gate.run} declares no inputs`).toBeDefined();

      if (gate.inputs.kind === 'live') expect(gate.inputs.why.length, `${gate.run} is live with no reason`).toBeGreaterThan(30);
    }
  });

  test('the gates the brief names as never-cached are declared live', () => {
    const live = new Set(LADDER.filter((gate) => gate.inputs.kind === 'live').map((gate) => gate.run));

    for (const run of [
      'bun scripts/preflight.ts', 'bun run gate:hammer', 'bun run gate:infra', 'bun run gate:first-run',
      'bun run test:live', 'bun run evals', 'bun run gate:dependency-advisories', 'bun run gate:commit-message',
    ]) {
      expect(live.has(run), `${run} is not declared live`).toBeTrue();
    }
  });
});

describe('changed hooks prove complete files', () => {
  const row: Gate = { run: 'bun test tests/ --changed=HEAD', label: 'fixture tests', tier: 'commit', seconds: 1,
    catches: 'a failing test', blind: 'no platform', inputs: DERIVED };

  const suites = {
    'tests/a.test.ts': 'import { test, expect } from "bun:test"; import { a } from "../src/a"; test("a", () => expect(a).toBe(1));',
    'tests/b.test.ts': 'import { test, expect } from "bun:test"; import { b } from "../src/b"; test("b", () => expect(b).toBe(1));',
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': 'export const b = 1;',
  };

  const plans = (fx: Fixture): TestProof[] => {
    const proof = testFileProofs(row, fx.repo(), fx.tools, fx.store);

    if (proof === undefined) throw new Error('fixture file proofs were not computed');

    return proof;
  };

  test('identical retries hit every file, while a one-file or imported-product change misses only its consumer', async () => {
    const fx = await fixture(suites);

    for (const proof of plans(fx)) {
      expect(proof.plan.kind).toBe('miss');
      const run = await runToExit([...proof.argv], { cwd: fx.root, env: gateEnvironment(proof.plan.closure) });

      expect(run.exitCode, run.stderr).toBe(0);

      if (proof.plan.kind === 'miss') expect(recordGreen(proof.plan, { ...proof.request, repo: fx.repo() }, { seconds: 0.1, revision: 'fixture' })).toBeUndefined();
    }

    expect(plans(fx).map((proof) => proof.plan.kind)).toEqual(['hit', 'hit']);
    writeFileSync(join(fx.root, 'tests/a.test.ts'), suites['tests/a.test.ts'] + '\n// changed file\n');
    expect(plans(fx).map((proof) => [proof.file, proof.plan.kind])).toEqual([['tests/a.test.ts', 'miss'], ['tests/b.test.ts', 'hit']]);
    writeFileSync(join(fx.root, 'tests/a.test.ts'), suites['tests/a.test.ts']);
    writeFileSync(join(fx.root, 'src/b.ts'), 'export const b = 2;');
    expect(plans(fx).map((proof) => [proof.file, proof.plan.kind])).toEqual([['tests/a.test.ts', 'hit'], ['tests/b.test.ts', 'miss']]);
  });

  test('a native empty changed selection cannot record a green for a failing complete file', async () => {
    const fx = await fixture({ ...suites, 'src/a.ts': 'export const a = 2;' });
    const proof = plans(fx).find((entry) => entry.file === 'tests/a.test.ts');

    if (proof === undefined) throw new Error('the failing consumer was omitted');
    expect(proof.argv.some((word) => word.startsWith('--changed='))).toBe(false);
    const run = await runToExit([...proof.argv], { cwd: fx.root, env: gateEnvironment(proof.plan.closure) });

    expect(run.exitCode).not.toBe(0);
    expect(entries(fx.store)).toEqual([]);
  });

  test('a file edit during planning cannot turn the operation snapshot into a stale hit', async () => {
    const fx = await fixture(suites);

    for (const proof of plans(fx)) {
      if (proof.plan.kind === 'miss') expect(recordGreen(proof.plan, { ...proof.request, repo: fx.repo() }, { seconds: 0.1, revision: 'fixture' })).toBeUndefined();
    }

    let edited = false;

    const store: Store = { ...fx.store, lookup: (key) => {
      const found = fx.store.lookup(key);

      if (!edited) {
        edited = true;
        writeFileSync(join(fx.root, 'src/b.ts'), 'export const b = 2;');
      }

      return found;
    } };

    expect(testFileProofs(row, fx.repo(), fx.tools, store)).toBeUndefined();
  });
});

describe('ladder-cache — single-gate CLI', () => {
  test.each([[[]], [['--changed=HEAD']]])('a declared gate records its pass and reuses it on the next invocation: %j', async (mode) => {
    const cache = scratchDir('ladder-cache-store');

    const invoke = async () => runToExit(['bun', 'scripts/ladder.ts', '--gate', 'bun run gate:install-scripts', ...mode], {
      cwd: new URL('..', import.meta.url).pathname,
      env: childEnv({ XDG_CACHE_HOME: cache }),
    });

    const first = await invoke();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(first.stdout.toString()).toContain('cache: 0 hit, 1 recorded');
    const second = await invoke();
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(second.stdout.toString()).toContain('cache: 1 hit, 0 recorded');
  });

  test('an undeclared command is refused rather than executed or cached', async () => {
    const cache = scratchDir('ladder-cache-store');

    const result = await runToExit(['bun', 'scripts/ladder.ts', '--gate', 'bun undeclared-gate.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: childEnv({ XDG_CACHE_HOME: cache }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('expected an exact command');
    expect(existsSync(join(cache, 'kinu-ladder'))).toBe(false);
  });
});
