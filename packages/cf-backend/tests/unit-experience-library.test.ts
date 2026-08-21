// The owner's experience library at the UserDO boundary.
//
// The tier matrix in unit-workspace-tier-gate proves a shared workspace loses
// both experience capabilities. What is proved here is the other half: that
// provenance is taken from the PROVEN caller rather than from an argument, so a
// workspace can only ever publish as itself and can never be handed back its
// own entries — and that an owner session, which is not any workspace, cannot
// publish at all.
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import type { UserCaller } from '../src/user/workspace-capability';
import type { PublishableCandidate } from '@kinu.run/core';

const ALPHA = 'workspace-a';
const BETA = 'workspace-b';

function lesson(text: string): PublishableCandidate {
  return {
    kind: 'lesson',
    key: `lsn-${text.length}`,
    title: text,
    payload: { kind: 'lesson', text },
    evidence: 'turn reflection corroborated 2026-08-01',
  };
}

async function twoWorkspaces() {
  const harness = createTestUserDO();
  const alpha: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, ALPHA, 'Alpha') };
  const beta: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, BETA, 'Beta') };
  return { harness, alpha, beta };
}

describe('the experience library is owner-scoped and provenance is proven', () => {
  test('a sibling workspace sees what was published; the author does not', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();

    const published = await harness.userDO.publishExperience(alpha, lesson('Read the error before rerunning.'));
    expect(published.sourceWorkspace).toBe(ALPHA);

    expect(await harness.userDO.searchExperience(alpha, {})).toEqual([]);
    const hits = await harness.userDO.searchExperience(beta, { query: 'error' });
    expect(hits.map((h) => [h.sourceWorkspace, h.kind, h.title]))
      .toEqual([[ALPHA, 'lesson', 'Read the error before rerunning.']]);
    harness.close();
  });

  test('a workspace cannot publish under a sibling\'s name', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();

    // The candidate carries no workspace field at all — provenance comes from
    // the token, so there is nothing to forge.
    await harness.userDO.publishExperience(alpha, lesson('Alpha knows this.'));
    const seenByBeta = await harness.userDO.searchExperience(beta, {});
    expect(seenByBeta.every((e) => e.sourceWorkspace === ALPHA)).toBe(true);

    await harness.userDO.publishExperience(beta, lesson('Beta knows this too.'));
    expect((await harness.userDO.searchExperience(alpha, {})).map((e) => e.sourceWorkspace)).toEqual([BETA]);
    harness.close();
  });

  test('an owner session may read the library but not publish into it', async () => {
    const { harness, alpha } = await twoWorkspaces();
    await harness.userDO.publishExperience(alpha, lesson('Alpha knows this.'));

    // No workspace identity, so nothing is excluded and nothing can be attributed.
    expect((await harness.userDO.searchExperience(await testOwner(), {})).map((e) => e.sourceWorkspace)).toEqual([ALPHA]);
    await expect(harness.userDO.publishExperience(await testOwner(), lesson('From nowhere.')))
      .rejects.toThrow('Only a workspace can publish experience');
    harness.close();
  });

  test('an entry can be fetched by id, and an unknown id answers null', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();
    const published = await harness.userDO.publishExperience(alpha, lesson('Read the error before rerunning.'));

    const fetched = await harness.userDO.getExperienceEntry(beta, published.id);
    expect(fetched).toMatchObject({ id: published.id, sourceWorkspace: ALPHA, kind: 'lesson' });
    expect(await harness.userDO.getExperienceEntry(beta, 'exp-nope')).toBeNull();
    harness.close();
  });
});
