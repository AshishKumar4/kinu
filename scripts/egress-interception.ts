/**
 * Egress interception totality — no container has an un-intercepted way out.
 *
 * Kinu removes the owner's secrets from the agent container. It substitutes
 * the real value outside the container on the way out. That trade is only safe
 * if the interception is TOTAL. A path
 * that leaves without passing a handler is worse than having no vault at all:
 * the secret is gone from the container, so the agent's own work breaks, while
 * the path that could have carried it is still open.
 *
 * So this gate enumerates the ways a request can leave a container and asserts
 * each one is closed by construction. It is a source gate, not a runtime probe,
 * because every one of these is a static property of the class declaration and
 * the Worker's export list — and because the failure mode being guarded is
 * somebody deleting a field during a refactor, which is exactly what a source
 * gate catches and a staging probe does not.
 *
 * ## The paths, and what closes each
 *
 * 1. TCP on any port other than 80/443. The platform NEVER routes these
 *    through an outbound handler — `outbound`/`outboundByHost` see HTTP and
 *    HTTPS only. The only thing that closes it is `enableInternet = false`,
 *    which makes the platform deny them outright.
 *
 * 2. HTTPS. Closed by `interceptHttps = true`, and NOT by default: the SDK's
 *    documentation says "Sandboxes intercept HTTPS traffic by default —
 *    `interceptHttps` is set to `true` on the Sandbox class", and that is false
 *    for the whole stable line. The gate re-measures the claim against the copy
 *    the deployed artifact binds (see {@link boundContainers}) so the day
 *    upstream changes it, this gate says so instead of our comments quietly
 *    becoming wrong.
 *
 * 3. HTTP with no handler bound. `ContainerProxy` must be exported from the
 *    Worker entry or `applyOutboundInterception` throws and NOTHING is
 *    intercepted; and a catch-all handler must be registered, or only the
 *    handful of hosts with per-host handlers are seen and everything else falls
 *    through to `enableInternet`.
 *
 * 4. An allow-listed host. `allowedHosts` is a gate, not a bypass, WHEN a
 *    catch-all handler exists — but the ContainerProxy's own precedence has a
 *    branch (`if (allowedHosts) return fetch(request)`) reached when no handler
 *    matched. Rather than depend on a handler always matching, the gate refuses
 *    a static `allowedHosts`/`deniedHosts` on a container class, so totality
 *    does not rest on the ordering of somebody else's switch.
 *
 * 5. DNS. Previously reported here as an open residual — "DNS leaves, to
 *    Cloudflare's resolvers, so query LABELS are a low-bandwidth channel
 *    outward". MEASURED FALSE on the deployed worker (0.2.0+28bc79307), inside a
 *    real KinuSandbox container reached through `executeInExecutor`:
 *
 *      raw UDP/53 to 1.1.1.1, 8.8.8.8 and 2606:4700:4700::1111 — no reply
 *      raw TCP/53 to 1.1.1.1                                   — timeout
 *      every name resolves to the SAME private ULA, fd00::119:1,
 *        including `<random>.invalidtld-nothing-here`, a TLD that cannot exist
 *
 *    A public resolver cannot return an fd00::/8 address, and cannot answer a
 *    nonexistent TLD at all, so those answers were not resolved on the internet:
 *    the platform synthesizes them locally to route 80/443 into the interception
 *    layer. Nothing reaches a resolver, so query labels carry nothing outward.
 *
 *    Kept as a printed line rather than deleted, because it is the load-bearing
 *    claim the placeholder design rests on and it is a property of the PLATFORM,
 *    not of this code — a future change could restore the residual without any
 *    diff here. It is re-measurable by the probe recorded above.
 *
 * ## Denominator
 *
 * The container classes are read from `packages/cf-backend/wrangler.jsonc`'s
 * `containers[].class_name` — the deployment's own list, which Cloudflare
 * requires to be complete and which therefore cannot drift the way a
 * hand-kept list here would. If that list is empty, or if none of those
 * classes is found in the source, the gate fails rather than passing on an
 * empty scan.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import * as v from 'valibot';

import { readSources } from './sources';
import { assertMeasured, finding } from './gate-ratchet';
import { classMembers, declaredName, literalText, parse, superClassName, walk, type SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';
const WORKER_ENTRY = 'packages/cf-backend/src/server.ts';

/** Fields that must be present, with this exact value, on every container
 *  class. The value is spelled as source text because that is what the gate can
 *  read, and because `false`/`true` here are the whole security posture. */
const REQUIRED_FIELDS = {
  enableInternet: 'false',
  interceptHttps: 'true',
} satisfies Record<string, string>;

/** Fields whose mere presence opens path 4. */
const FORBIDDEN_FIELDS: readonly string[] = ['allowedHosts', 'deniedHosts'];

/** `containers[].class_name` — the shape this gate reads out of wrangler.jsonc,
 *  at the top level and under every named environment. Parsed where the file is
 *  required; Bun decodes JSONC natively, so a commented-out block never reaches
 *  the schema. */
const ContainerList = v.optional(v.array(v.object({ class_name: v.string() })));
export const WranglerContainers = v.object({
  containers: ContainerList,
  env: v.optional(v.record(v.string(), v.object({ containers: ContainerList }))),
});

/** Classes bound to a container image by the deployment itself. Decoded
 *  structurally rather than by the regex this replaces, which stopped at the
 *  first `]` inside the block (an array-valued field on one entry silently
 *  dropped every class_name after it) and matched a commented-out block as if
 *  it were bound. */
export function wranglerContainerClasses(declared: v.InferOutput<typeof WranglerContainers>): string[] {
  const names = new Set<string>();
  for (const scope of [declared, ...Object.values(declared.env ?? {})]) {
    for (const { class_name } of scope.containers ?? []) names.add(class_name);
  }
  return [...names].sort();
}

/**
 * Classes that extend the Sandbox base, found in the source.
 *
 * Unioned with the wrangler list rather than trusting either alone. A
 * denominator derived only from configuration SHRINKS when configuration is
 * corrected — removing a DO binding that a facet never needed took the
 * `no-wait-until` corpus from 5 classes to 4 with nothing failing — and a gate
 * that quietly measures less is indistinguishable from one that got easier. A
 * class that extends Sandbox is a container whether or not it is bound yet, so
 * the two sources fail in opposite directions and the union survives both.
 *
 * THE LINEAGE, not one hop. `KinuSandbox extends Devbox extends Sandbox` after
 * the devbox extraction, and a matcher reading only the direct superclass lost
 * the deployment's ONLY container class — it failed closed, loudly, which is
 * how this sentence got written. The lineage is computed repo-wide to a
 * fixpoint (Devbox lives in another package), but the DECLARED set stays
 * scoped to this deployment's own source: the bench app's Devbox subclasses
 * ship under their own wrangler with their own posture, and auditing them here
 * would claim a set this gate does not govern.
 *
 * Read from the AST rather than by the regex this replaces: `class X<T> extends
 * Sandbox` has a token between the name and `extends`, so a generic container
 * class silently left this denominator, and a mention inside a comment or a
 * string counted as a declaration. The `includes` prefilter is sound — an
 * identifier cannot reach the AST without its token appearing in the text.
 */
export function sandboxLineage(sources: ReadonlyMap<string, string>): ReadonlySet<string> {
  const lineage = new Set<string>(['Sandbox']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, text] of sources) {
      if (!text.includes('Sandbox') && !text.includes('Devbox')) continue;
      walk(parse(file, text).root, (node) => {
        const base = superClassName(node);
        if (base === undefined || !lineage.has(base)) return;
        const name = declaredName(node);
        if (name !== undefined && !lineage.has(name)) {
          lineage.add(name);
          grew = true;
        }
      });
    }
  }
  return lineage;
}

export function declaredSandboxClasses(sources: ReadonlyMap<string, string>): string[] {
  const lineage = sandboxLineage(sources);
  const names = new Set<string>();
  for (const [file, text] of sources) {
    if (!file.startsWith('packages/cf-backend/')) continue;
    if (!text.includes('Sandbox') && !text.includes('Devbox')) continue;
    walk(parse(file, text).root, (node) => {
      const base = superClassName(node);
      if (base === undefined || !lineage.has(base)) return;
      const name = declaredName(node);
      if (name !== undefined) names.add(name);
    });
  }
  return [...names].sort();
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  readonly reason: string;
}

export interface InterceptionAudit {
  /** Every container class actually found in the source — the denominator. */
  readonly inspected: readonly { file: string; owner: string }[];
  readonly violations: readonly Violation[];
}

/** The literal source text of a class field's initializer, if it has one. */
function fieldValue(member: SyntaxNode): string | undefined {
  for (const child of member.children) {
    const literal = literalText(child);
    if (literal !== undefined) return literal;
    if (child.type === 'Literal') return String(child.raw);
  }
  return undefined;
}

export function auditInterception(
  sources: ReadonlyMap<string, string>,
  classes: readonly string[],
): InterceptionAudit {
  const inspected: { file: string; owner: string }[] = [];
  const violations: Violation[] = [];
  const wanted = new Set(classes);

  for (const [file, text] of sources) {
    if (!classes.some((name) => text.includes(`class ${name} `))) continue;
    const parsed = parse(file, text);
    walk(parsed.root, (node) => {
      if (node.type !== 'ClassDeclaration') return;
      const owner = declaredName(node);
      if (owner === undefined || !wanted.has(owner)) return;
      inspected.push({ file, owner });
      const line = parsed.lineAt(node.start);
      const fail = (reason: string): void => void violations.push({ file, line, owner, reason });

      const declared = new Map<string, string | undefined>();
      for (const member of classMembers(node)) {
        const name = declaredName(member);
        if (member.type === 'PropertyDefinition' && name !== undefined) {
          declared.set(name, fieldValue(member));
        }
      }
      for (const [field, value] of Object.entries(REQUIRED_FIELDS)) {
        if (!declared.has(field)) {
          fail(`does not declare \`${field} = ${value}\` — see this gate's header for the path that opens`);
        } else if (declared.get(field) !== value) {
          fail(`declares \`${field} = ${String(declared.get(field))}\`, must be \`${value}\``);
        }
      }
      for (const field of FORBIDDEN_FIELDS) {
        if (declared.has(field)) {
          fail(`declares \`${field}\` — an allow/deny list must not be what totality rests on`);
        }
      }
    });
  }
  return { inspected, violations };
}

/** Whether the Worker entry re-exports `ContainerProxy`. Without it the Sandbox
 *  DO cannot build an interception fetcher at all, and every request leaves
 *  unintercepted while the vault still believes it is substituting. */
export function exportsContainerProxy(entry: string): boolean {
  return /export\s*\{[^}]*\bContainerProxy\b[^}]*\}/.test(entry);
}

/** The SDK whose default this gate re-measures, and the package that resolves
 *  that SDK for the deployed artifact. Two copies of Containers are installed at
 *  two versions: the top-level copy carries one type import and no runtime byte,
 *  while the Worker reaches the nested copy through `@cloudflare/sandbox`. So the
 *  resolution starts at Sandbox's own module, never at this repository. */
const CONTAINERS = '@cloudflare/containers';
const CONTAINERS_HOST = '@cloudflare/sandbox';

/** The module that declares the default, spelled the way Containers' own entry
 *  spells it: `dist/index.js` re-exports `./lib/container`. A relative specifier,
 *  because Containers publishes `.` alone in `exports` and Node refuses every
 *  subpath of it. */
const CONTAINERS_MODULE = './lib/container';

const CopyVersion = v.object({ version: v.string() });

/** The installed copy of Containers the deployed artifact loads. */
export interface BoundContainers {
  /** Absolute path of the module the artifact loads. */
  readonly module: string;
  /** Version of the copy that module belongs to, from its own manifest. */
  readonly version: string;
}

/** Resolve `specifier` the way the module at `from` resolves it. Throws, and
 *  answers with no other copy: a gate that falls back to the top-level copy
 *  measures code the Worker never loads. */
function resolveFrom(from: string, specifier: string): string {
  try {
    return createRequire(from).resolve(specifier);
  } catch (cause) {
    throw new Error(finding({
      invariant: `the ${CONTAINERS} copy this gate reads is the copy the deployed artifact binds, `
        + `resolved from ${CONTAINERS_HOST} rather than named by a path`,
      at: `resolving '${specifier}' from ${from}`,
      found: 'the specifier resolves to nothing there',
      silently: `the top-level ${CONTAINERS} copy is a different version and contributes no runtime `
        + 'byte to the artifact, so it is NOT a substitute: reading it asserts a property of code '
        + 'the Worker never loads',
      fix: `install ${CONTAINERS_HOST} so it resolves ${CONTAINERS}, or correct the specifier`,
    }), { cause });
  }
}

/** The version of the copy `module` belongs to, read from the nearest manifest
 *  above it. Read rather than written down, because which version this gate read
 *  is the fact a future divergence becomes visible in. */
function copyVersion(module: string): string {
  for (let dir = dirname(module); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      return v.parse(CopyVersion, JSON.parse(readFileSync(manifest, 'utf8'))).version;
    }
  }
  throw new Error(finding({
    invariant: `the ${CONTAINERS} copy the artifact binds reports its own version`,
    at: module,
    found: 'no package.json above the resolved module',
    silently: 'the gate reads bytes it cannot attribute to a version, so an upstream change moves '
      + 'the property without moving anything the output names',
    fix: `reinstall ${CONTAINERS_HOST} so its nested ${CONTAINERS} copy carries its manifest`,
  }));
}

/**
 * The Containers module the deployed Worker binds, resolved along the edge the
 * artifact itself resolves: this repository loads `@cloudflare/sandbox`, and
 * Sandbox's own modules load the Containers copy nested beneath it.
 *
 * A literal path used to name the top-level copy here. That copy is a different
 * version and ships nothing, so the property asserted below held by accident.
 */
export function boundContainers(): BoundContainers {
  const host = resolveFrom(`${root}package.json`, CONTAINERS_HOST);
  const module = resolveFrom(resolveFrom(host, CONTAINERS), CONTAINERS_MODULE);
  return { module, version: copyVersion(module) };
}

/** Re-measure the upstream default this whole posture exists to correct. True
 *  while the SDK still leaves HTTPS interception OFF by default. */
export function sdkDefaultsHttpsInterceptionOff(containerBundle: string): boolean {
  return /interceptHttps\s*=\s*false/.test(containerBundle);
}

/** Whether a catch-all handler is registered AND bound. Both halves matter: a
 *  registry entry nobody binds intercepts nothing, and a bind naming a handler
 *  that is not in the registry throws at configuration time. */
export function catchAllIsBound(sources: ReadonlyMap<string, string>): boolean {
  let registered = false;
  let bound = false;
  for (const [, text] of sources) {
    if (/outboundHandlers\s*=\s*\{/.test(text) && text.includes('EGRESS_HANDLER')) registered = true;
    if (/setOutboundHandler\(\s*EGRESS_HANDLER/.test(text)) bound = true;
  }
  return registered && bound;
}

if (import.meta.main) {
  const sources = readSources();
  const fromWrangler = wranglerContainerClasses(v.parse(WranglerContainers, require(`${root}${WRANGLER}`)));
  const fromSource = declaredSandboxClasses(sources);
  const classes = [...new Set([...fromWrangler, ...fromSource])].sort();
  const { inspected, violations } = auditInterception(sources, classes);

  const problems: string[] = [];
  if (fromWrangler.length === 0) {
    problems.push(`parsed no "containers" class_name out of ${WRANGLER} — nothing is bound to a container image`);
  }
  if (fromSource.length === 0) {
    problems.push('found no class extending the Sandbox lineage in the deployment source — the matcher is not matching');
  }
  if (inspected.length === 0) {
    problems.push(`found none of the container classes (${classes.join(', ') || 'none'}) in the source`);
  }
  // A name in one source and not the other is always worth reporting: bound but
  // absent from source means the scan missed a container, and the union is what
  // stops a corrected binding from silently shrinking the corpus.
  for (const name of classes) {
    if (!fromSource.includes(name)) {
      problems.push(`${name} is bound to a container in ${WRANGLER} but no class ${name} extending the Sandbox lineage was found`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`egress-interception: ${problem}`);
    process.exit(1);
  }

  const entry = sources.get(WORKER_ENTRY) ?? readFileSync(`${root}${WORKER_ENTRY}`, 'utf8');
  if (!exportsContainerProxy(entry)) {
    console.error(finding({
      invariant: 'the Worker entry re-exports ContainerProxy, without which no interception is installed at all',
      at: WORKER_ENTRY,
      found: 'no `export { ContainerProxy }`',
      silently: 'applyOutboundInterception throws inside the Sandbox DO, so every container request leaves '
        + 'unintercepted while the vault still substitutes placeholders it believes are being caught',
      fix: `add \`export { ContainerProxy } from "@cloudflare/sandbox";\` to ${WORKER_ENTRY}`,
    }));
    process.exit(1);
  }

  if (!catchAllIsBound(sources)) {
    console.error(finding({
      invariant: 'a catch-all outbound handler is both registered in outboundHandlers and bound via setOutboundHandler',
      at: 'packages/cf-backend/src/egress/',
      found: 'the catch-all is missing from the registry, or nothing binds it',
      silently: 'only hosts with an explicit per-host handler are intercepted and everything else falls '
        + 'through to enableInternet, so a request to any other host leaves without being seen',
      fix: 'register EGRESS_HANDLER in KinuSandbox.outboundHandlers and bind it with setOutboundHandler',
    }));
    process.exit(1);
  }

  const containers = boundContainers();
  const httpsStillOffByDefault = sdkDefaultsHttpsInterceptionOff(
    readFileSync(containers.module, 'utf8'),
  );

  const measured = assertMeasured('egress-interception', [
    ['container classes bound in wrangler.jsonc', fromWrangler.length],
    ['classes extending Sandbox in source', fromSource.length],
    ['container classes inspected (union)', inspected.length],
    ['interception invariants per class', Object.keys(REQUIRED_FIELDS).length + FORBIDDEN_FIELDS.length],
  ]);

  if (violations.length > 0) {
    console.error(`egress-interception: ${violations.length} un-intercepted egress path(s)`);
    for (const v of violations) console.error(`  ${v.file}:${v.line} ${v.owner} — ${v.reason}`);
    process.exit(1);
  }

  console.log(`egress-interception: ok — ${measured}`);
  console.log(`egress-interception: read the SDK default from ${CONTAINERS} ${containers.version} `
    + `at ${relative(root, containers.module)}, the copy ${CONTAINERS_HOST} resolves for itself and `
    + 'the only copy the artifact binds');
  if (!httpsStillOffByDefault) {
    // Not a failure: upstream turning it on is good news. But our source
    // comments assert the opposite, so say it loudly rather than let them rot.
    console.log(`egress-interception: NOTE — ${CONTAINERS} ${containers.version} no longer defaults `
      + 'interceptHttps to false. Update the comments in kinu-sandbox.ts and this gate.');
  }
  console.log('egress-interception: DNS RESIDUAL — MEASURED CLOSED on the deployed container '
    + '(0.2.0+28bc79307): raw UDP/53 and TCP/53 to public resolvers get no reply, and every name '
    + 'resolves to the same private ULA fd00::119:1 including a TLD that cannot exist, so nothing '
    + 'reaches a resolver and query labels carry nothing outward. This is a PLATFORM property, not '
    + 'a property of this code: it can regress with no diff here. Re-measure, do not assume.');
  process.exit(0);
}
