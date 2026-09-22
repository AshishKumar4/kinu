// Experience library at the UserDO boundary: provenance comes from the proven caller, not an argument;
// an owner session cannot publish. (Tier denial: unit-workspace-tier-gate.)
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

/** One hub per caller, composed as `orchestrator.ts` does, so every case crosses the wire. */
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

    // No workspace field: provenance comes from the token, so there is nothing to forge.
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
