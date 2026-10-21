// Kinu PC agent — the roots this process's TLS no longer trusts, for the daemon and the CLI that embeds it.
'use strict';

const { getCACertificates, setDefaultCACertificates } = require('node:tls');

const { X509Certificate } = require('node:crypto');

/**
 * The roots eMudhra's compromised intermediates chain to (distrusted-roots.json, the one list; the computer reads it
 * too, devbox/src/processes.ts). Bun 1.4.3 still trusts the chain (it answered a test host chained through G3B), so
 * this process does not: the daemon and the CLI talk only to a Kinu origin and the hosts a model provider serves.
 *
 * Deleted when KINU_BUN_VERSION (core/src/cli/bun-runtime.ts) names a Bun that ships the distrust
 * (https://github.com/oven-sh/bun/pull/46159); trust.test.js goes red that day.
 */
const DISTRUSTED_ROOTS = require('./distrusted-roots.json').roots.map((/** @type {{ name: string, sha256: string }} */ root) => ({ name: root.name, sha256: root.sha256 }));

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

/** @param {string} pem */
function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '');
}

/**
 * Each certificate `ca` holds whose fingerprint `distrusted` does not name: `ca` as TLS options take it, a PEM (one
 * certificate or several), its bytes, or a list of either.
 * @param {unknown} ca @param {ReadonlySet<string>} distrusted
 */
function without(ca, distrusted) {
  const each = Array.isArray(ca) ? ca : [ca];
  const pems = each.flatMap((entry) => [...String(entry).matchAll(PEM)].map((match) => match[0]));

  return pems.filter((pem) => !distrusted.has(fingerprint(pem)));
}

/** @type {Map<string, string[]>} */
const trusted = new Map();

/**
 * This process's roots, `NODE_EXTRA_CA_CERTS` among them, without the distrusted: read once.
 * @param {readonly string[]} [distrusted] the fingerprints left out; the incident's, unless a test names its own
 */
function trustedRoots(distrusted = DISTRUSTED_ROOTS.map((root) => root.sha256)) {
  const key = distrusted.join(',');
  const held = trusted.get(key) ?? without(getCACertificates('default'), new Set(distrusted));

  trusted.set(key, held);

  return held;
}

/**
 * Options whose TLS trusts `roots`: a caller's own `ca` stands, but for any distrusted root it names; one that names
 * none (null, an empty list or string) is the default store, as Bun reads it.
 * @template {{ tls?: { ca?: unknown } } | undefined} T
 * @param {T} options @param {string[]} roots @param {ReadonlySet<string>} distrusted
 */
function withTrustedRoots(options, roots, distrusted) {
  const ca = options?.tls?.ca;
  const own = ca === undefined || ca === null ? [] : without(ca, distrusted);

  return { ...options, tls: { ...options?.tls, ca: own.length === 0 ? roots : own } };
}

/**
 * A socket's second argument as Bun's options, where it reads `tls`: a protocol, or a list of them, goes inside as
 * `protocols`, which Bun takes only as a sequence (a lone string there threw "Value is not a sequence", Bun 1.4.3).
 * @param {string | string[] | Record<string, unknown> | undefined} options
 */
function socketOptions(options) {
  if (typeof options === 'string') return { protocols: [options] };

  return Array.isArray(options) ? { protocols: options } : options;
}

/**
 * Every connection this process makes from here on trusts `trustedRoots()`: one place, at the process's start, so no
 * connection a module opens later (the device socket, a deploy's door, an update's download) is missed. `fetch` and
 * `WebSocket` take the roots in their TLS options (Bun's `checkServerIdentity` sees only the leaf, and its WebSocket
 * none); `node:https` and `node:tls` take them as the process's default store, which Bun's own fetch never reads.
 * @param {{ fetch: typeof fetch, WebSocket: typeof WebSocket }} [scope]
 * @param {readonly string[]} [distrusted]
 */
function installTrustedRoots(scope = globalThis, distrusted = DISTRUSTED_ROOTS.map((root) => root.sha256)) {
  const roots = trustedRoots(distrusted);
  const left = new Set(distrusted);
  const fetchOf = scope.fetch;
  const Socket = scope.WebSocket;

  /** @type {typeof fetch} */
  const trustedFetch = Object.assign(
    (/** @type {Parameters<typeof fetch>[0]} */ input, /** @type {RequestInit | undefined} */ init) => fetchOf(input, withTrustedRoots(init, roots, left)),
    fetchOf,
  );

  class TrustedSocket extends Socket {
    /** @param {string | URL} url @param {string | string[] | Record<string, unknown>} [options] */
    constructor(url, options) {
      super(url, /** @type {never} */ (withTrustedRoots(socketOptions(options), roots, left)));
    }
  }

  setDefaultCACertificates(roots);
  scope.fetch = trustedFetch;
  scope.WebSocket = TrustedSocket;
}

module.exports = { DISTRUSTED_ROOTS, installTrustedRoots, trustedRoots };
