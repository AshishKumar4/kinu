import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, NoOpLog } from 'miniflare';

const CAPABILITY = '0123456789abcdef01234567';
const sessionEntry = new URL('./nimbus-capability-websocket-worker.ts', import.meta.url).pathname;

const edgeScript = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const capability = url.searchParams.get('capability') || '';
    url.pathname = '/port/4321' + url.pathname;
    url.searchParams.delete('capability');
    const headers = new Headers(request.headers);
    headers.set('x-nimbus-preview-capability', capability);
    return await env.NIMBUS.fetch(new Request(url, { method: request.method, headers }));
  },
};
`;

const guestScript = `
export default {
  fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', (event) => server.send(event.data));
    server.addEventListener('close', () => {});
    server.addEventListener('error', () => {});
    const requested = request.headers.get('sec-websocket-protocol') || '';
    const protocol = requested.split(',').map((value) => value.trim()).find((value) => value === 'vite-hmr');
    const headers = new Headers({
      'x-guest-authorization': request.headers.get('authorization') || '',
      'x-guest-internal-capability': request.headers.get('x-nimbus-preview-capability') || '',
    });
    if (protocol) headers.set('sec-websocket-protocol', protocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  },
};
`;

const buildResult = await build({
  entryPoints: [sessionEntry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  loader: { '.wasm': 'binary' },
  external: ['cloudflare:workers', 'cloudflare:sockets'],
});
const sessionScript = buildResult.outputFiles[0].text;
let runtimeStderr = '';

const miniflare = new Miniflare({
  compatibilityDate: '2026-06-05',
  log: new NoOpLog(),
  handleRuntimeStdio(stdout, stderr) {
    stdout.resume();
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk) => { runtimeStderr += chunk; });
  },
  workers: [
    { name: 'edge', modules: true, script: edgeScript, serviceBindings: { NIMBUS: 'session' } },
    { name: 'session', modules: true, script: sessionScript, serviceBindings: { GUEST: 'guest' } },
    { name: 'guest', modules: true, script: guestScript },
  ],
});

try {
  const preview = new URL('https://preview.example/socket');
  preview.searchParams.set('capability', CAPABILITY);

  const response = await miniflare.dispatchFetch(preview, {
    headers: {
      upgrade: 'websocket',
      authorization: 'Bearer guest-token',
      'sec-websocket-protocol': 'vite-hmr',
    },
  });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('x-guest-authorization'), 'Bearer guest-token');
  assert.equal(response.headers.get('x-guest-internal-capability'), null);
  assert.equal(response.headers.get('sec-websocket-protocol'), 'vite-hmr');
  const socket = response.webSocket;
  assert.ok(socket);
  socket.accept();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for guest echo')), 5_000);
    socket.addEventListener('message', (event) => {
      assert.equal(event.data, 'hmr-ping');
      socket.close(1000, 'done');
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', reject);
    socket.send('hmr-ping');
  });

  const hmr = new URL('https://preview.example/__nimbus_hmr');
  hmr.searchParams.set('capability', CAPABILITY);
  const hmrResponse = await miniflare.dispatchFetch(hmr, {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-protocol': 'vite-hmr',
    },
  });
  assert.equal(hmrResponse.status, 101);
  assert.equal(hmrResponse.headers.get('sec-websocket-protocol'), 'vite-hmr');
  assert.ok(hmrResponse.webSocket);
  hmrResponse.webSocket.accept();
  hmrResponse.webSocket.close(1000, 'done');

  const revoked = new URL(preview);
  revoked.searchParams.set('capability', 'ffffffffffffffffffffffff');
  const rejected = await miniflare.dispatchFetch(revoked, {
    headers: { upgrade: 'websocket' },
  });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.webSocket, null);

  const spoofedPeerRoute = await miniflare.dispatchFetch(preview, {
    headers: {
      upgrade: 'websocket',
      'x-nimbus-hosted-websocket': 'guessed-process-key',
    },
  });
  assert.equal(spoofedPeerRoute.status, 404);
  assert.equal(spoofedPeerRoute.webSocket, null);

} finally {
  await miniflare.dispose();
}

let baselineStderr = '';
const baseline = new Miniflare({
  compatibilityDate: '2026-06-05',
  log: new NoOpLog(),
  handleRuntimeStdio(stdout, stderr) {
    stdout.resume();
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk) => { baselineStderr += chunk; });
  },
  workers: [{ name: 'edge', modules: true, script: guestScript }],
});
try {
  const response = await baseline.dispatchFetch('https://baseline.example/socket', {
    headers: { upgrade: 'websocket' },
  });
  assert.equal(response.status, 101);
  assert.ok(response.webSocket);
  response.webSocket.accept();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for baseline echo')), 5_000);
    response.webSocket.addEventListener('message', (event) => {
      assert.equal(event.data, 'baseline-ping');
      response.webSocket.close(1000, 'done');
    });
    response.webSocket.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });
    response.webSocket.addEventListener('error', reject);
    response.webSocket.send('baseline-ping');
  });
} finally {
  await baseline.dispose();
}

// Current workerd reports this diagnostic when a test-owned accepted socket is
// torn down with the whole Miniflare runtime. Prove the diagnostic against the
// one-Worker echo baseline before accepting it from the composed Nimbus route.
const teardownDiagnostic = /^workerd\/server\/server\.c\+\+:5535: error: Uncaught exception: .*detected that your Worker's code had hung and would never generate a response\..*\nstack: .+\n$/s;
assert.match(baselineStderr, teardownDiagnostic);
assert.match(runtimeStderr, teardownDiagnostic);
assert.doesNotMatch(runtimeStderr, /Tried to access method|RPC|TypeError|501/);
process.stdout.write('Nimbus capability WebSocket workerd probe passed\n');
