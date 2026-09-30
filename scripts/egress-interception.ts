/** Native container egress policy. D38 records the 2026-09-28/29 runtime measurements:
 * Kinu has no raw internet; HTTP/HTTPS go through the owner vault; generic Devbox stays public.
 * Configuration and source lineage jointly define the private set. Generic classes come from
 * Devbox's source lineage. Fixed-image forwarders retain separate image and RPC confinement.
 * This is a source proof; its blind spots print on every green run. */

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
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash, type ContainerImage } from './container-images';
import { tolerate } from "../packages/core/src/obs/index";

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

/** Direct `DurableObject` subclasses in the deployment source, each with the file declaring it: bound to a container,
 *  candidates for forwarder admission. */
export function declaredForwarderClasses(sources: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const declared = new Map<string, string>();

  for (const [file, text] of sources) {
    if (!file.startsWith("packages/cf-backend/") || !text.includes("DurableObject")) continue;
    walk(parse(file, text).root, (node) => {
      const name = superClassName(node) === 'DurableObject' ? declaredName(node) : undefined;

      if (name !== undefined && !declared.has(name)) declared.set(name, file);
    });
  }

  return declared;
}

/** The interpreters a forwarder's CMD may name besides its own tracked script. */
const FORWARDER_INTERPRETERS: readonly string[] = ['node'];

/** The only Dockerfile instructions a forwarder image may use: none of them runs anything at build or names a
 *  program other than CMD's. */
const FORWARDER_INSTRUCTIONS: readonly string[] = ['FROM', 'COPY', 'WORKDIR', 'ENV', 'EXPOSE', 'USER', 'LABEL', 'CMD'];

/** Everything RPC can call on an admitted forwarder, each with why it cannot change what the container runs or where it
 *  may connect. The class's own function properties must equal this table; one more, from the class or its base, is red. */
export const FORWARDER_SURFACE: ReadonlyMap<string, string> = new Map([
  ['constructor', 'not callable over RPC; the native container belongs to this Durable Object'],
  ['forward', 'checks the owner and core codexEgressAllowed, then the container\'s policy.mjs checks again'],
  ['cancel', 'aborts one of this object\'s own in-flight calls by id'],
]);


export interface ForwarderSurface {
  readonly parentIsDurableObject: boolean;
  readonly methods: readonly string[];
}

export interface ForwarderInputs {
  /** What the loaded class exposes: its parent, and its own function property names. */
  readonly surface: ForwarderSurface;
  readonly owner: string;
  /** The file declaring the class, whole: its imports name the predicates. */
  readonly fileText: string;
  readonly file: string;
  /** Its record in `container-images.ts`, if any. */
  readonly image: ContainerImage | undefined;
  /** The image wrangler.jsonc binds to the class. */
  readonly boundImage: string | undefined;
  /** Every tracked file under the record's source directory, with its bytes. */
  readonly sourceFiles: ReadonlyMap<string, string | Uint8Array>;
}

/**
 * A container-bound object runs guest code only if its image or its start command lets it, so it leaves the
 * interception set only when all three hold: (a) its image is the pinned build of a tracked directory whose hash is
 * recorded; (b) that Dockerfile copies only tracked files, runs nothing at build, and its CMD runs a tracked script;
 * (c) it extends DurableObject, its RPC surface equals FORWARDER_SURFACE, and the Container it holds privately declares
 * only BOX_FIELDS and is touched only through BOX_USES. The reasons it fails, empty when admitted.
 */
export function auditForwarder(input: ForwarderInputs): string[] {
  const reasons: string[] = [];
  const { image } = input;

  if (image === undefined) return ['has no record in scripts/container-images.ts, so nothing says what its image runs'];

  if (input.boundImage !== imageReference(image)) reasons.push(`is bound to ${String(input.boundImage)}, not its recorded ${imageReference(image)}`);

  if (input.sourceFiles.size === 0) reasons.push(`records source ${image.source}, which holds no tracked file`);
  else if (sourceHash(input.sourceFiles) !== image.sourceHash) reasons.push(`${image.source} no longer hashes to the source its digest was built from`);

  const dockerfile = input.sourceFiles.get(`${image.source}/Dockerfile`);

  if (dockerfile === undefined) reasons.push(`${image.source} tracks no Dockerfile`);
  else reasons.push(...dockerfileReasons(image.source, String(dockerfile), input.sourceFiles));

  reasons.push(...surfaceReasons(input.surface), ...classReasons(input));

  return reasons;
}

function dockerfileReasons(source: string, dockerfile: string, files: ReadonlyMap<string, unknown>): string[] {
  const reasons: string[] = [];
  const copied = new Set<string>();
  let command: string | undefined;
  const lines = dockerfile.replaceAll(/\\\r?\n/gu, ' ').split('\n').map((text) => text.trim()).filter((text) => text !== '' && !text.startsWith('#'));

  for (const line of lines) {
    const [instruction = '', ...rest] = line.split(/\s+/u);
    const verb = instruction.toUpperCase();

    if (!FORWARDER_INSTRUCTIONS.includes(verb)) {
      reasons.push(`uses \`${verb}\`, outside FROM, COPY, WORKDIR, ENV, EXPOSE, USER, LABEL and CMD`);
      continue;
    }

    if (verb === 'FROM' && !/@sha256:[0-9a-f]{64}$/u.test(rest[0] ?? '')) reasons.push(`builds FROM ${rest[0] ?? ''}, not a pinned digest`);

    if (verb === 'ENV' && rest.some((word) => word.startsWith('NODE_'))) reasons.push('sets a NODE_ variable, which can load code CMD does not name');

    if (verb === 'COPY') {
      if (rest.some((word) => word.startsWith('--'))) reasons.push(`copies with a flag (${line}), not tracked files alone`);

      for (const from of rest.slice(0, -1)) {
        if (!files.has(`${source}/${from}`)) reasons.push(`copies ${from}, which is not a tracked file of ${source}`);
        else copied.add(from);
      }
    }

    if (verb === 'CMD') {
      if (command !== undefined) reasons.push('names CMD twice');
      command = rest.join(' ');
    }
  }

  const words = command === undefined ? null : v.safeParse(v.array(v.string()), tolerate<unknown>(() => JSON.parse(command), 'malformed-input'));

  if (words === null || !words.success) {
    reasons.push('has no exec-form CMD, so what the container runs is not a named file');
  } else if (!words.output.some((word) => copied.has(word)) || words.output.some((word) => !copied.has(word) && !FORWARDER_INTERPRETERS.includes(word))) {
    reasons.push(`runs ${JSON.stringify(words.output)}, not one tracked script under a known interpreter`);
  }

  return reasons;
}

/** `name` of an Identifier or PrivateIdentifier (as `#name`), else undefined. */
function nameOf(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name;

  return node?.type === 'PrivateIdentifier' ? `#${node.name}` : undefined;
}

export function surfaceReasons(surface: ForwarderSurface): string[] {
  const reasons: string[] = [];

  if (!surface.parentIsDurableObject) reasons.push('does not extend DurableObject directly, so a base class\'s methods are on its RPC surface');

  for (const method of surface.methods) if (!FORWARDER_SURFACE.has(method)) reasons.push(`exposes \`${method}\` over RPC, which FORWARDER_SURFACE does not classify`);

  for (const method of FORWARDER_SURFACE.keys()) if (!surface.methods.includes(method)) reasons.push(`lacks \`${method}\`, which FORWARDER_SURFACE expects`);

  return reasons;
}

function isNativeContainer(raw: Node | null | undefined): boolean {
  return memberPath(raw) === 'this.ctx.container';
}

function containerAliases(owner: SyntaxNode): ReadonlySet<string> {
  const aliases = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    walk(owner, node => {
      const raw = node.raw;

      if (raw.type !== 'VariableDeclarator' || raw.init === null || raw.init === undefined) return;

      if (!isNativeContainer(raw.init) && !(raw.init.type === 'Identifier' && aliases.has(raw.init.name))) return;
      const name = nameOf(raw.id);

      if (name !== undefined && !aliases.has(name)) { aliases.add(name); changed = true; }
    });
  }

  return aliases;
}

function constantString(raw: Node | null | undefined, tree: SyntaxNode): boolean {
  if (raw?.type === 'Literal') return v.is(v.string(), raw.value);

  if (raw?.type === 'TemplateLiteral') return raw.expressions.length === 0;

  if (raw?.type !== 'Identifier') return false;
  let found = false;
  walk(tree, node => {
    if (node.raw.type === 'VariableDeclarator' && nameOf(node.raw.id) === raw.name
      && node.parent?.raw.type === 'VariableDeclaration' && node.parent.raw.kind === 'const') {
      const value = node.raw.init;

      if (value?.type === 'Literal' && v.is(v.string(), value.value)) found = true;

      if (value?.type === 'TemplateLiteral' && value.expressions.length === 0) found = true;
    }
  });

  return found;
}

function nativeReadinessAllowed(args: readonly Node[], tree: SyntaxNode): boolean {
  const [argv, options] = args;

  return args.length === 2 && argv?.type === 'ArrayExpression' && argv.elements.length === 3
    && literalIs(argv.elements[0], 'node') && literalIs(argv.elements[1], '-e') && constantString(argv.elements[2], tree)
    && options?.type === 'ObjectExpression' && options.properties.length === 1 && objectValue(options, 'signal') !== undefined;
}

function nativePortFetchAllowed(args: readonly Node[], call: SyntaxNode): boolean {
  if (args.length !== 1 || !literalIs(args[0], 8080)) return false;
  const fetch = call.parent?.parent?.raw;

  return call.parent?.raw.type === 'MemberExpression' && nameOf(call.parent.raw.property) === 'fetch'
    && fetch?.type === 'CallExpression' && fetch.arguments.length === 1
    && fetch.arguments[0]?.type === 'NewExpression' && nameOf(fetch.arguments[0].callee) === 'Request'
    && literalIs(fetch.arguments[0].arguments[0], 'http://codex-egress/forward');
}

function nativeCallAllowed(member: string, args: readonly Node[], call: SyntaxNode, tree: SyntaxNode): boolean {
  if (args.some(arg => arg.type === 'SpreadElement')) return false;

  if (member === 'start') {
    const options = args[0];

    return args.length === 1 && options?.type === 'ObjectExpression' && options.properties.length === 1
      && literalIs(objectValue(options, 'enableInternet'), true);
  }

  if (member === 'setInactivityTimeout') return args.length === 1;

  if (member === 'exec') return nativeReadinessAllowed(args, tree);

  return member === 'getTcpPort' && nativePortFetchAllowed(args, call);
}

function containerUseReasons(owner: SyntaxNode, tree: SyntaxNode): string[] {
  const aliases = containerAliases(owner);
  const reasons: string[] = [];
  let uses = 0;
  walk(owner, node => {
    const raw = node.raw;

    if (!isNativeContainer(raw) && !(raw.type === 'Identifier' && aliases.has(raw.name))) return;
    const parent = node.parent?.raw;

    if (parent?.type === 'MemberExpression' && parent.property === raw && !parent.computed) return;

    if (parent?.type === 'VariableDeclarator' && (parent.id === raw || parent.init === raw)) return;

    if (parent?.type === 'BinaryExpression' && ['===', '!=='].includes(parent.operator)
      && (nameOf(parent.left) === 'undefined' || nameOf(parent.right) === 'undefined')) return;

    if (parent?.type === 'MemberExpression' && parent.object === raw && !parent.computed) {
      const member = nameOf(parent.property);

      if (member === 'running') return;
      const call = node.parent?.parent;

      if (member !== undefined && call?.raw.type === 'CallExpression' && nativeCallAllowed(member, call.raw.arguments, call, tree)) { uses++;

 return; }
    }

    reasons.push('uses the native container outside fixed start, readiness, inactivity, and port-forward operations');
  });

  if (uses === 0) reasons.push('has no measured native container operations');

  return reasons;
}


/** A getter or setter is a function RPC can reach under a property name. */
function accessorReasons(owner: SyntaxNode): string[] {
  return classMembers(owner).flatMap((member) => (member.raw.type === 'MethodDefinition' && (member.raw.kind === 'get' || member.raw.kind === 'set')
    ? [`declares a ${member.raw.kind}ter \`${nameOf(member.raw.key) ?? '[computed]'}\`, which RPC can reach`]
    : []));
}

/** A function or arrow that captures `this` or a box alias can carry the box out unless it is called where it is made
 *  or handed to `#calls.run`, which only calls it. */
function closureReasons(owner: SyntaxNode, tree: SyntaxNode): string[] {
  const reasons: string[] = [];
  const trustedRun = callsIsEgressCalls(owner, tree);
  const aliases = containerAliases(owner);
  walk(owner, inner => {
    if (inner.raw.type !== 'ArrowFunctionExpression' && inner.raw.type !== 'FunctionExpression') return;

    if (inner.parent?.raw.type === 'MethodDefinition') return;
    let captures = false;
    walk(inner, child => { if (child.raw.type === 'ThisExpression' || (child.raw.type === 'Identifier' && aliases.has(child.raw.name))) captures = true; });

    if (!captures) return;

    if (inner.parent?.raw.type === 'CallExpression' && inner.parent.raw.callee === inner.raw) return;

    for (let parent = inner.parent; parent !== undefined; parent = parent.parent) {
      if (trustedRun && parent.raw.type === 'CallExpression' && isCallsRun(parent.raw)) return;
    }

    reasons.push('makes a function that captures this or the native container outside the owned call lifetime');
  });

  return reasons;
}

/** `#calls` is `new EgressCalls()` with EgressCalls imported from '@kinu.run/core': only then does `run` merely call
 *  the functions it is given. */
function callsIsEgressCalls(owner: SyntaxNode, tree: SyntaxNode): boolean {
  const imported = tree.children.some((statement) => statement.raw.type === 'ImportDeclaration' && statement.raw.source.value === '@kinu.run/core'
    && statement.raw.specifiers.some((spec) => spec.type === 'ImportSpecifier' && nameOf(spec.local) === 'EgressCalls' && nameOf(spec.imported) === 'EgressCalls'));

  return imported && classMembers(owner).some((member) => member.raw.type === 'PropertyDefinition' && nameOf(member.raw.key) === '#calls'
    && member.raw.value?.type === 'NewExpression' && nameOf(member.raw.value.callee) === 'EgressCalls' && member.raw.value.arguments.length === 0);
}

/** `this.#calls.run(…)`: EgressCalls only calls the functions it is given. */
function isCallsRun(call: Node): boolean {
  return call.type === 'CallExpression' && call.callee.type === 'MemberExpression' && nameOf(call.callee.property) === 'run'
    && call.callee.object.type === 'MemberExpression' && call.callee.object.object.type === 'ThisExpression' && nameOf(call.callee.object.property) === '#calls';
}

function classReasons(input: ForwarderInputs): string[] {
  const tree = parse(input.file, input.fileText).root;
  let owner: SyntaxNode | undefined;
  walk(tree, node => { if (node.type === 'ClassDeclaration' && declaredName(node) === input.owner) owner = node; });

  if (owner === undefined) return ['has no declared forwarder class'];
  const reasons: string[] = [];
  walk(owner, node => { if (node.type === 'Decorator') reasons.push('carries a decorator, which can rewrite its RPC surface'); });

  return [...reasons, ...accessorReasons(owner), ...closureReasons(owner, tree), ...containerUseReasons(owner, tree)];
}

/** A loaded class: a function whose prototype is an object. */
const LoadedClass = v.custom<{ readonly prototype: object }>((value) => value instanceof Function && Object.getPrototypeOf(value.prototype) !== undefined);

/** The loaded class's parent and own function properties, for {@link surfaceReasons}. */
export function surfaceOf(cls: { readonly prototype: object }, durableObject: { readonly prototype: object }): ForwarderSurface {
  const { prototype } = cls;

  return {
    parentIsDurableObject: Object.getPrototypeOf(prototype) === durableObject.prototype,
    // Every own key, accessors and symbols included: a getter can return a function RPC then calls.
    methods: [...Object.getOwnPropertyNames(prototype), ...Object.getOwnPropertySymbols(prototype).map(String)],
  };
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
  const kinu = classes.get('KinuSandbox');
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


/** What RPC can reach on `name` exported from `path`, read off the loaded class. `cloudflare:workers` is shimmed as
 *  scripts/test-preload.ts does, unless something already provides it; the class and the comparison use one module. */
export async function loadForwarderSurface(path: string, name: string): Promise<ForwarderSurface | undefined> {
  class DurableObject<Ctx, Env> {
    constructor(readonly ctx: Ctx, readonly env: Env) {}
  }

  Bun.plugin({
    name: 'egress-interception:cloudflare-workers',
    setup(build) {
      build.module('cloudflare:workers', () => ({
        exports: { DurableObject, WorkerEntrypoint: class {}, RpcTarget: class {}, env: {}, exports: {} },
        loader: 'object',
      }));
    },
  });

  const workersModule = 'cloudflare:workers';
  const base = v.safeParse(v.object({ DurableObject: LoadedClass }), await import(workersModule));
  const cls = v.safeParse(v.object({ [name]: LoadedClass }), await import(path));
  const loaded = cls.success ? cls.output[name] : undefined;

  return base.success && loaded !== undefined ? surfaceOf(loaded, base.output.DurableObject) : undefined;
}

if (import.meta.main) {
  const sources = readInterceptionSources();
  const bound = wranglerContainerClasses(parseJsonc(readFileSync(`${root}${WRANGLER}`, 'utf8'), WranglerContainers, WRANGLER));
  const declaredContainers = parseJsonc(readFileSync(`${root}${WRANGLER}`, 'utf8'), WranglerContainers, WRANGLER).containers ?? [];
  const records = new Map<string, ContainerImage>(Object.entries(CONTAINER_IMAGES));
  const forwarderReasons = new Map<string, string[]>();

  // The loaded class, not its source text, answers what RPC can reach: a base's methods are enumerable here.
  for (const [owner, file] of [...declaredForwarderClasses(sources)].sort(([a], [b]) => a.localeCompare(b))) {
    if (!bound.includes(owner)) continue;
    const image = records.get(owner);
    const surface = await loadForwarderSurface(join(root, file), owner);

    forwarderReasons.set(owner, surface === undefined ? ['has no loadable source file'] : auditForwarder({
      owner, file, fileText: sources.get(file) ?? '', image, surface,
      boundImage: declaredContainers.find((entry) => entry.class_name === owner)?.image,
      sourceFiles: image === undefined ? new Map() : readSource(root, image.source),
    }));
  }

  const forwarders = [...forwarderReasons].filter(([, reasons]) => reasons.length === 0).map(([owner]) => owner);

  for (const [owner, reasons] of forwarderReasons) {
    for (const reason of reasons) console.error(`egress-interception: ${owner} is not an admitted forwarder: it ${reason}`);
  }

  const fromWrangler = bound.filter(name => !forwarders.includes(name));
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
  console.log('egress-interception: admitted fixed-image forwarders: ' + (forwarders.join(', ') || 'none'));

  for (const [method, why] of FORWARDER_SURFACE) console.log('egress-interception: ' + method + ' — ' + why);
  console.log('egress-interception: blind spots: this proves literal/inherited policy and explicit native call/binding edges, not arbitrary control-flow equivalence or runtime platform enforcement. Dynamic aliases and metaprogramming are not credited. Vault authorization and forwarder policy bodies are covered by their behavioral tests; native routing, TLS trust and platform behavior by D38.');
  console.log('egress-interception: DNS was measured closed with internet disabled on 0.2.0+28bc79307: UDP/TCP 53 did not escape and nonexistent names resolved to the same private ULA. This is a platform observation, not a source proof.');
  process.exit(0);
}
