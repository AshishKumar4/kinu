/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('a UserDO socket with no device and no pane behind it', () => {
  it('hands its frame to the SDK lifecycle instead of a super that no longer exists', async () => {
    const probe = env.USER_SOCKET_PROBE.get(env.USER_SOCKET_PROBE.idFromName('socket-owner'));
    expect(await probe.deliverBareFrame()).toBe('handled');
  });
});
