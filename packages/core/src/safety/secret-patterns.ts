/**
 * The secret shapes Kinu refuses to let leave a tree unnoticed.
 *
 * ONE LIST, TWO READERS. `scripts/secret-scan.ts` runs it over the repository
 * in the commit tier; a slate blueprint export runs it over the tree a forker
 * will receive. A pattern added for one reader governs the other, so a shape
 * the repository refuses to commit is a shape a blueprint warns about, and
 * neither list can drift behind the other.
 *
 * A finding names WHERE and WHICH, never WHAT. `scanText` keeps the matched
 * text for the commit-tier report, which prints only the detector and path;
 * `secretSightings` drops it before the location leaves this module, because a
 * blueprint page is public by link and a warning that quoted the value would be
 * the leak it warns about.
 */

export interface SecretPattern {
  id: string;
  /** Global so a line carrying two secrets reports both. */
  regex: RegExp;
  /** Shapes that match `regex` but cannot be a live credential: env lookups,
   *  documentation placeholders, type declarations. Narrow on purpose — this
   *  is the one place where widening loses real detections. */
  benign?: RegExp;
  message: string;
}

// Build the two literal internal names in parts. The scanner must inspect its
// own historical source too, so spelling a detector's example contiguously here
// would create a circular adjudication whenever this implementation changes.
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
    // A Cloudflare user token has a 48-character URL-safe body. The benign
    // form is anchored to one whole placeholder line: a placeholder beside a
    // value never suppresses that value.
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
    // Kinu is a public repository. Cloudflare-internal research reached this
    // ecosystem once already: ~/Nimbus kept dossiers under a gitignored
    // `docs/research/`, compiled from Cloudflare's internal repository and wiki,
    // and their SECTION CITATIONS still shipped inside a public production
    // constant. A citation is not a secret, but it names internal material and
    // invites reconstruction, so the names are blocked at the same seam as a
    // credential rather than left to reviewer memory.
    id: 'cf-internal-reference',
    regex: CF_INTERNAL_REFERENCE,
    message: 'Cloudflare-internal source reference (public repo — cite the measurement instead)',
  },
  {
    // Kinu's OWN credentials were the one shape this scan did not cover, and
    // they are the shape most likely to leak from this repo: `kinu tokens
    // create` prints the value once, so it gets pasted — into a chat, a CI
    // config, a scratch file. The precedent is already in the ledger: an
    // OpenRouter key pasted in plaintext into a transcript has never been
    // confirmed rotated, and it is tracked as owner-blocked because the paste
    // is unrecoverable once it lands anywhere durable.
    //
    // The access, CLI, and device token prefixes share one shape. Fragments
    // match too, deliberately: eight or more hex characters after a prefix is
    // a finding. A truncated paste after the access-token prefix is still
    // evidence a live token reached a durable file — the 2026-08-18 transcript
    // leak carried one beside two full tokens, and the old `{16,}` floor plus a
    // benign that exempted any LINE containing an ellipsis let it through twice
    // over. An ellipsis is benign only when it elides the whole body directly
    // after the prefix, i.e. prose NAMING the shape rather than quoting a value.
    id: 'kinu-token',
    regex: /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/g,
    benign: /<your-|\bp(?:ta|tc|dt)_(?:\.\.\.|…)/,
    message: 'Kinu access/CLI/device token (rotate it — a printed-once value that reached a file is compromised)',
  },
  {
    // The shapes GITHUB blocks on. Learned the hard way: a push of 96 verified
    // commits was rejected by push protection for a Stripe-shaped literal in
    // `unit-egress-gate.test.ts:43` — a synthetic NEGATIVE CONTROL asserting
    // that a real-shaped secret is NOT mistaken for an egress placeholder —
    // while this scan passed, because it had no Stripe pattern to suppress.
    // Our measured set was strictly narrower than the set that governs us, and
    // the first anyone learned of it was at the push. A remote gate we cannot
    // see is still a gate; mirroring its shapes is what makes a local pass
    // predictive. Prefixes only — high-precision and delimited, never a bare
    // two-character prefix, which would fire on ordinary prose.
    //
    // The remedy it names is deliberately NOT ".secretscanignore". Declaring a
    // fixture satisfies THIS scan and changes nothing about GitHub's, which
    // reads the source text and cannot be given an in-repo exception. So a
    // negative control that must carry a real-looking shape has to assemble it
    // at runtime; the function under test still receives the identical string.
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
  /** The matched text, not the whole line — the line may carry real context. */
  match: string;
  text: string;
}

export function scanText(file: string, text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');

  for (const p of patterns) {
    lines.forEach((line, i) => {
      if (p.benign?.test(line)) return;

      for (const m of line.matchAll(p.regex)) {
        findings.push({ pattern: p.id, file, line: i + 1, match: m[0], text: line.trim() });
      }
    });
  }

  return findings;
}

/** Detector counts without retaining a matched value. Historical reporting is
 * deliberately metadata-only, even in memory after a blob has been decoded. */
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

/** The locations in one text where a secret shape appears, value withheld. */
export function secretSightings(path: string, text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretSighting[] {
  const sightings: SecretSighting[] = [];
  const lines = text.split('\n');

  for (const pattern of patterns) {
    lines.forEach((line, index) => {
      if (pattern.benign?.test(line)) return;

      for (const _ of line.matchAll(pattern.regex)) {
        sightings.push({ path, line: index + 1, pattern: pattern.id, message: pattern.message });
      }
    });
  }

  return sightings;
}
