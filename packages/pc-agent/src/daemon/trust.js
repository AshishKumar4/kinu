// Kinu PC agent — the roots this process's TLS no longer trusts, for the daemon and the CLI that embeds it.
'use strict';

const { getCACertificates } = require('node:tls');

const { X509Certificate } = require('node:crypto');

/**
 * The roots that eMudhra's eight compromised intermediates chain to (Mozilla bug 2083449, 2026-10-17: their private
 * keys were recoverable, so anyone could sign for any name through them), by SHA-256 fingerprint, as the incident's
 * record lists them (https://emudhra.we-have-a-problem.com/roots.json). Bun 1.4.3 still trusts the chain (it answered
 * a test host chained through G3B), so this process does not, on every connection it makes: the daemon and the CLI
 * talk only to a Kinu origin and the hosts a model provider serves, none of which chains to these.
 *
 * Deleted when KINU_BUN_VERSION (core/src/cli/bun-runtime.ts) names a Bun that ships the distrust
 * (https://github.com/oven-sh/bun/pull/46159). The computer deselects the same roots (devbox/src/processes.ts).
 */
const DISTRUSTED_ROOTS = [
  { name: 'emSign Root TLS CA - G3', sha256: '7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D' },
  { name: 'emSign Root CS CA - G3', sha256: 'F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5' },
  { name: 'AAA Certificate Services', sha256: 'D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4' },
  { name: 'emSign ECC Root CA - G3', sha256: '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B' },
];

/** @param {string} pem */
function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '');
}

/** @type {string[] | null} */
let trusted = null;

/** This process's roots, `NODE_EXTRA_CA_CERTS` among them, without the distrusted: read once. */
function trustedRoots() {
  if (trusted !== null) return trusted;
  const distrusted = new Set(DISTRUSTED_ROOTS.map((root) => root.sha256));

  trusted = getCACertificates('default').filter((pem) => !distrusted.has(fingerprint(pem)));

  return trusted;
}

/**
 * @template {{ tls?: { ca?: unknown } } | undefined} T
 * @param {T} options
 * Options whose TLS trusts `trustedRoots()`, unless the caller named roots of its own.
 */
function withTrustedRoots(options) {
  if (options?.tls?.ca !== undefined) return options;

  return { ...options, tls: { ...options?.tls, ca: trustedRoots() } };
}

/**
 * Every `fetch` and `WebSocket` this process makes from here on trusts `trustedRoots()`: one place, at the process's
 * start, so no connection a module opens later (the device socket, a deploy's door, an update's download) is missed.
 * Bun hands TLS options to both; its `checkServerIdentity` sees only the leaf, and its WebSocket none, so the roots are
 * the one place a chain is judged.
 * @param {{ fetch: typeof fetch, WebSocket: typeof WebSocket }} scope
 */
function installTrustedRoots(scope = globalThis) {
  const fetchOf = scope.fetch;
  const Socket = scope.WebSocket;

  /** @type {typeof fetch} */
  const trustedFetch = Object.assign(
    (/** @type {Parameters<typeof fetch>[0]} */ input, /** @type {RequestInit | undefined} */ init) => fetchOf(input, withTrustedRoots(init)),
    fetchOf,
  );

  // A protocol list given as the second argument goes inside the options, where Bun reads it beside `tls`.
  class TrustedSocket extends Socket {
    /** @param {string | URL} url @param {string | string[] | Record<string, unknown>} [options] */
    constructor(url, options) {
      const given = typeof options === 'string' || Array.isArray(options) ? { protocols: options } : options;

      super(url, /** @type {never} */ (withTrustedRoots(given)));
    }
  }

  scope.fetch = trustedFetch;
  scope.WebSocket = TrustedSocket;
}

module.exports = { DISTRUSTED_ROOTS, installTrustedRoots, trustedRoots };
