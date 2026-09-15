import * as v from 'valibot';
import { ContentRef } from '@agent-core/core';
import type { ContentStore } from '@agent-core/core/content';
import { processes, type ResidentFacetEnv } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { facetImagePath, facetImagePathDigest, type ProcessHostParams, type ResidentBootSpec } from '@nimbus-sh/fabric/process-fabric.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { CRED_KERNEL, type RouteableFacetTarget, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { WorkspaceSession } from '@kinu.run/core/workspace';
import { SLATE_METHOD_NAME_SOURCE, type SlateProcess, type SlateProject } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import slateVendor from 'virtual:kinu-slate-vendor';
import { slateCredentialKey } from './bindings';
import { SLATE_CLIENT_MODULE, SLATE_SERVER_MODULE } from '@kinu.run/core/slates';
import { acquireDurableFacetSlot } from '../nimbus-programmatic';

/** The bundle texts a booted slate serves — `client` and `shell` only when
 *  the slate declares a browser surface. */
export interface SlateBootArtifacts {
  application: string;
  client?: string;
  shell?: string;
}

export interface ResidentSlateProcess extends SlateProcess {
  /** The port the durable application listens on; null for a caller's private process, which is reached by RPC alone. */
  readonly port: number | null;
  request(request: Request): Promise<Response>;
  /** The browser's WebSocket upgrade against the process's own entrypoint. */
  connect(request: Request): Promise<Response>;
  /** The method names `startProcess` published — the forwarder's allow list. */
  readonly methods: readonly string[];
  readonly artifacts: Readonly<SlateBootArtifacts>;
}

export interface ResidentSlateDeps {
  readonly ctx: DurableObjectState;
  readonly env: ResidentFacetEnv;
  readonly workspace: string;
  readonly content: ContentStore;
  session(): Promise<Pick<WorkspaceSession, 'vfs' | 'processes'>>;
  registerPort(pid: number, port: number, target: RouteableFacetTarget, owner: string): Promise<void>;
  unregisterPorts(pid: number): void;
}

export interface ResidentSlateBoot {
  readonly key: string;
  /** Logical identity independent of source revision and process incarnation: the slate id. */
  readonly owner: string;
  readonly root: string;
  readonly project: SlateProject;
  /**
   * Set when this process IS the slate's durable application: it binds the
   * reserved port and boots into the facet pinned for the owner, whose SQLite
   * is kept across every launch. Null spawns a private process — no port, an
   * ephemeral facet wiped on release.
   */
  readonly app: { readonly port: number } | null;
  /** Whose file plane compiles the authored tree: the caller's, never the origin's on its behalf. */
  readonly cred: VfsCred;
  readonly bindings: Readonly<Record<string, Fetcher>>;
  /** The caller's explicitly selected network capability; never implicit inheritance. */
  readonly globalOutbound: Fetcher | null;
}

/** Kernel-owned runtime files every slate's VFS holds, written only when the
 *  bytes differ so a start never churns the file ledger. */
const RUNTIME_FILES = {
  'server.js': SLATE_SERVER_MODULE,
  'react-stub.js': slateVendor.reactStub,
} as const;

const RUNTIME_DIR = '/usr/lib/kinu/slate';

/** The ES module text of `runner.js`, the dynamic worker's main module. Its
 *  `vfsTextModules` siblings — `application.js`, `capnweb.js`, `server.js`,
 *  `react-stub.js`, `vendor.js` — arrive content-addressed; only this text
 *  is generated. */
function runner(assets: readonly { readonly path: string; readonly contents: string }[], shell: string | undefined): string {
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
    // The invocation is async context, not a parameter: a binding is a method's
    // to call while the method runs, and only there. `undefined` is "no method
    // running" (module top level, the constructor, a stray timer); `null` is
    // the root lineage the browser socket and uninvoked fetch run under.
    'const invocations = new AsyncLocalStorage();',
    'function bindingProxy(name, stub, needsInvocation) {',
    '  return new Proxy(Object.create(null), {',
    '    get(_target, member) {',
    '      if (typeof member !== "string" || member === "then" || member === "toJSON") return undefined;',
    '      return async (...args) => {',
    '        const invocation = invocations.getStore();',
    '        if (needsInvocation && invocation === undefined) {',
    '          throw new Error(`env.${name}.${member} is called from inside a slate method; there is no invocation to run it under`);',
    '        }',
    '        const result = await stub.call(member, args, invocation ?? null);',
    '        if (!result.ok) throw new SlateRefusal(result);',
    '        return result.value;',
    '      };',
    '    },',
    '  });',
    '}',
    // The reserved `__storage` stub answers the slate's own KV. Storage needs
    // no lineage — the rows are this slate's own either way — so it passes the
    // root invocation always and unwraps the { value } envelope on get.
    'function storageProxy(stub) {',
    '  return Object.freeze({',
    '    get: async (key) => {',
    '      const result = await stub.call("get", [key], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value === null ? undefined : result.value.value;',
    '    },',
    '    put: async (key, value) => {',
    '      const result = await stub.call("put", [key, value], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '    },',
    '    delete: async (key) => {',
    '      const result = await stub.call("delete", [key], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value;',
    '    },',
    '    list: async (options) => {',
    '      const result = await stub.call("list", options === undefined ? [] : [options], null);',
    '      if (!result.ok) throw new SlateRefusal(result);',
    '      return result.value;',
    '    },',
    '  });',
    '}',
    'export class NimbusProcess extends DurableObject {',
    '  #slate;',
    '  #forwarder;',
    '  constructor(ctx, env) { super(ctx, env); }',
    '  async startProcess() {',
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
    // `__storage` is the runner's own handle on the reserved binding, never
    // part of the guest's binding map: the slate reaches it as `this.storage`.
    // `__host` is the process's channel back to its host — likewise reserved.
    '    const env = {};',
    '    for (const [name, stub] of Object.entries(this.env)) {',
    '      if (name === "__storage" || name === "__host") continue;',
    '      env[name] = bindingProxy(name, stub, true);',
    '    }',
    '    const slate = new Slate({',
    '      storage: this.ctx.storage,',
    '      kv: storageProxy(this.env.__storage),',
    '      waitUntil: (work) => this.ctx.waitUntil(work),',
    '    }, Object.freeze(env));',
    '    // The callable surface: prototype methods between the instance and',
    '    // SlateObject (exclusive) whose name passes the host\'s own method rule.',
    '    // Own properties never appear — a closure assigned in the constructor',
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
    '    this.#forwarder = new Proxy(new RpcTarget(), {',
    '      get(target, member) {',
    '        // Symbols and the promise surface pass through to the RpcTarget so',
    '        // capnweb introspection never sees a throwing function.',
    '        if (typeof member !== "string" || member === "then" || member === "toJSON") return Reflect.get(target, member);',
    '        if (!allowed.has(member)) {',
    '          // A member the slate never published refuses at call time, not',
    '          // at lookup — capnweb dispatches on the value.',
    '          if (!(member in target)) return () => { throw new Error("Slate has no method " + member); };',
    '          return Reflect.get(target, member);',
    '        }',
    '        // One hop keeps the invocation of the REQUEST that carries it;',
    '        // outside one — the browser socket — the root lineage applies.',
    '        return (...args) => invocations.run(invocations.getStore() ?? null, () => slate[member](...args));',
    '      },',
    '    });',
    '    return { ok: true, methods: [...allowed] };',
    '  }',
    '  async fetch(request) { return this.handleHttpRequest(request); }',
    '  async handleHttpRequest(request) {',
    '    try {',
    '      return await this.respond(request);',
    '    }',
    '    catch (cause) { return Response.json({ reason: cause instanceof SlateRefusal ? cause.reason : "io", error: errorText(cause) }, { status: 500 }); }',
    '  }',
    '  async respond(request) {',
    '    const url = new URL(request.url);',
    '    const path = url.pathname;',
    '    if (path === "/__rpc") {',
    '      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {',
    // The socket session's invocation rides `x-slate-call` — one invocation,
    // held by this process until `release`, not settled when the 101 returns.
    '        const invocation = request.headers.get("x-slate-call");',
    '        const pair = new WebSocketPair();',
    '        const server = pair[0];',
    '        server.accept();',
    '        server.addEventListener("close", () => {',
    '          if (invocation !== null && this.env.__host !== undefined) this.env.__host.call("release", [invocation], null);',
    '        });',
    '        invocations.run(invocation, () => newWebSocketRpcSession(server, this.#forwarder));',
    '        return new Response(null, { status: 101, webSocket: pair[1] });',
    '      }',
    '      // A POST batch carries the host hop invocation on x-slate-call,',
    '      // already minted — no getStore() round trip.',
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

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The HTML the slate root serves: the import map every external specifier
 *  in the client bundle resolves through, the root element `mount` renders
 *  into, and one link per emitted stylesheet. */
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
    '  <script type="importmap">',
    '    {',
    '      "imports": {',
    '        "react": "/__kinu/react.js",',
    '        "react-dom/client": "/__kinu/react.js",',
    '        "react/jsx-runtime": "/__kinu/react.js",',
    '        "capnweb": "/__kinu/capnweb.js",',
    '        "kinu:slate": "/__kinu/slate.js"',
    '      }',
    '    }',
    '  </script>',
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

async function compileSlate(bundler: EsbuildService, entry: string, options: Parameters<EsbuildService['build']>[1]) {
  try { return await bundler.build([entry], options); }
  catch (cause) {
    if (cause instanceof Error && 'errors' in cause && Array.isArray(cause.errors)) {
      throw new KinuError('bad_input', 'Slate compilation failed', { cause });
    }

    throw cause;
  }
}

/** Where each bare specifier the server bundle keeps lands in the dynamic
 *  worker's module map — map keys must end `.js`, so `kinu:slate` and `react`
 *  cannot be map names; the emitted imports are rewritten onto these paths. */
const SERVER_MODULE_PATHS = {
  'kinu:slate': './server.js',
  'react': './react-stub.js',
  'react-dom/client': './react-stub.js',
  'react/jsx-runtime': './react-stub.js',
  'capnweb': './capnweb.js',
} as const;

/** `startProcess`'s payload: `ok` on boot, `error` when the authored module
 *  fails the class contract, `methods` the callable surface it published. */
const StartedResult = v.object({ ok: v.literal(false), error: v.string() });

const StartedSurface = v.object({ ok: v.literal(true), methods: v.array(v.string()) });

const SPECIFIERS = Object.keys(SERVER_MODULE_PATHS).join('|').replaceAll('/', '\\/');

const STATIC_SPECIFIER = new RegExp(`^(\\s*(?:import|export)\\s[^'"]*?\\bfrom\\s*|import\\s*)(["'])(${SPECIFIERS})\\2`, 'gm');

const DYNAMIC_SPECIFIER = new RegExp(`\\bimport\\(\\s*(["'])(${SPECIFIERS})\\1\\s*\\)`, 'g');

/** Point the application bundle's surviving bare imports at the module-map
 *  paths above. Anchored to statement position so a quoted `kinu:slate` inside
 *  authored data is never rewritten. */
function rewriteModuleSpecifiers(source: string): string {
  // SAFETY: SPECIFIERS is constructed from `Object.keys(SERVER_MODULE_PATHS)`,
  // so the captured group returns only a key of the map.
  return source
    .replace(STATIC_SPECIFIER, (_match, head: string, quote: string, specifier: string) => `${head}${quote}${SERVER_MODULE_PATHS[specifier as keyof typeof SERVER_MODULE_PATHS]}${quote}`)
    .replace(DYNAMIC_SPECIFIER, (_match, quote: string, specifier: string) => `import(${quote}${SERVER_MODULE_PATHS[specifier as keyof typeof SERVER_MODULE_PATHS]}${quote})`);
}

export class ResidentSlateProcesses {
  private readonly bundlers = new Map<string, EsbuildService>();


  constructor(private readonly deps: ResidentSlateDeps) {}

  async start(input: ResidentSlateBoot): Promise<ResidentSlateProcess> {
    const session = await this.deps.session();
    const main = input.project.main;
    const browser = input.project.browser;

    if (main === undefined) {
      throw new KinuError('bad_input', 'package.json main must name the module that exports class Slate extends SlateObject from kinu:slate');
    }

    const bundlerKey = slateCredentialKey(input.cred);
    let bundler = this.bundlers.get(bundlerKey);

    if (bundler === undefined) {
      bundler = new EsbuildService(session.vfs.as(input.cred));
      this.bundlers.set(bundlerKey, bundler);
    }

    this.provisionRuntimeFiles(session);

    // The entries esbuild opens are kernel-generated files under the runtime
    // directory — NEVER inside the slate root, where they would surface in
    // authored listings, snapshots, restores and revision bumps. Absolute
    // imports reach back into the authored tree. The client entry is always
    // generated: it wraps the default export in `mount` even when the same
    // file is main and browser. Named by the slate id — the root's basename.
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

    let serverEntry = `${input.root}/${main}`;

    if (browser === main) {
      // One file authored for both runtimes: the server entry picks out only
      // the class, so the client-only half of that file never reaches the
      // server bundle's class-contract check.
      serverEntry = `${entriesDir}/server.js`;
      provision('server.js', `export { Slate } from "${input.root}/${main}";\n`);
    }

    let clientEntry: string | undefined;

    if (browser !== undefined) {
      clientEntry = `${entriesDir}/client.js`;
      provision('client.js', `import App from "${input.root}/${browser}";\nimport { mount } from "kinu:slate";\nmount(App);\nexport default App;\n`);
    }

    const server = await compileSlate(bundler, serverEntry, {
      bundle: true, format: 'esm', platform: 'neutral', outfile: '/application.js',
      // `kinu:slate`, `react*` and `capnweb` stay imports in the bundle and
      // arrive as same-named dynamic-worker modules — the nimbus-vfs resolver
      // sees a specifier before esbuild ever applies `alias`, so an alias here
      // could never land.
      external: ['cloudflare:*', 'node:*', 'capnweb', 'kinu:slate', 'react', 'react-dom/client', 'react/jsx-runtime'],
      tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }),
    });

    if (server.errors.length !== 0) throw new KinuError('bad_input', server.errors.map((error) => error.text).join('\n'));
    const application = server.outputFiles.find((file) => file.path === '/application.js');

    if (application === undefined) throw new KinuError('io', 'Slate compiler did not produce the server module');
    let assets: typeof server.outputFiles = [];
    let shell: string | undefined;

    if (clientEntry !== undefined) {
      const client = await compileSlate(bundler, clientEntry, {
        bundle: true, format: 'esm', platform: 'browser', outfile: '/__kinu/client.js',
        // `kinu:slate` stays an import in the client bundle; the shell's
        // import map resolves it to /__kinu/slate.js.
        external: ['react', 'react-dom/client', 'react/jsx-runtime', 'capnweb', 'kinu:slate'],
        tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }),
      });

      if (client.errors.length !== 0) throw new KinuError('bad_input', client.errors.map((error) => error.text).join('\n'));
      assets = client.outputFiles;
      shell = slateShell({ title: input.project.slate.title ?? input.project.name ?? 'slate', assets });
    }

    const modules = {
      'runner.js': runner(assets, shell),
      // The application bundle's surviving bare specifiers are rewritten onto
      // these module-map paths — the map's names must end `.js`.
      'application.js': rewriteModuleSpecifiers(application.contents),
      'capnweb.js': slateVendor.capnwebWorkers,
      'server.js': SLATE_SERVER_MODULE,
      'react-stub.js': slateVendor.reactStub,
      'vendor.js': `export const react = ${JSON.stringify(slateVendor.react)};\nexport const capnweb = ${JSON.stringify(slateVendor.capnweb)};\nexport const slateClient = ${JSON.stringify(SLATE_CLIENT_MODULE)};\n`,
    };

    const textModules: Record<string, string> = {};

    for (const [name, contents] of Object.entries(modules)) {
      textModules[name] = facetImagePath((await this.deps.content.put(new TextEncoder().encode(contents))).ref.digest.value);
    }

    const entry = session.processes.spawn(main, [], input.root, { longRunning: true });
    const writerId = crypto.randomUUID();

    const boot: ResidentBootSpec = {
      kind: 'code',
      code: {
        compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js', modules: {},
        vfsTextModules: textModules,
        env: input.bindings,
        globalOutbound: input.globalOutbound,
      },
    };

    const params: ProcessHostParams = { pid: entry.pid, workerKey: input.key, boot, writerId, startArgs: {} };

    // The durable application's facet name is allocated out of this object's
    // storage and pinned for the owner, so `this.sql` re-attaches to the same
    // store on every launch; a released durable facet is aborted, never
    // deleted. An ephemeral facet takes a reused slot and is wiped on release.
    if (input.app !== null) params.facet = { name: await acquireDurableFacetSlot(this.deps.ctx, input.owner), durable: true };

    const process = processes(this.deps.ctx, this.deps.env).spawn(
      () => ({ readFile: async (path) => {
        const digest = facetImagePathDigest(path);

        if (digest === null) throw new KinuError('bad_input', `Invalid facet image path: ${path}`);

        return this.deps.content.get(new ContentRef(`sha256:${digest}`));
      } }),
      { doId: this.deps.workspace, pid: entry.pid, writerId },
      params,
    );

    let methods: readonly string[];

    try {
      // The runner reports the authored surface's contract violation as data,
      // and on success publishes the callable method list the host pre-checks.
      const started = await process.started;
      const refusal = v.safeParse(StartedResult, started);
      const surface = v.safeParse(StartedSurface, started);

      if (refusal.success) {
        throw new KinuError('bad_input', refusal.output.error);
      }

      if (!surface.success) throw new KinuError('io', 'Slate runner returned a boot result without a method list');

      methods = surface.output.methods;
    } catch (cause) {
      session.processes.exit(entry.pid, 1);
      this.deps.unregisterPorts(entry.pid);

      try { await process.release(); }
      catch (releaseCause) { throw new AggregateError([cause, releaseCause], 'Slate boot and process release failed', { cause: releaseCause }); }

      throw cause;
    }

    if (input.app !== null) await this.deps.registerPort(entry.pid, input.app.port, process, input.owner);

    session.processes.setTerminator(entry.pid, () => {
      // The one door a resident's registration leaves by: whoever ends the
      // pid is on the stack here, which is what the event records.
      diagnostics.event('slate.resident.terminated', {
        pid: entry.pid, owner: input.owner, port: input.app?.port ?? 0,
        state: session.processes.get(entry.pid)?.state ?? 'absent',
        by: new Error('resident terminated').stack?.split('\n').slice(2, 8).map((line) => line.trim()).join(' < ') ?? '',
      });
      this.deps.unregisterPorts(entry.pid);
      this.deps.ctx.waitUntil(process.release());
    });

    // The bundle texts this boot serves, so callers can read the real bytes.
    const artifacts: SlateBootArtifacts = { application: modules['application.js'] };
    const clientBundle = assets.find((asset) => asset.path === '/__kinu/client.js');

    if (shell !== undefined && clientBundle !== undefined) {
      artifacts.client = clientBundle.contents;
      artifacts.shell = shell;
    }

    return {
      id: String(entry.pid), port: input.app?.port ?? null, methods, artifacts,
      request: (request) => process.handleHttpRequest(request),
      connect: (request) => process.handleWebSocketRequest(request),
      isRunning: async () => session.processes.get(entry.pid)?.state === 'running',
      stop: async () => {
        await process.release();
        this.deps.unregisterPorts(entry.pid);
        session.processes.exit(entry.pid, 0);
      },
    };
  }

  /** The kernel-owned `kinu:slate` modules every slate's VFS carries. Written
   *  as CRED_KERNEL with fixed modes, only when the bytes differ. */
  private provisionRuntimeFiles(session: Pick<WorkspaceSession, 'vfs' | 'processes'>): void {
    const vfs = session.vfs.as(CRED_KERNEL);

    vfs.mkdir(RUNTIME_DIR, { recursive: true, mode: 0o755 });

    for (const [name, contents] of Object.entries(RUNTIME_FILES)) {
      const path = `${RUNTIME_DIR}/${name}`;

      if (vfs.exists(path) && vfs.readFileString(path) === contents) continue;

      vfs.writeFile(path, contents, { mode: 0o644 });
    }
  }
}
