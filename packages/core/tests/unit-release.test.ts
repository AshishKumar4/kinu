import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  assertReleaseTransition,
  createReleaseStore,
  initReleaseTables,
  isSecretReleasePath,
  normalizeReleasePath,
  releaseSqlFromExec,
  redactReleaseDiff,
  validateReleasePatchPath,
  validateReleasePatchTargets,
} from '../src/release/index';
import { makeSqlExec } from './helpers';

function makeExec(db: Database) {
  return makeSqlExec(db);
}

describe('release lifecycle', () => {
  test('allows the happy-path release change progression', () => {
    const flow = [
      ['draft', 'planning'],
      ['planning', 'patching'],
      ['patching', 'validating'],
      ['validating', 'preview_ready'],
      ['preview_ready', 'awaiting_approval'],
      ['awaiting_approval', 'applying'],
      ['applying', 'deployed'],
    ] as const;

    for (const [from, to] of flow) {
      expect(assertReleaseTransition(from, to).ok).toBe(true);
    }
  });

  test('rejects applying a release change before owner approval', () => {
    const result = assertReleaseTransition('preview_ready', 'applying');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not allowed');
  });
});

describe('release path safety', () => {
  test('normalizes safe repo-relative paths', () => {
    expect(normalizeReleasePath('./packages/cf-backend/src/App.tsx')).toBe('packages/cf-backend/src/App.tsx');
    expect(normalizeReleasePath('packages/core/../core/src/index.ts')).toBe('packages/core/src/index.ts');
  });

  test('rejects outside-root and secret paths', () => {
    expect(() => normalizeReleasePath('../outside.ts')).toThrow('outside');
    expect(validateReleasePatchPath('packages/cf-backend/.dev.vars').ok).toBe(false);
    expect(validateReleasePatchPath('.env.production').ok).toBe(false);
    expect(validateReleasePatchPath('packages/cf-backend/src/pages/WorkspacePage.tsx').ok).toBe(true);
  });

  test('secrecy is a decided fact, not a phrase inside the error message', () => {
    // isSecretReleasePath used to run /secret|config/ over the human-readable
    // error, so rewording that sentence silently changed the predicate. It now
    // reads a field, and a rejection for a DIFFERENT reason is not secret even
    // when its message happens to contain neither word.
    expect(isSecretReleasePath('packages/cf-backend/.dev.vars')).toBe(true);
    expect(isSecretReleasePath('.ssh/id_rsa')).toBe(true);
    expect(isSecretReleasePath('packages/core/src/index.ts')).toBe(false);
    expect(isSecretReleasePath('../outside.ts')).toBe(false);
    expect(isSecretReleasePath('/etc/passwd')).toBe(false);

    const secret = validateReleasePatchPath('.env.production');
    expect(secret.secret).toBe(true);
    const traversal = validateReleasePatchPath('../outside.ts');
    expect(traversal.ok).toBe(false);
    expect(traversal.secret).toBeUndefined();
  });

  test('redacts secret-looking diff lines while keeping code context', () => {
    const diff = [
      'diff --git a/.env b/.env',
      '+OPENAI_API_KEY=sk-test',
      '+const label = "safe";',
      '-CLOUDFLARE_API_TOKEN=secret',
    ].join('\n');

    const redacted = redactReleaseDiff(diff);
    expect(redacted).toContain('const label = "safe"');
    expect(redacted).not.toContain('sk-test');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('[redacted sensitive diff line]');
  });
});

describe('release sql store', () => {
  test('persists a governed release change board', () => {
    const db = new Database(':memory:');
    const exec = makeExec(db);
    initReleaseTables(exec);
    const store = createReleaseStore(releaseSqlFromExec(exec), {
      now: () => 1700000000000,
      id: (prefix, size) => `${prefix}-${size}`,
      validateAgentName: (name) => {
        if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('invalid agent name');
      },
    });

    const binding = store.upsertSourceBinding({ kind: 'local', label: 'Kinu checkout', localRoot: '/home/user/Kinu' });
    const change = store.createChange('jarvis', { bindingId: binding.id, userPrompt: 'Make the workspace denser' });
    store.transitionChange(change.id, 'planning');
    store.transitionChange(change.id, 'patching');
    store.updateChange(change.id, {
      plan: 'Patch the surface component and add tests.',
      patch: '+API_TOKEN=secret\n+const tone = "quiet";',
    });
    store.transitionChange(change.id, 'validating');
    store.recordCheck(change.id, { name: 'bun run check', status: 'passed', stdout: 'ok', durationMs: 1234 });
    store.transitionChange(change.id, 'preview_ready');
    const approval = store.requestApproval(change.id, 'apply');
    store.decideApproval(approval.id, 'approved', 'user-1');
    store.transitionChange(change.id, 'applying');
    store.recordDeployment(change.id, { environment: 'staging', deploymentId: 'dep-1' });
    store.transitionChange(change.id, 'deployed');

    const board = store.board('jarvis');
    expect(board.bindings[0].id).toBe(binding.id);
    expect(board.changes[0].status).toBe('deployed');
    expect(board.changes[0].patch).toContain('[redacted sensitive diff line]');
    expect(board.changes[0].patch).toContain('const tone = "quiet"');
    expect(board.checks[0].status).toBe('passed');
    expect(board.approvals[0].decision).toBe('approved');
    expect(board.deployments[0].deploymentId).toBe('dep-1');
  });
});

/**
 * The three authorities the release ledger and engine spend, each of which had
 * an exported guard that the production path did not consult.
 */
describe('release authority', () => {
  function store() {
    const db = new Database(':memory:');
    const exec = makeExec(db);
    initReleaseTables(exec);
    return createReleaseStore(releaseSqlFromExec(exec));
  }

  test('the stored patch is the applied patch, byte for byte', () => {
    const s = store();
    const binding = s.upsertSourceBinding({ kind: 'local', label: 'local', localRoot: '/w' });
    const change = s.createChange('jarvis', { bindingId: binding.id, userPrompt: 'p' });
    // A diff whose ADDED line trips the secret heuristic. Redacted in storage,
    // this is what `git apply` writes into the file — the literal marker.
    const patch = '--- a/app.ts\n+++ b/app.ts\n-const old = 1;\n+const API_TOKEN = process.env.X;\n';
    s.updateChange(change.id, { patch });

    // The authority read — what the engine hands to `git apply`.
    expect(s.getChange(change.id)?.patch).toBe(patch);
    // The display read, and only it, redacts.
    expect(s.board('jarvis').changes[0].patch).toContain('[redacted sensitive diff line]');
  });

  test('an oversized patch is refused rather than silently cut mid-hunk', () => {
    const s = store();
    const binding = s.upsertSourceBinding({ kind: 'local', label: 'local', localRoot: '/w' });
    const change = s.createChange('jarvis', { bindingId: binding.id, userPrompt: 'p' });
    expect(() => s.updateChange(change.id, { patch: 'x'.repeat(250_001) }))
      .toThrow(/over the 250000 limit/);
  });

  test.each([
    ['a non-github host', 'https://evil.example/kinu.git'],
    ['a suffix that only looks like github', 'https://github.com.evil.example/kinu.git'],
    ['plaintext http', 'http://github.com/o/r.git'],
    ['credentials in the URL', 'https://user:pass@github.com/o/r.git'],
  ])('a github binding refuses %s', (_label, repoUrl) => {
    // `apply` installs a github credential as an authorization header before
    // cloning this URL, so the URL is the destination of a secret.
    expect(() => store().upsertSourceBinding({ kind: 'github', label: 'src', repoUrl }))
      .toThrow();
  });

  test('a github binding accepts the provider it names', () => {
    const s = store();
    expect(s.upsertSourceBinding({ kind: 'github', label: 'src', repoUrl: 'https://github.com/o/r.git' }).repoUrl)
      .toBe('https://github.com/o/r.git');
  });
  test.each([
    ['a leading dash', '-evil'],
    ['embedded whitespace', 'my branch'],
    ['a parent traversal', 'foo..bar'],
  ])('a source binding refuses a defaultBranch with %s', (_label, defaultBranch) => {
    expect(() => store().upsertSourceBinding({ kind: 'github', label: 'src', repoUrl: 'https://github.com/o/r.git', defaultBranch }))
      .toThrow(/defaultBranch/);
  });

  test.each([
    ['a dotenv file', '--- a/.env\n+++ b/.env\n+API_KEY=1\n'],
    ['an ssh key', '--- /dev/null\n+++ b/.ssh/id_rsa\n+key\n'],
    ['the live wrangler manifest', '--- a/packages/cf-backend/wrangler.jsonc\n+++ b/packages/cf-backend/wrangler.jsonc\n+{}\n'],
    ['a git hook', '--- /dev/null\n+++ b/.git/hooks/pre-commit\n+curl evil\n'],
    ['a traversal out of the source root', '--- a/x\n+++ b/../../etc/passwd\n+root\n'],
  ])('a patch touching %s is refused', (_label, diff) => {
    expect(validateReleasePatchTargets(diff)).not.toBeNull();
  });

  test('an ordinary patch passes, and a non-diff is not silently allowed', () => {
    expect(validateReleasePatchTargets('--- a/src/app.ts\n+++ b/src/app.ts\n+ok\n')).toBeNull();
    // "Validated nothing" must not read as "found nothing wrong".
    expect(validateReleasePatchTargets('just some prose')).toContain('not a unified diff');
  });
});
