// `kinu auth` where nobody sees a browser it starts (2026-10-23: the CLI on a PC over SSH, approved in a laptop's
// browser): it starts none, prints the link and code for another device, and finishes on that approval with nothing
// typed into its terminal. A browser starter on PATH records whether it ran.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTest } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';

const SESSIONS = [
  { name: 'an SSH session with no display', ssh: true, display: false },
  { name: 'a local session with no display', ssh: false, display: false },
  { name: 'an SSH session forwarding a display', ssh: true, display: true },
  { name: 'a local desktop', ssh: false, display: true },
] as const;

const USER_CODE = 'ABCD-EFGH';

for (const session of SESSIONS) {
  // Seen only on this machine's own screen, which Linux has only with a display.
  const visible = !session.ssh && (session.display || platform() !== 'linux');

  test(`${session.name}: approval from another device signs in with nothing typed, and a browser starts only where it is seen`, async () => {
    const home = scratchDir('auth-headless');
    const bin = join(home, 'bin');
    const marker = join(home, 'browser-started');
    mkdirSync(bin);

    for (const starter of ['xdg-open', 'open']) writeFileSync(join(bin, starter), `#!/bin/sh\nprintf started > '${marker}'\n`, { mode: 0o755 });
    const firstPoll = Promise.withResolvers<void>();
    let approved = false;

    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;

        if (path === '/api/cli/auth/start') {
          return Response.json({
            deviceToken: 'fixture-device-secret', userCode: USER_CODE,
            verificationUrl: `${server.url.origin}/cli/auth?code=${USER_CODE}`,
            expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 1,
          });
        }

        if (path === '/api/cli/auth/poll' && !approved) {
          firstPoll.resolve();

          return Response.json({ status: 'pending' });
        }

        if (path === '/api/cli/auth/poll') {
          return Response.json({
            status: 'approved', token: 'fixture-cli-session', origin: server.url.origin,
            expiresAt: new Date(Date.now() + 600_000).toISOString(), user: { id: 'user-1', email: 'owner@example.test' },
          });
        }

        // The other device's browser: its approval reaches the server, never this terminal.
        if (path === '/cli/auth' && request.method === 'POST') {
          approved = true;

          return new Response('approved');
        }

        return new Response('not found', { status: 404 });
      },
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env, KINU_HOME: home, KINU_UPDATE_CHECK: '0', NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}`,
    };

    for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'KINU_TOKEN']) delete env[name];

    if (session.ssh) env.SSH_CONNECTION = '192.0.2.10 50000 192.0.2.20 22';

    if (session.display) env.DISPLAY = ':99';
    let output = '';

    const cli = spawnTest([process.execPath, 'packages/cli/bin/cli.ts', 'auth', '--origin', server.url.origin], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env,
      terminal: { cols: 160, rows: 40, data(_terminal, data) { output += Buffer.from(data).toString(); } },
    });

    try {
      await Promise.race([
        firstPoll.promise,
        cli.exited.then((code) => { throw new Error(`kinu auth exited (${String(code)}) before it polled: ${output}`); }),
      ]);
      expect((await fetch(`${server.url.origin}/cli/auth`, { method: 'POST', body: `userCode=${USER_CODE}` })).ok).toBe(true);
      expect(await cli.exited).toBe(0);
      expect(existsSync(marker)).toBe(visible);
      const shown = Bun.stripANSI(output);

      expect(shown).toContain(`${server.url.origin}/cli/auth?code=${USER_CODE}`);
      expect(shown).toContain(`Code: ${USER_CODE}`);
      expect(shown.includes('Open this link on any device')).toBe(!visible);
      expect(shown).toContain('Signed in as owner@example.test');
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toMatchObject({
        origin: server.url.origin, accessToken: 'fixture-cli-session', user: { id: 'user-1', email: 'owner@example.test' },
      });
    } finally {
      if (cli.exitCode === null) cli.kill();
      await cli.exited;
      cli.terminal?.close();
      await server.stop(true);
    }
  });
}
