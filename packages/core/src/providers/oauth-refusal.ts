/** RFC 6749 4.1.2.1 and 5.2, RFC 8628 3.5; any other `error`, and every `error_description`, is prose. */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type', 'invalid_scope',
  'server_error', 'temporarily_unavailable', 'invalid_client', 'invalid_grant', 'unsupported_grant_type',
  'authorization_pending', 'slow_down', 'expired_token',
]);

export function oauthRefusalText(sentence: string, answer: { readonly code?: string; readonly status?: number }): string {
  if (answer.code !== undefined && OAUTH_ERROR_CODES.has(answer.code)) return `${sentence} (${answer.code}).`;

  return answer.status === undefined ? `${sentence}.` : `${sentence} (HTTP ${String(answer.status)}).`;
}
