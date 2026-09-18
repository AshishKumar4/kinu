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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';

const REPO = join(import.meta.dir, '..');

const CF = join(REPO, 'packages', 'cf-backend');

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

export interface LiveAppOptions {
  /** Port for vite dev. Reserved 3000 is refused; 0 picks an ephemeral port. */
  readonly port?: number;
  /** Extra args appended to the puppeteer launch (default lane disables WebGPU etc). */
  readonly browserArgs?: string[];
  /** Environment for the dev child (tokens the container registry needs). */
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
      env: { ...process.env, ...options.env },
    },
  );

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

    const newPage = async (): Promise<Page> => {
      const page = await browser.newPage();

      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(0);

      return page;
    };

    try {
      return await body({ browser, newPage, origin });
    } finally {
      await browser.close();
    }
  } finally {
    child.kill(9);
    await child.exited;
  }
}
