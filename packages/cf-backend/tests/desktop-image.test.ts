// D70: in the real image, a click in KasmVNC's own client crosses the Worker's desktop route and the box's into
// Chromium on the desktop, and the screen shows it; the framed client can open no socket to another origin.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { desktopClientUrl, withAppSecurityHeaders } from '@kinu.run/core';
import { withTestChrome } from '../../../scripts/test-chrome';
import { KASMVNC_CLIENT } from '../../../scripts/kasmvnc-client';
// Relative paths, not `@kinu.run/devbox`: the barrel reaches `cloudflare:workers`, which does not exist under bun.
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../devbox/src/lifecycle';
import { BROWSER_WINDOW, buildToolsImage, removeBlockImage } from '../../devbox/tests/support/block-image';
import { Devbox, harness } from '../../devbox/tests/support/devbox-harness';
import { dockerContainer, inContainer } from '../../devbox/tests/support/docker-container';
import { DEVBOX_SCRATCH_PREFIX } from '../../devbox/tests/support/scratch';
import { serveFamily } from './helpers/api';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import type { TerminalSandbox, TerminalWorkspace } from '../src/terminal-route';

// `agents` reaches `cloudflare:email`: mock first, then the dynamic import.
mockAgentsSdk();

const { terminalRoutes } = await import('../src/terminal-route');

const name = `kinu-desktop-${process.pid}`;

const WORKSPACE = 'w';

class DesktopBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** One end of the runtime's `WebSocketPair`, which bun lacks: what one end sends, the other receives. */
class PairEnd extends EventTarget {
  peer: PairEnd | undefined;
  binaryType = 'arraybuffer';
  #open = true;

  accept(): void {}

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    const peer = this.peer;
    queueMicrotask(() => peer?.dispatchEvent(new MessageEvent('message', { data })));
  }

  close(code = 1000, reason = ''): void {
    if (!this.#open) return;
    this.#open = false;
    const peer = this.peer;
    queueMicrotask(() => peer?.dispatchEvent(Object.assign(new Event('close'), { code, reason })));
  }
}

/** Every pair the bridge makes, so the edge below can carry the visitor's end to the browser. */
const pairs: [PairEnd, PairEnd][] = [];

Object.assign(globalThis, {
  WebSocketPair: class {
    constructor() {
      const ends: [PairEnd, PairEnd] = [new PairEnd(), new PairEnd()];
      [ends[0].peer, ends[1].peer] = [ends[1], ends[0]];
      pairs.push(ends);

      return { 0: ends[0], 1: ends[1] };
    }
  },
});

const HANDSHAKE = new Set(['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']);

/** Bun's client to the published port, as the runtime's socket a port's upgrade answers with. */
async function portSocket(port: string, request: Request): Promise<Response> {
  // Bun's client sends the box's headers, which the browser's constructor type does not name; it makes the handshake's own.
  const socket: WebSocket = Reflect.construct(WebSocket, [`ws://127.0.0.1:${port}${new URL(request.url).pathname}`, {
    headers: Object.fromEntries([...request.headers].filter(([key]) => !HANDSHAKE.has(key))),
    protocols: (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((part) => part.trim()).filter(Boolean),
  }]);

  socket.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  const runtime = {
    accept: () => undefined, binaryType: 'arraybuffer',
    send: (data: ArrayBuffer | string) => { socket.send(data); },
    close: (code: number, reason: string) => { socket.close(code, reason); },
    addEventListener: (type: string, listener: EventListener) => { socket.addEventListener(type, listener); },
  };

  return Object.assign(new Response(null), { webSocket: runtime });
}

const TYPES = new Map([['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml']]);

/** Chromium's page in the box: the whole screen, red, turning blue on a click. */
const PAGE = '<body style="margin:0"><div style="width:100vw;height:100vh;background:#c00" onclick="this.style.background=\'#00c\'"></div></body>';

let scratch = '';

let published = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}desktop-`));
  buildToolsImage(name, scratch);
  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--publish', '127.0.0.1::6080', name, 'sleep', 'infinity'], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
  published = spawnSync('docker', ['port', name, '6080/tcp'], { encoding: 'utf8' }).stdout.trim().split(':').at(-1) ?? '';
});

afterAll(() => {
  spawnSync('docker', ['rm', '-f', name]);
  removeBlockImage(name);
  rmSync(scratch, { recursive: true, force: true });
});

test('a click in the framed client reaches Chromium on the desktop through both routes, and the screen shows it', async () => {
  const container = dockerContainer(name);
  const { box, container: fake } = harness(DesktopBox, undefined, (argv, options) => container.exec(argv, options));
  fake.portAnswer = (_port, request) => portSocket(published, request);
  await box.devboxStartup();

  const workspace = jsrpcStub<TerminalWorkspace>({
    prepareTerminal: async () => ({ ok: true as const }),
    fetch: () => { throw new Error('the workspace lane is not driven here'); },
    openDeviceTerminal: () => { throw new Error('the device lane is not driven here'); },
  });

  const sandbox = jsrpcStub<TerminalSandbox>({
    fetch: (request) => box.fetch(request), noteTerminalActivity: () => box.noteTerminalActivity(), resetShell: () => box.resetShell(),
  });

  const route = serveFamily(terminalRoutes(() => ({
    resolveWorkspace: async () => workspace,
    resolveSandbox: () => sandbox,
    UserDO: { idFromName: () => { throw new Error('no device lane here'); }, get: () => { throw new Error('no device lane here'); } },
  })), { workspace: { name: WORKSPACE }, ctx: { waitUntil: () => undefined } });

  const edge = Bun.serve<{ readonly visitor: PairEnd }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url);

      if (url.pathname === `/api/workspaces/${WORKSPACE}/desktop`) {
        const answer = await route(request, {});

        if (answer?.status !== 101) return answer ?? new Response('no route', { status: 404 });
        const visitor = pairs.at(-1)?.[0];

        if (visitor === undefined) return new Response('no bridge', { status: 500 });

        return server.upgrade(request, { headers: { 'sec-websocket-protocol': 'binary' }, data: { visitor } }) ? undefined : new Response('no upgrade', { status: 500 });
      }

      if (url.pathname === '/') return new Response(`<iframe src="${desktopClientUrl(url, WORKSPACE)}" style="width:1280px;height:800px;border:0"></iframe>`, { headers: { 'content-type': 'text/html' } });
      const file = Bun.file(join(KASMVNC_CLIENT, url.pathname.slice('/kasmvnc/'.length)));

      if (!url.pathname.startsWith('/kasmvnc/') || !(await file.exists())) return new Response('not found', { status: 404 });
      const type = TYPES.get(extname(url.pathname)) ?? 'application/octet-stream';

      return withAppSecurityHeaders(new Response(file, { headers: { 'content-type': type } }), url, null);
    },
    websocket: {
      open: (socket) => {
        socket.data.visitor.addEventListener('message', (event) => { if (event instanceof MessageEvent) socket.send(event.data); });
        socket.data.visitor.addEventListener('close', () => { socket.close(); });
      },
      message: (socket, data) => { socket.data.visitor.send(data); },
      close: (socket) => { socket.data.visitor.close(1000, 'client gone'); },
    },
  });

  try {
    const outcome = await withTestChrome(async (browser) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(0);
      await page.setViewport({ width: 1300, height: 820 });
      await page.goto(`http://127.0.0.1:${String(edge.port)}/`);
      const frame = await (await page.waitForSelector('iframe'))?.contentFrame();

      if (frame == null) throw new Error('the client was not framed');

      // Until the client's largest canvas shows the colour at the screen's centre; then where on the page that is.
      const shows = async (colour: 'red' | 'blue') => (await frame.waitForFunction((want) => {
        const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];

        if (canvas === undefined || canvas.width < 640) return null;
        const [r = 0, , b = 0] = canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data ?? [];
        const rect = canvas.getBoundingClientRect();

        return (want === 'red' ? r > 150 && b < 80 : b > 150 && r < 80) && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, { polling: 'raf' }, colour)).jsonValue();

      inContainer(name, ['bash', '-c', 'printf %s "$1" > /tmp/page.html', 'page', PAGE]);
      const opened = inContainer(name, ['bash', '-c', BROWSER_WINDOW('file:///tmp/page.html')]);

      if (opened.status !== 0) throw new Error(`the desktop's browser did not open: ${opened.stderr}`);
      const red = await shows('red');

      if (red === null || red === false) throw new Error('the red screen was not found');
      const clicked = performance.now();
      await page.mouse.click(red.x + 10, red.y + 10);
      await shows('blue');
      const ms = Math.round(performance.now() - clicked);

      // The client's own settings name the socket's host; the document's policy is what refuses another one.
      const elsewhere = await frame.evaluate(() => new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) => { resolve(event.violatedDirective); }, { once: true });
        new WebSocket('ws://elsewhere.example/websockify', ['binary']).addEventListener('open', () => { resolve('opened'); });
      }));

      return { ms, elsewhere };
    });

    console.log(`[desktop-image] click to screen ${String(outcome.ms)} ms`);
    expect(outcome.elsewhere).toBe('connect-src');
  } finally {
    await edge.stop(true);
    await box.destroy();
  }
});
