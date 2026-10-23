// The device a browser's connect command names is issued before the machine registers, so the page that asked
// watches the one row the machine becomes (26244c765: it took any unfamiliar connected row as its own). The command
// carries a ticket that registers the machine with no session of its own, and asked from a workspace, the device is
// that workspace's without an approval.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deviceJoinTicketUser } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { testDeviceKey, TEST_HUB_ORIGIN } from './helpers/device-key';

/** A machine's key as it enrols, with a fresh key each time. */
function enrolment(label?: string) {
  return { publicKey: testDeviceKey().publicKey, origin: TEST_HUB_ORIGIN, label };
}

test('a machine registers as the device its connect command named, once', async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    const { deviceId } = await harness.userDO.issueDeviceJoin(owner, null);
    const registered = await harness.userDO.registerDevice(owner, { ...enrolment('Build box'), join: deviceId });

    expect(registered.deviceId).toBe(deviceId);
    expect((await harness.userDO.listDevices(owner)).map((device) => [device.id, device.label])).toEqual([[deviceId, 'Build box']]);

    // A command run twice, or a guessed id, claims nothing.
    await expect(harness.userDO.registerDevice(owner, { ...enrolment('Again'), join: deviceId })).rejects.toThrow('expired or was already used');
    await expect(harness.userDO.registerDevice(owner, { ...enrolment('Guess'), join: 'dev-guessed' })).rejects.toThrow('expired or was already used');
    expect(await harness.userDO.listDevices(owner)).toHaveLength(1);
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});

test("a connect command's ticket registers its machine with no session, once, and names the account it is for", async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    const { deviceId, ticket } = await harness.userDO.issueDeviceJoin(owner, null);

    // It names this account, which its claim is routed to (this harness's object is named apart from a user id).
    expect(ticket.startsWith(`pjt_${harness.userDO.name}_`)).toBe(true);
    expect(deviceJoinTicketUser(ticket.replace(harness.userDO.name, '0123456789abcdef0123456789abcdef'))).toBe('0123456789abcdef0123456789abcdef');
    expect(await harness.userDO.joinDevice(owner, ticket, enrolment('Build box'))).toMatchObject({ deviceId, label: 'Build box' });
    expect((await harness.userDO.listDevices(owner)).map((device) => device.id)).toEqual([deviceId]);

    // Spent: pasted again, and the device id the command also names no longer claims anything either.
    await expect(harness.userDO.joinDevice(owner, ticket, enrolment('Again'))).rejects.toThrow('already used');
    await expect(harness.userDO.registerDevice(owner, { ...enrolment('Again'), join: deviceId })).rejects.toThrow('already used');
    expect(await harness.userDO.listDevices(owner)).toHaveLength(1);
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});

test('a join claimed by a signed-in machine spends its ticket too', async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    const { deviceId, ticket } = await harness.userDO.issueDeviceJoin(owner, null);

    await harness.userDO.registerDevice(owner, { ...enrolment('Signed in'), join: deviceId });
    await expect(harness.userDO.joinDevice(owner, ticket, enrolment())).rejects.toThrow('already used');
    expect(await harness.userDO.listDevices(owner)).toHaveLength(1);
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});

test("a device connected from a workspace's Environment is that workspace's, by either way in, and no other's", async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    await provisionTestWorkspace(harness, 'w-asked');
    await provisionTestWorkspace(harness, 'w-other');
    const joined = await harness.userDO.issueDeviceJoin(owner, 'w-asked');
    const claimed = await harness.userDO.issueDeviceJoin(owner, 'w-asked');
    const plain = await harness.userDO.issueDeviceJoin(owner, null);

    expect(await harness.userDO.joinDevice(owner, joined.ticket, enrolment())).toMatchObject({ deviceId: joined.deviceId });
    await harness.userDO.registerDevice(owner, { ...enrolment('Signed in'), join: claimed.deviceId });
    expect(await harness.userDO.joinDevice(owner, plain.ticket, enrolment())).toMatchObject({ deviceId: plain.deviceId });

    const grants = (await harness.userDO.listDeviceConsents(owner)).map((row) => [row.agentName, row.deviceId, row.policy]);

    expect(grants).toHaveLength(2);
    expect(grants).toEqual(expect.arrayContaining([['w-asked', claimed.deviceId, 'allow'], ['w-asked', joined.deviceId, 'allow']]));
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});

test('a join names only a workspace the account holds, and one deleted before the machine joins grants nothing', async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    await expect(harness.userDO.issueDeviceJoin(owner, 'w-nobody')).rejects.toThrow('No workspace named w-nobody');
    await provisionTestWorkspace(harness, 'w-gone');
    const { ticket } = await harness.userDO.issueDeviceJoin(owner, 'w-gone');

    await harness.userDO.removeWorkspace(owner, 'w-gone', '0'.repeat(32));
    // Its teardown took the join with it: a same-name workspace made later is granted nothing by an old command.
    await provisionTestWorkspace(harness, 'w-gone');
    await expect(harness.userDO.joinDevice(owner, ticket, enrolment())).rejects.toThrow('already used');
    expect(await harness.userDO.listDeviceConsents(owner)).toEqual([]);
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});

// Three purposes share one table: each ticket holds its own fields and none of another's.
test('a connection ticket holds one purpose whole, and is refused with another purpose\'s fields', () => {
  const storage = new Database(':memory:');
  const harness = createTestUserDO({ storage });

  try {
    const insert = (row: Record<string, string | number | null>) => {
      const columns = Object.keys(row);

      storage.query(`INSERT INTO connection_tickets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
    };

    const connect = { ticket_hash: 'h-1', purpose: 'device_connect', expires_at: 1, device_id: 'dev-1' };
    const join = { ticket_hash: 'h-2', purpose: 'device_join', expires_at: 1, device_id: 'dev-2', workspace: null };
    const cli = { ticket_hash: 'h-3', purpose: 'cli_agent_connect', expires_at: 1, workspace: 'kiln', cli_token_hash: 'c-1' };

    for (const whole of [connect, join, cli]) insert(whole);

    for (const mixed of [
      { ...connect, ticket_hash: 'h-4', workspace: 'kiln' },
      { ...join, ticket_hash: 'h-5', device_id: 'dev-5', cli_token_hash: 'c-5' },
      { ...cli, ticket_hash: 'h-6', device_id: 'dev-6' },
      { ...connect, ticket_hash: 'h-7', cli_token_hash: 'c-7' },
    ]) {
      expect(() => { insert(mixed); }).toThrow('CHECK constraint failed');
    }
  } finally {
    harness.close();
  }
});
