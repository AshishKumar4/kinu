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
} from '../src/release/index.js';

function makeExec(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => stmt.all(...bindings) as Array<Record<string, unknown>> };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
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

    const binding = store.upsertSourceBinding({ kind: 'local', label: 'Proteus checkout', localRoot: '/home/user/Proteus' });
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
