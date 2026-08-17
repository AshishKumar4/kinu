/**
 * Egress interception totality — no container has an un-intercepted way out.
 *
 * Proteus removes the owner's secrets from the agent's container and replaces
 * them with placeholders, substituting the real value outside the container on
 * the way out. That trade is only safe if the interception is TOTAL. A path
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
 *    for the whole stable line. The gate re-measures the claim against the
 *    installed bundle (see {@link sdkDefaultsHttpsInterceptionOff}) so the day
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
 * 5. DNS. NOT closed, and deliberately reported as open. DNS leaves even with
 *    `enableInternet = false`, restricted to Cloudflare's resolvers. Arbitrary
 *    destinations are impossible; arbitrary NAMES are not, so the labels of a
 *    query are a low-bandwidth channel outward. It cannot carry a secret the
 *    container does not have, which is the whole point of the placeholder
 *    design. This gate prints it every run so it stays a known residual rather
 *    than a forgotten one.
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

import { readFileSync } from 'node:fs';

import { readSources } from './sources.ts';
import { assertMeasured, finding } from './gate-ratchet.ts';
import { classMembers, declaredName, literalText, parse, walk, type SyntaxNode } from './syntax.ts';

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

/** Classes bound to a container image by the deployment itself. */
export function wranglerContainerClasses(wrangler: string): string[] {
  const containers = [...wrangler.matchAll(/"containers"\s*:\s*\[([\s\S]*?)\]/g)];
  const names = new Set<string>();
  for (const [, block] of containers) {
    for (const [, name] of block!.matchAll(/"class_name"\s*:\s*"(\w+)"/g)) names.add(name!);
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
 */
export function declaredSandboxClasses(sources: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const [, text] of sources) {
    for (const [, name] of text.matchAll(/class\s+(\w+)\s+extends\s+Sandbox\b/g)) names.add(name!);
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
  const fromWrangler = wranglerContainerClasses(readFileSync(`${root}${WRANGLER}`, 'utf8'));
  const fromSource = declaredSandboxClasses(sources);
  const classes = [...new Set([...fromWrangler, ...fromSource])].sort();
  const { inspected, violations } = auditInterception(sources, classes);

  const problems: string[] = [];
  if (fromWrangler.length === 0) {
    problems.push(`parsed no "containers" class_name out of ${WRANGLER} — the matcher is not matching`);
  }
  if (fromSource.length === 0) {
    problems.push('found no `class X extends Sandbox` in the source — the matcher is not matching');
  }
  if (inspected.length === 0) {
    problems.push(`found none of the container classes (${classes.join(', ') || 'none'}) in the source`);
  }
  // A name in one source and not the other is always worth reporting: bound but
  // absent from source means the scan missed a container, and the union is what
  // stops a corrected binding from silently shrinking the corpus.
  for (const name of classes) {
    if (!fromSource.includes(name)) {
      problems.push(`${name} is bound to a container in ${WRANGLER} but no \`class ${name} extends Sandbox\` was found`);
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
      fix: 'register EGRESS_HANDLER in ProteusSandbox.outboundHandlers and bind it with setOutboundHandler',
    }));
    process.exit(1);
  }

  const containerBundle = readFileSync(
    `${root}node_modules/@cloudflare/containers/dist/lib/container.js`, 'utf8',
  );
  const httpsStillOffByDefault = sdkDefaultsHttpsInterceptionOff(containerBundle);

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
  if (!httpsStillOffByDefault) {
    // Not a failure: upstream turning it on is good news. But our source
    // comments assert the opposite, so say it loudly rather than let them rot.
    console.log('egress-interception: NOTE — @cloudflare/containers no longer defaults '
      + 'interceptHttps to false. Update the comments in proteus-sandbox.ts and this gate.');
  }
  console.log('egress-interception: KNOWN RESIDUAL — DNS leaves the container even with '
    + 'enableInternet=false, to Cloudflare resolvers only. Arbitrary destinations are impossible; '
    + 'arbitrary query NAMES are not, so it is a low-bandwidth outward channel. It cannot carry a '
    + 'secret the container never holds.');
  process.exit(0);
}
