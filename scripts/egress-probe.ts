// Kinu's workspace egress in workerd, called as Nimbus would call it: a fake caller in the same Worker reaches
// `ctx.exports.KinuEgress`-shaped entrypoint by loopback and opens a TCP socket, a TLS socket and a WebSocket through it.
// Needs the internet (example.com, echo.websocket.org). Run: bun scripts/egress-probe.ts
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { nodeRequireAsImport } from '../packages/cf-backend/esbuild-node-require';

const ENTRY = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleContainerEgress, handleEgressConnect } from './packages/cf-backend/src/egress/outbound.ts';

const PARAMS = { workspaceName: 'probe', ownerUserId: 'probe-owner' };
const VAULT_DOWN = { UserDO: { idFromName: (name) => name, get: () => { throw new Error('no request here names a secret'); } }, CREDENTIAL_ENCRYPTION_KEY: 'egress-probe-credential-key-0123456789' };

export class Egress extends WorkerEntrypoint {
  fetch(request) { return handleContainerEgress(request, VAULT_DOWN, PARAMS, { grants: async () => [] }); }
  connect(socket) { return handleEgressConnect(socket, PARAMS); }
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
    // A TLS socket as Nimbus's patched node:tls names it: the egress makes the session and carries plaintext.
    const marked = (name) => [...new TextEncoder().encode(name)].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{1,62}/g).join('.') + '.tls.nimbus-egress.invalid';
    out.tls = await within((async () => {
      const socket = egress.connect(marked('example.com') + ':443', { allowHalfOpen: true });
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(http));
      const reader = socket.readable.getReader();
      const first = await reader.read();
      return first.done ? 'ended empty' : text(first.value).split('\\r\\n')[0];
    })().catch((error) => 'failed: ' + String(error)), 10000);
    out.tlsPrivate = await within(exchange(egress.connect(marked('192.168.1.1') + ':443', { allowHalfOpen: true }), 'x').then((answer) => 'bytes:' + answer.length, (error) => 'closed: ' + String(error)), 5000);
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
  external: ['cloudflare:*', 'node:*'], plugins: [nodeRequireAsImport], logLevel: 'error',
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
