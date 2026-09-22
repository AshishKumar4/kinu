/**
 * A fake update hub at the daemon's two seams (HTTP origin, device socket); the daemon is the real installed
 * file. Production rule: a HELLO whose `version` is not the served build gets UPDATE; a second socket replaces the first.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { generateReleaseSigningKey, signRelease, type SignedRelease } from '@kinu.run/core';
import DAEMON_SOURCE from '../../../pc-agent/src/index.js' with { type: 'text' };
import SANDBOX_SOURCE from '../../../pc-agent/src/sandbox.js' with { type: 'text' };
import PTY_SOURCE from '../../../pc-agent/src/pty.js' with { type: 'text' };
import UPDATE_SOURCE from '../../../pc-agent/src/update.js' with { type: 'text' };

export const DAEMON_FILES = {
  'pc-agent.js': DAEMON_SOURCE,
  'sandbox.js': SANDBOX_SOURCE,
  'pty.js': PTY_SOURCE,
  'update.js': UPDATE_SOURCE,
} as const;

export const SOCKET_REPLACED_REASON = 'replaced by a new connection';

export const PLATFORM_ARTIFACT = `/downloads/kinu-cli-${process.platform}-${process.arch}.tar.gz`;

/** Shape scripts/build-cli-dist.sh publishes: `kinu/pc-agent/<files>` plus the stamp. */
export function daemonArchive(files: Record<string, string>, stamp: string): Uint8Array {
  const work = scratchDir('update-hub-archive');
  mkdirSync(join(work, 'kinu', 'pc-agent'), { recursive: true });

  for (const [name, content] of Object.entries(files)) writeFileSync(join(work, 'kinu', 'pc-agent', name), content);
  writeFileSync(join(work, 'kinu', 'pc-agent', 'pc-agent.version'), `${stamp}\n`);
  writeFileSync(join(work, 'kinu', 'cli.js'), 'console.log("not the daemon");\n');
  const archived = Bun.spawnSync({ cmd: ['tar', '-czf', join(work, 'a.tar.gz'), '-C', work, 'kinu'] });

  if (archived.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(archived.stderr)}`);

  return new Uint8Array(readFileSync(join(work, 'a.tar.gz')));
}

const HelloSchema = v.looseObject({
  type: v.literal('HELLO'),
  version: v.optional(v.string()),
  os: v.optional(v.string()),
  arch: v.optional(v.string()),
  updateCheck: v.optional(v.boolean()),
});

const FrameSchema = v.looseObject({ id: v.optional(v.string()) });

export type HubHello = v.InferOutput<typeof HelloSchema>;

export type HubFrame = v.InferOutput<typeof FrameSchema>;

export type HubPush =
  | { type: 'ROTATE'; token: string }
  | { type: 'UPDATE'; version: string; urls: { tarball: string; checksum: string }; sha256: string; checksums?: Record<string, string>; signature?: string }
  | { id: string; method: string; params: unknown[] };

export interface HubSocket {
  hello: HubHello;
  frames: HubFrame[];
  closed: 'hub' | 'daemon' | null;
  send(frame: HubPush): void;
  /** Frames are handled in order, so an answer proves every earlier frame was handled too. */
  settle(): Promise<void>;
  /** Ordinary close from the hub side (a hub restart) so the daemon reconnects; recorded as 'hub'. */
  drop(): void;
}

export interface UpdateHub {
  origin: string;
  served: string;
  sockets: HubSocket[];
  hits: string[];
  close(): Promise<void>;
}

/** Per-process release signing key; the daemon pins its public half via {@link RELEASE_SIGNING_ENV}. */
const signingKey = generateReleaseSigningKey();

export const RELEASE_SIGNING_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

export async function releaseSigningEnv(): Promise<Record<string, string>> {
  return { [RELEASE_SIGNING_ENV]: (await signingKey).publicKeyHex };
}

export interface UpdateHubOptions {
  served: string;
  archive: Uint8Array;
  corrupt?: boolean;
  /** The daemon's own gates are then what the test reads. */
  pushAlways?: boolean;
  /** Checksums the test key never signed: unsigned, or signed by the hub's own key. */
  signing?: 'none' | 'foreign';
}

export function startUpdateHub(opts: UpdateHubOptions): UpdateHub {
  const sockets: HubSocket[] = [];
  const hits: string[] = [];
  const digest = createHash('sha256').update(opts.corrupt ? new Uint8Array([0]) : opts.archive).digest('hex');
  const checksums = { [PLATFORM_ARTIFACT]: digest };

  const manifest: Promise<SignedRelease | null> = (async () => {
    if (opts.signing === 'none') return null;
    const key = opts.signing === 'foreign' ? await generateReleaseSigningKey() : await signingKey;

    return signRelease(opts.served, checksums, key.privateKeyPkcs8Base64);
  })();

  const bySocket = new WeakMap<ServerWebSocket<unknown>, HubSocket>();
  const openSockets = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port: 0,
    fetch(req, self) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);

      if (pathname === '/pc/connect-ticket') return Response.json({ ticket: `pct_${'b'.repeat(32)}`, expiresAt: Date.now() + 60_000 });

      if (pathname === '/pc/connect') return self.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });

      if (pathname === PLATFORM_ARTIFACT) return new Response(Buffer.from(opts.archive));

      if (pathname === `${PLATFORM_ARTIFACT}.sha256`) return new Response(`${digest}  ${PLATFORM_ARTIFACT.slice('/downloads/'.length)}\n`);

      return new Response('not found', { status: 404 });
    },
    websocket: {
      async message(ws, message) {
        const text = String(message);

        if (text === 'ping') return;
        const known = bySocket.get(ws);

        if (known) {
          known.frames.push(v.parse(FrameSchema, JSON.parse(text)));

          return;
        }

        const parsed = v.safeParse(HelloSchema, JSON.parse(text));

        if (!parsed.success) return;
        const hello = parsed.output;
        let asked = 0;

        const socket: HubSocket = {
          hello,
          frames: [],
          closed: null,
          send: (out) => { ws.send(JSON.stringify(out)); },
          drop: () => {
            socket.closed = 'hub';
            ws.close(1012, 'hub restart');
          },
          settle: async () => {
            asked += 1;
            const id = `rpc-settle0000-${asked}`;
            ws.send(JSON.stringify({ id, method: 'which', params: [['bash']] }));
            await until(() => socket.frames.find((answer) => answer.id === id), `the answer to ${id}`);
          },
        };

        bySocket.set(ws, socket);

        for (const earlier of sockets) {
          earlier.closed ??= 'hub';
        }

        for (const other of openSockets) {
          if (other !== ws) other.close(1000, SOCKET_REPLACED_REASON);
        }

        sockets.push(socket);
        openSockets.add(ws);
        ws.send(JSON.stringify({ type: 'ROTATE', token: `pdt_${'c'.repeat(32)}` }));

        const behind = hello.version !== undefined && hello.version !== opts.served;
        const allowed = hello.updateCheck !== false;

        if (opts.pushAlways || (behind && allowed)) {
          const signed = await manifest;
          socket.send({
            type: 'UPDATE',
            version: opts.served,
            urls: { tarball: PLATFORM_ARTIFACT, checksum: `${PLATFORM_ARTIFACT}.sha256` },
            sha256: digest,
            // The audit's trojan probe: checksums of the hub's choosing, no signature.
            ...(signed === null ? { checksums } : { checksums: signed.checksums, signature: signed.signature }),
          });
        }
      },
      close(ws) {
        openSockets.delete(ws);
        const socket = bySocket.get(ws);

        if (socket && socket.closed === null) socket.closed = 'daemon';
      },
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    served: opts.served,
    sockets,
    hits,
    close: async () => { await server.stop(true); },
  };
}

export async function until<T>(predicate: () => T | null | undefined | false, what: string, log?: () => string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = predicate();

    if (found) return found;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${log ? `; daemon log:\n${log()}` : ''}`);
    await Bun.sleep(25);
  }
}
