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

/** The guest reports itself on the runtime's diagnostic channel: the same
 *  script runs as the one-Worker baseline and as the last hop of the composed
 *  route, so its line is the control the leak assertion at the end is measured
 *  against. See the comment there. */
const GUEST_REACHED = 'nimbus capability guest reached';

const guestScript = `
export default {
  fetch(request) {
    console.error('${GUEST_REACHED}');
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

/** miniflare 5: a worker is `{ config }` carrying its own compat date and its
 *  modules (`manifest`), and a service binding is a `worker` arm in `config.env`
 *  naming the target worker. */
const worker = (name, code, env) => ({
  config: {
    name,
    type: 'worker',
    compatibilityDate: '2026-06-05',
    manifest: {
      mainModule: 'index.mjs',
      modulesRoot: '/',
      modules: { 'index.mjs': { type: 'esm', contents: code } },
    },
    env,
  },
});

/** miniflare 5 replaced `handleRuntimeStdio` with parsed structured logs: one
 *  call per runtime log line, so the runtime diagnostics are rejoined here. */
const diagnosticSink = () => {
  const lines = [];
  return {
    handle: ({ level, message }) => { lines.push(`${level}: ${message}`); },
    text: () => lines.join('\n'),
  };
};

const runtimeDiagnostics = diagnosticSink();
const miniflare = new Miniflare({
  log: new NoOpLog(),
  handleStructuredLogs: runtimeDiagnostics.handle,
  workers: [
    worker('edge', edgeScript, { NIMBUS: { type: 'worker', workerName: 'session' } }),
    worker('session', sessionScript, { GUEST: { type: 'worker', workerName: 'guest' } }),
    worker('guest', guestScript),
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

const baselineDiagnostics = diagnosticSink();
const baseline = new Miniflare({
  log: new NoOpLog(),
  handleStructuredLogs: baselineDiagnostics.handle,
  workers: [worker('edge', guestScript)],
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

// This used to pin workerd's "your Worker's code had hung" teardown diagnostic
// (server.c++:5535). That failure mode is gone, not moved: miniflare 5 no
// longer leaves the socket's request outstanding when the runtime goes down, so
// nothing is cancelled and nothing is logged. Measured rather than assumed —
// workerd 1.20260820.1 driven under the pre-5 raw-stdio path still prints it
// (at server.c++:6573 now), while the same binary under miniflare 5 writes zero
// bytes to stdout and stderr for this flow, taken from a tee wrapper on the
// runtime's own streams via MINIFLARE_WORKERD_PATH.
//
// So the control is the guest's own line instead of platform noise: the
// one-Worker baseline proves the channel carries runtime diagnostics at all,
// and the composed route proves the same channel is live there — without which
// the leak assertion below would pass on an empty string.
const guestReached = new RegExp(`^error: ${GUEST_REACHED}$`, 'm');
assert.match(baselineDiagnostics.text(), guestReached);
assert.match(runtimeDiagnostics.text(), guestReached);
assert.doesNotMatch(runtimeDiagnostics.text(), /Tried to access method|RPC|TypeError|501/);
process.stdout.write('Nimbus capability WebSocket workerd probe passed\n');
