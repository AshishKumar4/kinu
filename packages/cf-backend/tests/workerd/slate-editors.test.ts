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
  expect(seen.afterEdit).toBe('edited-by:pat@probe.test');
  expect(seen.afterOwnBuild).toBe('edited-by:pat@probe.test');
  expect(seen.reapproved).not.toBeNull();
  expect(seen.reapproved?.startsWith('edited-by:')).toBe(false);

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
  expect(seen.shared).toContain('runs only as its own files build');
  expect(seen.shared).not.toContain("the owner's secret");
  // Theirs alone again: it runs as it did.
  expect(seen.afterUnshare).toContain("the owner's secret");
});
