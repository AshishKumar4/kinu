/** UserDO onboarding and display-name authorities over the real object. */
import { describe, expect, test } from 'bun:test';
import { CapabilityDeniedError, needsOnboarding } from '@kinu.run/core';
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

  test('a workspace its owner registered makes the account established, wizard or not', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');

    const fresh = await harness.userDO.getProfile(owner);
    expect(fresh?.workspaceCount).toBe(0);
    expect(needsOnboarding(fresh ?? null)).toBe(true);

    await harness.userDO.registerWorkspace(owner, 'w-a', 'Workspace A');

    const established = await harness.userDO.getProfile(owner);
    expect(established?.workspaceCount).toBe(1);
    expect(established?.onboardedAt).toBeNull();
    expect(needsOnboarding(established ?? null)).toBe(false);
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
