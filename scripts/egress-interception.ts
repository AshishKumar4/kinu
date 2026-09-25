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
 * 5. DNS. NOT an open residual. The claim — "DNS leaves, to Cloudflare's
 *    resolvers, so query LABELS are a low-bandwidth channel outward" — is
 *    MEASURED FALSE on the deployed worker (0.2.0+28bc79307), inside a
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

import type { Node } from 'oxc-parser';
import { parseJsonc } from './jsonc';
import { readSources } from './sources';
import { assertMeasured, finding } from './gate-ratchet';
import { classMembers, declaredName, literalText, parse, superClassName, walk, type SyntaxNode } from './syntax';
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash, type ContainerImage } from './container-images';
import { tolerate } from '../packages/core/src/obs/index';

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

/** Direct `DurableObject` subclasses in the deployment source: bound to a container, candidates for forwarder admission. */
export function declaredForwarderClasses(sources: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();

  for (const [file, text] of sources) {
    if (!file.startsWith('packages/cf-backend/') || !text.includes('Container')) continue;
    walk(parse(file, text).root, (node) => {
      const name = superClassName(node) === 'DurableObject' ? declaredName(node) : undefined;

      if (name !== undefined) names.add(name);
    });
  }

  return [...names].sort();
}

/** The interpreters a forwarder's CMD may name besides its own tracked script. */
const FORWARDER_INTERPRETERS: readonly string[] = ['node'];

/** The only Dockerfile instructions a forwarder image may use: none of them runs anything at build or names a
 *  program other than CMD's. */
const FORWARDER_INSTRUCTIONS: readonly string[] = ['FROM', 'COPY', 'WORKDIR', 'ENV', 'EXPOSE', 'USER', 'LABEL', 'CMD'];

/** Everything RPC can call on an admitted forwarder, each with why it cannot change what the container runs or where it
 *  may connect. The class's own function properties must equal this table; one more, from the class or its base, is red. */
export const FORWARDER_SURFACE: ReadonlyMap<string, string> = new Map([
  ['constructor', 'not callable over RPC; builds the private container box on this object\'s ctx'],
  ['forward', 'checks the owner and core codexEgressAllowed, then the container\'s policy.mjs checks again'],
  ['cancel', 'aborts one of this object\'s own in-flight calls by id'],
  ['alarm', 'a runtime handler, not RPC-callable (reserved); runs the box\'s sleepAfter and schedules'],
]);

/** The only fields the private box may declare: none names a command, env or outbound policy. */
const BOX_FIELDS: readonly string[] = ['defaultPort', 'sleepAfter', 'enableInternet'];

/** How the owner may touch its box: a member read or call, never the box itself. */
const BOX_USES: readonly string[] = ['startAndWaitForPorts', 'containerFetch', 'defaultPort', 'alarm'];

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

/** Why the private box could change what runs: a declaration beyond BOX_FIELDS, or any member at all besides them. */
function boxReasons(box: SyntaxNode): string[] {
  const reasons: string[] = [];

  for (const member of classMembers(box)) {
    const name = member.raw.type === 'PropertyDefinition' || member.raw.type === 'MethodDefinition' ? nameOf(member.raw.key) : undefined;

    if (name === undefined || !BOX_FIELDS.includes(name) || member.raw.type !== 'PropertyDefinition' || member.raw.static) {
      reasons.push(`its box declares \`${name ?? member.raw.type}\`, outside ${BOX_FIELDS.join(', ')}`);
    }
  }

  walk(box, (inner) => { if (inner.type === 'Decorator') reasons.push('its box carries a decorator'); });

  return reasons;
}

function inConstructor(node: SyntaxNode): boolean {
  for (let up = node.parent; up !== undefined; up = up.parent) {
    if (up.raw.type === 'MethodDefinition') return up.raw.kind === 'constructor';
  }

  return false;
}

/** Why the owner could hand its box out: a use of `this.#box`, or an alias of it, other than a BOX_USES member. */
function boxUseReasons(owner: SyntaxNode, field: string): string[] {
  const reasons: string[] = [];
  const aliases = new Set<string>();

  walk(owner, (inner) => {
    const { raw } = inner;

    if (raw.type === 'VariableDeclarator' && raw.init?.type === 'MemberExpression' && raw.init.object.type === 'ThisExpression' && nameOf(raw.init.property) === field) {
      const alias = nameOf(raw.id);

      if (alias === undefined) reasons.push('destructures its box');
      else aliases.add(alias);
    }
  });

  walk(owner, (inner) => {
    const { raw } = inner;

    const isBox = (raw.type === 'MemberExpression' && raw.object.type === 'ThisExpression' && nameOf(raw.property) === field)
      || (raw.type === 'Identifier' && aliases.has(raw.name) && inner.parent?.raw.type !== 'VariableDeclarator');

    if (isBox && !allowedBoxUse(inner)) reasons.push(`uses its box other than to read ${BOX_USES.join(', ')}, so the box or its ctx could leave the class`);
  });

  return reasons;
}

/** A box reference used as a declaration, the constructor's assignment, or a BOX_USES read or call. */
function allowedBoxUse(inner: SyntaxNode): boolean {
  const { raw } = inner;
  const up = inner.parent?.raw;

  if ((up?.type === 'VariableDeclarator' && up.init === raw) || (up?.type === 'PropertyDefinition' && up.key === raw)) return true;

  if (up?.type === 'AssignmentExpression' && up.left === raw) return inConstructor(inner);

  if (up?.type !== 'MemberExpression' || up.object !== raw || up.computed) return false;
  const member = nameOf(up.property) ?? '';
  const called = inner.parent?.parent?.raw;

  if (member === 'defaultPort') return true;

  return called?.type === 'CallExpression' && called.callee === up && boxCallAllowed(member, called.arguments, inner);
}

/** The only box calls: startAndWaitForPorts(box.defaultPort, { abort: X }), containerFetch(new Request(…)), and
 *  alarm(<the alarm parameter>). */
function boxCallAllowed(member: string, args: readonly Node[], inner: SyntaxNode): boolean {
  if (args.some((arg) => arg.type === 'SpreadElement')) return false;

  if (member === 'containerFetch') return args.length === 1 && args[0]?.type === 'NewExpression' && nameOf(args[0].callee) === 'Request';

  if (member === 'startAndWaitForPorts') {
    const [port, cancellation] = args;

    const onlyAbort = cancellation?.type === 'ObjectExpression' && cancellation.properties.length === 1
      && cancellation.properties[0]?.type === 'Property' && !cancellation.properties[0].computed && nameOf(cancellation.properties[0].key) === 'abort';

    return args.length === 2 && port?.type === 'MemberExpression' && !port.computed && nameOf(port.property) === 'defaultPort' && onlyAbort;
  }

  if (member !== 'alarm') return false;
  const method = enclosingMethod(inner);
  const param = method?.raw.type === 'MethodDefinition' ? nameOf(method.raw.value.params[0]) : undefined;

  return method !== undefined && nameOf(method.raw.type === 'MethodDefinition' ? method.raw.key : null) === 'alarm'
    && args.length <= 1 && (args.length === 0 || (param !== undefined && nameOf(args[0]) === param));
}

function enclosingMethod(node: SyntaxNode): SyntaxNode | undefined {
  for (let up = node.parent; up !== undefined; up = up.parent) if (up.raw.type === 'MethodDefinition') return up;

  return undefined;
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

  walk(owner, (inner) => {
    const { raw } = inner;

    if (raw.type !== 'ArrowFunctionExpression' && raw.type !== 'FunctionExpression') return;

    if (inner.parent?.raw.type === 'MethodDefinition') return;
    let captures = false;

    walk(inner, (deep) => {
      if (deep.raw.type === 'ThisExpression' || (deep.raw.type === 'Identifier' && deep.raw.name === 'box')) captures = true;
    });

    if (!captures) return;
    const up = inner.parent?.raw;
    const calledHere = up?.type === 'CallExpression' && up.callee === raw;

    const runArgument = trustedRun && up?.type === 'Property' && inner.parent?.parent?.parent?.raw.type === 'CallExpression'
      && isCallsRun(inner.parent.parent.parent.raw);

    if (!calledHere && !runArgument) reasons.push('makes a function that captures `this` or the box and is not called where it is made');
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
  const reasons: string[] = [];
  const tree = parse(input.file, input.fileText).root;
  const boxes: SyntaxNode[] = [];
  let owner: SyntaxNode | undefined;

  walk(tree, (node) => {
    if (node.type !== 'ClassDeclaration') return;

    if (declaredName(node) === input.owner) owner = node;
    else if (superClassName(node) === 'Container') boxes.push(node);
  });

  if (owner === undefined) return [`is not declared in ${input.file}`];

  if (boxes.length !== 1) return [`declares ${String(boxes.length)} Container classes beside it, not one private box`];
  const [box] = boxes;

  if (box === undefined) return reasons;

  for (const statement of tree.children) {
    if (statement.raw.type === 'ExportNamedDeclaration' && statement.children.some((child) => child === box)) reasons.push('exports its box');
  }

  walk(owner, (inner) => { if (inner.type === 'Decorator') reasons.push('carries a decorator, which can add or rewrite members'); });
  reasons.push(...accessorReasons(owner), ...closureReasons(owner, tree));
  reasons.push(...boxReasons(box));

  const field = classMembers(owner)
    .flatMap((member) => (member.raw.type === 'PropertyDefinition' && member.raw.key.type === 'PrivateIdentifier' ? [member.raw.key.name] : []))
    .find((name) => name === 'box');

  if (field === undefined) reasons.push('holds no private #box');
  else reasons.push(...boxUseReasons(owner, `#${field}`));

  return reasons;
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
 * Resolved rather than spelled: a literal path names the TOP-LEVEL copy, which
 * is a different version and ships nothing, so the property asserted below
 * would hold by accident.
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
  const sources = readSources();
  const bound = wranglerContainerClasses(parseJsonc(readFileSync(`${root}${WRANGLER}`, 'utf8'), WranglerContainers, WRANGLER));
  const declaredContainers = parseJsonc(readFileSync(`${root}${WRANGLER}`, 'utf8'), WranglerContainers, WRANGLER).containers ?? [];
  const records = new Map<string, ContainerImage>(Object.entries(CONTAINER_IMAGES));
  const forwarderReasons = new Map<string, string[]>();

  // The loaded class, not its source text, answers what RPC can reach: a base's methods are enumerable here.
  for (const owner of declaredForwarderClasses(sources).filter((name) => bound.includes(name))) {
    const file = [...sources.keys()].find((path) => path.startsWith('packages/cf-backend/') && sources.get(path)?.includes(`class ${owner} `) === true);
    const image = records.get(owner);
    const surface = file === undefined ? undefined : await loadForwarderSurface(join(root, file), owner);

    forwarderReasons.set(owner, file === undefined || surface === undefined ? ['has no loadable source file'] : auditForwarder({
      owner, file, fileText: sources.get(file) ?? '', image, surface,
      boundImage: declaredContainers.find((entry) => entry.class_name === owner)?.image,
      sourceFiles: image === undefined ? new Map() : readSource(root, image.source),
    }));
  }

  const forwarders = [...forwarderReasons].filter(([, reasons]) => reasons.length === 0).map(([owner]) => owner);

  for (const [owner, reasons] of forwarderReasons) {
    for (const reason of reasons) console.error(`egress-interception: ${owner} is not an admitted forwarder: it ${reason}`);
  }

  const fromWrangler = bound.filter((name) => !forwarders.includes(name));
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

    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} ${violation.owner} — ${violation.reason}`);
    }

    process.exit(1);
  }

  console.log(`egress-interception: ok — ${measured}`);
  console.log(`egress-interception: ADMITTED FORWARDERS — ${forwarders.join(', ') || 'none'}: each proved its image is the `
    + 'pinned build of a hashed tracked directory running one tracked script, and its loaded class extends DurableObject '
    + 'with exactly this RPC surface:');

  for (const [method, why] of FORWARDER_SURFACE) console.log(`egress-interception:   ${method} — ${why}`);
  console.log('egress-interception: residual: policy.mjs is proved by its unit test, not parsed, and holds for every forward');
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
