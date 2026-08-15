import { describe, expect, test } from 'bun:test';

const runner = new URL('./fixtures/nimbus-capability-websocket-workerd.mjs', import.meta.url).pathname;

describe('Nimbus capability WebSockets in workerd', () => {
  test('generic guest echo and the built-in HMR route survive reconstruction and capability revocation', async () => {
    const process = Bun.spawn(['node', runner], {
      cwd: new URL('../../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Nimbus capability WebSocket workerd probe passed');
  }, 30_000);
});
