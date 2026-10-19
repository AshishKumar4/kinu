/**
 * The Environment's own desktop client (KasmVNC's, `public/kasmvnc`) draws a PC's screen as the daemon serves it, and
 * the owner's pointer and keys reach the PC (1014-t). The daemon's RFB server is the one it runs, over a fixed screen;
 * the server here stands where the hub does, stripping and adding the tunnel's stream header as the hub relays.
 */
import { afterAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as v from 'valibot';
import { desktopClientUrl, readScreenData } from '@kinu.run/core';
import { launchTestChrome } from '../../scripts/test-chrome';

/** The daemon's screen module, CommonJS as the daemon runs it, read at its boundary. */
const ScreenModuleSchema = v.object({ createScreens: v.function() });

const ScreensSchema = v.object({ open: v.function(), receive: v.function(), closed: v.function() });

const { createScreens } = v.parse(ScreenModuleSchema, createRequire(import.meta.url)('../../packages/pc-agent/src/daemon/screen.js'));

const CLIENT = join(import.meta.dir, '../../packages/cf-backend/public');

const STREAM = 41;

const WIDTH = 320;

const HEIGHT = 200;

/** Four quadrants, each its own colour, so a frame drawn in the wrong channel order or place shows. */
const QUADRANTS = [
  { r: 0xe0, g: 0x30, b: 0x30 }, { r: 0x30, g: 0xe0, b: 0x30 },
  { r: 0x30, g: 0x30, b: 0xe0 }, { r: 0xf0, g: 0xd0, b: 0x20 },
] as const;

function quadrantScreen(): Uint8Array {
  const raw = new Uint8Array(WIDTH * HEIGHT * 4);

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const fill = QUADRANTS[(y < HEIGHT / 2 ? 0 : 2) + (x < WIDTH / 2 ? 0 : 1)];

      raw.set([fill.b, fill.g, fill.r, 0], (y * WIDTH + x) * 4);
    }
  }

  return raw;
}

const input: string[] = [];

/** A frame as a screen source hands it to the daemon: BGRX pixels and the serial that says it is new. */
interface RawFrame {
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  readonly raw: Uint8Array;
}

const source = {
  desktop: () => ({ state: 'ready', width: WIDTH, height: HEIGHT }),
  async open({ onFrame }: { onFrame: (frame: RawFrame) => void }) {
    onFrame({ serial: 1, width: WIDTH, height: HEIGHT, raw: quadrantScreen() });

    return {
      width: WIDTH, height: HEIGHT, name: 'studio',
      key: (down: boolean, keysym: number) => { input.push(`key ${down ? 'down' : 'up'} ${keysym.toString(16)}`); },
      pointer: (mask: number, x: number, y: number) => { if (mask !== 0) input.push(`pointer ${String(mask)} ${String(x)},${String(y)}`); },
      close: () => { input.push('closed'); },
    };
  },
};

type Viewer = Bun.ServerWebSocket<undefined>;

let viewer: Viewer | null = null;

const screens = v.parse(ScreensSchema, createScreens({ source, log: () => {} }));

/** The daemon's socket, as the hub's far end: each screen data frame reaches the viewer without its header. */
const daemonSocket = {
  send(data: string | Uint8Array) {
    if (typeof data === 'string') return;
    const frame = readScreenData(data);

    if (frame !== null) viewer?.send(frame.bytes);
  },
};

const server = Bun.serve<undefined>({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request, serving) {
    const path = new URL(request.url).pathname;

    if (path === '/api/workspaces/studio-work/devices/dev-mac/desktop') {
      return serving.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'binary' } }) ? undefined : new Response('no upgrade', { status: 400 });
    }

    const file = Bun.file(join(CLIENT, path));

    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      viewer = ws;
      screens.open(STREAM, daemonSocket);
    },
    message(_ws, message) {
      screens.receive(STREAM, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message));
    },
    close() { screens.closed(STREAM); },
  },
});

const chrome = await launchTestChrome();

afterAll(async () => {
  await chrome.close();
  await server.stop(true);
});

test("the desktop client draws a PC's screen as the daemon serves it, and the owner's pointer and keys reach the PC", async () => {
  const page = await chrome.browser.newPage();

  await page.setViewport({ width: 800, height: 600 });
  await page.goto(`http://127.0.0.1:${String(server.port)}${desktopClientUrl({ protocol: 'http:', hostname: '127.0.0.1', port: String(server.port) }, 'studio-work', 'dev-mac')}`);

  // The client sizes its canvas to the screen once ServerInit arrives, and draws the first frame into it.
  const screen = `[...document.querySelectorAll('canvas')].find((canvas) => canvas.width === ${String(WIDTH)} && canvas.height === ${String(HEIGHT)})`;

  await page.waitForFunction(`(() => {
    const canvas = ${screen};
    if (!canvas) return false;
    const [r, g, b] = canvas.getContext('2d').getImageData(${String(WIDTH * 3 / 4)}, ${String(HEIGHT * 3 / 4)}, 1, 1).data;
    return r + g + b > 0;
  })()`, { timeout: 20_000 });

  const drawn = await page.evaluate(`(() => {
    const context = ${screen}.getContext('2d');
    return [[80, 50], [240, 50], [80, 150], [240, 150]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  })()`);

  expect(drawn).toEqual(QUADRANTS.map((fill) => [fill.r, fill.g, fill.b]));

  // A click on the screen's top-right quadrant, and a key, in the screen's own coordinates.
  const box = await (await page.evaluateHandle(screen)).asElement()?.boundingBox();

  if (!box) throw new Error('the client drew no canvas');
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
  await page.keyboard.press('a');

  for (let turn = 0; turn < 200 && !input.some((said) => said.startsWith('key up')); turn += 1) {
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(resolve))');
  }

  const click = input.find((said) => said.startsWith('pointer 1 '))?.split(' ')[2]?.split(',').map(Number);

  expect({
    clickInTopRight: click !== undefined && click[0] >= WIDTH / 2 && click[1] < HEIGHT / 2,
    keys: input.filter((said) => said.startsWith('key')),
  }).toEqual({ clickInTopRight: true, keys: ['key down 61', 'key up 61'] });
});
