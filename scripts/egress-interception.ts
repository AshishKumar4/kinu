/** Native container egress policy. D38 records the 2026-09-28/29 runtime measurements:
 * Kinu has no raw internet; HTTP/HTTPS go through the owner vault; generic Devbox stays public.
 * Configuration and source lineage jointly define the private set: every bound container is a Devbox.
 * Generic classes come from Devbox's source lineage. This is a source proof; its blind spots print
 * on every green run. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';

import type { Node } from 'oxc-parser';
import { parseJsonc } from './jsonc';
import { posix } from 'node:path';
import { readMatching, isProductSource, isParseable, isTestFile } from "./sources";
import { assertMeasured } from "./gate-ratchet";
import {
  classMembers, declaredName, importBindings, literalText, memberCalleeName, parse, publishedNames, superClassName, walk, type SyntaxNode,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

const WORKER_ENTRY = 'packages/cf-backend/src/server.ts';

export function readInterceptionSources(): Map<string, string> {
  return readMatching(file => isProductSource(file) || (file.startsWith("packages/devbox/")
    && isParseable(file) && !isTestFile(file) && !file.includes("/tests/")));
}

/** `containers[].class_name` — the shape this gate reads out of wrangler.jsonc,
 *  at the top level and under every named environment. Parsed where the file is
 *  required; Bun decodes JSONC natively, so a commented-out block never reaches
 *  the schema. */
const ContainerList = v.optional(v.array(v.object({ class_name: v.string(), image: v.optional(v.string()) })));

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
 * THE LINEAGE, not one hop. `KinuDevbox extends Devbox extends DurableObject` after
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
  const classes = containerClasses(sources);
  const lineage = new Set<string>(['Devbox']);
  let changed = true;

  while (changed) {
    changed = false;

    for (const [name, cls] of classes) if (cls.base !== undefined && lineage.has(cls.base) && !lineage.has(name)) {
      lineage.add(name); changed = true;
    }
  }

  return lineage;
}

/** `name` of an Identifier or PrivateIdentifier (as `#name`), else undefined. */
function nameOf(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name;

  return node?.type === 'PrivateIdentifier' ? `#${node.name}` : undefined;
}

export function declaredSandboxClasses(sources: ReadonlyMap<string, string>): string[] {
  const lineage = sandboxLineage(sources);

  return [...containerClasses(sources)].filter(([name, cls]) => lineage.has(name)
    && cls.file.startsWith("packages/cf-backend/")).map(([name]) => name).sort();
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
  }

  return undefined;
}

interface ContainerClass {
  readonly file: string;
  readonly node: SyntaxNode;
  readonly base: string | undefined;
  readonly policy: string | undefined;
  readonly declaresPolicy: boolean;
}

function containerClasses(sources: ReadonlyMap<string, string>): Map<string, ContainerClass> {
  const classes = new Map<string, ContainerClass>();

  for (const [file, text] of sources) {
    if (!text.includes('class')) continue;
    walk(parse(file, text).root, node => {
      if (node.type !== 'ClassDeclaration') return;
      const name = declaredName(node);

      if (name === undefined) return;
      const policy = classMembers(node).find(member => declaredName(member) === 'enableInternet');
      classes.set(name, { file, node, base: superClassName(node), policy: policy === undefined ? undefined : fieldValue(policy), declaresPolicy: policy !== undefined });
    });
  }

  return classes;
}

function inheritedPolicy(name: string, classes: ReadonlyMap<string, ContainerClass>, seen = new Set<string>()): string | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const cls = classes.get(name);

  if (cls === undefined) return undefined;

  if (cls.declaresPolicy) return cls.policy;

  return cls.base === undefined ? undefined : inheritedPolicy(cls.base, classes, seen);
}

export function auditInterception(sources: ReadonlyMap<string, string>, names: readonly string[], internet = false): InterceptionAudit {
  const classes = containerClasses(sources);
  const inspected: { file: string; owner: string }[] = [];
  const violations: Violation[] = [];

  for (const owner of names) {
    const cls = classes.get(owner);

    if (cls === undefined) {
      violations.push({ file: '<sources>', line: 1, owner, reason: 'network policy owner is absent from the measured sources' });
      continue;
    }

    inspected.push({ file: cls.file, owner });

    if (inheritedPolicy(owner, classes) !== String(internet)) {
      violations.push({ file: cls.file, line: parse(cls.file, sources.get(cls.file) ?? '').lineAt(cls.node.start), owner,
        reason: `effective enableInternet must be ${internet}, including inherited policy` });
    }
  }

  return { inspected, violations };
}

function memberPath(raw: Node | null | undefined): string | undefined {
  if (raw?.type === 'ThisExpression') return 'this';

  if (raw?.type === 'Identifier') return raw.name;

  if (raw?.type !== 'MemberExpression' || raw.computed) return undefined;
  const base = memberPath(raw.object);
  const member = nameOf(raw.property);

  return base === undefined || member === undefined ? undefined : `${base}.${member}`;
}

function objectValue(raw: Node | null | undefined, name: string): Node | undefined {
  if (raw?.type !== 'ObjectExpression') return undefined;
  const property = raw.properties.find(entry => entry.type === 'Property' && !entry.computed && nameOf(entry.key) === name);

  return property?.type === 'Property' ? property.value : undefined;
}

function callsIn(node: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  walk(node, child => { if (child.raw.type === 'CallExpression') calls.push(child); });

  return calls;
}

function callName(node: SyntaxNode): string | undefined {
  if (node.raw.type !== 'CallExpression') return undefined;

  return node.raw.callee.type === 'Identifier' ? node.raw.callee.name : memberCalleeName(node);
}

function literalIs(raw: Node | null | undefined, value: string | number | boolean): boolean {
  return raw?.type === 'Literal' && raw.value === value;
}

function exportsNamed(entry: string, name: string, source?: string): boolean {
  return publishedNames(parse(WORKER_ENTRY, entry).root).some(published => published.name === name
    && (source === undefined ? published.origin === undefined : published.origin?.specifier === source && published.origin.imported === name));
}

function admissionPolicyReasons(base: ContainerClass): string[] {
  const reasons: string[] = [];
  const starts = callsIn(base.node).filter(call => call.raw.type === 'CallExpression' && memberPath(call.raw.callee) === 'container.start');

  if (starts.length !== 1 || starts.some(call => call.raw.type !== 'CallExpression'
    || memberPath(objectValue(call.raw.arguments[0], 'enableInternet')) !== 'this.enableInternet')) reasons.push('native start does not use the declared internet policy');
  const factories: Node[] = [];
  walk(base.node, node => { if (node.raw.type === 'NewExpression' && nameOf(node.raw.callee) === 'ContainerRoutes') factories.push(node.raw); });
  const factory = factories[0];

  if (factories.length !== 1 || factory?.type !== 'NewExpression'
    || memberPath(objectValue(factory.arguments[0], 'internet')) !== 'this.enableInternet') reasons.push('the router does not receive the declared public-network policy');

  return reasons;
}

function interceptionReasons(routes: ContainerClass): string[] {
  const reasons: string[] = [];
  const calls = callsIn(routes.node);
  const http = calls.find(call => callName(call) === 'interceptAllOutboundHttp');
  const https = calls.find(call => callName(call) === 'interceptOutboundHttps');

  if (http?.raw.type !== 'CallExpression' || http.raw.arguments.length !== 1) reasons.push('HTTP has no total native interception');

  if (https?.raw.type !== 'CallExpression' || https.raw.arguments.length !== 2 || !literalIs(https.raw.arguments[0], '*')) reasons.push('HTTPS has no total native interception');

  if (http?.raw.type === 'CallExpression' && https?.raw.type === 'CallExpression'
    && memberPath(http.raw.arguments[0]) !== memberPath(https.raw.arguments[1])) reasons.push('HTTP and HTTPS use different routing policies');
  let receivesPolicy = false;
  walk(routes.node, node => {
    if (node.raw.type === 'Property' && nameOf(node.raw.key) === 'internet' && memberPath(node.raw.value) === 'this.host.internet') receivesPolicy = true;
  });

  if (!receivesPolicy) reasons.push('the router does not receive the declared public-network policy');

  return reasons;
}

function importedImplementation(sources: ReadonlyMap<string, string>, file: string, name: string): SyntaxNode | undefined {
  const tree = parse(file, sources.get(file) ?? '').root;

  for (const statement of tree.children) {
    if (statement.raw.type !== 'ImportDeclaration' || !statement.raw.source.value.startsWith('.')) continue;

    if (!importBindings(statement).some(binding => binding.local === name && binding.imported === name)) continue;
    const path = posix.normalize(posix.join(posix.dirname(file), statement.raw.source.value)) + '.ts';
    const text = sources.get(path);

    if (text !== undefined) return parse(path, text).root;
  }

  return undefined;
}

/** The four classes the vault rule reads: Devbox, Kinu's sandbox, the route owner and the vault entrypoint. */
interface VaultClasses {
  readonly base: ContainerClass;
  readonly kinu: ContainerClass;
  readonly routes: ContainerClass;
  readonly vault: ContainerClass;
}

function vaultPolicyReasons({ base, kinu, routes, vault }: VaultClasses, sources: ReadonlyMap<string, string>): string[] {
  const reasons: string[] = [];
  const hostPolicy = classMembers(kinu.node).find(member => declaredName(member) === 'outboundPolicy');
  let bindsVault = false;

  if (hostPolicy !== undefined) walk(hostPolicy, node => {
    if (node.raw.type !== 'ReturnStatement') return;
    const fallback = objectValue(node.raw.argument, 'fallback');

    if (fallback?.type === 'CallExpression' && memberPath(fallback.callee) === 'this.#nativeExports.KinuEgress') bindsVault = true;
  });
  let usesHostPolicy = false;
  walk(routes.node, node => {
    if (node.raw.type === 'AssignmentExpression' && memberPath(node.raw.left) === 'this.#fallback'
      && memberPath(node.raw.right) === 'policy.fallback') usesHostPolicy = true;
  });

  const configured = callsIn(base.node).some(call => {
    if (callName(call) !== 'configure' || call.raw.type !== 'CallExpression') return false;
    const policy = call.raw.arguments[0];

    return policy?.type === 'AwaitExpression' && policy.argument.type === 'CallExpression' && memberPath(policy.argument.callee) === 'this.outboundPolicy';
  });

  if (!bindsVault || !usesHostPolicy || !configured) reasons.push('Kinu does not bind the vault as its default egress route');

  if (!callsIn(vault.node).some(call => callName(call) === 'handleContainerEgress')) reasons.push('the native vault entry does not enter credential injection');
  const implementation = importedImplementation(sources, vault.file, 'handleContainerEgress');

  if (implementation === undefined || !callsIn(implementation).some(call => callName(call) === 'resolveEgressInjection')) reasons.push('credential injection does not consult the owner vault');

  return reasons;
}

function dispatcherReasons(router: ContainerClass): string[] {
  const reasons: string[] = [];
  let hasFallback = false;
  walk(router.node, node => { if (node.raw.type === 'LogicalExpression' && memberPath(node.raw.right) === 'this.ctx.props.fallback') hasFallback = true; });
  const calls = callsIn(router.node);
  const routed = calls.find(call => call.raw.type === 'CallExpression' && memberPath(call.raw.callee) === 'route.fetch');
  const direct = calls.find(call => call.raw.type === 'CallExpression' && nameOf(call.raw.callee) === 'fetch');

  if (!hasFallback || routed === undefined || direct === undefined || routed.start >= direct.start) reasons.push('owned routes do not precede public networking');
  let conditional = false;

  for (let parent = direct?.parent; parent !== undefined; parent = parent.parent) {
    if (parent.raw.type === 'ConditionalExpression' && memberPath(parent.raw.test) === 'this.ctx.props.internet'
      && direct !== undefined && direct.start >= parent.raw.consequent.start && direct.end <= parent.raw.consequent.end) conditional = true;
  }

  if (!conditional) reasons.push('public forwarding is not conditional on the declared internet policy');

  return reasons;
}

/** Literal native admission, route installation, vault ownership and dispatch are separate obligations. */
export function nativeRoutingReasons(sources: ReadonlyMap<string, string>, entry: string): string[] {
  const classes = containerClasses(sources);
  const base = classes.get('Devbox');
  const kinu = classes.get('KinuDevbox');
  const routes = classes.get('ContainerRoutes');
  const router = classes.get('DevboxOutbound');
  const vault = classes.get('KinuEgress');

  if (base === undefined || kinu === undefined || routes === undefined || router === undefined || vault === undefined) return ['native routing has an unmeasured owner'];

  const reasons = [...admissionPolicyReasons(base), ...interceptionReasons(routes),
    ...vaultPolicyReasons({ base, kinu, routes, vault }, sources), ...dispatcherReasons(router)];

  if (!exportsNamed(entry, 'DevboxOutbound', '@kinu.run/devbox')) reasons.push('DevboxOutbound is not bound to its routing implementation in the Worker entry');

  if (vault.file !== WORKER_ENTRY || !exportsNamed(entry, 'KinuEgress')) reasons.push('KinuEgress is not bound to its routing implementation in the Worker entry');

  return reasons;
}


if (import.meta.main) {
  const sources = readInterceptionSources();
  const bound = wranglerContainerClasses(parseJsonc(readFileSync(`${root}${WRANGLER}`, 'utf8'), WranglerContainers, WRANGLER));
  const fromWrangler = bound;
  const fromSource = declaredSandboxClasses(sources);
  const classes = [...new Set([...fromWrangler, ...fromSource])].sort();
  const privateAudit = auditInterception(sources, classes);
  const lineage = sandboxLineage(sources);

  const generic = [...containerClasses(sources)].filter(([name, cls]) => lineage.has(name)
    && cls.file.startsWith('packages/devbox/') && !cls.file.includes('/tests/')).map(([name]) => name).sort();

  const publicAudit = auditInterception(sources, generic, true);
  const entry = sources.get(WORKER_ENTRY) ?? readFileSync(join(root, WORKER_ENTRY), 'utf8');
  const problems = nativeRoutingReasons(sources, entry);

  if (fromWrangler.length === 0 || fromSource.length === 0 || generic.length === 0) problems.push('the configured/private/public container denominator is empty');

  for (const name of classes) if (!fromSource.includes(name)) problems.push(name + ' is bound but has no Devbox lineage in the deployment source');
  const violations = [...privateAudit.violations, ...publicAudit.violations];

  for (const issue of violations) problems.push(issue.file + ':' + issue.line + ' ' + issue.owner + ': ' + issue.reason);

  const measured = assertMeasured('egress-interception', [
    ['private configured classes', fromWrangler.length], ['private source classes', fromSource.length],
    ['generic devbox/bench classes', generic.length], ['native routing owners', 5],
  ]);

  if (problems.length > 0) {
    for (const problem of problems) console.error('egress-interception: ' + problem);
    process.exit(1);
  }

  console.log('egress-interception: ok — ' + measured);
  console.log('egress-interception: private network denied: ' + classes.join(', ') + '; public network retained: ' + generic.join(', '));
  console.log('egress-interception: HTTP and HTTPS enter the host router; Kinu binds the owner vault before the public-network fallback');
  console.log('egress-interception: blind spots: this proves literal/inherited policy and explicit native call/binding edges, not arbitrary control-flow equivalence or runtime platform enforcement. Dynamic aliases and metaprogramming are not credited. Vault authorization is covered by its behavioral tests; native routing, TLS trust and platform behavior by D38.');
  console.log('egress-interception: DNS was measured closed with internet disabled on 0.2.0+28bc79307: UDP/TCP 53 did not escape and nonexistent names resolved to the same private ULA. This is a platform observation, not a source proof.');
  process.exit(0);
}
