#!/usr/bin/env bun
/**
 * The verified half of the secret scan, beside `secret-scan.ts`'s reviewed patterns: TruffleHog's detectors over every
 * ref the clone holds, each candidate tried against its provider, so a finding is a credential that still works. It ran
 * on GitHub (`.github/workflows/security-scan.yml`, TruffleHog v3.97.1 with `--only-verified`) until armada took it
 * (m2184c); `scripts/armada/setup.sh` installs that release, checksum first.
 *
 * A finding prints its detector, commit, file and line, never the credential. A scan that cannot see what it judges
 * is `blocked()`, not clean: a shallow clone holds no history, and a runner that cannot reach a provider verifies
 * nothing, which `--only-verified` would report as no finding.
 */
import * as v from 'valibot';
import { assertMeasured, blocked, finding } from './gate-ratchet';
import { childEnv } from '../packages/test-utils/src/ambient-env';
import { REPO_ROOT } from './repo-root';

const GATE = 'verified-secret-scan';

/** Acknowledges a blocked run for one invocation, with who and why. */
const BLOCKED_ACK = 'KINU_VERIFIED_SECRET_SCAN_BLOCKED';

/** The provider the gate asks before it trusts an empty verified set: GitHub's API, the host its tokens verify at. */
const PROVIDER_PROBE = 'https://api.github.com/zen';

/** One result line of `trufflehog --json`, as far as a report reads it; the credential's own fields are never read. */
const ResultSchema = v.looseObject({
  DetectorName: v.string(),
  Verified: v.boolean(),
  SourceMetadata: v.looseObject({
    Data: v.looseObject({
      Git: v.looseObject({ commit: v.string(), file: v.string(), line: v.optional(v.number()) }),
    }),
  }),
});

/** The summary TruffleHog logs once its scan completes. */
const SummarySchema = v.looseObject({
  msg: v.literal('finished scanning'),
  chunks: v.number(),
  bytes: v.number(),
  verified_secrets: v.number(),
  trufflehog_version: v.string(),
});

export interface VerifiedFinding {
  readonly detector: string;
  readonly commit: string;
  readonly at: string;
}

export type ScanSummary = v.InferOutput<typeof SummarySchema>;

/** One completed scan's exit code and the lines it prints. */
export interface ScanVerdict {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Each JSON line that parses as `schema`; any other line is not this shape's. */
function linesOf<T extends v.GenericSchema>(text: string, schema: T): v.InferOutput<T>[] {
  const line = v.pipe(v.string(), v.parseJson(), schema);

  return text.split('\n').flatMap((each) => {
    const parsed = v.safeParse(line, each);

    return parsed.success ? [parsed.output] : [];
  });
}

/** The verified results on TruffleHog's stdout, by where they sit; the matched value is dropped here. */
export function findingsOf(stdout: string): readonly VerifiedFinding[] {
  return linesOf(stdout, ResultSchema)
    .filter((result) => result.Verified)
    .map(({ DetectorName, SourceMetadata: { Data: { Git } } }) => ({
      detector: DetectorName,
      commit: Git.commit,
      at: Git.line === undefined ? Git.file : `${Git.file}:${String(Git.line)}`,
    }));
}

/** The completed scan's summary on TruffleHog's stderr; undefined when the scan did not finish. */
export function summaryOf(stderr: string): ScanSummary | undefined {
  return linesOf(stderr, SummarySchema).at(-1);
}

/** The verdict lines and exit code of one completed scan: red on any verified credential, else what it measured. */
export function verdictOf(findings: readonly VerifiedFinding[], summary: ScanSummary): ScanVerdict {
  const measured = assertMeasured(GATE, [['chunks', summary.chunks], ['bytes', summary.bytes]]);
  const scanned = `${measured} of every ref the clone holds, TruffleHog ${summary.trufflehog_version}`;

  if (findings.length === 0) return { code: 0, lines: [`${GATE}: ok — no verified credential in ${scanned}`] };

  return {
    code: 1,
    lines: [
      `${GATE}: ${String(findings.length)} verified credential(s) in ${scanned}`,
      ...findings.map((each) => finding({
        invariant: 'no credential that still works is reachable from any ref',
        at: `${each.at} @ ${each.commit}`,
        found: `a ${each.detector} credential its provider accepts`,
        silently: 'it stays usable by anyone who can read the history, whatever the tree shows today',
        fix: 'revoke it at the provider first, then remove it; rewriting history alone leaves it live',
      })),
    ],
  };
}

async function providerReachable(): Promise<string | undefined> {
  const [probe] = await Promise.allSettled([fetch(PROVIDER_PROBE, { method: 'HEAD' })]);

  return probe.status === 'fulfilled' ? undefined : String(probe.reason);
}

async function main(): Promise<number> {
  const acknowledged = process.env[BLOCKED_ACK];
  const binary = Bun.which('trufflehog');

  if (binary === null) {
    return blocked(GATE, 'trufflehog is not installed here (scripts/armada/setup.sh installs it on armada)', BLOCKED_ACK, acknowledged);
  }

  const shallow = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT }).stdout.toString().trim();

  if (shallow !== 'false') {
    return blocked(GATE, `the clone is shallow (${shallow}), so the history this scan judges is not in it`, BLOCKED_ACK, acknowledged);
  }

  const unreachable = await providerReachable();

  if (unreachable !== undefined) {
    return blocked(GATE, `${PROVIDER_PROBE} is unreachable (${unreachable}), so no candidate could be verified`, BLOCKED_ACK, acknowledged);
  }

  const scan = Bun.spawn([binary, 'git', 'file://.', '--only-verified', '--json', '--no-update'], {
    cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: childEnv(),
  });

  const [stdout, stderr, exitCode] = await Promise.all([new Response(scan.stdout).text(), new Response(scan.stderr).text(), scan.exited]);
  const summary = summaryOf(stderr);

  if (exitCode !== 0 || summary === undefined) {
    console.error(`${GATE}: trufflehog exited ${String(exitCode)} ${summary === undefined ? 'without finishing its scan' : 'after its scan'}; the scan it reports on did not complete, which is no verdict\n${stderr.trim().split('\n').slice(-5).join('\n')}`);

    return 1;
  }

  const { code, lines } = verdictOf(findingsOf(stdout), summary);

  for (const line of lines) (code === 0 ? console.log : console.error)(line);

  return code;
}

if (import.meta.main) process.exit(await main());
