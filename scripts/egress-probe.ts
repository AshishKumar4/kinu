// Kinu's workspace egress in workerd, called as Nimbus would call it: a fake caller in the same Worker reaches
// `ctx.exports.KinuEgress`-shaped entrypoint by loopback and opens a TCP socket, a TLS session (`connectTls`, as Nimbus
// 0.17 asks it for a program's TLS socket), a STARTTLS session over a keyed socket and a WebSocket through it.
// Needs the internet (example.com, smtp.gmail.com:587, echo.websocket.org). Run: bun scripts/egress-probe.ts
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const ENTRY = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleContainerEgress, handleEgressConnect, handleEgressTls } from './packages/cf-backend/src/egress/outbound.ts';

const PARAMS = { workspaceName: 'probe', ownerUserId: 'probe-owner' };
const VAULT_DOWN = { UserDO: { idFromName: (name) => name, get: () => { throw new Error('no request here names a secret'); } }, CREDENTIAL_ENCRYPTION_KEY: 'egress-probe-credential-key-0123456789' };

export class Egress extends WorkerEntrypoint {
  fetch(request) { return handleContainerEgress(request, VAULT_DOWN, PARAMS, { grants: async () => [] }); }
  connect(socket) { return handleEgressConnect(socket, PARAMS); }
  connectTls(target) { return handleEgressTls(target, PARAMS); }
}

const text = (bytes) => new TextDecoder().decode(bytes);
function within(promise, ms) {
  const late = Promise.withResolvers();
  setTimeout(() => late.resolve('TIMEOUT'), ms);
  return Promise.race([promise, late.promise]);
}

async function exchange(socket, request) {
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(request));
  await writer.close();
  return text(new Uint8Array(await new Response(socket.readable).arrayBuffer()));
}

export default {
  async fetch(_request, _env, ctx) {
    const egress = ctx.exports.Egress({ props: {} });
    const out = {};
    const http = 'HEAD / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n';
    out.private = await within(exchange(egress.connect('10.0.0.1:22', { allowHalfOpen: true }), 'x').then((answer) => 'bytes:' + answer.length, (error) => 'closed: ' + String(error)), 5000);
    out.loopback = await within(exchange(egress.connect('127.0.0.1:5432', { allowHalfOpen: true }), 'x').then((answer) => 'bytes:' + answer.length, (error) => 'closed: ' + String(error)), 5000);
    out.tcp = await within(exchange(egress.connect('example.com:80', { allowHalfOpen: true }), http).then((answer) => answer.split('\\r\\n')[0], (error) => 'failed: ' + String(error)), 10000);
    out.tcpOpen = await within((async () => {
      const socket = egress.connect('example.com:80', { allowHalfOpen: true });
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(http));
      const reader = socket.readable.getReader();
      const first = await reader.read();
      return first.done ? 'ended empty' : text(first.value).split('\\r\\n')[0];
    })().catch((error) => 'failed: ' + String(error)), 10000);
    // A TLS socket as Nimbus 0.17 asks for one: the egress makes the session and hands back its plaintext over RPC.
    const tlsSession = async (hostname, payload, servername) => {
      const { readable, writable } = await egress.connectTls(servername === undefined ? { hostname, port: 443 } : { hostname, port: 443, servername });
      const writer = writable.getWriter();
      await writer.write(new TextEncoder().encode(payload));
      const first = await readable.getReader().read();
      return first.done ? 'ended empty' : text(first.value).split('\\r\\n')[0];
    };
    out.tls = await within(tlsSession('example.com', http).catch((error) => 'failed: ' + String(error)), 10000);
    out.tlsExpired = await within(tlsSession('expired.badssl.com', http).catch((error) => 'refused: ' + String(error)), 10000);
    // A servername the server holds a certificate for is checked by it; one it does not is refused, as Node does.
    out.tlsNamed = await within(tlsSession('example.com', http, 'www.example.com').catch((error) => 'failed: ' + String(error)), 10000);
    out.tlsWrongName = await within(tlsSession('example.com', http, 'github.com').catch((error) => 'refused: ' + String(error)), 10000);
    out.tlsPrivate = await within(tlsSession('192.168.1.1', 'x').catch((error) => 'refused: ' + String(error)), 5000);
    out.websocket = await within((async () => {
      const response = await egress.fetch('https://echo.websocket.org/', { headers: { upgrade: 'websocket' } });
      if (response.webSocket === null) return 'status ' + response.status;
      const socket = response.webSocket;
      socket.accept();
      const messages = [];
      const heard = Promise.withResolvers();
      socket.addEventListener('message', (event) => { messages.push(String(event.data)); if (messages.includes('egress-probe')) heard.resolve(); });
      socket.send('egress-probe');
      await within(heard.promise, 5000);
      socket.close();
      return 'status ' + response.status + ', echoed ' + messages.includes('egress-probe');
    })().catch((error) => 'failed: ' + String(error)), 10000);
    // STARTTLS over a keyed socket, as the patched node:net names it and node:tls asks: SMTP's EHLO, STARTTLS, then the
    // ask, the egress's answer, and EHLO again over the session the egress made.
    out.starttls = await within((async () => {
      const key = crypto.getRandomValues(new Uint8Array(16));
      const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      const socket = egress.connect(hex(new TextEncoder().encode('smtp.gmail.com')) + '.k.' + hex(key) + '.tcp.nimbus-egress.invalid:587', { allowHalfOpen: true });
      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();
      let heard = new Uint8Array(0);
      const until = async (done) => {
        for (;;) {
          const found = done(heard);
          if (found !== null) { heard = heard.subarray(found); return; }
          const next = await reader.read();
          if (next.done) throw new Error('ended after ' + JSON.stringify(text(heard)));
          heard = Uint8Array.from([...heard, ...next.value]);
        }
      };
      const line = (code) => (bytes) => { const at = text(bytes).search(new RegExp('^' + code + ' .*\\r\\n', 'm')); return at < 0 ? null : bytes.length; };
      await until(line('220'));
      await writer.write(new TextEncoder().encode('EHLO kinu\\r\\n'));
      await until(line('250'));
      await writer.write(new TextEncoder().encode('STARTTLS\\r\\n'));
      await until(line('220'));
      await writer.write(Uint8Array.from([...key, 0x55, 0]));
      await until((bytes) => (bytes.length >= 17 ? 0 : null));
      if (heard[16] !== 1) return 'refused: ' + text(heard.subarray(19));
      heard = heard.subarray(17);
      await writer.write(new TextEncoder().encode('EHLO kinu\\r\\n'));
      await until(line('250'));
      return 'EHLO answered 250 over TLS';
    })().catch((error) => 'failed: ' + String(error)), 15000);
    out.https = await within(egress.fetch('https://example.com/').then((response) => 'status ' + response.status, (error) => 'failed: ' + String(error)), 10000);
    return Response.json(out);
  },
};
`;

const root = join(import.meta.dir, '..');

const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
  mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
  alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
  external: ['cloudflare:*', 'node:*'], logLevel: 'error',
});

const contents = bundled.outputFiles[0]?.text;

if (contents === undefined) throw new Error('the probe built no module');

const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'egress-probe', compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat', 'new_module_registry'],
  modules: [{ type: 'ESModule', path: 'index.mjs', contents }],
}));

try {
  const answer = await runtime.dispatchFetch('http://egress-probe.invalid/');

  process.stdout.write(`${await answer.text()}\n`);
} finally {
  await runtime.dispose();
}
