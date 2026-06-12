import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  assertProductChangeTransition,
  createProductChangeStore,
  initProductChangeTables,
  normalizeProductSourcePath,
  productChangeSqlFromExec,
  redactProductDiff,
  validateProductPatchPath,
} from '../src/product-change/index.js';

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

describe('product-change lifecycle', () => {
  test('allows the happy-path product change progression', () => {
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
      expect(assertProductChangeTransition(from, to).ok).toBe(true);
    }
  });

  test('rejects applying a product change before owner approval', () => {
    const result = assertProductChangeTransition('preview_ready', 'applying');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not allowed');
  });
});

describe('product-change path safety', () => {
  test('normalizes safe repo-relative paths', () => {
    expect(normalizeProductSourcePath('./packages/cf-backend/src/App.tsx')).toBe('packages/cf-backend/src/App.tsx');
    expect(normalizeProductSourcePath('packages/core/../core/src/index.ts')).toBe('packages/core/src/index.ts');
  });

  test('rejects outside-root and secret paths', () => {
    expect(() => normalizeProductSourcePath('../outside.ts')).toThrow('outside');
    expect(validateProductPatchPath('packages/cf-backend/.dev.vars').ok).toBe(false);
    expect(validateProductPatchPath('.env.production').ok).toBe(false);
    expect(validateProductPatchPath('packages/cf-backend/src/pages/WorkspacePage.tsx').ok).toBe(true);
  });

  test('redacts secret-looking diff lines while keeping code context', () => {
    const diff = [
      'diff --git a/.env b/.env',
      '+OPENAI_API_KEY=sk-test',
      '+const label = "safe";',
      '-CLOUDFLARE_API_TOKEN=secret',
    ].join('\n');

    const redacted = redactProductDiff(diff);
    expect(redacted).toContain('const label = "safe"');
    expect(redacted).not.toContain('sk-test');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('[redacted sensitive diff line]');
  });
});

describe('product-change sql store', () => {
  test('persists a governed product change board', () => {
    const db = new Database(':memory:');
    const exec = makeExec(db);
    initProductChangeTables(exec);
    const store = createProductChangeStore(productChangeSqlFromExec(exec), {
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
