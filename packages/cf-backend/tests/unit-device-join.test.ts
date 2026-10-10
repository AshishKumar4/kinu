// The device a browser's connect command names is issued before the machine registers, so the page that asked
// watches the one row the machine becomes (26244c765: it took any unfamiliar connected row as its own).
import { expect, test } from 'bun:test';
import { createTestUserDO, testOwner } from './helpers/user-do';

test('a machine registers as the device its connect command named, once', async () => {
  const harness = createTestUserDO();
  const owner = await testOwner();

  try {
    const { deviceId } = await harness.userDO.issueDeviceJoin(owner);
    const registered = await harness.userDO.registerDevice(owner, 'Build box', undefined, deviceId);

    expect(registered.deviceId).toBe(deviceId);
    expect((await harness.userDO.listDevices(owner)).map((device) => [device.id, device.label])).toEqual([[deviceId, 'Build box']]);

    // A command run twice, or a guessed id, claims nothing.
    await expect(harness.userDO.registerDevice(owner, 'Again', undefined, deviceId)).rejects.toThrow('expired or was already used');
    await expect(harness.userDO.registerDevice(owner, 'Guess', undefined, 'dev-guessed')).rejects.toThrow('expired or was already used');
    expect(await harness.userDO.listDevices(owner)).toHaveLength(1);
  } finally {
    await harness.joinFibers();
    harness.close();
  }
});
