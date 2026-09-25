/**
 * The live-app harness: the real product (vite dev = real Worker in workerd,
 * real Durable Objects, real client) in a real browser, for whoever asks.
 *
 * Sibling of gallery-harness.ts, not its replacement: the gallery serves a
 * FROZEN pre-built bundle with fixtures answering /api/*. This harness boots
 * `vite dev` in packages/cf-backend as a child process, so every response is
 * the product itself. Same puppeteer setup (clockless waits, desktop pointer),
 * same teardown-everything shape.
 *
 * No wall-clock waits anywhere: the dev server is awaited on the port it
 * answers `/api/health` on, racing the child's own exit, and every page wait is
 * a condition. Port 3000 is reserved, so the caller names a port or takes an
 * ephemeral one and the harness reads the actual port back.
 *
 * Nothing of the box carries into a run: every boot persists its Durable
 * Objects into a state directory minted for it, never the checkout's
 * `.wrangler/state` (`statePath` below).
 */

import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@kinu.run/test-utils';
import type { Subprocess } from 'bun';
import type { Browser, Page } from 'puppeteer';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { holdForRelease, releaseScratch, scratchDir } from '../packages/test-utils/src/scratch';
import { declaredSettings } from './browser-declarations';
import { signalGroup } from './process-group';
import { withTestChrome } from './test-chrome';
import { devPreviewTlsDir } from '../packages/cf-backend/vite-preview-zone';

const REPO = join(import.meta.dir, '..');

const CF = join(REPO, 'packages', 'cf-backend');

// A caller that is a script rather than a `bun test` row has no preload
// `afterAll` to release this run's scratch — the state directory each boot
// mints below would outlive it. Registered once for the module, not once per
// boot: eleven boots would be eleven listeners. gallery-harness does the same
// at its own single mint.
process.once('exit', releaseScratch);

/** The dev server's own output, by origin, for as long as `withLiveApp` holds
 *  that server up. A 500 out of the Worker is printed by vite as `Internal
 *  server error:` and its stack, on a stream this harness was reading only to
 *  decide whether the boot failed — so a request that failed AFTER the boot
 *  used to leave a bare status behind and the one account of why it failed in
 *  a buffer nobody read. */
const devServerOutput = new Map<string, readonly string[]>();

/** What the dev server said about the last failure it served. The LAST block
 *  is this request's: the harness runs one row at a time against its own
 *  server. */
function serverAccount(origin: string): string {
  const log = devServerOutput.get(origin)?.join('') ?? '';
  const at = log.lastIndexOf('Internal server error');

  if (at < 0) return '';

  return `\n--- vite dev said ---\n${log.slice(at).split('\n').slice(0, 20).join('\n')}`;
}

/** The route's JSON answer, parsed as a value rather than passed as unknown.
 *  A non-ok answer throws with its WHOLE body and the dev server's account of
 *  it: a live-app caller that gets HTML where it expected JSON has hit the
 *  app, not the API, and a 500 carries the worker's own error. */
export async function apiJson(origin: string, path: string, init?: RequestInit): Promise<JsonValue> {
  const headers = new Headers(init?.headers);

  if (!headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await fetch(`${origin}${path}`, { ...init, headers });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} -> ${String(response.status)}: ${text}${serverAccount(origin)}`,
    );
  }

  return text ? parseJsonValue(text) : null;
}

const WorkspaceEntrySchema = v.object({ name: v.string() });

/** What the app's workspace-create route takes: `name` is the URL name asked
 *  for, `displayName` the title the sidebar shows when it differs. */
export interface WorkspaceRequest {
  readonly name: string;
  readonly purpose: string;
  readonly model: string;
  readonly displayName?: string;
}

/** Create a workspace through the app's own route; the name it answers with is
 *  the one the URL takes, which is not always the one asked for. */
export async function createWorkspace(origin: string, request: WorkspaceRequest): Promise<string> {
  const created = v.parse(
    WorkspaceEntrySchema,
    await apiJson(origin, '/api/user/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        name: request.name, purpose: request.purpose, model: request.model,
        displayName: request.displayName,
      }),
    }),
  );

  return created.name;
}

const RosterPageSchema = v.object({
  entries: v.array(WorkspaceEntrySchema), nextCursor: v.nullable(v.string()),
});

/** Every workspace name on the caller's own roster, paged through the
 *  route's own cursor. */
export async function listWorkspaces(origin: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;

  do {
    const page: v.InferOutput<typeof RosterPageSchema> = v.parse(
      RosterPageSchema,
      await apiJson(origin, `/api/user/workspaces${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`),
    );

    names.push(...page.entries.map((entry) => entry.name));
    cursor = page.nextCursor;
  } while (cursor !== null);

  return names;
}

/** Remove a workspace through the app's own route — the same DELETE the
 *  sidebar's Remove control issues. */
export async function deleteWorkspace(origin: string, name: string): Promise<void> {
  await apiJson(origin, `/api/user/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export interface LiveApp {
  readonly browser: Browser;
  /** A page with no clock, as in the gallery harness. */
  readonly newPage: () => Promise<Page>;
  /** `http://127.0.0.1:<port>` — this run's dev server. */
  readonly origin: string;
  /** The directory this run's Durable Objects, KV and R2 live in: a scratch
   *  root minted for this boot, never the checkout's. The plugin writes its
   *  `v3/do/<namespace>` tree under it. */
  readonly statePath: string;
}

/** Wait until the dev server ANSWERS its port — the banner line is decoration
 *  here, not a gate: under the Cloudflare plugin it prints only after the
 *  worker's remote-connection phase, which can lag the live listener by
 *  minutes on a cold machine. The stream pump still runs, because it carries
 *  the failure signal (`error when starting dev server`) and the output kept
 *  for the error report. A refused connection is the expected not-yet state;
 *  anything else propagates. */
async function waitForDevServer(child: Subprocess<'ignore', 'pipe', 'pipe'>, port: number, output: string[]): Promise<string> {
  const failed = Promise.withResolvers<never>();
  void child.exited.then(
    () => failed.reject(new Error(`vite dev exited before ready: ${output.slice(-10).join('\n')}`)),
    (...rejection: [unknown]) => failed.reject(rejection[0]),
  );

  // Bun's piped stdout is a WHATWG stream, not an emitter: readers feed the
  // output buffer below, and a torn stream fails the wait it was feeding.
  const pump = (stream: ReadableStream<Uint8Array>, label: string): void => {
    const reader = stream.getReader();

    const next = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) return;
        onData(Buffer.from(value), label);
        next();
      }).catch(() => failed.reject(new Error(`vite dev ${label} went unreadable before ready`)));
    };

    next();
  };

  const onData = (chunk: Buffer, _label: string): void => {
    output.push(chunk.toString());

    if (/error when starting dev server/u.test(output.join('\n'))) {
      failed.reject(new Error(`vite dev refused to start: ${output.slice(-15).join('\n')}`));
    }
  };

  pump(child.stdout, 'stdout');
  pump(child.stderr, 'stderr');

  const up = (async (): Promise<string> => {
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);

        if (response.ok) return `http://127.0.0.1:${String(port)}`;
      } catch (cause) {
        if (!(cause instanceof TypeError || cause instanceof DOMException)) throw cause;
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();

  return Promise.race([up, failed.promise]);
}

/** The key=value lines of a .dev.vars file, merged left to right. Only
 *  process-env ABSENT keys are supplied: an explicit export always wins, and
 *  nothing the shell already provides is shadowed by a file. */
function loadDevVars(paths: readonly string[]) {
  const env: Record<string, string> = {};

  for (const path of paths) {
    if (!existsSync(path)) continue;

    const text = readFileSync(path, 'utf8');

    for (const line of text.split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());

      if (match === null) continue;

      const [, key, value] = match;

      if (key === undefined || value === undefined) continue;

      if (process.env[key] !== undefined) continue;

      env[key] = value;
    }
  }

  return env;
}

/** The worktree's own `.dev.vars` files first (checkout-local wins), then the
 *  primary checkout's root and cf-backend `.dev.vars` — where the
 *  containers-registry token and CREDENTIAL_ENCRYPTION_KEY live — resolved
 *  through `git worktree list` row one, never a literal path. vite dev needs
 *  these in PROCESS env for the container registry; wrangler's own secret
 *  injection does not cover that check (measured 2026-09-17: dev exits "error
 *  when starting dev server" without CLOUDFLARE_API_TOKEN), and the boot's
 *  credential path 503s without the cf-backend file plus CLOUDFLARE_INCLUDE_
 *  PROCESS_ENV below. */
function liveAppEnv() {
  const primary = /^worktree (.+)$/mu.exec(git(REPO, 'worktree', 'list', '--porcelain'))?.[1];

  const env = loadDevVars([
    join(REPO, '.dev.vars'),
    join(REPO, 'packages', 'cf-backend', '.dev.vars'),
    ...(primary !== undefined
      ? [join(primary, '.dev.vars'), join(primary, 'packages', 'cf-backend', '.dev.vars')]
      : []),
  ]);

  // Secrets reach workerd from packages/cf-backend/.dev.vars when the checkout
  // has one, and only then from that file; else from process.env when the flag
  // is on (wrangler getVarsForDev; CLOUDFLARE_INCLUDE_PROCESS_ENV defaults
  // false). The flag is how a worktree without the file binds the vars loaded
  // above without copying .dev.vars into it.
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true';

  // The Drive signs its listing cursors with JWT_SECRET and is unbound without
  // one (drive/tenant.ts `driveBound`: every Drive route answers 503). .dev.vars
  // carries none, and nothing durable is sealed with it (infra-manifest.ts), so
  // a boot on its own state gets its own, bound as a var by vite.config.ts: a
  // checkout that has packages/cf-backend/.dev.vars (the primary, and a clone
  // that links it) makes wrangler read secrets from that file alone, and one
  // handed through process env never binds (sweep-0924d, 2026-09-24).
  env.KINU_DEV_JWT_SECRET = randomBytes(32).toString('base64');

  return env;
}

export interface LiveAppOptions {
  /** Port for vite dev. Reserved 3000 is refused; 0 picks an ephemeral port. */
  readonly port?: number;
  /** Extra args appended to the puppeteer launch (default lane disables WebGPU etc). */
  readonly browserArgs?: string[];
  /** Extra environment for the dev child, over the `.dev.vars` this loads. */
  readonly env?: Record<string, string | undefined>;
}

/** One booted dev server: the product on loopback, on state minted for it. */
export interface DevServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** See {@link LiveApp.statePath}. */
  readonly statePath: string;
  /** The https port its preview zone answers on (vite-preview-zone.ts). */
  readonly previewPort: number;
}

/** The desktop viewport every browser row reads at: the inspector column, its
 *  separator and the rail lane exist above 900px (`INSPECTOR_WIDE_QUERY`), and
 *  puppeteer's own default page is 800x600, where the column is a mobile pane. */
export const DESKTOP = { width: 1440, height: 900 } as const;

/** The one certificate a browser row trusts beyond the system's: the local
 *  dev preview zone's (vite-preview-zone.ts), pinned by its public key, and
 *  none when this checkout has never served the zone. */
function devPreviewTrust(): string[] {
  const cert = join(devPreviewTlsDir(CF), 'cert.pem');

  if (!existsSync(cert)) return [];

  const key = new X509Certificate(readFileSync(cert)).publicKey.export({ type: 'spki', format: 'der' });

  return [`--ignore-certificate-errors-spki-list=${createHash('sha256').update(key).digest('base64')}`];
}

/** A free loopback port: listen on :0, take the kernel's pick, let it go. */
function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, close() {}, error() {} } });
  const { port } = probe;

  probe.stop(true);

  return port;
}

/** Boot vite dev, run `body` against it, tear it down entirely. */
export async function withDevServer<T>(body: (server: DevServer) => Promise<T>, options: LiveAppOptions = {}): Promise<T> {
  if (options.port === 3000) throw new Error('withDevServer: port 3000 is reserved');

  // 0 or unset: the kernel's pick, handed to vite's own --strictPort bind a beat later.
  const port = options.port === undefined || options.port === 0 ? freePort() : options.port;

  const output: string[] = [];

  // This boot's OWN Durable Object state. Without it the Cloudflare plugin
  // persists into `packages/cf-backend/.wrangler/state`, the checkout's one
  // directory: every run on the box shares it, it outlives every schema
  // change made since it was written, and genesis is locked with no column
  // reconcile — so a table it holds from before a column existed makes the
  // first route naming that column answer 500 (`no such column:
  // delete_pending`, the deploy wave at 419c31bdc, while the same file was
  // green from a fresh worktree). A tier reads the product, never the box's
  // leftovers. Released with the rest of this run's scratch.
  const statePath = scratchDir('live-app-state');
  const previewPort = freePort();

  const child = Bun.spawn(
    ['bun', 'x', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: CF,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      // `KINU_DEV_STATE_DIR` is read by packages/cf-backend/vite.config.ts and
      // handed to the plugin as `persistState.path`; `options.env` cannot
      // reach it, a caller asking for the checkout's state is asking for the
      // defect this directory exists to end.
      env: {
        ...process.env, ...liveAppEnv(), ...options.env,
        KINU_DEV_STATE_DIR: statePath,
        // Its own optimizer cache, kept across the harness's boots of this checkout and never `bun run dev`'s.
        KINU_DEV_CACHE_DIR: join(CF, '.vite-harness'),
        // The preview zone's own https port, so boots side by side never share one.
        KINU_DEV_PREVIEW_PORT: String(previewPort),
        // And no Workers inspector, whose default port every boot would race for (vite.config.ts).
        KINU_DEV_INSPECTOR: 'off',
      },
      // setsid, so vite leads its own process group: teardown can signal the
      // workerd children with it rather than orphaning them to systemd
      // (deploy.sh:357-362 — this accumulation OOM-killed the box once).
      detached: true,
    },
  );

  // Under `bun test` this is the ONLY teardown that runs when a row is killed:
  // the preload's signal listener releases and then ends the process inside
  // its own re-raise, so the `finally` below never opens
  // (scripts/test-scratch-home.ts; gallery-harness.ts says the same).
  const held = holdForRelease('the live app dev server', () => {
    signalGroup(child.pid, 'SIGTERM');
    signalGroup(child.pid, 'SIGKILL');
  });

  try {
    const origin = await waitForDevServer(child, port, output);

    // From here, a failing request can quote the server that failed it.
    devServerOutput.set(origin, output);

    try {
      return await body({ origin, statePath, previewPort });
    } finally {
      devServerOutput.delete(origin);
    }
  } finally {
    held();
    // The group, not just vite: workerd outlives a lone-parent kill. SIGTERM
    // first so the Cloudflare plugin's own shutdown runs; SIGKILL is the
    // backstop for a group that never took it. An already-exited group raises
    // ESRCH, an expected absence here.
    signalGroup(child.pid, 'SIGTERM');
    await child.exited;
    signalGroup(child.pid, 'SIGKILL');
  }
}

/** A browser row's Chrome, with a desktop pointer and colour scheme declared, for the length of `body`. */
export async function withBrowser<T>(body: (browser: Browser) => Promise<T>, extraArgs: readonly string[] = []): Promise<T> {
  return withTestChrome(body, { args: [declaredSettings({ mouse: true }), ...devPreviewTrust(), ...extraArgs] });
}

/** Boot vite dev, launch the browser, run `body`, tear both down entirely. */
export async function withLiveApp<T>(body: (app: LiveApp) => Promise<T>, options: LiveAppOptions = {}): Promise<T> {
  return withDevServer(({ origin, statePath }) => withBrowser((browser) => {
    const newPage = async (): Promise<Page> => {
      const page = await browser.newPage();

      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(0);

      return page;
    };

    return body({ browser, newPage, origin, statePath });
  }, options.browserArgs), options);
}
