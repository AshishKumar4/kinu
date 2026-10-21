import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// Editors (docs/SLATE-SHARING-NIMBUS.md §2): someone a live share adds to edit changes the slate in its owner's workspace,
// through their own workspace, which names them; the change builds from the slate's own tree, and the owner's access stays
// suspended until the owner approves it again.
it("an editor changes a shared slate in its owner's workspace, built from its own tree, and suspends the owner's access", async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('slate-editors'));
  const seen = await probe.editorsEdit({ owner: 'board-owner', workspace: 'editors-board', editor: 'pat', user: 'sam' });

  // The editor reads the slate's files, changes one, and the owner's slate runs the change.
  expect(seen.files).toContain('version() { return \\"v1\\"; }');
  expect(seen.edited).toContain('server.ts');
  expect(seen.runs).toContain('v2');

  // The owner's access is suspended by the editor's change, stays so through the owner's own next build, and comes
  // back only when the owner approves it again.
  expect(seen.afterEdit).toBe('pat@probe.test');
  expect(seen.afterOwnBuild).toBe('pat@probe.test');
  expect(seen.reapproved).not.toBeNull();

  // A change that imports the owner's file outside the slate does not build: it is taken back whole, the slate keeps
  // running what it ran, and the owner's approval stands.
  expect(seen.reached).toMatch(/notes\/secret/);
  expect(seen.runsAfter).toContain('v3');
  expect(seen.runsAfter).not.toContain('secret');
  expect(seen.filesAfter).toContain('version() { return \\"v3\\"; }');
  expect(seen.afterRefused).toBe(seen.reapproved);

  // Someone added to use it, and the editor once the share is revoked, change nothing.
  expect(seen.used).toContain('not shared with sam@probe.test to edit');
  expect(seen.revoked).toContain('not shared with pat@probe.test to edit');
});

it("a shared slate runs only as its own tree builds: the image built before it was shared reaches no one it is shared with", async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('slate-own-tree'));
  const seen = await probe.sharedRunsOwnTree({ owner: 'reacher-owner', workspace: 'own-tree' });

  // The owner's own slate may read their other slate's file while it is theirs alone.
  expect(seen.unshared).toContain("the owner's secret");
  // Shared, it does not build from its own tree, and the image built before is not run.
  expect(seen.shared).toContain("can't run while it's shared");
  expect(seen.shared).not.toContain("the owner's secret");
  // Theirs alone again: it runs as it did.
  expect(seen.afterUnshare).toContain("the owner's secret");
});

it('an editor batch whose second write fails changes no file and leaves no edit mark', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-atomic'));
  const seen = await probe.editorBatch({ owner: 'atomic-owner', workspace: 'editor-atomic', kind: 'atomic' });

  expect(seen.answers[0]).toContain('"ok":false');
  expect(seen.files.find((file) => file.path === 'a.ts')?.text).toBe('before-a');
  expect(seen.files.find((file) => file.path === 'b.ts')?.text).toBe('before-b');
  expect(seen.marks).toEqual([null]);
});

it('an editor cannot follow a leaf or parent symlink outside the shared slate', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-links'));
  const seen = await probe.editorBatch({ owner: 'links-owner', workspace: 'editor-links', kind: 'links' });

  expect(seen.answers).toHaveLength(2);

  for (const answer of seen.answers) {
    expect(answer).toContain('"ok":false');
    expect(answer).toContain('symlink');
  }

  expect(seen.outside).toContain('outside-private');
  expect(seen.outside).not.toContain('stolen');
  expect(seen.marks).toEqual([null, null]);
});

it('an editor stale base conflicts by path and refuses the whole batch', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-stale'));
  const seen = await probe.editorBatch({ owner: 'stale-owner', workspace: 'editor-stale', kind: 'stale' });

  expect(seen.answers[0]).toContain('File conflict: b.ts');
  expect(seen.files.find((file) => file.path === 'a.ts')?.text).toBe('before-a');
  expect(seen.files.find((file) => file.path === 'b.ts')?.text).toBe('before-b');
  expect(seen.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
  expect(seen.marks).toEqual([null]);
});

it('a shared HTML browser entry cannot read an outside file through an in-tree symlink', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-html-scope'));
  const seen = await probe.sharedHtmlScope({ owner: 'html-owner', workspace: 'editor-html-scope' });

  expect(seen.before).toContain('private-html-from-another-slate');
  expect(seen.shared).not.toContain('private-html-from-another-slate');
  expect(seen.shared).toMatch(/linked.html|can't run while it's shared/);
});

it('a shared build cannot read a package manifest linked outside the tree', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-manifest-scope'));
  const seen = await probe.sharedHtmlScope({ owner: 'manifest-owner', workspace: 'editor-manifest-scope', manifestLink: true });

  expect(seen.before).toContain('private-html-from-another-slate');
  expect(seen.shared).not.toContain('private-html-from-another-slate');
  expect(seen.shared).toContain('package.json is not a file inside');
});

it('an owner approval racing an own-mode editor batch is fenced, and owner builds never advance marked shares', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-mode-fence'));
  const seen = await probe.editorFence();

  expect(seen.pending).toContain("pat's change is still building; approve once it has built");
  expect(seen.afterPendingMode).toBe('own');
  expect(seen.approved).toBe(true);
  expect(seen.cleared).toBe(true);
  expect(seen.lending).toBe('grant');
  expect(seen.afterOwnerBuild).toEqual({ grantRevision: 'r1', editedBy: 'sam' });
  expect(seen.stopped).toBe('none');
});

it('the latest editor batch fences approval of the first build while the second edit is still pending', async () => {
  const probe = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('editor-latest-fence'));
  const seen = await probe.editorFence(true);

  expect(seen.pending).toContain("sam's change is still building; approve once it has built");
  expect(seen.afterPendingMode).toBe('own');
  expect(seen.approved).toBe(true);
  expect(seen.cleared).toBe(true);
  expect(seen.lending).toBe('grant');
});
