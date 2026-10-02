/**
 * SSRF and secret-exfiltration guards for outbound web fetches. The destination judgment lives in
 * `safety/egress-destination.ts` and must not be duplicated here. A Worker needs no resolution: its platform
 * refuses a name resolving inward (docs/CRAFT-ARCHITECTURE.md, "Names that resolve inward").
 */

import { Data, Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { refusedHostname } from '../safety/egress-destination';

/** Mirrors hermes-agent/agent/redact.py. */
const SECRET_PREFIX_RE =
  /(sk-[A-Za-z0-9_-]{10,}|sk_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

export class UnsafeUrlError extends Data.TaggedError('UnsafeUrlError')<{ readonly message: string; readonly cause?: unknown }> {
  constructor(public readonly reason: string, options?: ErrorOptions) {
    super({ message: reason, ...(options?.cause !== undefined && { cause: options.cause }) });
  }
}

/** Throws {@link UnsafeUrlError} for a private/internal target, non-http(s) scheme, or smuggled secret. */
export function assertSafeUrl(url: string): URL {
  return settleSync(Effect.catch(safeUrl(url), (unsafe) => Effect.die(unsafe)));
}

function safeUrl(url: string): Effect.Effect<URL, UnsafeUrlError> {
  return Effect.flatMap(safeDecode(url), (decoded) => (SECRET_PREFIX_RE.test(url) || SECRET_PREFIX_RE.test(decoded)
    ? Effect.fail(new UnsafeUrlError('URL contains what appears to be an API key or token: secrets must not be sent in URLs'))
    : parsedSafeUrl(url)));
}

function parsedSafeUrl(url: string): Effect.Effect<URL, UnsafeUrlError> {
  return Effect.try({ try: () => new URL(url), catch: (cause) => new UnsafeUrlError(`not a valid URL: ${url}`, { cause }) }).pipe(
    Effect.flatMap((parsed) => {
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

      if (scheme !== 'http' && scheme !== 'https') {
        return Effect.fail(new UnsafeUrlError(`unsupported URL scheme: ${scheme || '<empty>'}`));
      }

      // `parsed.hostname` is the WHATWG-canonical form the classifier expects.
      const refusal = refusedHostname(parsed.hostname);

      return refusal ? Effect.fail(new UnsafeUrlError(refusal.error)) : Effect.succeed(parsed);
    }),
  );
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

function canonicalAddress(address: string): string | null {
  const url = `http://${address.includes(':') ? `[${address}]` : address}/`;

  return URL.canParse(url) ? new URL(url).hostname : null;
}

/** The fetch resolves again, so DNS rebinding in between is not caught. */
export async function refusedResolution(url: URL, resolve: HostResolver): Promise<string | null> {
  const host = url.hostname;

  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;

  for (const address of await resolve(host)) {
    const canonical = canonicalAddress(address);
    const refusal = canonical === null ? `an unparseable address ${address}` : refusedHostname(canonical)?.error;

    if (refusal !== undefined) return `${host} resolves to ${address}: ${refusal}`;
  }

  return null;
}

/** Only an unsafe URL answers false; any other error is rethrown, never counted as a pass. */
export function isSafeUrl(url: string): boolean {
  return settleSync(Effect.match(safeUrl(url), { onSuccess: () => true, onFailure: () => false }));
}

function safeDecode(s: string): Effect.Effect<string> {
  return Effect.try({ try: () => decodeURIComponent(s), catch: (cause) => ({ cause }) }).pipe(
    // A malformed escape is expected here and outside classify's closed set.
    Effect.catch((failed) => (failed.cause instanceof URIError ? Effect.succeed(s) : Effect.die(failed.cause))),
  );
}
