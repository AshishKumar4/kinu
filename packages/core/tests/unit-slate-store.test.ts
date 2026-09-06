import { expect, test } from 'bun:test';
import { ContentRef, WorkspaceId } from '@agent-core/core';
import { Slate, SlateId, SlateVersion, SlateVersionId } from '@agent-core/core/slates';
import { SqliteSlateStore } from '../src/slates/store';
import { createTestWorkspace, makeSqlExec } from './helpers';

const source = new ContentRef(`sha256:${'a'.repeat(64)}`);

test('committed Slate history survives a new store and rejects stale writers', () => {
  const ws = createTestWorkspace();
  try {
    const open = () => new SqliteSlateStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const store = open();
    const slate = Slate.initial(new SlateId('notes'), new WorkspaceId('workspace'), source);
    expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
    const version = new SlateVersion(new SlateVersionId('first'), slate.workspaceId, slate.id, source);
    store.transaction((draft) => {
      draft.addVersion(version);
      expect(draft.compareAndSetSlate(slate.revision, slate.commit(version.id))).toBe(true);
    });
    const reopened = open();
    expect(reopened.getVersion(version.id)?.source.value).toBe(source.value);
    expect(reopened.getSlate(slate.id)?.headVersionId?.value).toBe(version.id.value);
    expect(reopened.getSlateRevision(slate.id, slate.revision)?.headVersionId).toBeUndefined();
    expect(reopened.compareAndSetSlate(slate.revision, slate.update(new ContentRef(`sha256:${'c'.repeat(64)}`)))).toBe(false);
    const changed = new SlateVersion(version.id, slate.workspaceId, slate.id, new ContentRef(`sha256:${'b'.repeat(64)}`));
    expect(() => reopened.addVersion(changed)).toThrow();
    expect(reopened.getVersion(version.id)?.source.value).toBe(source.value);
  } finally {
    ws.db.close();
  }
});

test('a failed Slate transaction retains neither a version nor an advanced head', () => {
  const ws = createTestWorkspace();
  try {
    const store = new SqliteSlateStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const slate = Slate.initial(new SlateId('notes'), new WorkspaceId('workspace'), source);
    store.compareAndSetSlate(undefined, slate);
    const version = new SlateVersion(new SlateVersionId('aborted'), slate.workspaceId, slate.id, source);
    expect(() => store.transaction((draft) => {
      draft.addVersion(version);
      draft.compareAndSetSlate(slate.revision, slate.commit(version.id));
      throw new Error('abort commit');
    })).toThrow('abort commit');
    expect(store.getVersion(version.id)).toBeUndefined();
    expect(store.getSlate(slate.id)?.revision.value).toBe(slate.revision.value);
  } finally {
    ws.db.close();
  }
});
