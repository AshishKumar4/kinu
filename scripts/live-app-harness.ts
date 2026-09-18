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
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@kinu.run/test-utils';
import type { Subprocess } from 'bun';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { holdForRelease } from '../packages/test-utils/src/scratch';
import { signalGroup } from './process-group';

const REPO = join(import.meta.dir, '..');

const CF = join(REPO, 'packages', 'cf-backend');

/** The route's JSON answer, parsed as a value rather than passed as unknown.
 *  A non-ok answer throws with its body: a live-app caller that gets HTML
 *  where it expected JSON has hit the app, not the API, and the text says so. */
export async function apiJson(origin: string, path: string, init?: RequestInit): Promise<JsonValue> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${String(response.status)}: ${text.slice(0, 200)}`);

  return text ? parseJsonValue(text) : null;
}

const WorkspaceEntrySchema = v.object({ name: v.string() });

/** Create a workspace through the app's own route; the name it answers with is
 *  the one the URL takes, which is not always the one asked for. */
export async function createWorkspace(
  origin: string, name: string, purpose: string, model: string,
): Promise<string> {
  const created = v.parse(
    WorkspaceEntrySchema,
    await apiJson(origin, '/api/user/workspaces', {
      method: 'POST', body: JSON.stringify({ name, purpose, model }),
    }),
  );

  return created.name;
}

export interface LiveApp {
  readonly browser: Browser;
  /** A page with no clock, as in the gallery harness. */
  newPage(): Promise<Page>;
  /** `http://127.0.0.1:<port>` — this run's dev server. */
  readonly origin: string;
}

function chromePath(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
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

  // Secrets reach workerd from .dev.vars on disk — a fresh worktree has none —
  // or from process.env when the flag is on (wrangler: CLOUDFLARE_INCLUDE_
  // PROCESS_ENV defaults false, and then a secret only ever binds from a
  // file). The flag is how the loaded vars become bindings without copying
  // .dev.vars into the worktree.
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true';

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

/** Boot vite dev, launch the browser, run `body`, tear both down entirely. */
export async function withLiveApp<T>(body: (app: LiveApp) => Promise<T>, options: LiveAppOptions = {}): Promise<T> {
  if (options.port === 3000) throw new Error('withLiveApp: port 3000 is reserved');

  const requested = options.port ?? 0;

  let port = requested;

  if (requested === 0) {
    // Listen on :0, take the kernel's pick, let it go — the chosen number is
    // then handed to vite's own --strictPort bind a beat later.
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, close() {}, error() {} } });

    port = probe.port;
    probe.stop(true);
  }

  const output: string[] = [];

  const child = Bun.spawn(
    ['bun', 'x', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: CF,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ...liveAppEnv(), ...options.env },
      // setsid, so vite leads its own process group: teardown can signal the
      // workerd children with it rather than orphaning them to systemd
      // (deploy.sh:357-362 — this accumulation OOM-killed the box once).
      detached: true,
    },
  );

  // Resolved once the browser is up; held from here so a row killed during
  // the dev server's own boot still lets vite go.
  let browserGroup: number | undefined;

  const held = holdForRelease('the live app and its browser', () => {
    // Both groups, in one hold, because both of this row's heavy children
    // leave its process group: vite leads its own (setsid, above) and
    // puppeteer spawns Chrome detached. A killed row leaks whichever it is
    // not told to end, and under `bun test` this is the ONLY teardown that
    // runs — the preload's signal listener releases and then ends the process
    // inside its own re-raise, so neither `finally` below ever opens
    // (scripts/test-scratch-home.ts; gallery-harness.ts says the same).
    signalGroup(child.pid, 'SIGTERM');
    signalGroup(browserGroup, 'SIGTERM');
    signalGroup(child.pid, 'SIGKILL');
    signalGroup(browserGroup, 'SIGKILL');
  });

  try {
    const origin = await waitForDevServer(child, port, output);
    const executablePath = chromePath();

    const launchOptions: LaunchOptions = {
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
        ...(options.browserArgs ?? []),
      ],
      protocolTimeout: 0,
    };

    if (executablePath) launchOptions.executablePath = executablePath;
    const browser = await puppeteer.launch(launchOptions);
    browserGroup = browser.process()?.pid;

    const newPage = async (): Promise<Page> => {
      const page = await browser.newPage();

      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(0);

      return page;
    };

    try {
      return await body({ browser, newPage, origin });
    } finally {
      signalGroup(browserGroup, 'SIGTERM');
      await browser.close();
      signalGroup(browserGroup, 'SIGKILL');
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
