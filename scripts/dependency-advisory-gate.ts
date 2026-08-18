/**
 * The gate over `bun pm scan`: the reviewed advisory set is the whole assertion.
 *
 * `install-scripts-gate.ts` decides which dependency lifecycle scripts may
 * EXECUTE and says so in its own blind-spot note: it cannot see CVEs, and
 * `bun pm scan` is the tool that can. Measured at b4b2f2d2, `bun pm scan` was
 * invoked nowhere in this repository — and could not have been useful if it had
 * been, because bun ships no scanner and answers `error: no security scanner
 * configured`. `scripts/security-scanner.ts` supplies one; this gate is what
 * makes its verdict mean something.
 *
 * WHAT IT ASSERTS. Not "the scanner found nothing" — this tree has 54 advisories
 * across 19 packages and will have more tomorrow, so a gate failing on any
 * finding would be red on the day it landed and disabled the day after. It
 * asserts that the set of exposures is EXACTLY the reviewed set in
 * `REVIEWED_ADVISORIES`, and it fails in both directions:
 *
 *   - an advisory matching an installed version that no entry accounts for — a
 *     new vulnerable dependency, or a new advisory against an accepted one;
 *   - a recorded id that no longer reproduces — a fixed or withdrawn advisory
 *     whose acceptance would otherwise pre-approve the next one against that
 *     package.
 *
 * That is the same shape as `ALLOWED_INSTALL_SCRIPTS` next door and as
 * `gate-set-equality.ts`: pin the reviewed set, fail when it CHANGES, and make
 * every change an edit somebody has to justify. It is deliberately not a
 * judgement about whether an advisory is exploitable here — it cannot be, and a
 * gate that guessed would be worse than one that reports honestly.
 *
 * IT ALSO ASSERTS THE WIRING. A reviewed set is worthless if the scanner behind
 * it is not the one `bun install` uses, so the gate reads `bunfig.toml` and
 * fails unless `[install.security] scanner` is exactly {@link SCANNER_PATH}.
 * Without that line `bun pm scan` exits unconfigured and every install skips the
 * check, while this gate would still be printing a tidy verdict about a
 * reviewed set — green over something nobody looked at, one level up.
 *
 * OFFLINE. The feed is a network call. An unreachable or unreadable feed is
 * `unknown`, never `clean`: the scan is not judged, and the gate returns
 * `blocked()` — non-zero by default, acknowledgeable for one run with
 * {@link UNREACHABLE_ACK} so the acknowledgement lands in the invocation rather
 * than in a comment. This gate therefore runs at the `ci` tier, never at commit
 * or push: a pre-push hook that needs the network would fail every offline push,
 * and `--no-verify` is not an option here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { assertMeasured, blocked, finding } from './gate-ratchet.ts';
import {
  REPORT_ENV, REPORT_SENTINEL, REVIEWED_ADVISORIES, SEVERITIES,
  type AdvisoryScan, type Exposure, type ReviewedPackage,
} from './security-scanner.ts';

const REPO_ROOT = join(import.meta.dir, '..');

export const GATE = 'dependency-advisories';

/** What `bunfig.toml` must name, exactly. */
export const SCANNER_PATH = './scripts/security-scanner.ts';

/** Names the environment variable that records "I know the feed was down". */
export const UNREACHABLE_ACK = 'PROTEUS_ADVISORY_FEED_BLOCKED';

/* ── The wiring ─────────────────────────────────────────────────────────── */

/**
 * The scanner `bunfig.toml` configures, or undefined when the tree has none.
 * Read from the `[install.security]` table specifically: a `scanner` key under
 * any other table configures nothing and must not read as wired.
 */
export function configuredScanner(bunfig: string): string | undefined {
  let table = '';
  for (const raw of bunfig.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      table = header[1];
      continue;
    }
    if (table !== 'install.security') continue;
    const key = /^scanner\s*=\s*"([^"]*)"/.exec(line);
    if (key?.[1] !== undefined) return key[1];
  }
  return undefined;
}

/* ── The measurement ────────────────────────────────────────────────────── */

const ScanSchema: v.GenericSchema<AdvisoryScan> = v.variant('status', [
  v.object({
    status: v.literal('reported'),
    scanned: v.number(),
    exposures: v.array(v.object({
      pkg: v.string(),
      version: v.string(),
      id: v.number(),
      severity: v.picklist(SEVERITIES),
      title: v.string(),
      url: v.string(),
      range: v.string(),
    })),
  }),
  v.object({
    status: v.literal('unreachable'),
    scanned: v.number(),
    reason: v.picklist(['io', 'unreadable']),
    error: v.string(),
  }),
]);

/**
 * The scan `bun pm scan` performed, read from the scanner itself.
 *
 * Bun enumerates the lockfile and hands the set to the scanner, so this gate
 * never derives its own package list — a second derivation is a second
 * enumeration, and drifting narrower than the thing enforced is the defect
 * `gate:set-equality` exists to prevent. A run that produces no report line is
 * a broken measurement and throws: it is not an empty one, and it is certainly
 * not a clean tree.
 */
export function scanViaBun(cwd: string = REPO_ROOT): AdvisoryScan {
  const proc = Bun.spawnSync(['bun', 'pm', 'scan'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, [REPORT_ENV]: '1' },
  });
  const stdout = proc.stdout.toString();
  const line = stdout.split('\n').find((each) => each.startsWith(REPORT_SENTINEL));
  if (line === undefined) {
    throw new Error(
      `${GATE}: bun pm scan produced no ${REPORT_SENTINEL} line (exit ${String(proc.exitCode)}). `
      + 'The scan this gate reports on did not run, so there is nothing to judge — and a gate '
      + 'that treated that as a clean tree would certify a scan that never happened.\n'
      + `  stdout: ${stdout.trim().slice(0, 300)}\n`
      + `  stderr: ${proc.stderr.toString().trim().slice(0, 300)}`,
    );
  }
  return v.parse(ScanSchema, JSON.parse(line.slice(REPORT_SENTINEL.length)));
}

/* ── The assertion ──────────────────────────────────────────────────────── */

export interface AdvisoryFinding {
  readonly at: string;
  readonly rendered: string;
}

export interface AdvisoryVerdict {
  readonly findings: readonly AdvisoryFinding[];
  /** Exposures the reviewed set accounts for. */
  readonly accepted: number;
}

/**
 * Compare the measured exposures against the reviewed set, both directions.
 * Pure, so the decision boundary is testable without a network round trip.
 */
export function judgeAdvisories(
  exposures: readonly Exposure[],
  reviewed: Record<string, ReviewedPackage> = REVIEWED_ADVISORIES,
): AdvisoryVerdict {
  const matched = new Set<string>();
  const packagesSeen = new Set<string>();
  for (const exposure of exposures) {
    matched.add(`${exposure.pkg}#${String(exposure.id)}`);
    packagesSeen.add(exposure.pkg);
  }

  const findings: AdvisoryFinding[] = [];
  let accepted = 0;
  for (const exposure of exposures) {
    const entry = reviewed[exposure.pkg];
    if (entry !== undefined && entry.ids.includes(exposure.id)) {
      accepted += 1;
      continue;
    }
    const at = `${exposure.pkg}@${exposure.version} — advisory ${String(exposure.id)}`;
    findings.push({
      at,
      rendered: finding({
        invariant: 'every advisory matching an installed version is recorded in '
          + 'REVIEWED_ADVISORIES with the reason it is accepted',
        at,
        found: `${exposure.severity}: ${exposure.title} (vulnerable ${exposure.range}) ${exposure.url}`,
        silently: entry === undefined
          ? 'a package this repository never reviewed carries a known vulnerability. Before a '
            + 'scanner was configured `bun pm scan` exited unconfigured and every `bun install` '
            + 'proceeded with no advisory check at all, so it would have arrived unremarked'
          : 'a package whose OTHER advisories were reviewed gained a new one, and a per-package '
            + 'acceptance would have covered it without anybody reading it',
        fix: 'bump the dependency out of the vulnerable range, or add the id to that package\'s '
          + '`ids` in REVIEWED_ADVISORIES with the reason it is accepted',
      }),
    });
  }

  for (const [pkg, entry] of Object.entries(reviewed)) {
    for (const id of entry.ids) {
      if (matched.has(`${pkg}#${String(id)}`)) continue;
      const at = `${pkg} — advisory ${String(id)}`;
      findings.push({
        at,
        rendered: finding({
          invariant: 'REVIEWED_ADVISORIES describes the tree as it is now',
          at,
          found: packagesSeen.has(pkg)
            ? 'recorded as accepted, but no installed version matches it any more'
            : `recorded as accepted, but ${pkg} now has no matching advisory at all`,
          silently: 'a fixed or withdrawn advisory keeps its acceptance, so the list stops being '
            + 'a statement about reality and the next real advisory against this package is '
            + 'pre-approved by an entry nobody re-read',
          fix: `drop ${String(id)} from ${pkg} in REVIEWED_ADVISORIES (and the package too, once `
            + 'it has no ids left)',
        }),
      });
    }
  }
  return { findings, accepted };
}

/* ── The verdict ────────────────────────────────────────────────────────── */

function main(): number {
  const wired = configuredScanner(readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8'));
  if (wired !== SCANNER_PATH) {
    console.error(`${GATE}: 1 finding\n`);
    console.error(finding({
      invariant: `bunfig.toml [install.security] scanner is "${SCANNER_PATH}"`,
      at: 'bunfig.toml [install.security]',
      found: wired === undefined ? 'no scanner configured' : `scanner = "${wired}"`,
      silently: 'bun ships no built-in scanner, so `bun pm scan` exits with "no security scanner '
        + 'configured" and every `bun install` unpacks tarballs with no advisory check — while '
        + 'this gate would still print a verdict about a reviewed set, which is a green signal '
        + 'over a scan that never ran',
      fix: `set scanner = "${SCANNER_PATH}" in bunfig.toml`,
    }));
    return 1;
  }

  const scan = scanViaBun();
  if (scan.status === 'unreachable') {
    return blocked(
      GATE,
      `the advisory feed is ${scan.reason === 'io' ? 'unreachable' : 'unreadable'} (${scan.error}), `
      + `so none of the ${String(scan.scanned)} lockfile package(s) was checked. The reviewed set `
      + 'could not be compared against anything — this is `unknown`, not `clean`',
      UNREACHABLE_ACK,
    );
  }

  const reviewedPackages = Object.keys(REVIEWED_ADVISORIES).length;
  const reviewedIds = Object.values<ReviewedPackage>(REVIEWED_ADVISORIES)
    .reduce((total, entry) => total + entry.ids.length, 0);
  const measured = assertMeasured(GATE, [
    ['lockfile packages scanned', scan.scanned],
    ['reviewed packages', reviewedPackages],
    ['reviewed advisory ids', reviewedIds],
  ]);

  const { findings, accepted } = judgeAdvisories(scan.exposures);
  if (findings.length > 0) {
    console.error(`${GATE}: ${String(findings.length)} finding(s)\n`);
    for (const each of findings) {
      console.error(`::error::${GATE}: ${each.at}`);
      console.error(each.rendered);
    }
    console.error(`\n${GATE}: ${measured}`);
    return 1;
  }
  console.log(
    `${GATE}: ok — ${measured}, ${String(scan.exposures.length)} exposure(s) matched and all `
    + `${String(accepted)} accounted for by review, 0 recorded id(s) stale`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
