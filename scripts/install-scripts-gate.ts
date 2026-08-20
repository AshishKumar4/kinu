/**
 * The dependency lifecycle scripts this repository allows to execute.
 *
 * Bun blocks a dependency's `preinstall`/`install`/`postinstall` unless the
 * package is trusted — and it ships its OWN built-in allowlist, which is not in
 * this repository and can widen in a patch release. So "we do not run install
 * scripts" was true here by Bun's default and asserted by nothing:
 * `trustedDependencies` is absent from package.json, and reading only
 * `bun pm untrusted` says five packages were blocked while saying nothing about
 * the four that ran.
 *
 * Nine dependencies declare a lifecycle script. Five are blocked. FOUR EXECUTE,
 * and they are the highest-risk shape there is: `esbuild/install.js` and
 * `workerd/install.js` both contain `fetch(`, `https.get`, `child_process` and
 * `execFileSync` — fetch a binary at install time and run it. `sharp` falls
 * through to a native compile. That happens on every `bun install`, including
 * CI and scripts/deploy.sh.
 *
 * This gate makes the set a decision instead of a default. Adding a package to
 * ALLOWED_INSTALL_SCRIPTS is a deliberate edit with a stated reason; a new
 * dependency that arrives WITH a lifecycle script — or an existing one that
 * gains one, or a `trustedDependencies` entry appearing in package.json — fails
 * here and has to be argued for.
 *
 * It deliberately does NOT try to decide whether a script is safe. It cannot,
 * and a gate that guessed would be worse than one that reports honestly.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const REPO_ROOT = join(import.meta.dir, '..');
const MODULES = join(REPO_ROOT, 'node_modules');

/** The lifecycle hooks Bun will run for a trusted package. */
const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

/** Package name -> the recorded reason its lifecycle script may execute. */
export type InstallScriptAllowlist = Readonly<Record<string, string>>;

/**
 * Packages whose lifecycle scripts we accept, each with the reason. Every entry
 * is a build-time binary fetch or native compile for a dependency we chose;
 * none is optional at the version we pin.
 */
export const ALLOWED_INSTALL_SCRIPTS = {
  esbuild: 'downloads its platform binary; vite and the bundler chain cannot build without it',
  workerd: 'downloads the Cloudflare runtime binary that `vitest-pool-workers` and `wrangler dev` execute',
  puppeteer: 'resolves a browser for the `browser` tool and the screenshot gates',
} satisfies InstallScriptAllowlist;

/** Reason this package's lifecycle script may run, or undefined when unlisted. */
function allowedReason(pkg: string): string | undefined {
  // Searched rather than indexed: the literal keeps its inferred key literals (so
  // a typo in the allowlist is a type error), and looking a runtime string up in
  // it needs no assertion. Four entries.
  for (const [name, reason] of Object.entries(ALLOWED_INSTALL_SCRIPTS)) {
    if (name === pkg) return reason;
  }
  return undefined;
}

const PackageJsonSchema = v.object({
  name: v.optional(v.string()),
  scripts: v.optional(v.record(v.string(), v.string())),
  trustedDependencies: v.optional(v.array(v.string())),
});

export interface DeclaredScript {
  readonly pkg: string;
  readonly hooks: readonly string[];
}

/** Every installed dependency that declares a lifecycle hook, scoped names included. */
export function declaredInstallScripts(modules: string = MODULES): readonly DeclaredScript[] {
  if (!existsSync(modules)) return [];
  const out: DeclaredScript[] = [];
  const consider = (dir: string, pkgName: string): void => {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) return;
    const parsed = v.safeParse(PackageJsonSchema, JSON.parse(readFileSync(manifest, 'utf8')));
    if (!parsed.success) return;
    const scripts = parsed.output.scripts ?? {};
    const hooks = LIFECYCLE.filter((h) => scripts[h] !== undefined);
    if (hooks.length > 0) out.push({ pkg: parsed.output.name ?? pkgName, hooks });
  };
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scope = join(modules, entry.name);
      if (!existsSync(scope)) continue;
      for (const inner of readdirSync(scope, { withFileTypes: true })) {
        consider(join(scope, inner.name), `${entry.name}/${inner.name}`);
      }
      continue;
    }
    consider(join(modules, entry.name), entry.name);
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** `trustedDependencies` from the root manifest — Bun's per-repo allowlist. */
export function rootTrustedDependencies(root: string = REPO_ROOT): readonly string[] {
  const parsed = v.parse(PackageJsonSchema, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  return parsed.trustedDependencies ?? [];
}

export interface GateFinding {
  readonly pkg: string;
  readonly detail: string;
}

/**
 * The packages whose lifecycle scripts bun REFUSED to run, asked of bun itself.
 *
 * Parsed from `bun pm untrusted`, whose lines read
 * `./node_modules/@scope/name @1.2.3`. Nothing else can answer this: bun's
 * built-in trusted list is compiled into bun, not declared here, so subtracting
 * this set from the declared set is the only way to learn what EXECUTES.
 */
export function blockedByBun(cwd: string = REPO_ROOT): ReadonlySet<string> {
  const proc = Bun.spawnSync(['bun', 'pm', 'untrusted'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const text = proc.stdout.toString();
  if (proc.exitCode !== 0 && text.trim() === '') {
    throw new Error(
      `bun pm untrusted failed (exit ${proc.exitCode}) — cannot determine which install scripts `
      + `bun blocked, so this gate refuses to guess: ${proc.stderr.toString().trim()}`,
    );
  }
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\.\/node_modules\/(@[^/\s]+\/[^/\s]+|[^/\s@][^/\s]*)\s+@/.exec(line.trim());
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

export interface GateOutcome {
  readonly declared: readonly DeclaredScript[];
  readonly allowed: readonly string[];
  /** Packages bun refused to run, per `bun pm untrusted`. */
  readonly blocked: readonly string[];
  /** declared minus blocked — the scripts that actually execute on install. */
  readonly ran: readonly string[];
  readonly findings: readonly GateFinding[];
}

/**
 * The whole check. `declared` is the denominator and it must not be empty: this
 * repo demonstrably installs packages that declare hooks, so an empty scan means
 * the enumeration broke, not that the tree became safe.
 */
export function judgeInstallScripts(
  modules: string = MODULES,
  root: string = REPO_ROOT,
): GateOutcome {
  const declared = declaredInstallScripts(modules);
  const allowed = Object.keys(ALLOWED_INSTALL_SCRIPTS).sort();
  const findings: GateFinding[] = [];

  // What bun BLOCKED, asked of bun rather than inferred from manifests. This is
  // the load-bearing call: bun's built-in allowlist is not in this repository, so
  // the only way to know which scripts EXECUTE is to subtract the blocked set
  // from the declared set. A gate that read manifests alone would report "no
  // trustedDependencies, therefore nothing runs" — which is exactly the wrong
  // answer, and the one this file exists to retire.
  const blocked = blockedByBun();
  const ran = declared.filter((d) => !blocked.has(d.pkg));

  for (const entry of ran) {
    if (allowedReason(entry.pkg) !== undefined) continue;
    findings.push({
      pkg: entry.pkg,
      detail: `EXECUTES ${entry.hooks.join('+')} on every install and is not in `
        + 'ALLOWED_INSTALL_SCRIPTS. bun ran it from its own built-in allowlist, which this '
        + 'repository does not control. Add it with a reason, or pin a version without the hook.',
    });
  }
  for (const name of allowed) {
    if (!declared.some((d) => d.pkg === name)) {
      findings.push({
        pkg: name,
        detail: 'allowed but no longer declares a lifecycle script — drop it from '
          + 'ALLOWED_INSTALL_SCRIPTS so the list stays a statement about reality',
      });
    }
  }
  // `trustedDependencies` widens Bun's execution set for THIS repo. Every entry
  // must also be allowed here, so the two lists cannot disagree silently.
  for (const name of rootTrustedDependencies(root)) {
    if (allowedReason(name) === undefined) {
      findings.push({
        pkg: name,
        detail: 'listed in package.json trustedDependencies but not in '
          + 'ALLOWED_INSTALL_SCRIPTS — a repo-level grant with no recorded reason',
      });
    }
  }
  return { declared, allowed, blocked: [...blocked].sort(), ran: ran.map((r) => r.pkg), findings };
}

function main(): void {
  const { declared, allowed, blocked, ran, findings } = judgeInstallScripts();
  if (declared.length === 0) {
    console.error('install-scripts: the scan found NO dependency declaring a lifecycle hook. '
      + 'This repo installs several that do, so the enumeration is broken rather than the tree clean.');
    process.exit(1);
  }
  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`::error::install-scripts: ${f.pkg} — ${f.detail}`);
      console.error(`  ${f.pkg}  ${f.detail}`);
    }
    console.error(`install-scripts: ${findings.length} finding(s) over ${declared.length} `
      + `dependency(ies) declaring a lifecycle hook`);
    process.exit(1);
  }
  console.log(
    `install-scripts: ok — ${declared.length} declare a lifecycle hook, ${blocked.length} blocked `
    + `by bun, ${ran.length} EXECUTE (${ran.join(', ')}), all ${ran.length} allowed with a stated `
    + `reason, ${allowed.length} entries in the allowlist, 0 repo-level grants without a reason`,
  );
}

if (import.meta.main) main();
