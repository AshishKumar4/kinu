/**
 * Secret shapes shared by `scripts/secret-scan.ts`, blueprint export (`secret-scan.ts` finds them) and redaction.
 * The device daemon requires it (pc-agent/src/chatgpt.js) to redact a provider's refusal.
 */

export interface SecretPattern {
  id: string;
  /** Global so a line carrying two secrets reports both. */
  regex: RegExp;
  /** Shapes that cannot be a live credential. Keep narrow: widening loses detections. */
  benign?: RegExp;
  message: string;
  /** What redaction writes in place of a match; `<redacted>` when absent. */
  mask?: string;
}

// Built in parts so this source never matches its own detector.
const CF_INTERNAL_REFERENCE = new RegExp([
  'wiki\\.cfdata\\.org',
  'cloudflare' + '/ew\\b',
  'edge' + 'worker\\b',
  'metrics\\.c\\+\\+',
  'cf-(?:primitives|internal)-dossier',
].join('|'), 'g');

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'aws-access-key',
    regex: /AKIA[A-Z0-9]{16}/g,
    message: 'AWS access key id',
  },
  {
    id: 'private-key',
    regex: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/g,
    message: 'private key block',
  },
  {
    id: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./g,
    message: 'JWT with a payload',
  },
  {
    id: 'aig-bearer',
    regex: /cf-aig-authorization.*Bearer\s+[A-Za-z0-9_-]{30,}/g,
    benign: /process\.env\.|<your-/,
    message: 'hardcoded AI Gateway bearer token',
  },
  {
    // Benign form must be a whole placeholder line, so a placeholder never hides a value.
    id: 'cloudflare-user-token',
    regex: /\bcfut_[A-Za-z0-9_-]{48}\b/g,
    benign: /^\s*cfut_<your-[A-Za-z0-9-]+>\s*$/,
    message: 'Cloudflare user API token (revoke and replace it immediately)',
  },
  {
    id: 'secret-assignment',
    regex: /(?:password|secret_key|api_key|api_secret|auth_token|oauth_token)\s*[:=]\s*["'][A-Za-z0-9_/+=-]{8,}["']/gi,
    benign: /process\.env\.|<your-|^\s*(?:type|interface)\s/,
    message: 'hardcoded secret assignment',
  },
  {
    // Public repo: internal citations are blocked like credentials.
    id: 'cf-internal-reference',
    regex: CF_INTERNAL_REFERENCE,
    message: 'Cloudflare-internal source reference (public repo: cite the measurement instead)',
  },
  {
    // Fragments (8+ hex after a prefix) count. An ellipsis is benign only
    // directly after the prefix, i.e. prose naming the shape.
    id: 'kinu-token',
    regex: /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/g,
    benign: /<your-|\bp(?:ta|tc|dt)_(?:\.\.\.|…)/,
    message: 'Kinu access/CLI/device token (rotate it: a printed-once value that reached a file is compromised)',
  },
  {
    // Mirrors GitHub push protection prefixes so a local pass predicts the push.
    // Fixtures must assemble such strings at runtime; .secretscanignore cannot exempt GitHub.
    id: 'provider-secret',
    regex: /\b(?:[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})/g,
    benign: /<your-|example|placeholder/,
    message: "third-party provider credential, if this is a deliberate test fixture, ASSEMBLE it at runtime rather than declaring it in .secretscanignore: a declaration satisfies THIS scan, but GitHub push protection reads the source text and will block the push anyway",
  },
  {
    id: 'credentialed-url',
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]{8,}@/g,
    benign: /<your-|localhost/,
    message: 'connection string with embedded credentials',
  },
];

/** Shapes redaction masks but a source scan does not flag: a fixture or a doc legitimately
 *  spells them, while a stored transcript or a debug bundle never should. */
const REDACTION_ONLY_PATTERNS: readonly SecretPattern[] = [
  {
    // A device token's body is base64url from its first character, so `kinu-token`'s hex body
    // misses it; the scan keeps the hex shape because fixtures spell whole-token placeholders.
    id: 'kinu-token-any-body',
    regex: /\bp(?:ta|tc|dt)_[A-Za-z0-9_-]{16,}/g,
    message: 'Kinu access/CLI/device token',
  },
  {
    id: 'openai-key',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    message: 'OpenAI-shaped API key',
  },
  {
    id: 'bearer-token',
    regex: /\bBearer\s+[A-Za-z0-9._-]{15,}/gi,
    message: 'bearer credential',
  },
  {
    // A JSON pair written as text, the shape a logged request body carries.
    id: 'json-secret-pair',
    regex: /("(?:token|secret|password|api[_-]?key|credential|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]{4,}(")/gi,
    message: 'secret-named JSON field in free text',
    mask: '$1<redacted>$2',
  },
];

/** Each pattern with a non-global copy, so a match's mask expands its own groups. */
const REDACTION_PASSES = [...SECRET_PATTERNS, ...REDACTION_ONLY_PATTERNS].map((pattern) => ({
  pattern,
  one: new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '')),
}));

/** Applies `SECRET_PATTERNS` and `REDACTION_ONLY_PATTERNS` per line (a match that is itself a
 *  pattern's `benign` form stays) and masks with `<redacted>`, the marker every redacted line carries. */
export function redactSecrets(text: string): string {
  return text.split('\n').map((line) => {
    let redacted = line;

    for (const { pattern, one } of REDACTION_PASSES) {
      // `benign` judges the match, not the line: prose beside a live key never spares it.
      redacted = redacted.replaceAll(pattern.regex, (match) =>
        pattern.benign?.test(match) === true ? match : match.replace(one, pattern.mask ?? '<redacted>'));
    }

    return redacted;
  }).join('\n');
}
