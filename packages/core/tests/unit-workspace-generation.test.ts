/**
 * The workspace generation sets every process's pid floor, so two processes booting one workspace database must
 * never share one. The CLI's daemon and its chat boot the same file at once on a workspace's first open.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { generation } from '@nimbus-sh/fabric/generation.js';
import { inlineWorkspaceStorage } from '../src/identity/inline-primitives';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';

test('two openers booting one workspace at once take different generations, and both boot', async () => {
  const path = join(scratchDir('generation'), 'agent.db');

  const openers = [0, 1].map(() => {
    const db = new Database(path, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    const storage = inlineWorkspaceStorage(db);
    const context = workspaceGenerationStorage(storage.sql);

    return { context, bundle: createWorkspace({ ...storage, generation: context }) };
  });

  await Promise.all(openers.map(({ bundle }) => bundle.session()));
  const taken = openers.map(({ context }) => generation(context));

  expect(new Set(taken).size).toBe(2);
  expect(Math.min(...taken)).toBeGreaterThan(0);
});
