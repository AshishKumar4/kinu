/**
 * The UserDO's onboarding and display-name authorities, exercised over the
 * real object against in-memory storage. What a test here proves that a unit
 * of the read model cannot: the row exists, the stamp is written once and
 * kept, the name constraint is enforced inside the object, and a workspace
 * token is refused before it reaches either one.
 */
import { describe, expect, test } from 'bun:test';
import { CapabilityDeniedError } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

describe('account onboarding on the real UserDO', () => {
  test('a fresh profile reports onboardedAt: null', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');

    const profile = await harness.userDO.getProfile(owner);
    expect(profile).not.toBeNull();
    expect(profile?.onboardedAt).toBeNull();
    harness.close();
  });

  test('completeOnboarding stamps the profile once and keeps the first stamp', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');

    const first = await harness.userDO.completeOnboarding(owner);

    expect(first.onboardedAt).toBeGreaterThan(0);

    const after = await harness.userDO.getProfile(owner);
    expect(after?.onboardedAt).toBe(first.onboardedAt);

    const second = await harness.userDO.completeOnboarding(owner);
    expect(second.onboardedAt).toBe(first.onboardedAt);
    harness.close();
  });

  test('setDisplayName trims, persists, and refuses empty or overlong names', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');

    const renamed = await harness.userDO.setDisplayName(owner, '  Ashish Rao  ');
    expect(renamed.displayName).toBe('Ashish Rao');

    const read = await harness.userDO.getProfile(owner);
    expect(read?.displayName).toBe('Ashish Rao');

    await expect(harness.userDO.setDisplayName(owner, '')).rejects.toThrow();
    await expect(harness.userDO.setDisplayName(owner, '   ')).rejects.toThrow();
    await expect(harness.userDO.setDisplayName(owner, 'x'.repeat(81))).rejects.toThrow();
    harness.close();
  });

  test('a workspace token reaches neither account method', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');
    const workspaceToken = await provisionTestWorkspace(harness, 'w-a', 'Workspace A');
    const workspace = { workspaceToken };

    await expect(harness.userDO.completeOnboarding(workspace)).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(harness.userDO.setDisplayName(workspace, 'Trespasser')).rejects.toBeInstanceOf(CapabilityDeniedError);
    harness.close();
  });
});
