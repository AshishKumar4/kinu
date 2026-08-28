/**
 * Which React runtime the SHIPPED client artifact contains, and which dispatcher
 * the browser installs when it runs.
 *
 * KINU-082 asks two questions that no source read can answer. `vite.config.ts`
 * declares no `resolve.dedupe`, and the application and the Agents UI reach
 * React through different dependency paths, so the audit could not rule out two
 * React module identities in one page. A second identity is not a style
 * complaint: `useAgent` would read a dispatcher its own React copy never had,
 * and every hook crossing the boundary would throw.
 *
 * So this file measures the ARTIFACT, twice over, and never our own source text.
 *
 * BUILD HALF. It runs the client build the deploy path runs — `scripts/deploy.sh`
 * step 2 is a bare `vite build` in `packages/cf-backend`, with no `CLOUDFLARE_ENV`
 * for production — through Vite's own API against the repository's own
 * `vite.config.ts`, and adds one observer plugin that records the emitted chunk
 * graph. Building is not deploying: nothing is uploaded and both output trees are
 * deleted when the run ends.
 *
 * The graph names REACT'S OWN FILES. React ships `cjs/react.production.js` and
 * `cjs/react.development.js` as separate files, so the emitted module ids decide
 * both questions at once: how many React runtimes are in the artifact, and which
 * build each one is. No string guessing decides the verdict.
 *
 * RUNTIME HALF. A build assertion proves what shipped. The finding is about the
 * DISPATCHER, so the built assets are served over a local socket and driven in
 * real Chromium. React reports its own identity to the DevTools hook — bundleType,
 * version, and `currentDispatcherRef`, which IS the React copy's shared internals
 * object. The probe installs a recording hook before any document script runs,
 * then counts injected renderers, distinct dispatcher refs, and reads and writes
 * of the dispatcher slot. Writes come from react-dom, reads come from react: both
 * above zero on ONE object means the two packages share one React identity.
 *
 * The Agents UI is driven, not assumed. `/workspace/<id>` mounts `useAgent`, and
 * `agents/dist/client.js` opens `ws://.../agents/<class>/<name>`. The local server
 * records that upgrade, so the socket is the proof the Agents-side hooks really
 * ran against the same dispatcher.
 *
 * RED. The last describe block builds the same graph with React forced to its
 * development build and asserts every production predicate rejects it. A probe
 * that cannot fail decides nothing.
 *
 * This suite builds the whole client graph, so a half-finished edit anywhere in
 * the imported tree fails it as a build error rather than a verdict. That is the
 * same property `scripts/deploy.sh` step 2 has.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';
import { renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  build, type BuildEnvironmentOptions, type InlineConfig, type Plugin,
} from 'vite';

// The build under test, from the config the deploy path uses. Imported rather
// than named by path: see `buildClient`.
import clientConfig from '../packages/cf-backend/vite.config';

const REPO = join(import.meta.dir, '..');
const CF = join(REPO, 'packages', 'cf-backend');
/** Both output trees sit under `packages/cf-backend/dist/`, which that package's
 *  own `.gitignore` already covers, so a run adds nothing to a shared tree's
 *  status. `afterAll` deletes them. */
const PRODUCTION_OUT = 'dist/react-runtime-identity-probe';
const DEVELOPMENT_OUT = 'dist/react-runtime-identity-probe-dev';

const require = createRequire(import.meta.url);
const REACT_PACKAGES = ['react', 'react-dom', 'scheduler'] as const;

/** One emitted chunk of the client artifact, as the bundler wrote it. */
interface Chunk {
  readonly fileName: string;
  readonly isEntry: boolean;
  /** Statically imported chunk file names. A static import shares one module
   *  instance, which is what makes "the React chunk" an identity claim. */
  readonly imports: readonly string[];
  /** Resolved absolute module ids the chunk holds. */
  readonly modules: readonly string[];
}

/** What one built artifact is, measured from its own graph and its own bytes. */
interface Artifact {
  readonly chunks: readonly Chunk[];
  /** React-package module ids in the graph, package-relative. */
  readonly reactModules: readonly string[];
  /** Those of them that are React's development files. */
  readonly developmentModules: readonly string[];
  /** Chunks holding `react/cjs/react.*.js`. More than one is more than one
   *  React runtime identity in one artifact. */
  readonly reactChunks: readonly string[];
  /** Chunks holding `agents/dist/react.js` — the Agents UI hook module. */
  readonly agentsChunks: readonly string[];
  /** React's own development-only warning texts found in the emitted JS. */
  readonly developmentMarkers: readonly string[];
  /** How much emitted JS the marker scan actually read. An empty marker list
   *  means nothing shipped only if these are above zero. */
  readonly scannedFiles: number;
  readonly scannedBytes: number;
}

/** What the browser reported about React's identity in one page. */
interface RuntimeFacts {
  readonly renderers: readonly ReactRendererFacts[];
  /** Distinct `currentDispatcherRef` objects: one per React copy that a
   *  renderer bound to. */
  readonly dispatcherRefs: number;
  /** Distinct dispatcher objects written into the slot. */
  readonly dispatchers: number;
  /** Of those, how many really carry a `useState` member. */
  readonly dispatchersWithUseState: number;
  /** Writes come from react-dom. */
  readonly writes: number;
  /** Reads come from react's own `resolveDispatcher`. */
  readonly reads: number;
  readonly commits: number;
  readonly resources: readonly string[];
  readonly pageErrors: readonly string[];
}

/** React's self-description, exactly as it hands it to the DevTools hook. */
interface ReactRendererFacts {
  /** 0 production, 1 development. React's own constant, not our inference. */
  readonly bundleType: number;
  readonly version: string;
  readonly rendererPackageName: string;
  readonly reconcilerVersion: string;
}

/**
 * The dispatcher React installs in its `H` slot: the hook implementations for
 * the current render phase.
 *
 * `useState` is declared because React's own client dispatchers all carry it,
 * and the probe PROVES that rather than trusting it — every dispatcher written
 * into the slot is checked for the member, so an arbitrary object landing there
 * reddens instead of passing as a dispatcher. Its call signature is not declared
 * because the probe never invokes a hook.
 */
interface ReactDispatcher {
  readonly useState: unknown;
}

/** The React copy's shared internals. `H` is the hooks dispatcher slot. */
interface DispatcherRef {
  H: ReactDispatcher | null;
}

interface ReactInternals {
  readonly bundleType: number;
  readonly version: string;
  readonly rendererPackageName: string;
  readonly reconcilerVersion: string;
  readonly currentDispatcherRef: DispatcherRef;
}

/** What the installed hook accumulates in the page. */
interface ProbeState {
  readonly injects: ReactRendererFacts[];
  readonly refs: DispatcherRef[];
  readonly dispatchers: ReactDispatcher[];
  /** How many of the recorded dispatchers really expose a `useState` member.
   *  Equal to `dispatchers.length` or the slot held something that is not one. */
  dispatchersWithUseState: number;
  reads: number;
  writes: number;
  commits: number;
}

interface DevToolsHook {
  readonly supportsFiber: boolean;
  readonly isDisabled: boolean;
  readonly renderers: Map<number, ReactInternals>;
  inject(internals: ReactInternals): number;
  onCommitFiberRoot(): void;
  onPostCommitFiberRoot(): void;
  onCommitFiberUnmount(): void;
  getFiberRoots(): Set<unknown>;
  checkDCE(): void;
}

declare global {
  var __kinuReactProbe: ProbeState | undefined;
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: DevToolsHook | undefined;
}

/** React's `cjs` directory for one package, as the install really resolves it. */
function reactDistDir(pkg: string): string {
  return join(dirname(require.resolve(`${pkg}/package.json`)), 'cjs');
}

/** The version the install really carries, read from the package's own manifest
 *  rather than from a range in `package.json`. Parsed at the boundary: a
 *  manifest is external JSON, so its shape is decided by the schema and not by
 *  a runtime shape check. */
const ManifestSchema = v.object({ version: v.string() });

function installedVersion(pkg: string): string {
  const manifest = require.resolve(`${pkg}/package.json`);
  return v.parse(ManifestSchema, JSON.parse(readFileSync(manifest, 'utf8'))).version;
}

/** String literals of at least `min` characters. Minification renames bindings
 *  and drops whitespace; it does not rewrite string contents, so a literal is
 *  the one thing that survives from React's dist into the bundle unchanged. */
function literals(source: string, min: number): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/"((?:[^"\\\n]|\\.){1,400})"/g)) {
    const text = match[1];
    if (text !== undefined && text.length >= min) found.add(text);
  }
  return found;
}

/**
 * React's development-only texts, derived from React's own dist files rather
 * than recalled.
 *
 * Every literal in a `*.development.js` file of react, react-dom or scheduler
 * that appears in NONE of their production or profiling files. The 40-character
 * floor is what makes the set trustworthy: short literals such as `SuspenseList`
 * are dev-only in one file and shipped in another, while a 40-character React
 * warning sentence has no other possible author.
 */
function developmentMarkers(): readonly string[] {
  const MIN = 40;
  const development = new Set<string>();
  const shipped = new Set<string>();
  for (const pkg of REACT_PACKAGES) {
    const dir = reactDistDir(pkg);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const target = file.endsWith('.development.js') ? development : shipped;
      for (const text of literals(readFileSync(join(dir, file), 'utf8'), MIN)) target.add(text);
    }
  }
  const markers = [...development].filter((text) => !shipped.has(text));
  if (markers.length === 0) throw new Error('derived no development-only marker from React\'s dist');
  return markers;
}

const MARKERS = developmentMarkers();

/**
 * Build the client artifact and record its emitted graph.
 *
 * The repository's own `vite.config.ts` is imported and passed inline with
 * `configFile: false`. Vite's file loader bundles a config into
 * `node_modules/.vite-temp/` and re-imports it by path, and under Bun that path
 * resolves through the shared `node_modules` symlink into a sibling worktree, so
 * the loader cannot find what it just wrote. Importing the module directly gives
 * the same exported config object, side effects included, and keeps the whole
 * build in this process.
 *
 * `forceDevelopmentReact` is the RED lever and the only intended difference from
 * the deploy path: React's entry files branch on `process.env.NODE_ENV`, so
 * defining it as development selects React's development dist.
 *
 * `copyPublicDir` is off because the public tree is a 70 MB symlinked
 * runtime-asset directory that no module in the graph imports. The JS this probe
 * measures is byte-identical either way.
 */
async function buildClient(outDir: string, forceDevelopmentReact: boolean): Promise<Artifact> {
  const chunks: Chunk[] = [];
  const observer: Plugin = {
    name: 'kinu:react-runtime-identity-observer',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks.push({
          fileName,
          isEntry: output.isEntry,
          imports: [...output.imports],
          modules: Object.keys(output.modules),
        });
      }
    },
  };
  // `bun test` injects NODE_ENV=test, and Vite derives its own
  // `process.env.NODE_ENV` replacement from the ambient value. Left alone, the
  // test runner would decide which React build the artifact under test holds,
  // and the production assertion below would be measuring the runner. The
  // deploy shell exports no NODE_ENV, so for the length of the build neither
  // does this one.
  const inherited = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  // The two development levers are ADDED rather than spread-when-true, so the
  // production arm passes the deploy path's own options and nothing else.
  const buildOptions: BuildEnvironmentOptions = {
    ...clientConfig.build, outDir, copyPublicDir: false,
  };
  const overrides: InlineConfig = { ...clientConfig, configFile: false, root: CF, logLevel: 'error' };
  if (forceDevelopmentReact) {
    buildOptions.minify = false;
    overrides.define = { ...clientConfig.define, 'process.env.NODE_ENV': '"development"' };
  }
  try {
    await build({
      ...overrides,
      plugins: [...(clientConfig.plugins ?? []), observer],
      build: buildOptions,
    });
  } finally {
    if (inherited !== undefined) process.env.NODE_ENV = inherited;
  }
  if (chunks.length === 0) throw new Error(`${outDir}: the build emitted no chunk`);

  // The marker scan's own extent, carried as a measured fact rather than left
  // implicit. `developmentMarkers: []` reads identically for "no development
  // text shipped" and "the scan read no bytes at all", so without these two the
  // production arm could pass while measuring nothing.
  const assetsDir = join(CF, outDir, 'client', 'assets');
  const scanned = readdirSync(assetsDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(assetsDir, file), 'utf8'));
  const emitted = scanned.join('\n');

  const reactModules: string[] = [];
  const reactChunks: string[] = [];
  const agentsChunks: string[] = [];
  for (const chunk of chunks) {
    for (const id of chunk.modules) {
      // Package-relative, so a failure names `react/cjs/react.production.js`
      // rather than an absolute path that differs per checkout.
      const parts = id.split('node_modules/');
      const relative = parts[parts.length - 1] ?? id;
      if (/^(react|react-dom|scheduler)\//.test(relative)) reactModules.push(relative);
      if (/^react\/cjs\/react\.[a-z]+\.js$/.test(relative) && !reactChunks.includes(chunk.fileName)) {
        reactChunks.push(chunk.fileName);
      }
      if (relative === 'agents/dist/react.js' && !agentsChunks.includes(chunk.fileName)) {
        agentsChunks.push(chunk.fileName);
      }
    }
  }
  return {
    chunks,
    reactModules,
    developmentModules: reactModules.filter((id) => id.endsWith('.development.js')),
    reactChunks,
    agentsChunks,
    developmentMarkers: MARKERS.filter((marker) => emitted.includes(marker)),
    scannedFiles: scanned.length,
    scannedBytes: emitted.length,
  };
}

/** What the artifact server declares for the five kinds of file the built client
 *  actually holds. A switch rather than a lookup table: the extensions are a
 *  closed set the build emits, and an open dictionary would state otherwise. */
function contentType(file: string): string {
  switch (extname(file)) {
    case '.js': return 'text/javascript';
    case '.css': return 'text/css';
    case '.html': return 'text/html';
    case '.svg': return 'image/svg+xml';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/** The shape `server.address()` takes once it is a bound TCP socket. */
const TcpAddressSchema = v.object({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
});

/** One built artifact served over a kernel-assigned port, with the WebSocket
 *  upgrades it receives recorded. Port 0 is bound in the same syscall that
 *  selects it, so a concurrent worktree cannot claim this run's port. */
interface Origin {
  readonly origin: string;
  readonly upgrades: readonly string[];
  close(): void;
}

async function serveArtifact(outDir: string): Promise<Origin> {
  const root = join(CF, outDir, 'client');
  const upgrades: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://artifact.invalid').pathname;
    // No worker is running. Answering /api/* as JSON keeps the application on
    // its signed-out path instead of feeding it the SPA shell as a JSON body.
    if (path.startsWith('/api/')) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'no worker behind this probe' }));
      return;
    }
    let file = join(root, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', contentType(file));
    response.end(readFileSync(file));
  });
  // Recorded, then refused. The Agents client only needs to ATTEMPT the socket
  // for its hooks to have run; a handshake would need the Durable Object.
  server.on('upgrade', (request, socket) => {
    upgrades.push(request.url ?? '');
    socket.destroy();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  // `address()` answers a pipe name, a TCP record or null. Parsed rather than
  // shape-checked, the same way `gallery-harness.ts` reads its own port.
  const address = v.safeParse(TcpAddressSchema, server.address());
  if (!address.success) {
    server.close();
    throw new Error(`${outDir}: the artifact server has no TCP address after listen`);
  }
  return {
    origin: `http://127.0.0.1:${String(address.output.port)}`,
    upgrades,
    close: () => { server.close(); },
  };
}

/**
 * Record React's own identity report, before any document script runs.
 *
 * React looks for `__REACT_DEVTOOLS_GLOBAL_HOOK__` at module init and hands it
 * `bundleType`, `version` and `currentDispatcherRef`. Wrapping the `H` slot of
 * that ref in an accessor is what separates the two packages: react-dom WRITES
 * the dispatcher, react's `resolveDispatcher` READS it. Both counters above zero
 * on one object is the runtime statement that react and react-dom are one
 * identity.
 */
function installProbe(): void {
  const state: ProbeState = {
    injects: [], refs: [], dispatchers: [],
    dispatchersWithUseState: 0, reads: 0, writes: 0, commits: 0,
  };
  globalThis.__kinuReactProbe = state;
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(internals) {
      state.injects.push({
        bundleType: internals.bundleType,
        version: internals.version,
        rendererPackageName: internals.rendererPackageName,
        reconcilerVersion: internals.reconcilerVersion,
      });
      const ref = internals.currentDispatcherRef;
      if (!state.refs.includes(ref)) {
        state.refs.push(ref);
        let held = ref.H;
        Object.defineProperty(ref, 'H', {
          configurable: true,
          get() {
            state.reads += 1;
            return held;
          },
          set(next: ReactDispatcher | null) {
            state.writes += 1;
            if (next !== null && !state.dispatchers.includes(next)) {
              state.dispatchers.push(next);
              // Evidence that the slot really holds a hooks dispatcher, taken
              // from the object's own key list rather than from a shape check.
              if (Object.keys(next).includes('useState')) state.dispatchersWithUseState += 1;
            }
            held = next;
          },
        });
      }
      return state.injects.length;
    },
    onCommitFiberRoot() { state.commits += 1; },
    onPostCommitFiberRoot() { /* not measured */ },
    onCommitFiberUnmount() { /* not measured */ },
    getFiberRoots() { return new Set(); },
    checkDCE() { /* the production dist calls this; nothing to check here */ },
  };
}

async function readRuntime(browser: Browser, origin: string, path: string): Promise<RuntimeFacts> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (thrown) => pageErrors.push(renderThrownChain({ cause: thrown })));
  try {
    await page.evaluateOnNewDocument(installProbe);
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle0', timeout: 120_000 });
    const measured = await page.evaluate(() => {
      const state = globalThis.__kinuReactProbe;
      if (state === undefined) throw new Error('the probe hook never installed');
      return {
        renderers: state.injects,
        dispatcherRefs: state.refs.length,
        dispatchers: state.dispatchers.length,
        dispatchersWithUseState: state.dispatchersWithUseState,
        writes: state.writes,
        reads: state.reads,
        commits: state.commits,
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      };
    });
    return { ...measured, pageErrors };
  } finally {
    await page.close();
  }
}

function chromePath(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function launch(): Promise<Browser> {
  const executablePath = chromePath();
  const options: LaunchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (executablePath !== undefined) options.executablePath = executablePath;
  return puppeteer.launch(options);
}

/** Every react and react-dom resolution the lockfile records. A key of
 *  `<parent>/react` is a nested copy, which is the multi-identity risk the
 *  finding names; a bare `react` key is the single hoisted one. */
function lockedReactResolutions(): readonly string[] {
  const lock = readFileSync(join(REPO, 'bun.lock'), 'utf8');
  const resolutions: string[] = [];
  for (const match of lock.matchAll(/"([^"\n]*)":\s*\["(react|react-dom)@([^"\n]+)"/g)) {
    resolutions.push(`${match[1] ?? ''} -> ${match[2] ?? ''}@${match[3] ?? ''}`);
  }
  return resolutions.sort();
}

const HOME = '/';
const WORKSPACE = '/workspace/react-runtime-identity-probe';
const LANDING = '/landing.html';

let production: Artifact;
let developmentBuild: Artifact;
let home: RuntimeFacts;
let workspace: RuntimeFacts;
let landing: RuntimeFacts;
let developmentHome: RuntimeFacts;
let agentSockets: readonly string[];
const REACT_VERSION = installedVersion('react');
const REACT_DOM_VERSION = installedVersion('react-dom');

beforeAll(async () => {
  production = await buildClient(PRODUCTION_OUT, false);
  developmentBuild = await buildClient(DEVELOPMENT_OUT, true);
  const browser = await launch();
  try {
    const served = await serveArtifact(PRODUCTION_OUT);
    try {
      home = await readRuntime(browser, served.origin, HOME);
      workspace = await readRuntime(browser, served.origin, WORKSPACE);
      landing = await readRuntime(browser, served.origin, LANDING);
      agentSockets = served.upgrades.filter((url) => url.startsWith('/agents/'));
    } finally {
      served.close();
    }
    const servedDevelopment = await serveArtifact(DEVELOPMENT_OUT);
    try {
      developmentHome = await readRuntime(browser, servedDevelopment.origin, HOME);
    } finally {
      servedDevelopment.close();
    }
  } finally {
    await browser.close();
  }
}, 900_000);

afterAll(() => {
  for (const outDir of [PRODUCTION_OUT, DEVELOPMENT_OUT]) {
    rmSync(join(CF, outDir), { recursive: true, force: true });
  }
});

describe('the shipped client artifact holds one React runtime', () => {
  test('exactly one React runtime module is emitted, and it is the production build', () => {
    const runtimes = production.reactModules.filter((id) => /^react\/cjs\/react\.[a-z]+\.js$/.test(id));
    expect(runtimes).toEqual(['react/cjs/react.production.js']);
    expect(production.reactChunks.length).toBe(1);
  });

  test('every React-package module in the graph is a production file', () => {
    expect(production.developmentModules).toEqual([]);
    expect([...production.reactModules].sort()).toEqual([
      'react-dom/cjs/react-dom-client.production.js',
      'react-dom/cjs/react-dom.production.js',
      'react-dom/client.js',
      'react-dom/index.js',
      'react/cjs/react-jsx-runtime.production.js',
      'react/cjs/react.production.js',
      'react/index.js',
      'react/jsx-runtime.js',
      'scheduler/cjs/scheduler.production.js',
      'scheduler/index.js',
    ]);
  });

  test('one react-dom reconciler is emitted, so one renderer can exist', () => {
    const reconcilers = production.reactModules.filter((id) => id.startsWith('react-dom/cjs/react-dom-client.'));
    expect(reconcilers).toEqual(['react-dom/cjs/react-dom-client.production.js']);
  });

  test('React\'s own development-only texts do not survive into the emitted JS', () => {
    // The scan's extent is asserted beside its result. Without this, a scan that
    // read no bytes and a bundle that shipped no development text are the same
    // observable, and this arm would pass forever on either.
    expect(production.scannedFiles).toBeGreaterThan(0);
    expect(production.scannedBytes).toBeGreaterThan(100_000);
    expect(production.developmentMarkers).toEqual([]);
  });
});

describe('the application and the Agents UI share that one runtime', () => {
  test('the Agents UI hook module is bundled and reaches React by static import', () => {
    expect(production.agentsChunks.length).toBeGreaterThan(0);
    const reactChunk = production.reactChunks[0];
    expect(reactChunk).toBeDefined();
    for (const fileName of production.agentsChunks) {
      const chunk = production.chunks.find((candidate) => candidate.fileName === fileName);
      expect(chunk).toBeDefined();
      // Either the Agents module sits in the React chunk itself, or it imports
      // it statically. Both share one module instance; a dynamic boundary or a
      // second React chunk would not.
      const shared = fileName === reactChunk || (chunk?.imports.includes(reactChunk ?? '') ?? false);
      expect(shared).toBe(true);
    }
  });

  test('every entry chunk reaches the same React chunk', () => {
    const reactChunk = production.reactChunks[0] ?? '';
    const entries = production.chunks.filter((chunk) => chunk.isEntry);
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.imports).toContain(reactChunk);
    }
  });

  test('the lockfile records one react and one react-dom resolution, with no nested copy', () => {
    expect(lockedReactResolutions()).toEqual([
      `react -> react@${REACT_VERSION}`,
      `react-dom -> react-dom@${REACT_DOM_VERSION}`,
    ]);
  });
});

describe('the browser installs one production dispatcher', () => {
  const pages = (): readonly [string, RuntimeFacts][] => [
    [HOME, home], [WORKSPACE, workspace], [LANDING, landing],
  ];

  test('each page injects exactly one renderer, and React calls it production', () => {
    for (const [path, facts] of pages()) {
      expect({ path, renderers: facts.renderers }).toEqual({
        path,
        renderers: [{
          bundleType: 0,
          version: REACT_DOM_VERSION,
          rendererPackageName: 'react-dom',
          reconcilerVersion: REACT_DOM_VERSION,
        }],
      });
    }
  });

  test('each page holds exactly one React dispatcher ref', () => {
    for (const [path, facts] of pages()) {
      expect({ path, refs: facts.dispatcherRefs }).toEqual({ path, refs: 1 });
    }
  });

  test('react-dom writes the dispatcher and react reads the same slot', () => {
    for (const [path, facts] of pages()) {
      // Writes come from react-dom, reads from react. Both above zero on ONE
      // recorded ref is the statement that the two packages are one identity.
      expect({
        path,
        writesAboveZero: facts.writes > 0,
        readsAboveZero: facts.reads > 0,
        dispatchersAboveZero: facts.dispatchers > 0,
        commitsAboveZero: facts.commits > 0,
      }).toEqual({
        path,
        writesAboveZero: true,
        readsAboveZero: true,
        dispatchersAboveZero: true,
        commitsAboveZero: true,
      });
    }
  });

  test('every object written into the slot is really a hooks dispatcher', () => {
    for (const [path, facts] of pages()) {
      // Without this, "a dispatcher was installed" would be satisfied by any
      // object at all, and the slot accessor would be measuring itself.
      expect({ path, recorded: facts.dispatchers, withUseState: facts.dispatchersWithUseState })
        .toEqual({ path, recorded: facts.dispatchers, withUseState: facts.dispatchers });
      expect(facts.dispatchers).toBeGreaterThan(0);
    }
  });

  test('no page throws while rendering through that dispatcher', () => {
    for (const [path, facts] of pages()) {
      expect({ path, errors: facts.pageErrors }).toEqual({ path, errors: [] });
    }
  });

  test('the Agents UI hooks really ran: the workspace opened an agent socket', () => {
    expect(agentSockets.length).toBeGreaterThan(0);
    const chunk = production.agentsChunks[0] ?? '';
    expect(workspace.resources.some((url) => url.endsWith(chunk))).toBe(true);
  });
});

describe('the probe rejects a development artifact', () => {
  test('the development build emits React\'s development files', () => {
    expect(developmentBuild.developmentModules.length).toBeGreaterThan(0);
    const runtimes = developmentBuild.reactModules.filter((id) => /^react\/cjs\/react\.[a-z]+\.js$/.test(id));
    expect(runtimes).toEqual(['react/cjs/react.development.js']);
  });

  test('the development build carries React\'s development-only texts', () => {
    expect(developmentBuild.developmentMarkers.length).toBeGreaterThan(0);
  });

  test('the development build reports bundleType 1 at runtime', () => {
    expect(developmentHome.renderers.map((renderer) => renderer.bundleType)).toEqual([1]);
  });
});
