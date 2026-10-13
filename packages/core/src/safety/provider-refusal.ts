// A provider's refusal in its own words, safe to log and show; the device daemon requires it too
// (pc-agent/src/chatgpt.js). Parsing the body is each side's.
import type { JsonObject, JsonValue } from '../utils/json';
import { redactSecrets } from './secret-patterns';
import { revealMisrepresenting } from './untrusted-text';

/**
 * What an OAuth endpoint said when it refused (RFC 6749 §5.2, RFC 7009 §2.2.1): its description, else its code, else
 * the status line. The secrets the call submitted are masked wherever the words echo them, as is every other secret
 * shape; controls and bidi marks are drawn, not obeyed, on one line.
 */
export function refusalWords(input: {
  readonly status: number;
  readonly statusText: string;
  readonly body: JsonValue | null;
  readonly submitted: readonly string[];
}): string {
  const { body } = input;
  const fields: JsonObject = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const said = [fields.error_description, fields.error].find((word): word is string => typeof word === 'string' && word.trim() !== '');
  const words = said ?? `HTTP ${String(input.status)} ${input.statusText}`;
  const masked = input.submitted.filter((secret) => secret !== '').reduce((text, secret) => text.replaceAll(secret, '<redacted>'), words);

  return revealMisrepresenting(redactSecrets(masked)).replace(/\s+/gu, ' ').trim();
}
