/**
 * Local dev's preview zone: the same shape production serves, on loopback.
 *
 * A preview is a host of its own under `PREVIEW_HOST_SUFFIX`, over https, so a
 * previewed app is its own origin (`@kinu.run/core` preview-origin.ts);
 * production's zone is `kinu.run` on 443. `vite dev` serves `*.preview.localhost`
 * (every browser resolves a `*.localhost` name to loopback) on its own https
 * port, with a certificate minted for the zone, and forwards each request to
 * vite with the scheme it arrived on, so the Worker routes a preview by its host
 * exactly as it does deployed. The Worker learns the zone from
 * `PREVIEW_HOST_SUFFIX`, as deployed, and the port its URLs carry from
 * `PREVIEW_HOST_PORT`, which only this zone sets. The browser rows pin the
 * certificate by key (scripts/live-app-harness.ts); a person's browser trusts it
 * once, by opening a preview host and accepting it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import type { Plugin, ViteDevServer } from 'vite';

export const DEV_PREVIEW_SUFFIX = 'preview.localhost';

/** The zone's https port: `KINU_DEV_PREVIEW_PORT` when a harness picks one, else one derived from the
 *  checkout, below the kernel's ephemeral range, so dev servers in different worktrees never share one. */
export function devPreviewPort(root: string): number {
  const chosen = process.env.KINU_DEV_PREVIEW_PORT;

  if (chosen !== undefined) return Number(chosen);

  return 20_000 + (createHash('sha256').update(root).digest().readUInt16BE(0) % 10_000);
}

/** Where this checkout keeps the zone's key and certificate. */
export function devPreviewTlsDir(root: string): string {
  return join(root, '.wrangler', 'dev-preview-tls');
}

/** The zone's certificate, minted once per checkout for `*.preview.localhost`. Dev servers of one
 *  checkout boot side by side, so the pair is minted apart and renamed into place whole: the first
 *  rename wins and every boot reads that one pair. */
function devPreviewCertificate(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    const minting = mkdtempSync(`${dir}.minting-`);

    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825',
      '-subj', `/CN=*.${DEV_PREVIEW_SUFFIX}`, '-addext', `subjectAltName=DNS:*.${DEV_PREVIEW_SUFFIX}`,
      '-keyout', join(minting, 'key.pem'), '-out', join(minting, 'cert.pem'),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    try {
      renameSync(minting, dir);
    } catch (cause) {
      if (!existsSync(dir)) throw cause;
      rmSync(minting, { recursive: true, force: true });
    }
  }

  return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
}

function vitePort(server: ViteDevServer): number | null {
  const address = v.safeParse(v.object({ port: v.number() }), server.httpServer?.address());

  return address.success ? address.output.port : null;
}

/** Serves the zone on its https port for as long as vite serves, forwarding requests and socket upgrades. */
export function devPreviewZone(tlsDir: string, port: number): Plugin {
  return {
    name: 'kinu:dev-preview-zone',
    apply: 'serve',
    configureServer(server) {
      const zone = createServer(devPreviewCertificate(tlsDir), (incoming, outgoing) => {
        const target = vitePort(server);

        if (target === null) {
          outgoing.writeHead(503).end('vite is not listening yet');

          return;
        }

        // The Worker reads the client-facing scheme from this header (@cloudflare/vite-plugin getForwardedProto):
        // without it every preview request reads as plain http and is upgraded away from the zone's port.
        const headers = { ...incoming.headers, 'x-forwarded-proto': 'https' };

        const upstream = request({ host: '127.0.0.1', port: target, method: incoming.method, path: incoming.url, headers },
          (answer) => {
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(outgoing);
          });

        upstream.on('error', (error) => { outgoing.writeHead(502).end(`the preview zone could not reach vite: ${error.message}`); });
        incoming.pipe(upstream);
      });

      zone.on('upgrade', (incoming, socket, head) => {
        const target = vitePort(server);

        if (target === null) {
          socket.destroy();

          return;
        }

        const upstream = connect(target, '127.0.0.1', () => {
          const lines = [`${incoming.method ?? 'GET'} ${incoming.url ?? '/'} HTTP/1.1`];

          for (let at = 0; at < incoming.rawHeaders.length; at += 2) lines.push(`${incoming.rawHeaders[at] ?? ''}: ${incoming.rawHeaders[at + 1] ?? ''}`);

          lines.push('X-Forwarded-Proto: https');
          upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
          upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });

        upstream.on('error', () => { socket.destroy(); });
        socket.on('error', () => { upstream.destroy(); });
      });

      // A port another server holds leaves this one without previews, not without a dev server.
      zone.on('error', (error) => {
        server.config.logger.error(`kinu: the dev preview zone cannot serve on ${String(port)} (${error.message}); `
          + 'previews from this server will not load. Set KINU_DEV_PREVIEW_PORT to a free port.');
      });
      zone.listen(port, '127.0.0.1');
      server.httpServer?.on('close', () => { zone.close(); });
    },
  };
}
