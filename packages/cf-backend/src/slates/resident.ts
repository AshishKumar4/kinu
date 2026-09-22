import * as v from 'valibot';
import { FACET_IMAGE_DIR, facetImageDigest, facetImagePath } from '@nimbus-sh/fabric/process-fabric.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { CRED_KERNEL, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ComposedFacetManager, LongRunningWorkerSpawnOptions } from '@nimbus-sh/worker/workspace-host';
import type { WorkspaceSession } from '@kinu.run/core/workspace';
import { SLATE_METHOD_NAME_SOURCE, type SlateProcess, type SlateProject } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import slateVendor from 'virtual:kinu-slate-vendor';
import { slateCredentialKey } from './bindings';
import { SLATE_CLIENT_MODULE, SLATE_SERVER_MODULE } from '@kinu.run/core/slates';

export interface SlateBootArtifacts {
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
  session: () => Promise<Pick<WorkspaceSession, 'vfs' | 'processes'>>;
  /** Every resident spawn goes through its `spawnWorker` and every teardown through its `kill`. */
  facetManager: () => Promise<ComposedFacetManager>;
}

export interface ResidentSlateBoot {
  readonly key: string;
  /** The slate id, independent of source revision and process incarnation. */
  readonly owner: string;
  readonly root: string;
  readonly project: SlateProject;
  /** Set for the durable application (reserved port, owner-pinned facet whose SQLite persists); null spawns a private ephemeral process. */
  readonly app: { readonly port: number } | null;
  /** Whose file plane compiles the authored tree: the caller's, never the origin's on its behalf. */
  readonly cred: VfsCred;
  readonly bindings: Readonly<Record<string, Fetcher>>;
  /** The caller's explicitly selected network capability; never implicit inheritance. */
  readonly globalOutbound: Fetcher | null;
}

/** Written only when the bytes differ, so a start never churns the file ledger. */
const RUNTIME_FILES = {
  'server.js': SLATE_SERVER_MODULE,
  'react-stub.js': slateVendor.reactStub,
} as const;

const RUNTIME_DIR = '/usr/lib/kinu/slate';

const MAIN_MODULE = 'runner.js';

const APPLICATION_MODULE = 'application.js';

/** The generated `runner.js`; exported because its contract (a re-created instance starts before it serves) is asserted on the text. */
export function slateRunnerSource(assets: readonly { readonly path: string; readonly contents: string }[], shell: string | undefined): string {
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
    // `__storage` needs no lineage, so it always passes the root invocation.
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
    // `__storage` and `__host` are reserved; string env values (`PORT`, `NIMBUS_APP`) are not bindings.
    '    const env = {};',
    '    for (const [name, stub] of Object.entries(this.env)) {',
    '      if (name === "__storage" || name === "__host" || typeof stub !== "object") continue;',
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

export class ResidentSlateProcesses {
  private readonly bundlers = new Map<string, EsbuildService>();
  /** Image digests per pid that a sweep must keep; a manager-driven restart reads these paths again. */
  private readonly imagesInUse = new Map<number, ReadonlySet<string>>();

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

    let serverEntry = `${input.root}/${main}`;

    if (browser === main) {
      // Re-export only the class so the file's client half never reaches the server bundle.
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
      // Not `alias`: the nimbus-vfs resolver sees a specifier before esbuild applies it.
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
        external: ['react', 'react-dom/client', 'react/jsx-runtime', 'capnweb', 'kinu:slate'],
        tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }),
      });

      if (client.errors.length !== 0) throw new KinuError('bad_input', client.errors.map((error) => error.text).join('\n'));
      assets = client.outputFiles;
      shell = slateShell({ title: input.project.slate.title ?? input.project.name ?? 'slate', assets });
    }

    const modules = {
      [MAIN_MODULE]: slateRunnerSource(assets, shell),
      [APPLICATION_MODULE]: rewriteModuleSpecifiers(application.contents),
      'capnweb.js': slateVendor.capnwebWorkers,
      'server.js': SLATE_SERVER_MODULE,
      'react-stub.js': slateVendor.reactStub,
      'vendor.js': `export const react = ${JSON.stringify(slateVendor.react)};\nexport const capnweb = ${JSON.stringify(slateVendor.capnweb)};\nexport const slateClient = ${JSON.stringify(SLATE_CLIENT_MODULE)};\n`,
    };

    // Non-main modules travel by content-addressed VFS path; the loader verifies bytes against the digest.
    const images: Record<string, string> = {};
    const textModules: Record<string, string> = {};
    kernelVfs.mkdir(`/${FACET_IMAGE_DIR}`, { recursive: true, mode: 0o755 });

    for (const [name, contents] of Object.entries(modules)) {
      const digest = await facetImageDigest(contents);
      const path = facetImagePath(digest);

      if (!kernelVfs.exists(path)) kernelVfs.writeFile(path, contents, { mode: 0o644 });
      images[name] = digest;

      if (name !== MAIN_MODULE) textModules[name] = path;
    }

    const manager = (await this.deps.facetManager()).manager;

    const launch: LongRunningWorkerSpawnOptions = {
      mainModule: MAIN_MODULE,
      compatibilityDate: '2025-12-01',
      compatibilityFlags: ['nodejs_compat'],
      vfsTextModules: textModules,
      env: input.bindings,
      globalOutbound: input.globalOutbound,
    };

    if (input.app !== null) {
      const runner = images[MAIN_MODULE];
      const applicationImage = images[APPLICATION_MODULE];

      if (runner === undefined) throw new KinuError('io', `Slate boot produced no ${MAIN_MODULE} image`);

      if (applicationImage === undefined) throw new KinuError('io', `Slate boot produced no ${APPLICATION_MODULE} image`);
      launch.port = input.app.port;
      launch.durable = { owner: input.owner, image: { runner, application: applicationImage } };
    }

    const spawned = await manager.spawnWorker(modules[MAIN_MODULE], `slate ${slateId}`, input.root, launch);

    const pid = spawned.pid;
    const refusal = v.safeParse(StartedResult, spawned.boot);
    const surface = v.safeParse(StartedSurface, spawned.boot);

    if (!surface.success) {
      manager.kill(pid);

      if (refusal.success) throw new KinuError('bad_input', refusal.output.error);
      throw new KinuError('io', 'Slate runner returned a boot result without a method list');
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

    const artifacts: SlateBootArtifacts = { application: modules[APPLICATION_MODULE] };
    const clientBundle = assets.find((asset) => asset.path === '/__kinu/client.js');

    if (shell !== undefined && clientBundle !== undefined) {
      artifacts.client = clientBundle.contents;
      artifacts.shell = shell;
    }

    // Nothing else sweeps these images (fabric sweeps only its own), and every source edit writes a new one.
    this.imagesInUse.set(pid, new Set(Object.values(images)));
    this.sweepFacetImages(kernelVfs);

    return {
      id: String(pid), port: input.app?.port ?? null, methods, artifacts,
      request: (request) => spawned.facet.fetch(request),
      connect: (request) => spawned.facet.connect(request),
      isRunning: async () => session.processes.get(pid)?.state === 'running',
      stop: async () => { manager.kill(pid); this.imagesInUse.delete(pid); },
    };
  }

  private sweepFacetImages(kernelVfs: ReturnType<WorkspaceSession['vfs']['as']>): void {
    const keep = new Set<string>();

    for (const digests of this.imagesInUse.values()) for (const digest of digests) keep.add(facetImagePath(digest));

    for (const entry of kernelVfs.readdir(`/${FACET_IMAGE_DIR}`)) {
      const path = `/${FACET_IMAGE_DIR}/${entry.name}`;

      if (entry.type === 'file' && !keep.has(path)) kernelVfs.unlink(path);
    }
  }

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
