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

test('every fetch and socket after the install carries those roots, and a caller\'s own roots stand', async () => {
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

  installTrustedRoots(/** @type {never} */ (scope));
  const ca = trustedRoots();

  await scope.fetch('https://kinu.run/api/health', { method: 'POST', tls: { serverName: 'kinu.run' } });
  await scope.fetch('https://own.example/', { tls: { ca: ['mine'] } });
  new scope.WebSocket('wss://kinu.run/pc/connect');
  new scope.WebSocket('wss://kinu.run/api/deploy/runs/r/socket', ['kinu-deploy.v1', 'key']);

  expect(fetched).toEqual([
    ['https://kinu.run/api/health', { method: 'POST', tls: { serverName: 'kinu.run', ca } }],
    ['https://own.example/', { tls: { ca: ['mine'] } }],
  ]);
  expect(opened).toEqual([
    ['wss://kinu.run/pc/connect', { tls: { ca } }],
    ['wss://kinu.run/api/deploy/runs/r/socket', { protocols: ['kinu-deploy.v1', 'key'], tls: { ca } }],
  ]);
});
