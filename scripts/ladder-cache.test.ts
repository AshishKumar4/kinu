/**
 * The cache is sound — proved red in every direction it claims, over a
 * throwaway repository with real gate scripts and a scratch store.
 *
 * Every direction from the owner's brief is one test below, and each test
 * asserts the MISS or the REFUSAL as well as the hit: a suite that only saw
 * hits could not tell a cache from a `true`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { childEnv, git, initRepo, scratchDir } from '@kinu.run/test-utils';
import { claims, LADDER, gatesFor } from './ladder';
import { auditClosure } from './ladder-audit';
import {
  CACHE_BLIND_SPOTS, gateEnvironment, gateEnvNames, planGate, recordGreen, storeAt, toolVersions,
} from './ladder-cache';
import type { Plan, Store, ToolVersions } from './ladder-cache';
import { deriveClosure, repoAt } from './ladder-closure';
import type { Inputs, Repo } from './ladder-closure';

const DERIVED: Inputs = { kind: 'derived', reads: [], env: [] };

interface Fixture {
  readonly root: string;
  readonly store: Store;
  readonly tools: ToolVersions;
  repo(): Repo;
}

/** A committed repository with an installed `typescript` manifest (so the
 *  toolchain reads a version), a scratch store beside it, and `files`. */
function fixture(files: Record<string, string>, scripts: Record<string, string> = {}): Fixture {
  const root = scratchDir('ladder-cache');
  initRepo(root);

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
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');

  return {
    root,
    store: storeAt(join(scratchDir('ladder-cache-store'), 'kinu-ladder')),
    tools: toolVersions(root),
    repo: () => repoAt(root, (run, tracked) => claims(run, tracked)),
  };
}

/** Run the gate the way the ladder does and record it if green. Returns the
 *  plan the run was made under and the recorder's refusal, if any. */
interface GateRun {
  readonly plan: Plan;
  readonly refused: string | undefined;
  readonly exitCode: number;
}

function runGate(fx: Fixture, run: string, inputs: Inputs = DERIVED, tools = fx.tools): GateRun {
  const repo = fx.repo();
  const plan = planGate({ run, inputs, repo, tools, store: fx.store });

  if (plan.kind === 'hit') return { plan, refused: undefined, exitCode: 0 };
  const env = plan.kind === 'miss' ? gateEnvironment(plan.closure) : undefined;
  const proc = Bun.spawnSync(run.split(' '), { cwd: fx.root, env, stdout: 'pipe', stderr: 'pipe' });

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
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);

  const apply = (pairs: Iterable<readonly [string, string | undefined]>): void => {
    for (const [name, value] of pairs) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };

  apply(Object.entries(values));

  try {
    return body();
  } finally {
    apply(saved);
  }
}

describe('ladder-cache — the green path', () => {
  test('after a green run, a rerun hits every cacheable gate and names the hash, the revision and the closure size', () => {
    const fx = fixture({
      'scripts/a.ts': `import { shared } from './shared';\nexport const a = shared;\n${GREEN}`,
      'scripts/b.ts': `import { shared } from './shared';\nexport const b = shared;\n${GREEN}`,
      'scripts/shared.ts': 'export const shared = 1;',
    });

    const first = [runGate(fx, 'bun scripts/a.ts'), runGate(fx, 'bun scripts/b.ts')];
    expect(first.map((r) => r.plan.kind)).toEqual(['miss', 'miss']);
    expect(first.map((r) => r.refused)).toEqual([undefined, undefined]);

    const second = [runGate(fx, 'bun scripts/a.ts'), runGate(fx, 'bun scripts/b.ts')];
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
  test('touching ONE file misses exactly the gates whose closure holds it and hits the rest', () => {
    const fx = fixture({
      'scripts/a.ts': `import { shared } from './shared';\nexport const a = shared;\n${GREEN}`,
      'scripts/b.ts': `import { shared } from './shared';\nexport const b = shared;\n${GREEN}`,
      'scripts/c.ts': `export const c = 1;\n${GREEN}`,
      'scripts/shared.ts': 'export const shared = 1;',
      'scripts/c.test.ts': "import { test } from 'bun:test';\nimport { c } from './c';\ntest('c', () => { if (c !== 1) throw new Error('c'); });",
      'tsconfig.json': '{}',
    });

    const gates = ['bun scripts/a.ts', 'bun scripts/b.ts', 'bun scripts/c.ts', 'bun test scripts/c.test.ts'];

    for (const run of gates) expect(runGate(fx, run).refused).toBeUndefined();

    const touch = (file: string, text: string): string[] => {
      writeFileSync(join(fx.root, file), text);

      return gates.filter((run) => runGate(fx, run).plan.kind === 'miss');
    };

    // A product file: only the gates whose graph reaches it.
    expect(touch('scripts/shared.ts', 'export const shared = 2;')).toEqual(['bun scripts/a.ts', 'bun scripts/b.ts']);
    // A test file: only the gate that runs it.
    expect(touch('scripts/c.test.ts', "import { test } from 'bun:test';\nimport { c } from './c';\ntest('c again', () => { if (c !== 1) throw new Error('c'); });"))
      .toEqual(['bun test scripts/c.test.ts']);
    // A gate's own script: only that gate.
    expect(touch('scripts/c.ts', `export const c = 1;\n// touched\n${GREEN}`)).toEqual(['bun scripts/c.ts', 'bun test scripts/c.test.ts']);
    // A tsconfig on the path: every gate under it.
    expect(touch('tsconfig.json', '{ "compilerOptions": {} }')).toEqual(gates);
    // The lock: every gate.
    expect(touch('bun.lock', '{ "touched": 1 }')).toEqual(gates);
    // The preload: every bun test gate and nothing else.
    expect(touch('scripts/preload.ts', 'export const preloaded = 2;')).toEqual(['bun test scripts/c.test.ts']);
  });

  test('a gate with no computable closure never hits', () => {
    const fx = fixture({
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
        const { plan } = runGate(fx, run, inputs);

        if (plan.kind !== 'uncacheable') throw new Error(`${run} planned as ${plan.kind}`);
        expect(plan.closure.kind).toBe('uncomputable');
        expect(plan.closure.why).toContain(why);
      }
    }

    expect(entries(fx.store)).toEqual([]);
  });

  test('a result recorded in one checkout is never reused in another', () => {
    // Byte-identical trees at two roots: the second is a MISS, because the
    // gate runs in its checkout and an absolute path, an untracked file or a
    // linked node_modules is that checkout's and not the other's.
    const files = { 'scripts/a.ts': `export const a = 1;\n${GREEN}` };
    const recorded = fixture(files);
    expect(runGate(recorded, 'bun scripts/a.ts').refused).toBeUndefined();
    expect(runGate(recorded, 'bun scripts/a.ts').plan.kind).toBe('hit');

    const other = fixture(files);
    const plan = planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo: other.repo(), tools: other.tools, store: recorded.store });
    expect(plan.kind).toBe('miss');
  });

  test('a red result leaves no cache entry, and the next run is still a miss', () => {
    const fx = fixture({ 'scripts/red.ts': 'process.exit(3);' });

    const first = runGate(fx, 'bun scripts/red.ts');
    expect(first.exitCode).toBe(3);
    expect(first.plan.kind).toBe('miss');
    expect(entries(fx.store)).toEqual([]);
    expect(runGate(fx, 'bun scripts/red.ts').plan.kind).toBe('miss');
  });

  test('an entry a crash left unreadable is a miss, and the next green run replaces it', () => {
    // The shape a crash left on 2026-09-22: the entry's name and size, and
    // nothing but NUL bytes where its JSON should be.
    const fx = fixture({ 'scripts/a.ts': `export const a = 1;\n${GREEN}` });
    expect(runGate(fx, 'bun scripts/a.ts').refused).toBeUndefined();
    const [key] = entries(fx.store);

    if (key === undefined) throw new Error('the green run recorded nothing');
    const path = join(fx.store.directory, key);
    writeFileSync(path, Buffer.alloc(statSync(path).size));

    const { plan } = runGate(fx, 'bun scripts/a.ts');

    if (plan.kind !== 'miss') throw new Error(`planned as ${plan.kind}`);
    expect(plan.unreadable).toContain('not JSON');
    expect(runGate(fx, 'bun scripts/a.ts').plan.kind).toBe('hit');
  });

  test('a tool version change misses everything', () => {
    const fx = fixture({
      'scripts/a.ts': `export const a = 1;\n${GREEN}`,
      'scripts/b.ts': `export const b = 1;\n${GREEN}`,
    });

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect(runGate(fx, run).refused).toBeUndefined();

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect(runGate(fx, run).plan.kind).toBe('hit');

    // The installed compiler moves: the key reads the manifest, not a list.
    writeFileSync(join(fx.root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '7.1.0' }));
    const moved = toolVersions(fx.root);
    expect(moved.typescript).toBe('7.1.0');

    for (const run of ['bun scripts/a.ts', 'bun scripts/b.ts']) expect(runGate(fx, run, DERIVED, moved).plan.kind).toBe('miss');

    // Every field of the toolchain is a key input, not only the one that moved.
    for (const [field, value] of Object.entries(fx.tools)) {
      const other = { ...fx.tools, [field]: `${value}-other` };
      expect(runGate(fx, 'bun scripts/a.ts', DERIVED, other).plan.kind, `${field} is not a key input`).toBe('miss');
    }
  });

  test('a recorded green is reused only under the environment it was recorded in, name by name', () => {
    const fx = fixture({ 'scripts/a.ts': `export const a = process.env.ALPHA;\n${GREEN}` });
    const declaredBeta: Inputs = { kind: 'derived', env: ['BETA'] };
    const recordedUnder = { ALPHA: undefined, BETA: undefined, CI: undefined };
    // Read once, so the git it runs is found on the PATH this process started with.
    const repo = fx.repo();
    const planned = (inputs: Inputs = DERIVED): Plan['kind'] => planGate({ run: 'bun scripts/a.ts', inputs, repo, tools: fx.tools, store: fx.store }).kind;

    withEnv(recordedUnder, () => {
      expect(runGate(fx, 'bun scripts/a.ts').refused).toBeUndefined();
      expect(runGate(fx, 'bun scripts/a.ts', declaredBeta).refused).toBeUndefined();
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

  test('a name the key does not hash never reaches the gate, however the gate reads the environment', () => {
    // The planted input: a verdict that flips on an environment name the
    // walker cannot see, read through a computed key and by enumeration.
    const fx = fixture({
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
    const run = (env: Record<string, string | undefined>) => Bun.spawnSync(['bun', 'scripts/planted.ts'], { cwd: fx.root, env, stdout: 'pipe' });

    // Handed the ambient environment, the planted value turns the gate red.
    expect(run(ambient).exitCode).toBe(1);
    // Handed its gate environment, the gate cannot see the name at all.
    const gated = run(gateEnvironment(plan.closure, (name) => ambient[name]));
    expect(gated.exitCode).toBe(0);
    const seen = v.parse(v.array(v.string()), JSON.parse(gated.stdout.toString()));
    expect(seen.filter((name) => !gateEnvNames(plan.closure).includes(name))).toEqual([]);
    // So a green recorded without the name is reused with it set: no value of
    // it can split two runs of one key.
    withEnv({ PLANTED: undefined }, () => expect(runGate(fx, 'bun scripts/planted.ts').refused).toBeUndefined());
    expect(withEnv({ PLANTED: 'x' }, planned).kind).toBe('hit');
  });

  test('a closure that changes while the gate runs is not recorded', () => {
    const fx = fixture({ 'scripts/a.ts': `import { s } from './s';\nexport const a = s;\n${GREEN}`, 'scripts/s.ts': 'export const s = 1;' });
    const repo = fx.repo();
    const plan = planGate({ run: 'bun scripts/a.ts', inputs: DERIVED, repo, tools: fx.tools, store: fx.store });

    if (plan.kind !== 'miss') throw new Error(`planned as ${plan.kind}`);
    // The gate ran green; an edit landed before the recorder looked again.
    writeFileSync(join(fx.root, 'scripts/s.ts'), 'export const s = 2;');
    const refused = recordGreen(plan, { run: 'bun scripts/a.ts', inputs: DERIVED, repo: fx.repo(), tools: fx.tools, store: fx.store }, { seconds: 1, revision: 'fixture' });
    expect(refused).toContain('changed while the gate ran');
    expect(entries(fx.store)).toEqual([]);
  });

  test('the never-cache list is read from each row\'s declaration, never matched by name', () => {
    const fx = fixture({ 'scripts/a.ts': `export const a = 1;\n${GREEN}` });
    const live = runGate(fx, 'bun scripts/a.ts', { kind: 'live', why: 'talks to the account' });
    expect(live.plan.kind).toBe('uncacheable');
    expect(live.plan.kind === 'uncacheable' && live.plan.closure.kind).toBe('live');
    // The same command, declared derived, is cacheable: the declaration decided, not the name.
    expect(runGate(fx, 'bun scripts/a.ts').plan.kind).toBe('miss');
    expect(runGate(fx, 'bun scripts/a.ts').plan.kind).toBe('hit');
  });
});

describe('ladder-cache — the audit sees what the walker cannot', () => {
  // A `reads` declaration is a claim; strace is the measurement. The same
  // gate is a HOLE with the read undeclared and clean with it declared, so
  // the audit is red in the direction that matters and the declaration is
  // what turns it green — never an exclusion.
  test('a tracked file read by path is a hole until the row declares it', () => {
    const fx = fixture({
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
      'bun run gate:trajectory', 'bun run test:eval', 'bun run gate:dependency-advisories', 'bun run gate:commit-message',
    ]) {
      expect(live.has(run), `${run} is not declared live`).toBeTrue();
    }
  });
});

describe('ladder-cache — single-gate CLI', () => {
  test('a declared gate records its pass and reuses it on the next invocation', () => {
    const cache = scratchDir('ladder-cache-store');

    const invoke = () => Bun.spawnSync(['bun', 'scripts/ladder.ts', '--gate', 'bun run gate:install-scripts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: childEnv({ XDG_CACHE_HOME: cache }),
      stdout: 'pipe', stderr: 'pipe',
    });

    const first = invoke();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(first.stdout.toString()).toContain('cache: 0 hit, 1 recorded');
    const second = invoke();
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(second.stdout.toString()).toContain('cache: 1 hit, 0 recorded');
  });

  test('an undeclared command is refused rather than executed or cached', () => {
    const cache = scratchDir('ladder-cache-store');

    const result = Bun.spawnSync(['bun', 'scripts/ladder.ts', '--gate', 'bun undeclared-gate.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: childEnv({ XDG_CACHE_HOME: cache }),
      stdout: 'pipe', stderr: 'pipe',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('expected an exact command');
    expect(existsSync(join(cache, 'kinu-ladder'))).toBe(false);
  });
});
