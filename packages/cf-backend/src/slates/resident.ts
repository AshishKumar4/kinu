import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { FACET_IMAGE_DIR, facetImageDigest, facetImagePath } from '@nimbus-sh/fabric/process-fabric.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { NamespaceFs } from '@nimbus-sh/core/runtime/process-files.js';
import { CRED_KERNEL, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ComposedFacetManager, LongRunningWorkerSpawnOptions } from '@nimbus-sh/worker/workspace-host';
import type { WorkspaceSession } from '@kinu.run/core/workspace';
import {
  SLATE_DRIVEN_MEMBERS, SLATE_METHOD_NAME_SOURCE, SLATE_PAGE_PREAMBLE, slateTitle, type SlateProcess, type SlateProject,
} from '@kinu.run/core';
import { attempt, diagnostics, KinuError, renderCauseChain, settle } from '@kinu.run/core/obs';
import { slateCredentialKey } from './bindings';
import { SLATE_CLIENT_MODULE, SLATE_SERVER_MODULE } from '@kinu.run/core/slates';
import { BROWSER_CLIENT_MODULE, BROWSER_PRELUDE, browserClientSource } from '../browser-prelude';

interface SlateBootArtifacts {
  application: string;
  client?: string;
  shell?: string;
}

export interface ResidentSlateProcess extends SlateProcess {
  /** The port the durable application listens on; null for a caller's private process, which is reached by RPC alone. */
  readonly port: number | null;
  request(request: Request): Promise<Response>;
  connect(request: Request): Promise<Response>;
  /** The method names `startProcess` published — the forwarder's allow list. */
  readonly methods: readonly string[];
  readonly artifacts: Readonly<SlateBootArtifacts>;
}

export interface ResidentSlateDeps {
  session: () => Promise<Pick<WorkspaceSession, 'vfs' | 'processes' | 'filesystem'>>;
  /** Every resident spawn goes through its `spawnWorker` and every teardown through its `kill`. */
  facetManager: () => Promise<ComposedFacetManager>;
  /** esbuild for a credential's view, in the object's esbuild facet: esbuild-wasm's heap only grows. */
  bundler: (vfs: NamespaceFs) => EsbuildService;
  /** Image digests no process runs that a sweep keeps: each slate's last working build. */
  retained: () => Iterable<string>;
}

/**
 * A slate's compiled modules and the files its runner serves, each held by digest in the facet image directory: what a
 * launch runs, and what a slate falls back to while a later edit fails to build.
 */
export interface SlateImage {
  readonly modules: Readonly<Record<string, string>>;
  readonly client?: string;
  readonly shell?: string;
}

/** What a build that did not compile says: the compiler's own words, file and line among them. */
export interface SlateBuildFailure {
  readonly failed: string;
}

/** What a build reads: the authored tree, as its caller sees it. */
export type SlateBuildInput = Pick<ResidentSlateBoot, 'owner' | 'root' | 'project' | 'read' | 'cred'>;

export interface ResidentSlateBoot {
  readonly key: string;
  /** The slate id, independent of source revision and process incarnation. */
  readonly owner: string;
  readonly root: string;
  readonly project: SlateProject;
  /** An authored entry's text, wherever the slate's source keeps it; null for one it does not hold. */
  readonly read: (entry: string) => string | null;
  /** Set for the durable application (reserved port, owner-pinned facet whose SQLite persists); null spawns a private ephemeral process. */
  readonly app: { readonly port: number } | null;
  /** Whose file plane compiles the authored tree: the caller's, never the origin's on its behalf. */
  readonly cred: VfsCred;
  /** `workspace`, `__storage` and `__host`, each the host's entrypoint for this slate as its caller. */
  readonly bindings: Readonly<Record<string, Fetcher>>;
  /** The caller's explicitly selected network capability; never implicit inheritance. */
  readonly globalOutbound: Fetcher | null;
}

/** Written only when the bytes differ, so a start never churns the file ledger. */
function runtimeFiles(reactStub: string) {
  return { 'server.js': SLATE_SERVER_MODULE, 'react-stub.js': reactStub };
}

const RUNTIME_DIR = '/usr/lib/kinu/slate';

const MAIN_MODULE = 'runner.js';

const APPLICATION_MODULE = 'application.js';

const CLASS_BOOT: readonly string[] = [
  '    // The authored module is imported here, not at the top: a static import',
  '    // evaluates during worker boot, where a throw in authored source (say a',
  '    // missing SlateObject import) surfaces as an io fault instead of the',
  '    // bad_input refusal startProcess is built to return.',
  '    let slateModule;',
  '    try {',
  '      slateModule = await import("./application.js");',
  '    }',
  '    catch (cause) {',
  '      return { ok: false, error: "package.json main threw at evaluation: " + errorText(cause) };',
  '    }',
  '    // Either export shape satisfies the contract: the named Slate the skill',
  '    // documents, or the class carried as the module\'s default export.',
  '    const Slate = typeof slateModule.Slate === "function" && slateModule.Slate.prototype?.[Symbol.for("kinu.slate")] === true',
  '      ? slateModule.Slate',
  '      : slateModule.default;',
  '    // The contract check is authored-input refusal, not a fault: it crosses',
  '    // as data so the promise never logs as an uncaught rejection.',
  '    if (typeof Slate !== "function" || Slate.prototype?.[Symbol.for("kinu.slate")] !== true) {',
  '      const found = Object.keys(slateModule)',
  '        .map((name) => name + ": " + describeExport(slateModule[name]))',
  '        .join(", ");',
  '      return { ok: false, error: "package.json main must export class Slate extends SlateObject from kinu:slate (the Slate export or the default export); found " + (found === "" ? "no exports at all" : found) };',
  '    }',
  '    const slate = new Slate({',
  '      storage: this.ctx.storage,',
  '      kv: storageProxy(this.env.__storage),',
  '      waitUntil: (work) => this.ctx.waitUntil(work),',
  '    }, Object.freeze({ workspace: workspaceSurface(this.env.workspace) }));',
  '    // The callable surface: prototype methods between the instance and',
  '    // SlateObject (exclusive) whose name passes the host\'s own method rule.',
  '    // Own properties never appear: a closure assigned in the constructor',
  '    // stays private, and `fetch` serves HTTP, not RPC.',
  '    const allowed = new Set();',
  '    for (let proto = Object.getPrototypeOf(slate); proto !== null && !Object.hasOwn(proto, Symbol.for("kinu.slate")); proto = Object.getPrototypeOf(proto)) {',
  '      for (const name of Object.getOwnPropertyNames(proto)) {',
  '        const descriptor = Object.getOwnPropertyDescriptor(proto, name);',
  '        if (name === "fetch" || !METHOD_RE.test(name) || name === "constructor" || name.startsWith("_") || typeof descriptor?.value !== "function") continue;',
  '        allowed.add(name);',
  '      }',
  '    }',
  '    this.#slate = slate;',
  '    const workspace = new SurfaceTarget(this.env.workspace);',
  '    this.#forwarder = new Proxy(new RpcTarget(), {',
  '      get(target, member) {',
  '        // Symbols and the promise surface pass through to the RpcTarget so',
  '        // capnweb introspection never sees a throwing function.',
  '        if (typeof member !== "string" || member === "then" || member === "toJSON") return Reflect.get(target, member);',
  '        // The page\'s `workspace`: the method rule refuses `$`, so no class method takes the name.',
  '        if (member === "$workspace") return (path, args) => invocations.run(invocations.getStore() ?? null, () => workspace.$workspace(path, args));',
  '        if (!allowed.has(member)) {',
  '          // A member the slate never published refuses at call time, not',
  '          // at lookup: capnweb dispatches on the value.',
  '          if (!(member in target)) return () => { throw new Error("Slate has no method " + member); };',
  '          return Reflect.get(target, member);',
  '        }',
  '        // One hop keeps the invocation of the REQUEST that carries it;',
  '        // outside one (the browser socket) the root lineage applies.',
  '        return (...args) => invocations.run(invocations.getStore() ?? null, () => slate[member](...args));',
  '      },',
  '    });',
  '    return { ok: true, methods: [...allowed] };',
];

/** No class: the socket serves only the page's `$workspace(path, args)`, and no method is published for an actor to call. */
const SURFACE_BOOT: readonly string[] = [
  '    const workspace = this.env.workspace;',
  '    this.#forwarder = new SurfaceTarget(workspace);',
  // Nothing of its own answers HTTP: a path no asset serves is the runner's `no-fetch`.
  '    this.#slate = {};',
  '    return { ok: true, methods: [] };',
];

/**
 * The generated `runner.js`; exported because its contract (a re-created instance starts before it serves) is asserted on the text.
 * With no class of its own, a slate is served its surface on the socket where a class's methods would be.
 */
export function slateRunnerSource(
  assets: readonly { readonly path: string; readonly contents: string }[], shell: string | undefined, served: 'class' | 'surface',
): string {
  const raw: Record<string, { body: string; immutable: boolean }> = {};

  for (const asset of assets) raw[asset.path] = { body: asset.contents, immutable: false };

  return [
    'import { AsyncLocalStorage } from "node:async_hooks";',
    'import { DurableObject } from "cloudflare:workers";',
    'import { newWorkersRpcResponse, newWebSocketRpcSession, RpcTarget } from "./capnweb.js";',
    'import { react, capnweb, slateClient } from "./vendor.js";',
    'function describeExport(value) {',
    '  if (value === undefined) return "nothing";',
    '  if (typeof value === "function") {',
    '    if (value.prototype?.[Symbol.for("kinu.slate")] === true) return "a class extending SlateObject under the wrong export name";',
    '    return Function.prototype.toString.call(value).trimStart().startsWith("class") ? "a class that does not extend SlateObject" : "a function";',
    '  }',
    '  if (typeof value === "object" && value !== null) return "an object, not a class";',
    '  return "a " + typeof value;',
    '}',
    'const METHOD_RE = new RegExp(' + JSON.stringify(SLATE_METHOD_NAME_SOURCE) + ');',
    'class SlateRefusal extends Error {',
    '  constructor(result) {',
    '    super(result.reason + ": " + result.error);',
    '    this.name = "SlateRefusal";',
    '    this.reason = result.reason;',
    '  }',
    '}',
    'function errorText(cause) {',
    '  const parts = []; const seen = new Set();',
    '  while (cause instanceof Error && !seen.has(cause)) { seen.add(cause); parts.push(cause.message); cause = cause.cause; }',
    '  if (cause !== undefined) parts.push(seen.has(cause) ? "[cause cycle]" : String(cause));',
    '  return parts.join(": ");',
    '}',
    `const rawAssets = ${JSON.stringify(raw)};`,
    'const assets = Object.freeze({',
    '  ...rawAssets,',
    ...(shell === undefined ? [] : ['  "/__kinu/index.html": { body: ' + JSON.stringify(shell) + ', immutable: false },']),
    '  "/__kinu/react.js": { body: react, immutable: true },',
    '  "/__kinu/capnweb.js": { body: capnweb, immutable: true },',
    '  "/__kinu/slate.js": { body: slateClient, immutable: true },',
    '});',
    // Invocation is async context: `undefined` means no method is running; `null` is the root lineage.
    'const invocations = new AsyncLocalStorage();',
    // Every page this origin answers, the runner's own or the class's `fetch`, is opened one way: the import map,
    // the host's palette and faces, and kinu:slate's `fit`, which takes the host's theme and tells it the page's height.
    'const PAGE_PREAMBLE = ' + JSON.stringify(SLATE_PAGE_PREAMBLE) + ';',
    'async function openedPage(response) {',
    '  if (response.body === null || !/^text\\/html\\b/i.test(response.headers.get("content-type") ?? "")) return response;',
    '  let opened = false;',
    '  const page = await new HTMLRewriter().on("html", { element(element) { opened = true; element.prepend(PAGE_PREAMBLE, { html: true }); } }).transform(response).text();',
    '  const headers = new Headers(response.headers);',
    '  headers.delete("content-length");',
    '  headers.delete("content-encoding");',
    '  return new Response(opened ? page : PAGE_PREAMBLE + page, { status: response.status, statusText: response.statusText, headers });',
    '}',
    // `workspace.memory.search(query)` calls ["memory", "search"]; outside a method or the socket there is no invocation.
    'function surface(stub, path) {',
    '  return new Proxy(function () {}, {',
    '    apply(_fn, _self, args) {',
    '      const invocation = invocations.getStore();',
    '      if (invocation === undefined) {',
    '        return Promise.reject(new Error(`workspace.${path.join(".")} is called outside a slate method; there is no invocation to run it under`));',
    '      }',
    '      return stub.call(path, args, invocation).then((result) => {',
    '        if (!result.ok) throw new SlateRefusal(result);',
    // `ai.stream` answers its text as UTF-8 bytes, and `agent.ask` its reply: bytes are all a stream carries across the
    // host's RPC, and the class reads text.
    '        const value = result.value;',
    '        if (value instanceof ReadableStream) return value.pipeThrough(new TextDecoderStream());',
    '        if (value !== null && typeof value === "object" && value.reply instanceof ReadableStream) return { ...value, reply: value.reply.pipeThrough(new TextDecoderStream()) };',
    '        return value;',
    '      });',
    '    },',
    '    get(_fn, name) {',
    '      if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined;',
    '      return surface(stub, [...path, name]);',
    '    },',
    '  });',
    '}',
    // The class's `workspace`: `web` carries the browser members an eval program's does, from the same prelude, since a
    // CDP socket lives in this isolate and no JSON call to the host can hold one. A page drives a browser through its class.
    'function browserWeb(stub) {',
    '  const web = new Proxy({}, {',
    '    get(own, name) {',
    '      if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined;',
    '      return Object.hasOwn(own, name) ? own[name] : surface(stub, ["web", name]);',
    '    },',
    '  });',
    BROWSER_PRELUDE,
    // Each runs here, where its socket lives, once the host has authorized it as it authorizes every call: the
    // caller's role now, a share's grant, and the slate's recorded reach. A refusal never dials.
    `  for (const member of ${JSON.stringify(SLATE_DRIVEN_MEMBERS)}) {`,
    '    const local = web[member];',
    '    web[member] = async (...args) => {',
    '      const invocation = invocations.getStore();',
    '      if (invocation === undefined) throw new Error(`workspace.web.${member} is called outside a slate method; there is no invocation to run it under`);',
    '      const result = await stub.call(["web", member], [], invocation, true);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return local(...args);',
    '    };',
    '  }',
    '  return web;',
    '}',
    'function workspaceSurface(stub) {',
    '  const web = browserWeb(stub);',
    '  return new Proxy(surface(stub, []), { get: (root, name) => (name === "web" ? web : Reflect.get(root, name)) });',
    '}',
    // The page's socket: each call runs under the socket's invocation.
    'class SurfaceTarget extends RpcTarget {',
    '  #stub;',
    '  constructor(stub) { super(); this.#stub = stub; }',
    '  $workspace(path, args) { return surface(this.#stub, path)(...args); }',
    '}',
    // `__storage` needs no lineage, so it always passes the root invocation.
    'function storageProxy(stub) {',
    '  return Object.freeze({',
    '    get: async (key) => {',
    '      const result = await stub.call(["get"], [key], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value === null ? undefined : result.value.value;',
    '    },',
    '    put: async (key, value) => {',
    '      const result = await stub.call(["put"], [key, value], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '    },',
    '    delete: async (key) => {',
    '      const result = await stub.call(["delete"], [key], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value;',
    '    },',
    '    list: async (options) => {',
    '      const result = await stub.call(["list"], options === undefined ? [] : [options], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value;',
    '    },',
    '  });',
    '}',
    'export class NimbusProcess extends DurableObject {',
    '  #slate;',
    '  #forwarder;',
    // The platform can re-create the object under a "running" process row, so every request starts through
    // this memo; a failed boot clears it so the next request retries.
    '  #started;',
    '  constructor(ctx, env) { super(ctx, env); }',
    '  startProcess() { return this.#ensureStarted(); }',
    '  #ensureStarted() {',
    '    if (this.#started === undefined) {',
    '      const started = this.#bootProcess();',
    '      this.#started = started;',
    '      started.then((result) => {',
    '        if (result.ok === false && this.#started === started) this.#started = undefined;',
    '      }, () => {',
    '        if (this.#started === started) this.#started = undefined;',
    '      });',
    '    }',
    '    return this.#started;',
    '  }',
    '  async #bootProcess() {',
    ...(served === 'class' ? CLASS_BOOT : SURFACE_BOOT),
    '  }',
    '  async fetch(request) { return this.handleHttpRequest(request); }',
    '  async handleHttpRequest(request) {',
    '    try {',
    '      return await openedPage(await this.respond(request));',
    '    }',
    '    catch (cause) { return Response.json({ reason: cause instanceof SlateRefusal ? cause.reason : "io", error: errorText(cause) }, { status: 500 }); }',
    '  }',
    '  async respond(request) {',
    '    const started = await this.#ensureStarted();',
    '    if (!started.ok) return Response.json({ reason: started.error, error: started.error }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "3", "x-slate-runner": "start-failed" } });',
    '    const url = new URL(request.url);',
    '    const path = url.pathname;',
    '    if (path === "/__rpc") {',
    '      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {',
    // The socket's invocation is held until `release`, not settled when the 101 returns.
    '        const invocation = request.headers.get("x-slate-call");',
    '        const pair = new WebSocketPair();',
    '        const server = pair[0];',
    '        server.accept();',
    '        server.addEventListener("close", () => {',
    '          if (invocation !== null && this.env.__host !== undefined) this.env.__host.call(["release"], [invocation], null);',
    '        });',
    '        invocations.run(invocation, () => newWebSocketRpcSession(server, this.#forwarder));',
    '        return new Response(null, { status: 101, webSocket: pair[1] });',
    '      }',
    '      // A POST batch carries the host hop invocation on x-slate-call,',
    '      // already minted: no getStore() round trip.',
    '      return invocations.run(request.headers.get("x-slate-call"), () => newWorkersRpcResponse(request, this.#forwarder));',
    '    }',
    '    // The shell mounts at the slate root; every other registered asset',
    '    // answers at its own path.',
    '    const assetPath = path === "/" ? "/__kinu/index.html" : path;',
    '    const asset = Object.hasOwn(assets, assetPath) ? assets[assetPath] : undefined;',
    '    if (asset !== undefined && (request.method === "GET" || request.method === "HEAD")) {',
    '      const contentType = assetPath.endsWith(".css") ? "text/css; charset=utf-8"',
    '        : assetPath.endsWith(".html") ? "text/html; charset=utf-8"',
    '        : "text/javascript; charset=utf-8";',
    '      return new Response(request.method === "HEAD" ? null : asset.body, { headers: {',
    '        "content-type": contentType,',
    '        "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store"',
    '      }});',
    '    }',
    '    const slate = this.#slate;',
    '    // The header names this refusal as the runner\'s own: the host\'s route',
    '    // answers the same bare body when nothing listens, and the two must',
    '    // be told apart from outside.',
    '    if (slate === undefined || typeof slate.fetch !== "function") return new Response("Not found", { status: 404, headers: { "x-slate-runner": slate === undefined ? "unstarted" : "no-fetch" } });',
    '    return invocations.run(request.headers.get("x-slate-call"), () => slate.fetch(request));',
    '  }',
    '}',
  ].join('\n');
}

/** A slate with no class still runs as a module whose import nothing reads. */
const NO_APPLICATION = 'export {};\n';

function isPageEntry(browser: string): boolean {
  return browser.endsWith('.html');
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function slateShell(input: { readonly title: string; readonly assets: readonly { readonly path: string }[] }): string {
  const styles = input.assets
    .filter((asset) => asset.path.endsWith('.css'))
    .map((asset) => `  <link rel="stylesheet" href="${asset.path}">`)
    .join('\n');

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(input.title)}</title>`,
    styles,
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    '  <script type="module" src="/__kinu/client.js"></script>',
    '</body>',
    '</html>',
    '',
  ].filter((line) => line !== '').join('\n');
}

function compileSlate(bundler: EsbuildService, entry: string, options: Parameters<EsbuildService['build']>[1]) {
  return Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.gen(function* () { return yield* Effect.promise(async () => bundler.build([entry], options)); }), (failed) => Effect.gen(function* () {
      const cause = Cause.squash(failed);

      if (cause instanceof Error && 'errors' in cause && Array.isArray(cause.errors)) {
        return yield* new KinuError('bad_input', 'Slate compilation failed', { cause });
      }

      return yield* Effect.failCause(failed);
    }));
  });
}

/** Module-map keys must end `.js`, so kept bare specifiers are rewritten onto these paths. */
const SERVER_MODULE_PATHS = {
  'kinu:slate': './server.js',
  'react': './react-stub.js',
  'react-dom/client': './react-stub.js',
  'react/jsx-runtime': './react-stub.js',
  'capnweb': './capnweb.js',
} as const;

const StartedResult = v.object({ ok: v.literal(false), error: v.string() });

const StartedSurface = v.object({ ok: v.literal(true), methods: v.array(v.string()) });

const SPECIFIERS = Object.keys(SERVER_MODULE_PATHS).join('|').replaceAll('/', '\\/');

const STATIC_SPECIFIER = new RegExp(`^(\\s*(?:import|export)\\s[^'"]*?\\bfrom\\s*|import\\s*)(["'])(${SPECIFIERS})\\2`, 'gm');

const DYNAMIC_SPECIFIER = new RegExp(`\\bimport\\(\\s*(["'])(${SPECIFIERS})\\1\\s*\\)`, 'g');

function isMappedSpecifier(specifier: string): specifier is keyof typeof SERVER_MODULE_PATHS {
  return specifier in SERVER_MODULE_PATHS;
}

/** A capture the map cannot answer means the patterns and map drifted apart; never guess a path. */
function mappedModulePath(specifier: string): string {
  if (!isMappedSpecifier(specifier)) {
    throw new KinuError('unsupported', `Slate bundle imports ${specifier}, which the module map does not name`);
  }

  return SERVER_MODULE_PATHS[specifier];
}

/** Anchored to statement position so a quoted `kinu:slate` in authored data is never rewritten. */
function rewriteModuleSpecifiers(source: string): string {
  return source
    .replace(STATIC_SPECIFIER, (_match, head: string, quote: string, specifier: string) => `${head}${quote}${mappedModulePath(specifier)}${quote}`)
    .replace(DYNAMIC_SPECIFIER, (_match, quote: string, specifier: string) => `import(${quote}${mappedModulePath(specifier)}${quote})`);
}

/** Where a boot compiles: its bundler, the authored root, and the runtime directory its generated entries go in. */
interface SlateBuild {
  readonly bundler: EsbuildService;
  readonly root: string;
  readonly entries: string;
  readonly provision: (name: string, contents: string) => void;
}

const COMPILED_JSX = JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } });

/** The class's module, compiled; a slate with no class runs an empty one. */
function serverModule(build: SlateBuild, project: SlateProject): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const { main, browser } = project;

    if (main === undefined) return NO_APPLICATION;

    // Re-export only the class so the file's client half never reaches the server bundle.
    if (browser === main) build.provision('server.js', `export { Slate } from "${build.root}/${main}";\n`);

    const server = yield* compileSlate(build.bundler, browser === main ? `${build.entries}/server.js` : `${build.root}/${main}`, {
      bundle: true, format: 'esm', platform: 'neutral', outfile: '/application.js',
      // Not `alias`: the nimbus-vfs resolver sees a specifier before esbuild applies it.
      external: ['cloudflare:*', 'node:*', 'capnweb', 'kinu:slate', 'react', 'react-dom/client', 'react/jsx-runtime'],
      tsconfigRaw: COMPILED_JSX,
    });

    if (server.errors.length !== 0) return yield* new KinuError('bad_input', server.errors.map((error) => error.text).join('\n'));
    const compiled = server.outputFiles.find((file) => file.path === '/application.js');

    if (compiled === undefined) return yield* new KinuError('io', 'Slate compiler did not produce the server module');

    return rewriteModuleSpecifiers(compiled.contents);
  });
}

interface BrowserSurface {
  readonly assets: readonly { readonly path: string; readonly contents: string }[];
  readonly shell: string | undefined;
}

/** What the page is served: an HTML entry as written, needing no build; a component compiled into the shell; or none. */
function browserSurface(build: SlateBuild, id: string, project: SlateProject, read: (entry: string) => string): Effect.Effect<BrowserSurface, KinuError> {
  return Effect.gen(function* () {
    const { browser } = project;

    if (browser === undefined) return { assets: [], shell: undefined };

    // Served as written: the runner opens every page it answers, this one with the rest.
    if (isPageEntry(browser)) return { assets: [], shell: read(browser) };
    const clientEntry = `${build.entries}/client.js`;

    build.provision('client.js', `import App from "${build.root}/${browser}";\nimport { mount } from "kinu:slate";\nmount(App);\nexport default App;\n`);

    const client = yield* compileSlate(build.bundler, clientEntry, {
      bundle: true, format: 'esm', platform: 'browser', outfile: '/__kinu/client.js',
      external: ['react', 'react-dom/client', 'react/jsx-runtime', 'capnweb', 'kinu:slate'],
      tsconfigRaw: COMPILED_JSX,
    });

    if (client.errors.length !== 0) return yield* new KinuError('bad_input', client.errors.map((error) => error.text).join('\n'));

    return { assets: client.outputFiles, shell: slateShell({ title: slateTitle(project, id), assets: client.outputFiles }) };
  });
}

export class ResidentSlateProcesses {
  private readonly bundlers = new Map<string, EsbuildService>();
  /** Image digests per pid that a sweep must keep; a manager-driven restart reads these paths again. */
  private readonly imagesInUse = new Map<number, ReadonlySet<string>>();

  constructor(private readonly deps: ResidentSlateDeps) {}

  /** Builds the tree and runs it; a tree that does not compile is refused in the compiler's words. */
  start(input: ResidentSlateBoot): Promise<ResidentSlateProcess> {
    return settle(Effect.gen({ self: this }, function* () {
      const built = yield* Effect.promise(async () => this.build(input));

      if ('failed' in built) return yield* new KinuError('bad_input', built.failed);

      return yield* Effect.promise(async () => this.launch(input, built));
    }));
  }

  /**
   * Compiles the authored tree into an image. A tree that does not compile is answered as a value, in the compiler's
   * words, so its caller can keep serving the last image that did.
   */
  build(input: SlateBuildInput): Promise<SlateImage | SlateBuildFailure> {
    return settle(Effect.catchIf(Effect.gen({ self: this }, function* () {
      const session = yield* Effect.promise(async () => this.deps.session());
      const main = input.project.main;
      const browser = input.project.browser;

      for (const [field, entry] of [['main', main], ['browser', browser]] as const) {
        if (entry !== undefined && input.read(entry) === null) {
          return yield* new KinuError('bad_input', `package.json "${field}" names ${entry}, which is not a file in ${input.root}`);
        }
      }

      const bundlerKey = slateCredentialKey(input.cred);
      let bundler = this.bundlers.get(bundlerKey);

      if (bundler === undefined) {
        bundler = this.deps.bundler(session.filesystem.namespaceFs(input.cred));
        this.bundlers.set(bundlerKey, bundler);
      }

      // Its react, capnweb and puppeteer sources are compiled only when a slate first starts in this isolate.
      const { default: slateVendor } = yield* attempt({ doing: 'loading the slate runtime vendor', otherwise: 'io' }, async () => import('virtual:kinu-slate-vendor'));
      this.provisionRuntimeFiles(session, slateVendor.reactStub);

      // Generated entries live under the runtime dir, never the slate root, where they would surface in listings,
      // snapshots and revision bumps.
      const slateId = input.root.slice(input.root.lastIndexOf('/') + 1);
      const entriesDir = `${RUNTIME_DIR}/entries/${slateId}`;
      const kernelVfs = session.vfs.as(CRED_KERNEL);

      const provision = (name: string, contents: string) => {
        kernelVfs.mkdir(entriesDir, { recursive: true, mode: 0o755 });

        const path = `${entriesDir}/${name}`;

        if (!(kernelVfs.exists(path) && kernelVfs.readFileString(path) === contents)) {
          kernelVfs.writeFile(path, contents, { mode: 0o644 });
        }
      };

      const build: SlateBuild = { bundler, root: input.root, entries: entriesDir, provision };
      const application = yield* serverModule(build, input.project);
      const { assets, shell } = yield* browserSurface(build, input.owner, input.project, (entry) => input.read(entry) ?? '');

      const modules = {
        [MAIN_MODULE]: slateRunnerSource(assets, shell, main === undefined ? 'surface' : 'class'),
        [APPLICATION_MODULE]: application,
        'capnweb.js': slateVendor.capnwebWorkers,
        'server.js': SLATE_SERVER_MODULE,
        'react-stub.js': slateVendor.reactStub,
        'vendor.js': `export const react = ${JSON.stringify(slateVendor.react)};\nexport const capnweb = ${JSON.stringify(slateVendor.capnweb)};\nexport const slateClient = ${JSON.stringify(SLATE_CLIENT_MODULE)};\n`,
        // Evaluated only when the slate first connects a browser, as in an eval program.
        [BROWSER_CLIENT_MODULE]: yield* Effect.promise(browserClientSource),
      };

      // Every module travels by content-addressed VFS path; the loader verifies bytes against the digest.
      kernelVfs.mkdir(`/${FACET_IMAGE_DIR}`, { recursive: true, mode: 0o755 });

      const held = (contents: string) => Effect.gen(function* () {
        const digest = yield* Effect.promise(async () => facetImageDigest(contents));
        const path = facetImagePath(digest);

        if (!kernelVfs.exists(path)) kernelVfs.writeFile(path, contents, { mode: 0o644 });

        return digest;
      });

      const digests: Record<string, string> = {};

      for (const [name, contents] of Object.entries(modules)) digests[name] = yield* held(contents);
      const client = assets.find((asset) => asset.path === '/__kinu/client.js');

      return {
        modules: digests,
        ...(shell !== undefined && client !== undefined && { client: yield* held(client.contents), shell: yield* held(shell) }),
      };
    }), (error): error is KinuError => error instanceof KinuError && error.code === 'bad_input', (error) => Effect.succeed({ failed: renderCauseChain(error) })));
  }

  /** Runs an image: the durable application on its port, or a caller's private process. */
  launch(input: ResidentSlateBoot, image: SlateImage): Promise<ResidentSlateProcess> {
    return settle(Effect.gen({ self: this }, function* () {
      const session = yield* Effect.promise(async () => this.deps.session());
      const { workerCompatibility } = yield* attempt({ doing: 'loading the slate runtime vendor', otherwise: 'io' }, async () => import('virtual:kinu-slate-vendor'));
      const kernelVfs = session.vfs.as(CRED_KERNEL);
      const slateId = input.root.slice(input.root.lastIndexOf('/') + 1);
      const read = (digest: string) => kernelVfs.readFileString(facetImagePath(digest));
      const runner = image.modules[MAIN_MODULE];
      const applicationImage = image.modules[APPLICATION_MODULE];

      if (runner === undefined) return yield* new KinuError('io', `Slate image holds no ${MAIN_MODULE}`);

      if (applicationImage === undefined) return yield* new KinuError('io', `Slate image holds no ${APPLICATION_MODULE}`);
      const textModules = Object.fromEntries(Object.entries(image.modules).filter(([name]) => name !== MAIN_MODULE).map(([name, digest]) => [name, facetImagePath(digest)]));
      const manager = (yield* Effect.promise(async () => this.deps.facetManager())).manager;

      const launch: LongRunningWorkerSpawnOptions = {
        mainModule: MAIN_MODULE,
        ...workerCompatibility,
        vfsTextModules: textModules,
        env: input.bindings,
        globalOutbound: input.globalOutbound,
      };

      if (input.app !== null) {
        launch.port = input.app.port;
        launch.durable = { owner: input.owner, image: { runner, application: applicationImage } };
      }

      const spawned = yield* Effect.promise(async () => manager.spawnWorker(read(runner), `slate ${slateId}`, input.root, launch));

      const pid = spawned.pid;
      const refusal = v.safeParse(StartedResult, spawned.boot);
      const surface = v.safeParse(StartedSurface, spawned.boot);

      if (!surface.success) {
        manager.kill(pid);

        if (refusal.success) return yield* new KinuError('bad_input', refusal.output.error);

        return yield* new KinuError('io', 'Slate runner returned a boot result without a method list');
      }

      const methods = surface.output.methods;

      session.processes.setTerminator(pid, () => {
        // Every resident exit passes here; the stack records who ended the pid.
        diagnostics.event('slate.resident.terminated', {
          pid, owner: input.owner, port: input.app?.port ?? 0,
          state: session.processes.get(pid)?.state ?? 'absent',
          by: new Error('resident terminated').stack?.split('\n').slice(2, 8).map((line) => line.trim()).join(' < ') ?? '',
        });
      });

      const artifacts: SlateBootArtifacts = {
        application: read(applicationImage),
        ...(image.client !== undefined && image.shell !== undefined && { client: read(image.client), shell: read(image.shell) }),
      };

      // Nothing else sweeps these images (fabric sweeps only its own), and every source edit writes a new one.
      this.imagesInUse.set(pid, new Set([...Object.values(image.modules), ...[image.client, image.shell].filter((digest) => digest !== undefined)]));
      this.sweepFacetImages(kernelVfs);

      return {
        id: String(pid), port: input.app?.port ?? null, methods, artifacts,
        request: (request) => spawned.facet.fetch(request),
        connect: (request) => spawned.facet.connect(request),
        isRunning: async () => session.processes.get(pid)?.state === 'running',
        stop: async () => { manager.kill(pid); this.imagesInUse.delete(pid); },
      };
    }));
  }

  private sweepFacetImages(kernelVfs: ReturnType<WorkspaceSession['vfs']['as']>): void {
    const keep = new Set<string>();

    for (const digests of this.imagesInUse.values()) for (const digest of digests) keep.add(facetImagePath(digest));

    // A slate's last working build stays, so a later edit that fails to compile still has something to serve.
    for (const digest of this.deps.retained()) keep.add(facetImagePath(digest));

    for (const entry of kernelVfs.readdir(`/${FACET_IMAGE_DIR}`)) {
      const path = `/${FACET_IMAGE_DIR}/${entry.name}`;

      if (entry.type === 'file' && !keep.has(path)) kernelVfs.unlink(path);
    }
  }

  private provisionRuntimeFiles(session: Pick<WorkspaceSession, 'vfs' | 'processes'>, reactStub: string): void {
    const vfs = session.vfs.as(CRED_KERNEL);

    vfs.mkdir(RUNTIME_DIR, { recursive: true, mode: 0o755 });

    for (const [name, contents] of Object.entries(runtimeFiles(reactStub))) {
      const path = `${RUNTIME_DIR}/${name}`;

      if (vfs.exists(path) && vfs.readFileString(path) === contents) continue;

      vfs.writeFile(path, contents, { mode: 0o644 });
    }
  }
}
