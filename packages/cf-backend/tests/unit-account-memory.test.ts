/**
 * The account's memory in the user object. A workspace's agents read it whole and propose to it; nothing they propose
 * is kept until the owner accepts it, and only the owner accepts, edits, promotes or forgets. A fact accepted from one
 * workspace is what every other workspace of the account reads, with who wrote it and every value it held.
 */
import { describe, expect, test } from 'bun:test';
import { CapabilityDeniedError } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

async function account() {
  const harness = createTestUserDO();
  const owner = await testOwner();
  const research = { workspaceToken: await provisionTestWorkspace(harness, 'research', 'Research') };
  const billing = { workspaceToken: await provisionTestWorkspace(harness, 'billing', 'Billing') };

  return { harness, user: harness.userDO, owner, research, billing };
}

describe('a proposal is kept only once the owner accepts it', () => {
  test('a fact said in one workspace, once accepted, is what another reads, with who said it', async () => {
    const { harness, user, owner, research, billing } = await account();
    const id = await user.accountMemory_propose(research, { kind: 'fact', key: 'Owner Name', value: 'Ashish' }, { by: 'agent', agent: 'main' });

    expect(await user.accountMemory_facts(billing)).toEqual([]);
    expect((await user.accountMemory_view(owner)).pending).toEqual([
      expect.objectContaining({ id, proposal: { kind: 'fact', key: 'owner_name', value: 'Ashish' }, origin: { by: 'agent', workspace: 'research', agent: 'main' } }),
    ]);
    expect(await user.accountMemory_decide(owner, id, 'accept')).toBe(true);

    expect((await user.accountMemory_facts(billing)).map((fact) => [fact.key, fact.value, fact.origin])).toEqual([
      ['owner_name', 'Ashish', { by: 'agent', workspace: 'research', agent: 'main' }],
    ]);
    // Decided once: a second answer decides nothing.
    expect(await user.accountMemory_decide(owner, id, 'decline')).toBe(false);
    expect((await user.accountMemory_view(owner)).pending).toEqual([]);
    harness.close();
  });

  test('a declined proposal keeps nothing, and the same ask filed twice is one proposal', async () => {
    const { harness, user, owner, research } = await account();
    const first = await user.accountMemory_propose(research, { kind: 'note', content: 'Invoices go to accounts@example.com' }, { by: 'background' });
    const again = await user.accountMemory_propose(research, { kind: 'note', content: '  Invoices go to accounts@example.com ' }, { by: 'background' });

    expect(again).toBe(first);
    expect(await user.accountMemory_decide(owner, first, 'decline')).toBe(true);
    expect(await user.accountMemory_view(owner)).toMatchObject({ notes: [], pending: [], facts: [] });
    harness.close();
  });

  test('an accepted note is searched by every workspace, by its words and their other forms', async () => {
    const { harness, user, owner, research, billing } = await account();
    const id = await user.accountMemory_propose(research, { kind: 'note', content: 'Invoices go to accounts@example.com every month' }, { by: 'agent', agent: 'main' });

    await user.accountMemory_decide(owner, id, 'accept');

    expect((await user.accountMemory_searchNotes(billing, 'invoice', 5)).map((hit) => hit.text)).toEqual(['Invoices go to accounts@example.com every month']);
    expect(await user.accountMemory_searchNotes(billing, 'timezone', 5)).toEqual([]);
    harness.close();
  });
});

describe('what a proposal is filed as', () => {
  test('a delivery filed again files nothing new, even after the owner decided the first', async () => {
    const { harness, user, owner, research } = await account();
    const first = await user.accountMemory_propose(research, { kind: 'fact', key: 'timezone', value: 'Asia/Kolkata' }, { by: 'background' }, 'turn-9#0');

    await user.accountMemory_decide(owner, first, 'decline');

    expect(await user.accountMemory_propose(research, { kind: 'fact', key: 'timezone', value: 'Asia/Kolkata' }, { by: 'background' }, 'turn-9#0')).toBe(first);
    expect((await user.accountMemory_view(owner)).pending).toEqual([]);
    harness.close();
  });

  test('an agent named "background" is an agent: its origin names it, and its fact is kept as stated', async () => {
    const { harness, user, owner, research } = await account();
    const id = await user.accountMemory_propose(research, { kind: 'fact', key: 'owner_name', value: 'Ashish' }, { by: 'agent', agent: 'background' });

    await user.accountMemory_decide(owner, id, 'accept');

    expect((await user.accountMemory_facts(research)).map((fact) => [fact.veracity, fact.origin])).toEqual([
      ['stated', { by: 'agent', agent: 'background', workspace: 'research' }],
    ]);
    harness.close();
  });

  test('a key that normalizes to nothing, or a note of blanks, is refused before it is filed', async () => {
    const { harness, user, owner, research } = await account();

    await expect(user.accountMemory_propose(research, { kind: 'fact', key: '  ', value: 'x' }, { by: 'agent', agent: 'main' })).rejects.toThrow('An account fact needs a key.');
    await expect(user.accountMemory_propose(research, { kind: 'note', content: '   ' }, { by: 'agent', agent: 'main' })).rejects.toThrow('An account note needs words.');
    expect((await user.accountMemory_view(owner)).pending).toEqual([]);
    harness.close();
  });
});

describe("the owner's own writes", () => {
  test('a forgotten fact leaves every workspace\'s reads and the owner\'s view', async () => {
    const { harness, user, owner, billing } = await account();

    await user.accountMemory_put(owner, 'reply_language', 'Hindi', 'research');
    expect(await user.accountMemory_forget(owner, 'reply_language')).toBe(true);

    expect({ read: await user.accountMemory_facts(billing), view: (await user.accountMemory_view(owner)).facts }).toEqual({ read: [], view: [] });
    harness.close();
  });

  test('every revision of a kept fact is shown with it, newest first', async () => {
    const { harness, user, owner } = await account();

    await user.accountMemory_put(owner, 'reply_language', 'Hindi', 'research');
    await user.accountMemory_put(owner, 'reply_language', 'English');

    const [kept] = (await user.accountMemory_view(owner)).facts;

    expect(kept?.history.map((revision) => [revision.value, revision.origin])).toEqual([
      ['English', { by: 'owner' }], ['Hindi', { by: 'owner', workspace: 'research' }],
    ]);
    harness.close();
  });

  test("a workspace may read and propose, never accept, edit, view the queue or forget", async () => {
    const { harness, user, research } = await account();
    const id = await user.accountMemory_propose(research, { kind: 'fact', key: 'owner_name', value: 'Ashish' }, { by: 'agent', agent: 'main' });

    for (const refused of [
      () => user.accountMemory_decide(research, id, 'accept'),
      () => user.accountMemory_put(research, 'owner_name', 'Mallory'),
      () => user.accountMemory_view(research),
      () => user.accountMemory_forget(research, 'owner_name'),
    ]) {
      await expect(refused()).rejects.toBeInstanceOf(CapabilityDeniedError);
    }

    expect(await user.accountMemory_facts(research)).toEqual([]);
    harness.close();
  });
});
