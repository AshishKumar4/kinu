// The owner's experience library at the UserDO boundary.
//
// The tier matrix in unit-workspace-tier-gate proves a shared workspace loses
// both experience capabilities. What is proved here is the other half: that
// provenance is taken from the PROVEN caller rather than from an argument, so a
// workspace can only ever publish as itself and can never be handed back its
// own entries — and that an owner session, which is not any workspace, cannot
// publish at all.
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { experienceLibraryOver } from '../src/user/experience-library';
import { describe, expect, test } from 'bun:test';
import type { ExperienceLibraryClient, UserCaller } from '@kinu.run/core';
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

/** The library as a holder reaches it: one hub per caller, the composition
 *  `orchestrator.ts` hands the workspace, so every case here crosses the wire
 *  and is decoded the way production decodes it. */
function libraryFor(harness: TestUserDO, caller: () => Promise<UserCaller>): ExperienceLibraryClient {
  return experienceLibraryOver(async () => ({ stub: harness.userDO, caller: await caller() }));
}

async function twoWorkspaces() {
  const harness = createTestUserDO();
  const alpha: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, ALPHA, 'Alpha') };
  const beta: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, BETA, 'Beta') };

  return {
    harness,
    alpha: libraryFor(harness, async () => alpha),
    beta: libraryFor(harness, async () => beta),
    owner: libraryFor(harness, testOwner),
  };
}

describe('the experience library is owner-scoped and provenance is proven', () => {
  test('a sibling workspace sees what was published; the author does not', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();

    const published = await alpha.publish(lesson('Read the error before rerunning.'));
    expect(published.sourceWorkspace).toBe(ALPHA);

    expect(await alpha.search({})).toEqual([]);
    const hits = await beta.search({ query: 'error' });
    expect(hits.map((h) => [h.sourceWorkspace, h.kind, h.title]))
      .toEqual([[ALPHA, 'lesson', 'Read the error before rerunning.']]);
    harness.close();
  });

  test('a workspace cannot publish under a sibling\'s name', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();

    // The candidate carries no workspace field at all — provenance comes from
    // the token, so there is nothing to forge.
    await alpha.publish(lesson('Alpha knows this.'));
    const seenByBeta = await beta.search({});
    expect(seenByBeta.every((e) => e.sourceWorkspace === ALPHA)).toBe(true);

    await beta.publish(lesson('Beta knows this too.'));
    expect((await alpha.search({})).map((e) => e.sourceWorkspace)).toEqual([BETA]);
    harness.close();
  });

  test('an owner session may read the library but not publish into it', async () => {
    const { harness, alpha, owner } = await twoWorkspaces();
    await alpha.publish(lesson('Alpha knows this.'));

    // No workspace identity, so nothing is excluded and nothing can be attributed.
    expect((await owner.search({})).map((e) => e.sourceWorkspace)).toEqual([ALPHA]);
    await expect(owner.publish(lesson('From nowhere.')))
      .rejects.toThrow('Only a workspace can publish experience');
    harness.close();
  });

  test('an entry can be fetched by id, and an unknown id answers null', async () => {
    const { harness, alpha, beta } = await twoWorkspaces();
    const published = await alpha.publish(lesson('Read the error before rerunning.'));

    expect(await beta.get(published.id)).toMatchObject({ id: published.id, sourceWorkspace: ALPHA, kind: 'lesson' });
    expect(await beta.get('exp-nope')).toBeNull();
    harness.close();
  });
});
