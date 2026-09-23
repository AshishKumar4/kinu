/**
 * With the hub unreachable, device file operations fail closed and the reason must say so, not the
 * absent-directory refusal that would send the owner to reconnect a healthy machine.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

const SCOPE_READ = "reading the device's file-view scope";

describe('a device file operation whose hub read fails', () => {
  test('fails closed with the hub failure as its cause, never as "no consented directory"', async () => {
    const { agent } = orchestratorHarness();
    const { error } = await agent.readExecutorFile('device', '/home/me/proj/notes.md');

    expect(error).toStartWith(`${SCOPE_READ}: `);
    expect(error).toContain('getDeviceFileView is not reachable');
    expect(error).not.toContain('no consented directory');
  });

  test('every operation is closed the same way', async () => {
    const { agent } = orchestratorHarness();

    const answers = [
      await agent.getExecutorFiles('device', '/home/me/proj'),
      await agent.deleteExecutorFile('device', '/home/me/proj/x'),
      await agent.renameExecutorFile('device', '/home/me/proj/x', '/home/me/proj/y'),
    ];

    for (const answer of answers) expect(answer).toMatchObject({ error: expect.stringMatching(new RegExp(`^${SCOPE_READ}: `)) });
  });
});
