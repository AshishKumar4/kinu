/**
 * The cache is sound — proved red in every direction it claims, over a
 * throwaway repository with real gate scripts and a scratch store.
 *
 * Every direction from the owner's brief is one test below, and each test
 * asserts the MISS or the REFUSAL as well as the hit: a suite that only saw
 * hits could not tell a cache from a `true`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { childEnv, git, initRepo, scratchDir } from '@kinu.run/test-utils';
import { claims, LADDER, gatesFor } from './ladder';
import { auditClosure } from './ladder-audit';
import { CACHE_BLIND_SPOTS, keyFor, planGate, recordGreen, storeAt, toolVersions } from './ladder-cache';
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
  const plan = planGate(run, inputs, repo, tools, fx.store);

  if (plan.kind === 'hit') return { plan, refused: undefined, exitCode: 0 };
  const proc = Bun.spawnSync(run.split(' '), { cwd: fx.root, stdout: 'pipe', stderr: 'pipe' });

  if (plan.kind === 'uncacheable' || proc.exitCode !== 0) return { plan, refused: undefined, exitCode: proc.exitCode };
  const refused = recordGreen(plan, run, inputs, fx.repo(), tools, fx.store, { seconds: 0.1, revision: 'fixture' });

  return { plan, refused, exitCode: proc.exitCode };
}

const GREEN = 'process.exit(0);';

/** Entries in the store. An absent directory is a store nothing has written
 *  to, which is the property most of these tests assert. */
const entries = (store: Store): string[] => (existsSync(store.directory) ? readdirSync(store.directory) : []);

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
      'scripts/whole.ts': `export const whole = { ...process.env };\n${GREEN}`,
      'scripts/reads.ts': `import { readFileSync } from 'node:fs';\nexport const r = readFileSync('package.json');\n${GREEN}`,
    });

    for (const [run, inputs, why] of [
      ['bash scripts/shell.sh', DERIVED, 'shell gate'],
      ['bun scripts/dyn.ts', DERIVED, 'computed specifier'],
      ['bun scripts/whole.ts', DERIVED, 'reads the environment whole'],
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

  test('a red result leaves no cache entry, and the next run is still a miss', () => {
    const fx = fixture({ 'scripts/red.ts': 'process.exit(3);' });

    const first = runGate(fx, 'bun scripts/red.ts');
    expect(first.exitCode).toBe(3);
    expect(first.plan.kind).toBe('miss');
    expect(entries(fx.store)).toEqual([]);
    expect(runGate(fx, 'bun scripts/red.ts').plan.kind).toBe('miss');
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

  test('a declared environment value enters the key, and an undeclared one does not', () => {
    const fx = fixture({ 'scripts/a.ts': `export const a = process.env.ALPHA;\n${GREEN}` });
    const repo = fx.repo();
    const plan = planGate('bun scripts/a.ts', DERIVED, repo, fx.tools, fx.store);

    if (plan.kind === 'uncacheable') throw new Error(plan.closure.why);
    expect(plan.closure.env).toEqual(['ALPHA']);
    const reader = (values: Record<string, string>) => (name: string) => values[name];
    const base = keyFor('bun scripts/a.ts', plan.closure, fx.tools, repo, reader({}));
    expect(keyFor('bun scripts/a.ts', plan.closure, fx.tools, repo, reader({ ALPHA: 'x' }))).not.toBe(base);
    expect(keyFor('bun scripts/a.ts', plan.closure, fx.tools, repo, reader({ ALPHA: '' }))).not.toBe(base);
    expect(keyFor('bun scripts/a.ts', plan.closure, fx.tools, repo, reader({ UNRELATED: 'x' }))).toBe(base);

    // A declared name the graph never reads is a key input once declared:
    // with it, a value for BETA moves the key away from the base; without it,
    // the same value leaves the base untouched.
    const declared = { ...plan.closure, env: ['ALPHA', 'BETA'] };
    expect(keyFor('bun scripts/a.ts', plan.closure, fx.tools, repo, reader({ BETA: 'y' }))).toBe(base);
    expect(keyFor('bun scripts/a.ts', declared, fx.tools, repo, reader({}))).not.toBe(base);
    expect(keyFor('bun scripts/a.ts', declared, fx.tools, repo, reader({ BETA: 'y' }))).not.toBe(base);
  });

  test('a closure that changes while the gate runs is not recorded', () => {
    const fx = fixture({ 'scripts/a.ts': `import { s } from './s';\nexport const a = s;\n${GREEN}`, 'scripts/s.ts': 'export const s = 1;' });
    const repo = fx.repo();
    const plan = planGate('bun scripts/a.ts', DERIVED, repo, fx.tools, fx.store);

    if (plan.kind !== 'miss') throw new Error(`planned as ${plan.kind}`);
    // The gate ran green; an edit landed before the recorder looked again.
    writeFileSync(join(fx.root, 'scripts/s.ts'), 'export const s = 2;');
    const refused = recordGreen(plan, 'bun scripts/a.ts', DERIVED, fx.repo(), fx.tools, fx.store, { seconds: 1, revision: 'fixture' });
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
    expect(auditClosure(argv, fx.root, undeclared).undeclared).toEqual(['fixtures/data.txt']);
    const declared = deriveClosure('bun scripts/a.ts', { kind: 'derived', reads: ['fixtures/data.txt'] }, repo);

    if (declared.kind !== 'derived') throw new Error(declared.why);
    const audit = auditClosure(argv, fx.root, declared);
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
