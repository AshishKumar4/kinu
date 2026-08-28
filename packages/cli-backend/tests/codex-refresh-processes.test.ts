import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { decodeLockOwner, withConfigLock } from '../src/config-lock';
import * as v from 'valibot';

/**
 * The Codex refresh across two real OS PROCESSES, against a token endpoint this
 * test controls.
 *
 * One process cannot prove the property that matters. The defect was a lock
 * released while the refresh was in flight, and the loss it produced — two
 * processes submitting the same refresh token and racing their replacements into
 * one file — belongs to two `kinu` invocations sharing a home directory.
 *
 * Nothing here sleeps. The endpoint IS the barrier: every step waits for a
 * request that only the previous step can send, so the interleaving is
 * constructed rather than hoped for.
 *
 *   1. both children announce themselves and the holder is released first
 *   2. the holder takes the lock and its refresh reaches the endpoint, which
 *      does not answer yet
 *   3. only now is the waiter released, so its first acquisition attempt lands
 *      while the holder is provably inside the refresh AND holding the lock
 *   4. the waiter announces itself and the endpoint answers the holder, which
 *      writes and releases
 *   5. the waiter acquires, finds the rotated credential, and asks nobody
 *
 * A lock that does not cover the refresh fails at step 3: the waiter's first
 * attempt succeeds, it reads the credential the holder has not replaced yet, and
 * a SECOND request reaches the endpoint with the same refresh token.
 */
describe('two kinu processes refreshing one Codex credential', () => {
  const STORE_TS = JSON.stringify(join(import.meta.dir, '../src/codex-auth-store.ts'));

  const childResultSchema = v.object({
    role: v.string(),
    authorization: v.string(),
  });

  const savedSchema = v.object({
    origin: v.string(),
    providers: v.object({
      codex: v.object({
        accessToken: v.string(),
        refreshToken: v.string(),
        expiresAt: v.number(),
        metadata: v.object({ accountId: v.string() }),
      }),
    }),
  });

  interface Gate {
    readonly reached: Promise<void>;
    readonly open: () => void;
  }

  function gate(): Gate {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { reached: promise, open: resolve };
  }

  /** The two halves of the unsigned JWT the store reads an expiry out of. */
  type JwtSegment =
    | { readonly alg: string; readonly typ: string }
    | { readonly exp: number };

  function jwt(expSeconds: number): string {
    const segment = (payload: JwtSegment): string => Buffer.from(JSON.stringify(payload), 'utf-8')
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    return `${segment({ alg: 'none', typ: 'JWT' })}.${segment({ exp: expSeconds })}.`;
  }

  /**
   * One child = one `kinu` process. `bun -e` rather than a static import,
   * because the point is a second OS process with its own module state, its own
   * file handles and its own view of the lock.
   */
  function spawnChild(role: string, base: string, configPath: string): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
    return Bun.spawn({
      cmd: [process.execPath, '-e', `
        const { createFileCodexAuthStore } = await import(${STORE_TS});
        const { asFetchFunction } = await import('@kinu.run/core');
        const role = ${JSON.stringify(role)};
        const base = ${JSON.stringify(base)};

        // Announce, and wait to be released. The endpoint decides the order.
        await fetch(base + '/arrive?role=' + role);

        const store = createFileCodexAuthStore(${JSON.stringify(configPath)}, {
          // Every provider request goes to the endpoint this test controls.
          fetch: asFetchFunction(async (input, init) => await fetch(base + '/token', init)),
        });

        // The waiter announces itself WITHOUT awaiting the answer, so its first
        // acquisition attempt happens while the holder is still inside the
        // refresh. Awaiting here would hand the holder time to finish.
        if (role === 'waiter') void fetch(base + '/armed');

        const auth = await store.getAuth();
        console.log(JSON.stringify({ role, authorization: auth.headers.Authorization }));
      `],
      cwd: join(import.meta.dir, '../../..'),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  async function settle(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<{ code: number; stdout: string; stderr: string }> {
    const code = await proc.exited;
    return {
      code,
      stdout: new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer()),
      stderr: new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer()),
    };
  }

  test('the provider sees one rotation and both processes carry it', async () => {
    const configPath = join(scratchDir('codex-refresh-processes'), 'config.json');
    const rotated = jwt(Math.floor(Date.now() / 1000) + 3600);
    writeFileSync(configPath, `${JSON.stringify({
      origin: 'https://kinu.example',
      providers: {
        codex: {
          accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
          refreshToken: 'refresh-old',
          metadata: { accountId: 'acct_123' },
        },
      },
    }, null, 2)}\n`);

    const submitted: string[] = [];
    const releaseWaiter = gate();
    const armed = gate();
    const refreshReached = gate();

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/arrive') {
          const role = url.searchParams.get('role') ?? '';
          // The holder goes first; the waiter is released in the test body, once
          // the holder's refresh has provably reached this endpoint.
          if (role === 'waiter') await releaseWaiter.reached;
          return new Response(role);
        }
        if (url.pathname === '/armed') {
          armed.open();
          return new Response('armed');
        }
        submitted.push(String(new URLSearchParams(await request.text()).get('refresh_token')));
        if (submitted.length === 1) {
          refreshReached.open();
          // Answer only once the waiter is inside its own acquisition, so the
          // holder cannot finish early and hide the interleaving. A SECOND
          // request is already the failure this test exists for, so it is
          // answered at once rather than held — a hang would say less than the
          // assertion below.
          await armed.reached;
        }
        return Response.json({
          access_token: rotated,
          refresh_token: `refresh-new-${String(submitted.length)}`,
          expires_in: 3600,
        });
      },
    });

    const base = `http://127.0.0.1:${String(server.port)}`;
    const holder = spawnChild('holder', base, configPath);
    const waiter = spawnChild('waiter', base, configPath);
    try {
      await refreshReached.reached;
      // Step 3: the holder holds the lock and is blocked inside its refresh.
      // THIS is the moment at which the pre-fix lock was already gone — the
      // readlink below fails with ENOENT when it is.
      const record = decodeLockOwner(readlinkSync(`${configPath}.lock`));
      expect(record).not.toBeNull();
      expect(record?.pid).toBe(holder.pid);
      releaseWaiter.open();

      const [first, second] = await Promise.all([settle(holder), settle(waiter)]);
      expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
      expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: '' });

      // One rotation, carrying the stored refresh token exactly once.
      expect(submitted).toEqual(['refresh-old']);

      const results = [first, second].map((outcome) =>
        v.parse(childResultSchema, JSON.parse(outcome.stdout)));
      expect(results.map((result) => result.role).sort()).toEqual(['holder', 'waiter']);
      // Both processes carry the credential that one rotation produced.
      expect(results[0]?.authorization).toBe(`Bearer ${rotated}`);
      expect(results[1]?.authorization).toBe(`Bearer ${rotated}`);

      // The file is valid, rotated, and still carries what it carried before.
      const saved = v.parse(savedSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
      expect(saved.origin).toBe('https://kinu.example');
      expect(saved.providers.codex.accessToken).toBe(rotated);
      expect(saved.providers.codex.refreshToken).toBe('refresh-new-1');
      expect(saved.providers.codex.metadata.accountId).toBe('acct_123');
      // And no lock outlived either process.
      expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      // A failed assertion above must not become a hang: the endpoint is holding
      // the holder's refresh open on purpose, and `stop(true)` waits for it. Open
      // every gate, end both children, and let the assertion be the failure.
      releaseWaiter.open();
      armed.open();
      holder.kill('SIGKILL');
      waiter.kill('SIGKILL');
      await Promise.all([holder.exited, waiter.exited]);
      await server.stop(true);
    }
  });

  test('a process killed while holding the lock does not block the next one', async () => {
    const configPath = join(scratchDir('codex-refresh-crash'), 'config.json');
    writeFileSync(configPath, `${JSON.stringify({ origin: 'https://kinu.example' }, null, 2)}\n`);

    const holding = gate();
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        holding.open();
        return new Response(new URL(request.url).pathname);
      },
    });

    try {
      const base = `http://127.0.0.1:${String(server.port)}`;
      // A process that takes the lock, says so, and then never lets go.
      const victim = Bun.spawn({
        cmd: [process.execPath, '-e', `
          const { withConfigLockAsync } = await import(${JSON.stringify(join(import.meta.dir, '../src/config-lock.ts'))});
          await withConfigLockAsync(${JSON.stringify(configPath)}, async () => {
            await fetch(${JSON.stringify(base)} + '/holding');
            await new Promise(() => {});
          });
        `],
        cwd: join(import.meta.dir, '../../..'),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await holding.reached;
      const record = decodeLockOwner(readlinkSync(`${configPath}.lock`));
      expect(record?.pid).toBe(victim.pid);

      // SIGKILL: no unwinding, no release, exactly what a crash leaves behind.
      victim.kill('SIGKILL');
      await victim.exited;

      // The next writer takes it over on its FIRST attempt, because the recorded
      // process is gone. A staleness window made this wait the window out; an
      // unlink by age made it unsafe for every lock that was merely slow.
      expect(withConfigLock(configPath, () => 'taken')).toBe('taken');
      expect(lstatSync(`${configPath}.lock`, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
