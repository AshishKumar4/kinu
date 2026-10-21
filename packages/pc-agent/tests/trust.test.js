/**
 * The daemon and the CLI no longer trust the roots eMudhra's eight compromised intermediates chain to (Mozilla bug
 * 2083449, 2026-10-17): Bun 1.4.3 still answered a test host chained through emSign's G3B. Every fetch and socket they
 * open trusts the process's roots without them (daemon/trust.js), and the list is the incident record's, the same as
 * the computer's (devbox/src/processes.ts, which leaves the same roots out of its system bundle).
 */
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const { getCACertificates } = require('node:tls');

const { spawnSync } = require('node:child_process');

const { X509Certificate } = require('node:crypto');

const { expect, test } = require('bun:test');

const { DISTRUSTED_ROOTS, installTrustedRoots, trustedRoots } = require('../src/daemon/trust.js');

const fingerprint = (/** @type {string} */ pem) => new X509Certificate(pem).fingerprint256.replaceAll(':', '');

test('the roots it distrusts are the incident record\'s, as the computer leaves them out of its bundle', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '../../devbox/tests/fixtures/distrusted-roots.pem'), 'utf8');
  const recorded = [...fixture.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)].map((pem) => fingerprint(pem[0]));

  const byName = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b);

  expect(DISTRUSTED_ROOTS.map((root) => root.sha256).sort(byName)).toEqual(recorded.sort(byName));
});

test('its roots are the process\'s own but for the distrusted, which Bun\'s own store still holds', () => {
  const distrusted = new Set(DISTRUSTED_ROOTS.map((root) => root.sha256));
  const all = getCACertificates('default');

  // emSign ECC Root CA - G3 is in Bun's store: the reason for all of this.
  expect(all.some((pem) => distrusted.has(fingerprint(pem)))).toBe(true);
  expect(trustedRoots()).toEqual(all.filter((pem) => !distrusted.has(fingerprint(pem))));
});

/** A root of this test's own and a localhost leaf it signs, in `dir`: the root's PEM path and fingerprint, the leaf. */
function rootAndLeaf(/** @type {string} */ dir, /** @type {string} */ name) {
  const run = (/** @type {string[]} */ args) => {
    const ran = spawnSync('openssl', args, { encoding: 'utf8' });

    if (ran.status !== 0) throw new Error(ran.stderr);
  };

  const at = (/** @type {string} */ file) => path.join(dir, `${name}-${file}`);

  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', at('ca.key'), '-out', at('ca.pem')]);
  run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost', '-keyout', at('leaf.key'), '-out', at('leaf.csr')]);
  fs.writeFileSync(at('leaf.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run(['x509', '-req', '-in', at('leaf.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial', '-days', '1', '-extfile', at('leaf.ext'), '-out', at('leaf.pem')]);

  return { ca: at('ca.pem'), print: fingerprint(fs.readFileSync(at('ca.pem'), 'utf8')), leaf: { cert: fs.readFileSync(at('leaf.pem'), 'utf8'), key: fs.readFileSync(at('leaf.key'), 'utf8') } };
}

// A process as the daemon and the CLI are: a root in its default store (`NODE_EXTRA_CA_CERTS`, as Bun's own holds emSign
// ECC G3), asked through the real clients before and after the install leaves that root out.
const ASK = `
const https = require('node:https');
const [trust, url, socket, print, own] = process.argv.slice(1);
const ownPem = require('node:fs').readFileSync(own, 'utf8');
const fetched = (init) => fetch(url, init).then((res) => String(res.status), () => 'refused');
const asks = async () => ({
  fetch: await fetched(),
  nullCa: await fetched({ tls: { ca: null } }),
  emptyCa: await fetched({ tls: { ca: [] } }),
  ownCaNamingIt: await fetched({ tls: { ca: [ownPem] } }),
  socket: await new Promise((resolve) => {
    const ws = new WebSocket(socket, ['kinu-deploy.v1']);
    ws.onopen = () => { resolve('open'); ws.close(); };
    ws.onerror = () => resolve('refused');
  }),
  // A connection of its own each time: the default agent keeps one alive, which would carry the earlier handshake.
  https: await new Promise((resolve) => { https.get(url, { agent: false }, (res) => { res.resume(); resolve(String(res.statusCode)); }).on('error', () => resolve('refused')); }),
});
const before = await asks();
require(trust).installTrustedRoots(globalThis, [print]);
console.log(JSON.stringify({ before, after: await asks() }));
`;

test('after the install, fetch, WebSocket and node:https refuse a chain through a root it leaves out, however the caller names its roots', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kinu-scratch-trust-'));
  const { ca, print, leaf } = rootAndLeaf(dir, 'left-out');

  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1', tls: leaf,
    fetch: (request, served) => (served.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'kinu-deploy.v1' } }) ? undefined : new Response('ok')),
    websocket: { message: () => undefined },
  });

  try {
    const child = Bun.spawn(['bun', '-e', ASK, path.join(__dirname, '../src/daemon/trust.js'), `https://localhost:${String(server.port)}/`, `wss://localhost:${String(server.port)}/`, print, ca], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, NODE_EXTRA_CA_CERTS: ca }, stdout: 'pipe', stderr: 'pipe',
    });

    const said = await new Response(child.stdout).text();

    expect(JSON.parse(said)).toEqual({
      before: { fetch: '200', nullCa: '200', emptyCa: '200', ownCaNamingIt: '200', socket: 'open', https: '200' },
      after: { fetch: 'refused', nullCa: 'refused', emptyCa: 'refused', ownCaNamingIt: 'refused', socket: 'refused', https: 'refused' },
    });
  } finally {
    await server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A lone protocol in Bun's options threw "Value is not a sequence" (Bun 1.4.3): asked of a real server, as a caller would.
test('a socket given one protocol, or a list of them, opens on a real server with that protocol agreed', async () => {
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: (request, served) => (served.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'kinu-deploy.v1' } }) ? undefined : new Response('ok')),
    websocket: { message: () => undefined },
  });

  const scope = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };

  installTrustedRoots(scope);

  /** @param {string | string[]} protocols @returns {Promise<string>} */
  const agreed = (protocols) => new Promise((resolve, reject) => {
    const ws = new scope.WebSocket(`ws://127.0.0.1:${String(server.port)}/`, protocols);

    ws.onopen = () => { resolve(ws.protocol); ws.close(); };

    ws.onerror = () => { reject(new Error('the socket did not open')); };
  });

  try {
    expect({ one: await agreed('kinu-deploy.v1'), list: await agreed(['kinu-deploy.v1']) }).toEqual({ one: 'kinu-deploy.v1', list: 'kinu-deploy.v1' });
  } finally {
    await server.stop(true);
  }
});

test('a caller\'s own roots stand, and a protocol list rides the socket\'s options beside them', async () => {
  /** @type {unknown[]} */
  const fetched = [];

  /** @type {unknown[]} */
  const opened = [];

  class Socket {
    /** @param {string} url @param {unknown} options */
    constructor(url, options) {
      opened.push([url, options]);
    }
  }

  const scope = {
    fetch: async (/** @type {unknown} */ input, /** @type {unknown} */ init) => {
      fetched.push([input, init]);

      return new Response('ok');
    },
    WebSocket: Socket,
  };

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kinu-scratch-trust-'));

  try {
    const mine = fs.readFileSync(rootAndLeaf(dir, 'private').ca, 'utf8');

    installTrustedRoots(/** @type {never} */ (scope));
    await scope.fetch('https://own.example/', { tls: { ca: [mine] } });
    new scope.WebSocket('wss://kinu.run/api/deploy/runs/r/socket', ['kinu-deploy.v1', 'key']);

    expect(fetched).toEqual([['https://own.example/', { tls: { ca: [mine.trim()] } }]]);
    expect(opened).toEqual([['wss://kinu.run/api/deploy/runs/r/socket', { protocols: ['kinu-deploy.v1', 'key'], tls: { ca: trustedRoots() } }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
