/** File checkpoints: the store lives where the files are, and core decides what each answer means. */
import { expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileRestoreChange } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import type { SharedCase } from '../cases';

const byPath = (files: readonly FileRestoreChange[]) => [...files].sort((left, right) => left.path.localeCompare(right.path));

export const CHECKPOINT_CASES: readonly SharedCase[] = [
  {
    title: 'a snapshot is listed under its turn alone, plans the changes since it, and restores them',
    covers: ['checkpointStatus', 'listFileCheckpoints', 'planFileRestore', 'restoreFileCheckpoint'],
    async run({ surface, snapshot }) {
      const project = scratchDir('shared-checkpoint-project');
      writeFileSync(join(project, 'notes.txt'), 'before the turn');
      expect(await surface.checkpointStatus()).toEqual({ available: true });

      await snapshot(project, { turnId: 'turn-1', sessionId: 'session-1' });
      writeFileSync(join(project, 'notes.txt'), 'rewritten by the turn');
      writeFileSync(join(project, 'created.txt'), 'new in the turn');

      const listing = await surface.listFileCheckpoints(10, 'turn-1');
      expect(listing).toEqual({ availability: { available: true }, entries: [{
        id: expect.any(String), dir: project, at: expect.any(Number),
        turnId: 'turn-1', sessionId: 'session-1', reason: 'pre-mutation',
      }] });
      expect(await surface.listFileCheckpoints(10, 'turn-2')).toEqual({ availability: { available: true }, entries: [] });
      const [{ id }] = listing.entries;
      const changes: FileRestoreChange[] = [{ path: 'created.txt', kind: 'delete' }, { path: 'notes.txt', kind: 'modify' }];

      const plan = await surface.planFileRestore(project, id);
      expect({ ...plan, files: byPath(plan.files) }).toEqual({ dir: project, id, files: changes });

      const restored = await surface.restoreFileCheckpoint(project, id);
      expect({ ...restored, files: byPath(restored.files) })
        .toEqual({ dir: project, id, files: changes, preRestoreId: expect.any(String) });
      expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('before the turn');
      expect(existsSync(join(project, 'created.txt'))).toBe(false);
    },
  },
];
