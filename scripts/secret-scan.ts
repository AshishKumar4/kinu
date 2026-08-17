#!/usr/bin/env bun
// Custom secret-pattern scan, over the repo's tracked files.
//
// Complements the TruffleHog job (which only reports VERIFIED live credentials)
// with shape-based patterns that catch a secret before it is ever valid.
//
//   bun scripts/secret-scan.ts          # scan; exit 1 on any finding
//
// Every pattern goes through one path: same file set, same suppression rules,
// same reporting. The previous inline-YAML version had six hand-copied grep
// pipelines whose filters had drifted apart — only the JWT one skipped test
// files, so the AWS fixture in the redactor's own test failed the build while a
// real JWT in any test file would have passed it.
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const IGNORE_FILE = '.secretscanignore';

/** Files worth scanning: source, config, docs, and the formats a key is
 *  normally pasted into. One set for every pattern — a private key is no less
 *  committed for being in a .md than in a .ts. */
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|ya?ml|toml|sh|env|pem|key)$/;

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

export const PATTERNS: readonly SecretPattern[] = [
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
    id: 'secret-assignment',
    regex: /(?:password|secret_key|api_key|api_secret|auth_token|oauth_token)\s*[:=]\s*["'][A-Za-z0-9_/+=-]{8,}["']/gi,
    benign: /process\.env\.|<your-|^\s*(?:type|interface)\s/,
    message: 'hardcoded secret assignment',
  },
  {
    // Proteus is a public repository. Cloudflare-internal research reached this
    // ecosystem once already: ~/Nimbus kept dossiers under a gitignored
    // `docs/research/`, compiled from Cloudflare's internal repository and wiki,
    // and their SECTION CITATIONS still shipped inside a public production
    // constant. A citation is not a secret, but it names internal material and
    // invites reconstruction, so the names are blocked at the same seam as a
    // credential rather than left to reviewer memory.
    id: 'cf-internal-reference',
    regex: /wiki\.cfdata\.org|cloudflare\/ew\b|edgeworker\b|metrics\.c\+\+|cf-(?:primitives|internal)-dossier/g,
    message: 'Cloudflare-internal source reference (public repo — cite the measurement instead)',
  },
  {
    // Proteus's OWN credentials were the one shape this scan did not cover, and
    // they are the shape most likely to leak from this repo: `proteus tokens
    // create` prints the value once, so it gets pasted — into a chat, a CI
    // config, a scratch file. The precedent is already in the ledger: an
    // OpenRouter key pasted in plaintext into a transcript has never been
    // confirmed rotated, and it is tracked as owner-blocked because the paste
    // is unrecoverable once it lands anywhere durable.
    //
    // `pta_` access token, `ptc_` CLI token, `pdt_` device token. The body is a
    // hex block, so 16+ hex digits after the prefix distinguishes a real value
    // from prose naming the prefix.
    id: 'proteus-token',
    regex: /\bp(?:ta|tc|dt)_[0-9a-f]{16,}/g,
    benign: /<your-|\bpta_\.\.\.|…/,
    message: 'Proteus access/CLI/device token (rotate it — a printed-once value that reached a file is compromised)',
  },
  {
    id: 'credentialed-url',
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]{8,}@/g,
    benign: /<your-|localhost/,
    message: 'connection string with embedded credentials',
  },
];

export interface Finding {
  pattern: string;
  file: string;
  line: number;
  /** The matched text, not the whole line — the line may carry real context. */
  match: string;
  text: string;
}

/** One sanctioned false positive: an exact literal in an exact file.
 *
 *  Deliberately NOT line numbers (any edit above would silently move the
 *  suppression onto a different line) and NOT bare paths (which would blind the
 *  scan to a whole file — the mistake that made the JWT pattern skip every test
 *  file). Moving the fixture is fine; changing it re-arms the scan. */
export interface IgnoreEntry {
  path: string;
  literal: string;
  line: number;
}

export function parseIgnoreFile(text: string): IgnoreEntry[] {
  const entries: IgnoreEntry[] = [];
  text.split('\n').forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const at = trimmed.search(/\s/);
    // A one-field line is the old bare-path format. Refusing it loudly is the
    // point: it used to parse as "ignore this file" and actually do nothing.
    if (at === -1) {
      throw new Error(`${IGNORE_FILE}:${i + 1}: expected "<path> <literal>", got "${trimmed}"`);
    }
    entries.push({ path: trimmed.slice(0, at), literal: trimmed.slice(at).trim(), line: i + 1 });
  });
  return entries;
}

export function scanText(file: string, text: string, patterns: readonly SecretPattern[] = PATTERNS): Finding[] {
  const findings: Finding[] = [];
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

/** An entry suppresses a finding when it names the same file and its literal
 *  appears in the matched text. */
export function suppresses(entry: IgnoreEntry, finding: Finding): boolean {
  return entry.path === finding.file && finding.match.includes(entry.literal);
}

export interface ScanOutcome {
  findings: Finding[];
  /** Entries that suppressed nothing. A suppression nobody needs is a hole
   *  nobody is watching, so it fails the scan rather than lingering. */
  unused: IgnoreEntry[];
}

export function applyIgnores(findings: readonly Finding[], entries: readonly IgnoreEntry[]): ScanOutcome {
  const used = new Set<IgnoreEntry>();
  const kept = findings.filter((f) => {
    const hit = entries.find((e) => suppresses(e, f));
    if (hit) used.add(hit);
    return !hit;
  });
  return { findings: kept, unused: entries.filter((e) => !used.has(e)) };
}

/** Tracked files PLUS new files not covered by `.gitignore`.
 *
 *  `git ls-files -z` alone is tracked-only, so a brand-new file carrying a
 *  credential passed this gate until the commit that introduced it — after
 *  which the secret is already in history and the gate fires too late to
 *  matter. `--others --exclude-standard` closes that window while still
 *  honouring `.gitignore`, which is what keeps the `external/` reference
 *  clones (they contain Cloudflare-internal source) out of the scan. */
function scannableFiles(): string[] {
  const proc = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  if (proc.exitCode !== 0) throw new Error(`git ls-files failed: ${proc.stderr.toString()}`);
  return selectScanCandidates(proc.stdout.toString().split('\0'), (file) =>
    existsSync(join(REPO_ROOT, file))
  );
}

export function selectScanCandidates(
  files: readonly string[],
  exists: (file: string) => boolean,
): string[] {
  return files.filter((file) => file.length > 0 && SCANNED.test(file) && exists(file));
}

function main(): void {
  const ignorePath = join(REPO_ROOT, IGNORE_FILE);
  const entries = existsSync(ignorePath) ? parseIgnoreFile(readFileSync(ignorePath, 'utf8')) : [];

  const files = scannableFiles().filter((f) => f !== IGNORE_FILE && f !== relative(REPO_ROOT, import.meta.path));
  const raw: Finding[] = [];
  for (const file of files) raw.push(...scanText(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
  const { findings, unused } = applyIgnores(raw, entries);

  for (const f of findings) {
    console.error(`::error file=${f.file},line=${f.line}::${f.pattern}: ${f.text}`);
    console.error(`  ${f.file}:${f.line}  ${f.pattern}  ${f.text}`);
  }
  for (const e of unused) {
    console.error(`::error file=${IGNORE_FILE},line=${e.line}::stale suppression: nothing matches "${e.literal}" in ${e.path}`);
  }

  if (findings.length > 0) {
    console.error(`\nSecret scan FAILED — ${findings.length} finding(s).`);
    console.error('If one is genuinely a fixture, add its file and the exact literal to '
      + `${IGNORE_FILE}, one per line, e.g.:\n  ${findings[0]!.file} ${findings[0]!.match}`);
  }
  if (unused.length > 0) {
    console.error(`\n${unused.length} stale ${IGNORE_FILE} entr(ies) — delete them; they suppress nothing.`);
  }
  if (findings.length > 0 || unused.length > 0) process.exit(1);

  console.log(`Secret scan passed — ${PATTERNS.length} patterns over ${files.length} tracked files.`);
}

if (import.meta.main) main();
