/**
 * Secret shapes shared by `scripts/secret-scan.ts` and blueprint export.
 * Findings name where and which, never the value (blueprint pages are public).
 */

export interface SecretPattern {
  id: string;
  /** Global so a line carrying two secrets reports both. */
  regex: RegExp;
  /** Shapes that cannot be a live credential. Keep narrow: widening loses detections. */
  benign?: RegExp;
  message: string;
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
    message: 'Cloudflare-internal source reference (public repo — cite the measurement instead)',
  },
  {
    // Fragments (8+ hex after a prefix) count. An ellipsis is benign only
    // directly after the prefix, i.e. prose naming the shape.
    id: 'kinu-token',
    regex: /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/g,
    benign: /<your-|\bp(?:ta|tc|dt)_(?:\.\.\.|…)/,
    message: 'Kinu access/CLI/device token (rotate it — a printed-once value that reached a file is compromised)',
  },
  {
    // Mirrors GitHub push protection prefixes so a local pass predicts the push.
    // Fixtures must assemble such strings at runtime; .secretscanignore cannot exempt GitHub.
    id: 'provider-secret',
    regex: /\b(?:[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})/g,
    benign: /<your-|example|placeholder/,
    message: "third-party provider credential — if this is a deliberate test fixture, ASSEMBLE it at runtime rather than declaring it in .secretscanignore: a declaration satisfies THIS scan, but GitHub push protection reads the source text and will block the push anyway",
  },
  {
    id: 'credentialed-url',
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]{8,}@/g,
    benign: /<your-|localhost/,
    message: 'connection string with embedded credentials',
  },
];

export interface SecretFinding {
  pattern: string;
  file: string;
  line: number;
  /** The matched text, not the whole line. */
  match: string;
  text: string;
}

export function scanText(file: string, text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');

  for (const p of patterns) {
    for (const [i, line] of lines.entries()) {
      if (p.benign?.test(line)) continue;

      for (const m of line.matchAll(p.regex)) {
        findings.push({ pattern: p.id, file, line: i + 1, match: m[0], text: line.trim() });
      }
    }
  }

  return findings;
}

/** Detector counts only; never retains a matched value. */
export function countDetections(
  text: string,
  patterns: readonly SecretPattern[] = SECRET_PATTERNS,
): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = text.split('\n');

  for (const pattern of patterns) {
    let count = 0;

    for (const line of lines) {
      if (pattern.benign?.test(line)) continue;

      for (const _ of line.matchAll(pattern.regex)) count += 1;
    }

    if (count > 0) counts.set(pattern.id, count);
  }

  return counts;
}

/** Where a secret-shaped value sits and what shape it has. Never the value. */
export interface SecretSighting {
  readonly path: string;
  readonly line: number;
  readonly pattern: string;
  readonly message: string;
}

export function secretSightings(path: string, text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretSighting[] {
  const sightings: SecretSighting[] = [];
  const lines = text.split('\n');

  for (const pattern of patterns) {
    for (const [index, line] of lines.entries()) {
      if (pattern.benign?.test(line)) continue;

      for (const _ of line.matchAll(pattern.regex)) {
        sightings.push({ path, line: index + 1, pattern: pattern.id, message: pattern.message });
      }
    }
  }

  return sightings;
}
