/** Where secret shapes sit in a text: findings name where and which, never the value (blueprint pages are public). */
import { SECRET_PATTERNS, type SecretPattern } from './secret-patterns';

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
