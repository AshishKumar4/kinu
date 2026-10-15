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

/** Every secret shape in `text`, pattern by pattern, line by line: the pattern, the line (1-based) and the match. A line
 *  its pattern reads as benign is skipped. */
function* secretMatches(text: string, patterns: readonly SecretPattern[]): Generator<{ readonly pattern: SecretPattern; readonly line: number; readonly text: string; readonly match: string }> {
  const lines = text.split('\n');

  for (const pattern of patterns) {
    for (const [index, line] of lines.entries()) {
      if (pattern.benign?.test(line)) continue;

      for (const m of line.matchAll(pattern.regex)) yield { pattern, line: index + 1, text: line, match: m[0] };
    }
  }
}

export function scanText(file: string, text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretFinding[] {
  return [...secretMatches(text, patterns)].map((m) => ({ pattern: m.pattern.id, file, line: m.line, match: m.match, text: m.text.trim() }));
}

/** Detector counts only; never retains a matched value. */
export function countDetections(
  text: string,
  patterns: readonly SecretPattern[] = SECRET_PATTERNS,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const { pattern } of secretMatches(text, patterns)) counts.set(pattern.id, (counts.get(pattern.id) ?? 0) + 1);

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
  return [...secretMatches(text, patterns)].map(({ pattern, line }) => ({ path, line, pattern: pattern.id, message: pattern.message }));
}
