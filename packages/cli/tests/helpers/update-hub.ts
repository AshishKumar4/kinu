/**
 * A hub for the daemon's self-update, faked at the two seams the daemon has:
 * the HTTP origin (ticket exchange, the CLI archive and its checksum) and the
 * device socket (HELLO in, UPDATE out, the replaced close). The daemon under
 * test is the real installed file, run under this Bun; nothing inside it is
 * stubbed.
 *
 * The hub's own rule is the production one: a HELLO whose `version` is not
 * the served build gets an UPDATE, and a second socket for the same device
 * closes the first with the hub's "replaced" reason.
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

/** The daemon's files by their installed names, as this CLI ships them. */
export const DAEMON_FILES = {
  'pc-agent.js': DAEMON_SOURCE,
  'sandbox.js': SANDBOX_SOURCE,
  'pty.js': PTY_SOURCE,
  'update.js': UPDATE_SOURCE,
} as const;

/** The hub's close reason for a replaced socket, verbatim from core. */
export const SOCKET_REPLACED_REASON = 'replaced by a new connection';

export const PLATFORM_ARTIFACT = `/downloads/kinu-cli-${process.platform}-${process.arch}.tar.gz`;

/** A real tar.gz carrying `kinu/pc-agent/<files>` plus the stamp — the shape
 *  scripts/build-cli-dist.sh publishes. */
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

/** The HELLO as this hub reads it: the fields the update decision uses,
 *  the rest kept as sent. */
const HelloSchema = v.looseObject({
  type: v.literal('HELLO'),
  version: v.optional(v.string()),
  os: v.optional(v.string()),
  arch: v.optional(v.string()),
  updateCheck: v.optional(v.boolean()),
});

/** Any other frame the daemon sends: an RPC answer carries its `id`. */
const FrameSchema = v.looseObject({ id: v.optional(v.string()) });

export type HubHello = v.InferOutput<typeof HelloSchema>;

export type HubFrame = v.InferOutput<typeof FrameSchema>;

/** What this hub pushes: the daemon's own frame vocabulary. */
export type HubPush =
  | { type: 'ROTATE'; token: string }
  | { type: 'UPDATE'; version: string; urls: { tarball: string; checksum: string }; sha256: string; checksums?: Record<string, string>; signature?: string }
  | { id: string; method: string; params: unknown[] };

export interface HubSocket {
  /** The HELLO this socket opened with, as the daemon sent it. */
  hello: HubHello;
  /** Every frame after the HELLO, as parsed. */
  frames: HubFrame[];
  /** How it closed: by the hub (replaced), by the daemon, or not yet. */
  closed: 'hub' | 'daemon' | null;
  send(frame: HubPush): void;
  /** Ask the daemon something it answers, and wait for the answer. The
   *  daemon handles frames in order, so an answer proves every frame the hub
   *  sent before the question has been handled too — the positive signal for
   *  "nothing else happened". */
  settle(): Promise<void>;
  /** Drop the socket from the hub's side with an ordinary close — a hub
   *  restart, as the daemon sees one — so the daemon reconnects and HELLOs
   *  again. Recorded as 'hub'. */
  drop(): void;
}

export interface UpdateHub {
  origin: string;
  served: string;
  /** Sockets in the order their HELLO arrived. */
  sockets: HubSocket[];
  /** Every HTTP path asked for, in order. */
  hits: string[];
  close(): Promise<void>;
}

/**
 * The key the test hub signs releases with, minted once per process. A daemon
 * under test pins its PUBLIC half through its environment
 * ({@link RELEASE_SIGNING_ENV}), the way a machine's own operator would; the
 * production pin never signs anything here.
 */
const signingKey = generateReleaseSigningKey();

export const RELEASE_SIGNING_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

/** The environment a daemon under test is started with, so it verifies the
 *  hub's signatures against the test key. */
export async function releaseSigningEnv(): Promise<Record<string, string>> {
  return { [RELEASE_SIGNING_ENV]: (await signingKey).publicKeyHex };
}

export interface UpdateHubOptions {
  served: string;
  archive: Uint8Array;
  /** Publish a checksum that is not the archive's. */
  corrupt?: boolean;
  /** Push UPDATE regardless of the HELLO's version and opt-out — the
   *  daemon's own gates are then what the test reads. */
  pushAlways?: boolean;
  /** The hostile hub: a frame whose checksums the test key never signed —
   *  none at all, or a signature by a key of the hub's own. */
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

        // Production's accept: a second socket for the device replaces the first.
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
            // A hub that signs nothing sends the frame the audit's trojan
            // probe sent: checksums it chose, and no signature over them.
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

/** Poll until `predicate` answers, or fail with `what` and the daemon log. */
export async function until<T>(predicate: () => T | null | undefined | false, what: string, log?: () => string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = predicate();

    if (found) return found;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${log ? `; daemon log:\n${log()}` : ''}`);
    await Bun.sleep(25);
  }
}
