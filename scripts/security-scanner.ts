/**
 * The security scanner `bun pm scan` and every `bun install` run through.
 *
 * `bun pm scan` was named in `scripts/ladder.ts` as the tool covering the CVE
 * blind spot of `install-scripts-gate.ts` and was wired nowhere: measured at
 * d02f146b it appears in no package.json script, no workflow and no
 * `scripts/*.ts`. Running it proves why — bun ships NO built-in scanner, so a
 * bare `bun pm scan` exits 1 with `error: no security scanner configured` and
 * `bun install` performs no advisory check at all. The blind spot was not a
 * missing invocation; it was a missing scanner.
 *
 * So this file IS the scanner. `bunfig.toml`'s `[install.security] scanner`
 * points at it, which is what makes `bun pm scan` a real check and — the part
 * that actually protects anything — makes every `bun install` consult the
 * advisory feed before unpacking a tarball. Measured: bun hands it all 1288
 * lockfile entries, and it does so on a warm tree too, not only when resolving.
 *
 * WHAT IT BLOCKS, AND WHY THAT IS NOT "EVERY FINDING". This tree carries 54
 * advisories across 19 packages today, 17 of them transitive through wrangler,
 * miniflare, puppeteer and the MCP SDK. A scanner returning an advisory for
 * each would refuse every `bun install` in CI and on this box, and would be
 * ripped out of bunfig.toml the same day — a scanner nobody can afford to run
 * protects nothing. So the accepted set is REVIEWED and recorded here with a
 * reason per package, and only an exposure OUTSIDE it is reported to bun. A new
 * vulnerable package, or a new advisory id against one already accepted, stops
 * the install and has to be argued for. That is the same shape as
 * `ALLOWED_INSTALL_SCRIPTS`: the set is a decision, not a default.
 *
 * OFFLINE IS `unknown`, NEVER `clean`. The feed is a network call, so it can
 * fail, and `return []` on failure would make "nothing is vulnerable"
 * indistinguishable from "nobody looked" — the defect class this repository
 * pays for elsewhere. An unreachable or unreadable feed therefore yields a
 * `warn` advisory naming the outage: bun prompts an interactive developer, who
 * can proceed knowing the check did not run, and CANCELS in any non-TTY, so no
 * automated install is ever certified by a scan that never happened. The gate
 * over this file, `dependency-advisory-gate.ts`, refuses even harder — see
 * `blocked()` there.
 *
 * Bun's scanner contract is declared here rather than imported: `Bun.Security`
 * does not exist in the installed `@types/bun` (1.3.14), so `Bun.Security.Scanner`
 * would not typecheck.
 */

import * as v from 'valibot';

/** npm's bulk advisory endpoint — the source `npm audit` reads, and the only
 *  one reachable without a vendor credential. One POST answers the whole tree. */
export const ADVISORY_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

/** A feed that hangs must not hang CI. */
const FEED_TIMEOUT_MS = 20_000;

/** Set for the gate's own `bun pm scan` run: emits the machine-readable scan on
 *  stdout behind {@link REPORT_SENTINEL}. Bun consumes the scanner's return
 *  value itself and offers a caller no structured channel, so the gate reads the
 *  scan the scanner actually performed instead of re-deriving one — a second
 *  derivation is a second enumeration, which is what `gate:set-equality` exists
 *  to prevent. */
export const REPORT_ENV = 'KINU_ADVISORY_REPORT';

/** Prefix of the one machine-readable stdout line. */
export const REPORT_SENTINEL = '::kinu-advisory-report::';

/* ── Bun's scanner contract ─────────────────────────────────────────────── */

/** One entry bun offers for scanning, as bun spells it. */
export interface ScannedPackage {
  readonly name: string;
  readonly version: string;
  readonly requestedRange: string;
  readonly tarball: string;
}

/**
 * `fatal` stops an install immediately. `warn` prompts in a TTY and cancels in
 * any non-TTY, which is why it is the honest level for "the check did not run".
 */
export type AdvisoryLevel = 'fatal' | 'warn';

export interface BunAdvisory {
  readonly level: AdvisoryLevel;
  readonly package: string;
  readonly url: string | null;
  readonly description: string | null;
}

export interface BunScanner {
  readonly version: '1';
  scan(request: { readonly packages: readonly ScannedPackage[] }): Promise<BunAdvisory[]>;
}

/* ── The feed ───────────────────────────────────────────────────────────── */

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

const AdvisorySchema = v.object({
  id: v.number(),
  url: v.string(),
  title: v.string(),
  severity: v.picklist(SEVERITIES),
  vulnerable_versions: v.string(),
});

const BulkSchema = v.record(v.string(), v.array(AdvisorySchema));

/** One installed version matched by one advisory. The unit of review: a package
 *  is not "vulnerable", a version is, and only against a named advisory. */
export interface Exposure {
  readonly pkg: string;
  readonly version: string;
  readonly id: number;
  readonly severity: Severity;
  readonly title: string;
  readonly url: string;
  /** The advisory's own vulnerable range, so a reader can check the match. */
  readonly range: string;
}

/**
 * The scan, with `unreachable` a first-class outcome carrying its cause. An
 * empty `exposures` under `reported` means the feed answered and matched
 * nothing; it can never mean the feed failed.
 */
export type AdvisoryScan =
  | { readonly status: 'reported'; readonly scanned: number; readonly exposures: readonly Exposure[] }
  | {
    readonly status: 'unreachable';
    readonly scanned: number;
    /** `io` — the feed did not answer. `unreadable` — it answered something no
     *  reader here can trust, which is not the same defect and not a clean tree. */
    readonly reason: 'io' | 'unreadable';
    readonly error: string;
  };

/** An `Error` and the cause it wraps, which is where a fetch failure keeps the
 *  syscall-level reason worth reading. */
function causeChain(error: Error): string {
  const cause = error.cause instanceof Error ? ` <- ${error.cause.name}: ${error.cause.message}` : '';
  return `${error.name}: ${error.message}${cause}`;
}

/**
 * Ask the feed about exactly the installed versions, then re-check every
 * returned range locally with `Bun.semver.satisfies`. The endpoint answers per
 * NAME once any submitted version matches, so attributing an advisory to the
 * version that actually matches is this function's job, not the feed's.
 */
export async function queryAdvisories(
  packages: readonly ScannedPackage[],
  endpoint: string = ADVISORY_ENDPOINT,
): Promise<AdvisoryScan> {
  const installed = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const versions = installed.get(pkg.name) ?? new Set<string>();
    versions.add(pkg.version);
    installed.set(pkg.name, versions);
  }
  const scanned = packages.length;
  if (scanned === 0) return { status: 'reported', scanned, exposures: [] };

  const body: Record<string, string[]> = {};
  for (const [name, versions] of installed) body[name] = [...versions];

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 'unreachable',
      scanned,
      reason: 'io',
      error: error instanceof Error ? causeChain(error) : String(error),
    };
  }
  if (!response.ok) {
    return {
      status: 'unreachable',
      scanned,
      reason: 'io',
      error: `${endpoint} answered HTTP ${String(response.status)}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: 'unreachable',
      scanned,
      reason: 'unreadable',
      error: error instanceof Error ? causeChain(error) : String(error),
    };
  }
  const parsed = v.safeParse(BulkSchema, payload);
  if (!parsed.success) {
    return {
      status: 'unreachable',
      scanned,
      reason: 'unreadable',
      error: `advisory feed returned a shape this scanner cannot read: ${parsed.issues[0]?.message ?? 'unknown'}`,
    };
  }

  const exposures: Exposure[] = [];
  for (const [pkg, advisories] of Object.entries(parsed.output)) {
    const versions = installed.get(pkg);
    if (versions === undefined) continue;
    for (const advisory of advisories) {
      for (const version of versions) {
        if (!Bun.semver.satisfies(version, advisory.vulnerable_versions)) continue;
        exposures.push({
          pkg,
          version,
          id: advisory.id,
          severity: advisory.severity,
          title: advisory.title,
          url: advisory.url,
          range: advisory.vulnerable_versions,
        });
      }
    }
  }
  exposures.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.id - b.id || a.version.localeCompare(b.version));
  return { status: 'reported', scanned, exposures };
}

/* ── The reviewed set ───────────────────────────────────────────────────── */

/** An accepted package, the advisory ids accepted with it, and why. */
export interface ReviewedPackage {
  /** How it is reached and what would remove it. Measured with `bun pm why`. */
  readonly reason: string;
  /** Advisory ids accepted at review time. A new id against this package is a
   *  new decision and fails the gate. */
  readonly ids: readonly number[];
}

/**
 * Every advisory this repository accepts, reviewed 2026-08-17 against bun.lock
 * at d02f146b: 54 ids over 19 packages. Provenance in every reason is measured
 * `bun pm why` output, not inference.
 *
 * Seventeen arrive through wrangler, miniflare, puppeteer, the MCP SDK, @opentui
 * and the pi-coding-agent dev toolchain, most at versions those parents pin
 * exactly. Two are our own direct dependencies — `valibot` and `shell-quote` —
 * and in both the vulnerable function is called nowhere in tracked source.
 * `react-router` is the one entry that ships in code we serve.
 *
 * Six entries say a lockfile refresh would clear them. That is a statement this
 * gate then enforces: once the refresh happens the ids stop reproducing and the
 * gate fails until the entries are deleted, so "we will fix it later" cannot
 * quietly become "we accepted it forever".
 */
export const REVIEWED_ADVISORIES = {
  '@hono/node-server': {
    reason: 'transitive: @modelcontextprotocol/sdk requires ^1.19.9, resolved 1.19.14. '
      + 'Windows-only path traversal in serve-static; nothing here starts the SDK\'s Node '
      + 'server. Fixed in 1.19.15, inside the SDK\'s range — a lockfile refresh clears it.',
    ids: [1139322],
  },
  'body-parser': {
    reason: 'transitive: express 5.2.1 <- @modelcontextprotocol/sdk. DoS when an invalid limit '
      + 'silently disables size enforcement; this repository mounts no express app.',
    ids: [1123976],
  },
  'brace-expansion': {
    reason: 'transitive: minimatch 10.2.5 <- @earendil-works/pi-coding-agent (dev, pinned '
      + '0.84.2), glob and just-bash. Expansion DoS driven by the glob pattern, which the dev '
      + 'toolchain supplies to itself.',
    ids: [1123898, 1130591, 1130734],
  },
  diff: {
    reason: 'transitive: @opentui/core pins 8.0.2 exactly and just-bash requires ^8.0.2. '
      + 'parsePatch/applyPatch DoS on a crafted patch. The fix is 8.0.3, which @opentui\'s exact '
      + 'pin blocks until it moves.',
    ids: [1112706],
  },
  'extract-zip': {
    reason: 'transitive: @puppeteer/browsers <- puppeteer (dev). Unvalidated symlink path '
      + 'traversal while unpacking; the only archive it unpacks is the Chrome build puppeteer '
      + 'downloads. No fixed release exists — the advisory covers <=2.0.1, the latest publish.',
    ids: [1139346],
  },
  'file-type': {
    reason: 'transitive: @jimp/core requires ^16.0.0 <- jimp <- @opentui/core, the CLI\'s TUI '
      + 'image path. Infinite loop in the ASF parser on malformed input. 16.5.4 is the last of '
      + 'that major line, so the fix (21.3.1) needs a @jimp bump.',
    ids: [1114301],
  },
  hono: {
    reason: 'transitive: @modelcontextprotocol/sdk requires ^4.11.4, resolved 4.12.23. The '
      + '4.13.2 copy our @cloudflare/sandbox path uses matches none of these. All twelve are '
      + 'middleware and adapter defects — CORS, JSX/memo per-request context, Lambda and API '
      + 'Gateway adapters, serve-static — in an app this repository never mounts. The SDK range '
      + 'admits the fixed 4.12.34.',
    ids: [
      1123997, 1123998, 1123999, 1124000, 1124001, 1124005,
      1124009, 1124010, 1130733, 1138771, 1138772, 1138773,
    ],
  },
  'ip-address': {
    reason: 'transitive: express-rate-limit 8.5.2 <- @modelcontextprotocol/sdk. Leading-zero '
      + 'octet and IPv4-mapped misclassification that can bypass an SSRF check — in the rate '
      + 'limiter, which nothing here mounts.',
    ids: [1130722, 1130723, 1130724],
  },
  'js-yaml': {
    reason: 'transitive: cosmiconfig 9.0.1 <- puppeteer (dev). Quadratic CPU on merge-key chains '
      + 'and !!omap; the only YAML it loads is a puppeteer config in this repository. Fixed in '
      + '4.3.0/4.3.1, inside cosmiconfig\'s ^4.1.0.',
    ids: [1123911, 1138115],
  },
  nanoid: {
    reason: 'transitive: postcss requires ^3.3.12 <- vite <- vitest. The non-secure generator '
      + 'loops forever on a negative or zero size; postcss calls it with a fixed size. Build '
      + 'and test only.',
    ids: [1138811, 1139427],
  },
  postcss: {
    reason: 'transitive: vite 8.0.16 requires ^8.5.15 <- vitest. Path traversal via '
      + 'sourceMappingURL auto-loading, at build time over CSS in this repository. Fixed above '
      + '8.5.22, inside vite\'s range.',
    ids: [1130709, 1139510],
  },
  'react-router': {
    reason: 'SHIPS IN CODE WE SERVE: react-router-dom 7.16.0 <- @kinu/cf-backend (^7.14.1). '
      + 'Open redirect via backslash, RSC XSS and CSRF bypass, constructor injection through '
      + 'deserializeErrors, and route-matching DoS. Our own ^7.14.1 admits the fixed 7.18.2, so '
      + 'a lockfile refresh clears all five: accepted until that refresh, not indefinitely.',
    ids: [1124268, 1124271, 1124272, 1124276, 1138769],
  },
  'shell-quote': {
    reason: 'declared by @kinu/agent-utils (^1.8.3) and imported by NO tracked source, so the '
      + 'quadratic parse() is called nowhere here. No fixed release exists either: the advisory '
      + 'covers <=1.8.4, which is the latest publish. Removing the unused declaration would '
      + 'remove this entry.',
    ids: [1123944],
  },
  valibot: {
    reason: 'direct: the root manifest and @kinu/cf-backend both require ^1.4.1. record() '
      + 'issue paths can make flatten() throw for an inherited Object property name, and '
      + 'flatten() is called in no package src. `bun update --dry-run` resolves 1.4.2, outside '
      + 'the vulnerable <=1.4.1 — the next lockfile refresh clears it.',
    ids: [1124298],
  },
} satisfies Record<string, ReviewedPackage>;

/** Exposures the reviewed set does not account for. */
export function unreviewedExposures(
  exposures: readonly Exposure[],
  reviewed: Record<string, ReviewedPackage> = REVIEWED_ADVISORIES,
): readonly Exposure[] {
  return exposures.filter((exposure) => {
    const entry = reviewed[exposure.pkg];
    return entry === undefined || !entry.ids.includes(exposure.id);
  });
}

/** The name bun prints for an outage. Not a package, and it must not collide
 *  with one, because the line means the scan did not happen. */
const FEED_SUBJECT = '(advisory feed)';

/**
 * What bun is told about a scan. The one place the outage decision is made, so
 * both branches are testable: an unreachable feed yields a `warn` and NEVER an
 * empty list, because an empty list is how "nobody looked" becomes "nothing is
 * wrong".
 */
export function advisoriesFor(scan: AdvisoryScan): BunAdvisory[] {
  if (scan.status === 'unreachable') {
    return [{
      level: 'warn',
      package: FEED_SUBJECT,
      url: ADVISORY_ENDPOINT,
      description: `advisory feed ${scan.reason === 'io' ? 'unreachable' : 'unreadable'} — `
        + `${String(scan.scanned)} package(s) were NOT checked for known vulnerabilities: `
        + `${scan.error}. This is not a clean scan. Continue only if you accept installing `
        + 'unchecked.',
    }];
  }
  // critical/high stop even an interactive install; the rest cancel every
  // automated one and let a developer decide in a terminal.
  return unreviewedExposures(scan.exposures).map((exposure) => ({
    level: exposure.severity === 'critical' || exposure.severity === 'high' ? 'fatal' : 'warn',
    package: exposure.pkg,
    url: exposure.url,
    description: `${exposure.severity} advisory ${String(exposure.id)} matches installed `
      + `${exposure.pkg}@${exposure.version} (vulnerable ${exposure.range}): ${exposure.title}. `
      + 'Not in REVIEWED_ADVISORIES in scripts/security-scanner.ts — bump the dependency, or '
      + 'record it there with the reason it is accepted.',
  }));
}

export const scanner: BunScanner = {
  version: '1',
  async scan({ packages }) {
    const scan = await queryAdvisories(packages);
    if ((process.env[REPORT_ENV] ?? '').trim().length > 0) {
      console.log(REPORT_SENTINEL + JSON.stringify(scan));
    }
    return advisoriesFor(scan);
  },
};
