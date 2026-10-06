// What Cloudflare Email Service accepts in a send's `headers`: its allowlist and any `X-` header, nothing else
// (developers.cloudflare.com/email-service/reference/headers, read 2026-10-05). Production refused a Message-ID
// header with "custom header 'Message-ID' is not allowed" on 2026-10-05 (MonitorDO, 17:30:39Z).
const ALLOWED = new Set([
  'in-reply-to', 'references', 'thread-index', 'thread-topic',
  'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'list-archive', 'list-help', 'list-owner', 'list-post', 'list-subscribe',
  'precedence', 'auto-submitted', 'content-language', 'keywords', 'comments', 'importance', 'priority', 'sensitivity',
  'organization', 'require-recipient-valid-since', 'expires', 'reply-by', 'archived-at',
]);

/** Throws as the binding does for a header the service refuses. */
export function refuseUnlistedHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    if (!ALLOWED.has(name.toLowerCase()) && !/^x-/i.test(name)) {
      throw new Error(`E_HEADER_NOT_ALLOWED: custom header '${name}' is not allowed. Only whitelisted headers and X-* headers are accepted.`);
    }
  }
}
