/**
 * A PC's screen (1014-t) — the daemon's RFB server and its streams, through
 * the daemon's own dispatcher.
 *
 * The viewer here is a few lines of RFB 3.8 written from the specification, so
 * every byte the server sends is checked against what a viewer reads: the
 * handshake, the frame in the pixel format the viewer asked for, a resize, a
 * JPEG frame as Tight, and input reaching the screen source. The stream rules
 * are the hub's contract: one stream at a time, every data frame numbered, and a
 * stream nobody speaks on closed rather than left capturing.
 */
'use strict';

const zlib = require('node:zlib');

const { describe, expect, test } = require('bun:test');

const protocol = require('../src/device-protocol.json');

const { handle } = require('../src/index.js');

const { createScreens, readScreenData } = require('../src/daemon/screen.js');

const { screenDataFrames } = require('../../core/src/execution/device-screen-data.ts');

const STREAM = 7;

/** noVNC's own choice: 32-bit little-endian, red in the low byte. */
const VIEWER_FORMAT = { bitsPerPixel: 32, depth: 24, bigEndian: 0, trueColour: 1, redShift: 0, greenShift: 8, blueShift: 16 };

const ENCODINGS = { raw: 0, tight: 7, desktopSize: -223, lastRect: -224, extendedDesktopSize: -308 };

/** What the daemon wrote to its socket: binary screen data per stream, and JSON frames. */
function fakeWs() {
  const binary = [];
  const json = [];

  return {
    binary,
    json,
    bufferedAmount: 0,
    send(data) {
      if (typeof data === 'string') json.push(JSON.parse(data));
      else binary.push(Buffer.from(data));
    },
    /** Everything sent on `stream`, its frame headers checked and dropped. */
    served(stream) {
      return Buffer.concat(binary.map((frame) => {
        const data = readScreenData(frame);

        expect(data?.stream).toBe(stream);

        return data.bytes;
      }));
    },
  };
}

/** BGRX pixels of one colour, as a source's raw frame holds them. */
function pixels(width, height, { r, g, b }) {
  const raw = Buffer.alloc(width * height * 4);

  for (let at = 0; at < width * height; at += 1) raw.set([b, g, r, 0], at * 4);

  return raw;
}

/** A screen of one colour, which records what the viewer did to it. */
function fixedSource({ width, height, colour }) {
  const calls = [];
  let draw = null;
  let serial = 0;

  const frame = (size, fill) => ({ serial: (serial += 1), width: size.width, height: size.height, raw: pixels(size.width, size.height, fill) });

  return {
    calls,
    desktop: () => ({ state: 'ready', width, height }),
    async open({ onFrame }) {
      draw = onFrame;
      onFrame(frame({ width, height }, colour));
      calls.push(['open']);

      return {
        width, height, name: 'studio',
        key: (down, keysym) => calls.push(['key', down, keysym]),
        pointer: (mask, x, y, wheel) => calls.push(wheel.x === 0 && wheel.y === 0 ? ['pointer', mask, x, y] : ['pointer', mask, x, y, wheel]),
        close: () => calls.push(['close']),
      };
    },
    draw(size, fill) { draw(frame(size, fill)); },
    drawJpeg(size, jpeg) { draw({ serial: (serial += 1), width: size.width, height: size.height, jpeg }); },
  };
}

/** A timer the test fires. */
function manualTimers() {
  const pending = [];

  return {
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };

      pending.push(timer);

      return () => { timer.cancelled = true; };
    },
    fire: () => {
      for (const timer of pending.splice(0)) if (!timer.cancelled) timer.fn();
    },
  };
}

function settled() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function message(type, body) {
  return Buffer.concat([Buffer.from([type]), body]);
}

function pixelFormat(format) {
  const bytes = Buffer.alloc(16);

  bytes.writeUInt8(format.bitsPerPixel, 0);
  bytes.writeUInt8(format.depth, 1);
  bytes.writeUInt8(format.bigEndian, 2);
  bytes.writeUInt8(format.trueColour, 3);
  bytes.writeUInt16BE(255, 4);
  bytes.writeUInt16BE(255, 6);
  bytes.writeUInt16BE(255, 8);
  bytes.writeUInt8(format.redShift, 10);
  bytes.writeUInt8(format.greenShift, 11);
  bytes.writeUInt8(format.blueShift, 12);

  return bytes;
}

function setEncodings(list) {
  const body = Buffer.alloc(3 + list.length * 4);

  body.writeUInt16BE(list.length, 1);

  for (const [at, encoding] of list.entries()) body.writeInt32BE(encoding, 3 + at * 4);

  return message(2, body);
}

function updateRequest({ incremental, width, height }) {
  const body = Buffer.alloc(9);

  body.writeUInt8(incremental ? 1 : 0, 0);
  body.writeUInt16BE(width, 5);
  body.writeUInt16BE(height, 7);

  return message(3, body);
}

/** Opens a stream through the dispatcher and walks the RFB handshake as a viewer does; returns what the server sent
 *  after its ServerInit, and reads it on. */
async function handshake({ source, encodings = [ENCODINGS.raw, ENCODINGS.desktopSize] }) {
  const timers = manualTimers();
  const screens = createScreens({ source, log: () => {}, after: timers.after });
  const ws = fakeWs();
  const viewer = (bytes) => screens.receive(STREAM, bytes);

  handle({ id: 'scr-1', method: 'screenOpen', params: [STREAM] }, ws, { screens });
  expect(ws.json).toEqual([{ id: 'scr-1', result: { stream: STREAM } }]);
  expect(ws.served(STREAM).toString('latin1')).toBe('RFB 003.008\n');

  viewer(Buffer.from('RFB 003.008\n', 'latin1'));
  viewer(Buffer.from([1]));
  viewer(Buffer.from([0]));
  await settled();

  const handshaken = ws.served(STREAM);
  // Version, then one security type (None), then SecurityResult OK, then ServerInit.
  expect([...handshaken.subarray(12, 14)]).toEqual([1, 1]);
  expect(handshaken.readUInt32BE(14)).toBe(0);
  const init = handshaken.subarray(18);
  const nameLength = init.readUInt32BE(20);

  viewer(message(0, Buffer.concat([Buffer.alloc(3), pixelFormat(VIEWER_FORMAT)])));
  viewer(setEncodings(encodings));
  let read = handshaken.byteLength;

  return {
    screens, ws, viewer, timers,
    init: { width: init.readUInt16BE(0), height: init.readUInt16BE(2), bitsPerPixel: init[4], name: init.subarray(24, 24 + nameLength).toString('utf8') },
    /** What the server sent since the last read. */
    next() {
      const all = ws.served(STREAM);
      const fresh = all.subarray(read);

      read = all.byteLength;

      return fresh;
    },
  };
}

/** A FramebufferUpdate's rectangles: each one's head, and the bytes up to the next. A count of 0xffff runs to the
 *  LastRect, which is not returned. */
function readUpdate(bytes) {
  expect(bytes[0]).toBe(0);
  const count = bytes.readUInt16BE(2);
  const rects = [];
  let at = 4;

  for (let index = 0; index < count; index += 1) {
    const rect = { x: bytes.readUInt16BE(at), y: bytes.readUInt16BE(at + 2), width: bytes.readUInt16BE(at + 4), height: bytes.readUInt16BE(at + 6), encoding: bytes.readInt32BE(at + 8) };

    at += 12;

    if (rect.encoding === ENCODINGS.lastRect) break;

    if (rect.encoding === ENCODINGS.extendedDesktopSize) {
      const screens = bytes[at];

      rect.screens = Array.from({ length: screens }, (_, screen) => {
        const entry = at + 4 + screen * 16;

        return { id: bytes.readUInt32BE(entry), x: bytes.readUInt16BE(entry + 4), y: bytes.readUInt16BE(entry + 6), width: bytes.readUInt16BE(entry + 8), height: bytes.readUInt16BE(entry + 10) };
      });
      at += 4 + screens * 16;
    } else if (rect.encoding === ENCODINGS.raw) {
      rect.pixels = bytes.subarray(at, at + rect.width * rect.height * 4);
      at += rect.width * rect.height * 4;
    } else if (rect.encoding === ENCODINGS.tight) {
      rect.control = bytes[at];
      let length = bytes[at + 1] & 0x7f;
      let used = 1;

      if (bytes[at + 1] & 0x80) {
        length |= (bytes[at + 2] & 0x7f) << 7;
        used = 2;

        if (bytes[at + 2] & 0x80) {
          length |= bytes[at + 3] << 14;
          used = 3;
        }
      }

      const data = bytes.subarray(at + 1 + used, at + 1 + used + length);

      if (rect.control === 0x90) rect.jpeg = data;
      else rect.rgb = zlib.inflateSync(data);
      at += 1 + used + length;
    }

    rects.push(rect);
  }

  expect(at).toBe(bytes.byteLength);

  return rects;
}

describe('the daemon serves its screen as RFB', () => {
  test('a viewer gets the screen in the pixel format it asked for, and only when it asks', async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0x11, g: 0x22, b: 0x33 } });
    const viewer = await handshake({ source });

    expect(viewer.init).toEqual({ width: 4, height: 2, bitsPerPixel: 32, name: 'studio' });
    expect(viewer.next().byteLength).toBe(0);

    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    const [frame] = readUpdate(viewer.next());

    expect({ ...frame, pixels: [...frame.pixels.subarray(0, 8)] }).toEqual({
      x: 0, y: 0, width: 4, height: 2, encoding: ENCODINGS.raw, pixels: [0x11, 0x22, 0x33, 0, 0x11, 0x22, 0x33, 0],
    });

    // Nothing changed: an incremental request waits for the next frame, and gets it when it is drawn.
    viewer.viewer(updateRequest({ incremental: true, width: 4, height: 2 }));
    expect(viewer.next().byteLength).toBe(0);
    source.draw({ width: 4, height: 2 }, { r: 0xaa, g: 0xbb, b: 0xcc });
    expect([...readUpdate(viewer.next())[0].pixels.subarray(0, 4)]).toEqual([0xaa, 0xbb, 0xcc, 0]);

    // A frame drawn while nobody asks waits for the next request.
    source.draw({ width: 4, height: 2 }, { r: 1, g: 2, b: 3 });
    expect(viewer.next().byteLength).toBe(0);
  });

  test("the viewer's keys and pointer reach the screen, and a resize reaches the viewer before the frame", async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const viewer = await handshake({ source });
    const key = Buffer.alloc(7);
    const pointer = Buffer.alloc(5);

    key.writeUInt8(1, 0);
    key.writeUInt32BE(0xff0d, 3);
    pointer.writeUInt8(1, 0);
    pointer.writeUInt16BE(3, 1);
    pointer.writeUInt16BE(1, 3);
    viewer.viewer(Buffer.concat([message(4, key), message(5, pointer)]));
    expect(source.calls).toEqual([['open'], ['key', true, 0xff0d], ['pointer', 1, 3, 1]]);

    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    viewer.next();
    viewer.viewer(updateRequest({ incremental: true, width: 4, height: 2 }));
    source.draw({ width: 2, height: 3 }, { r: 9, g: 9, b: 9 });
    const [size, frame] = readUpdate(viewer.next());

    expect({ size, frame: { width: frame.width, height: frame.height, bytes: frame.pixels.byteLength } })
      .toEqual({ size: { x: 0, y: 0, width: 2, height: 3, encoding: ENCODINGS.desktopSize }, frame: { width: 2, height: 3, bytes: 24 } });
  });

  test('a JPEG frame goes as one Tight rectangle; a viewer without Tight is told why the screen closed', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]);
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const viewer = await handshake({ source, encodings: [ENCODINGS.tight, ENCODINGS.raw] });

    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    viewer.next();
    viewer.viewer(updateRequest({ incremental: true, width: 4, height: 2 }));
    source.drawJpeg({ width: 4, height: 2 }, jpeg);
    const [rect] = readUpdate(viewer.next());

    expect({ encoding: rect.encoding, control: rect.control, jpeg: Buffer.compare(rect.jpeg, jpeg) }).toEqual({ encoding: ENCODINGS.tight, control: 0x90, jpeg: 0 });

    // A viewer that never named Tight cannot draw a JPEG frame.
    const jpegSource = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const refused = await handshake({ source: jpegSource, encodings: [ENCODINGS.raw] });

    refused.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    refused.next();
    refused.viewer(updateRequest({ incremental: true, width: 4, height: 2 }));
    jpegSource.drawJpeg({ width: 4, height: 2 }, jpeg);
    expect(refused.ws.json.at(-1)).toEqual({ type: protocol.frames.screenClose, stream: STREAM, reason: "this viewer can't draw the PC's screen: it lacks Tight encoding" });
    expect(jpegSource.calls.at(-1)).toEqual(['close']);
  });

  test("KasmVNC's client: its own messages are read, its pointer is its own, and the screen's layout opens the first update", async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0x10, g: 0x20, b: 0x30 } });
    const viewer = await handshake({ source, encodings: [ENCODINGS.tight, ENCODINGS.raw, ENCODINGS.lastRect, ENCODINGS.extendedDesktopSize] });
    const encoders = Buffer.from([184, 2, 0xff, 0xff, 0xfb, 0xfe, 0xff, 0xff, 0xfb, 0xf4]);
    const relay = Buffer.concat([Buffer.from([182, 7]), Buffer.from('printer')]);
    const pointer = Buffer.alloc(11);

    pointer.writeUInt8(5, 0);
    pointer.writeUInt16BE(1, 1);
    pointer.writeUInt16BE(3, 3);
    pointer.writeUInt16BE(1, 5);
    pointer.writeInt16BE(-120, 9);
    viewer.viewer(Buffer.concat([encoders, relay, Buffer.from([252, 0x03, 0xc0, 0x02, 0x1c]), pointer]));
    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    const [layout, band] = readUpdate(viewer.next());

    expect(source.calls).toEqual([['open'], ['pointer', 1, 3, 1, { x: 0, y: -120 }]]);
    expect(layout).toEqual({ x: 0, y: 0, width: 4, height: 2, encoding: ENCODINGS.extendedDesktopSize, screens: [{ id: 0, x: 0, y: 0, width: 4, height: 2 }] });
    // A raw frame goes as Tight, deflated: KasmVNC's own Raw decoder draws a rectangle's first rows down the screen.
    expect({ encoding: band.encoding, control: band.control, first: [...band.rgb.subarray(0, 6)], bytes: band.rgb.byteLength })
      .toEqual({ encoding: ENCODINGS.tight, control: 0x01, first: [0x10, 0x20, 0x30, 0x10, 0x20, 0x30], bytes: 24 });
  });

  test('one message holding many update requests is answered once, and an update waits while the socket is behind', async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 1, g: 2, b: 3 } });
    const viewer = await handshake({ source });

    viewer.viewer(Buffer.concat(Array.from({ length: 50 }, () => updateRequest({ incremental: false, width: 4, height: 2 }))));
    expect(readUpdate(viewer.next()).length).toBe(1);

    viewer.ws.bufferedAmount = 9 * 1024 * 1024;
    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    expect(viewer.next().byteLength).toBe(0);

    viewer.ws.bufferedAmount = 0;
    viewer.timers.fire();
    expect(readUpdate(viewer.next()).length).toBe(1);
  });

  test('a JPEG frame past what Tight can carry closes the stream in words', async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const viewer = await handshake({ source, encodings: [ENCODINGS.tight, ENCODINGS.raw] });

    viewer.viewer(updateRequest({ incremental: false, width: 4, height: 2 }));
    viewer.next();
    viewer.viewer(updateRequest({ incremental: true, width: 4, height: 2 }));
    source.drawJpeg({ width: 4, height: 2 }, Buffer.alloc(0x400000));

    expect(viewer.ws.json.at(-1)).toEqual({ type: protocol.frames.screenClose, stream: STREAM, reason: "a frame of the PC's screen is 4194304 bytes, past the 4194303 Tight carries" });
  });

  test('a viewer speaking another RFB version is refused in words, and nothing is captured', async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const screens = createScreens({ source, log: () => {}, after: manualTimers().after });
    const ws = fakeWs();

    handle({ id: 'scr-1', method: 'screenOpen', params: [STREAM] }, ws, { screens });
    screens.receive(STREAM, Buffer.from('RFB 003.003\n', 'latin1'));

    expect(ws.json.at(-1)).toEqual({ type: protocol.frames.screenClose, stream: STREAM, reason: 'this viewer speaks "RFB 003.003"; the PC speaks RFB 3.8' });
    expect(source.calls).toEqual([]);
  });
});

describe("the daemon's screen streams", () => {
  test('a second open ends the first and says why; bytes for the ended stream reach nothing', async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const viewer = await handshake({ source });

    handle({ id: 'scr-2', method: 'screenOpen', params: [STREAM + 1] }, viewer.ws, { screens: viewer.screens });

    expect(viewer.ws.json.slice(1)).toEqual([
      { type: protocol.frames.screenClose, stream: STREAM, reason: 'the screen opened in another tab' },
      { id: 'scr-2', result: { stream: STREAM + 1 } },
    ]);
    expect(source.calls).toEqual([['open'], ['close']]);
    expect(viewer.screens.receive(STREAM, Buffer.from([3]))).toBe(false);
  });

  test("a stream no viewer speaks on stops capturing when the attach window ends; the hub's close ends one silently", async () => {
    const source = fixedSource({ width: 4, height: 2, colour: { r: 0, g: 0, b: 0 } });
    const timers = manualTimers();
    const screens = createScreens({ source, log: () => {}, after: timers.after });
    const ws = fakeWs();

    handle({ id: 'scr-1', method: 'screenOpen', params: [STREAM] }, ws, { screens });
    timers.fire();
    expect(ws.json.at(-1)).toEqual({ type: protocol.frames.screenClose, stream: STREAM, reason: 'no viewer attached to the screen' });

    const spoken = await handshake({ source });

    spoken.timers.fire();
    expect(spoken.ws.json).toEqual([{ id: 'scr-1', result: { stream: STREAM } }]);
    handle({ type: protocol.frames.screenClose, stream: STREAM }, spoken.ws, { screens: spoken.screens });
    expect({ json: spoken.ws.json.length, closed: source.calls.at(-1), live: spoken.screens.receive(STREAM, Buffer.from([3])) })
      .toEqual({ json: 1, closed: ['close'], live: false });
  });

  test('a machine with no screen source reports none and refuses an open in words', () => {
    const screens = createScreens({ source: null, log: () => {} });
    const ws = fakeWs();

    handle({ id: 'scr-1', method: 'screenOpen', params: [STREAM] }, ws, { screens });

    expect({ desktop: screens.desktop(), answer: ws.json }).toEqual({
      desktop: { state: 'none' },
      answer: [{ id: 'scr-1', error: expect.objectContaining({ message: expect.stringContaining('this PC shares no screen') }) }],
    });
  });

  test("screen data frames carry the stream and at most the protocol's bytes each", () => {
    const frames = screenDataFrames(0xfedcba98, Buffer.alloc(protocol.screenData.maxBytes + 5, 1));

    expect(frames.map((frame) => ({ kind: frame[0], stream: readScreenData(frame)?.stream, bytes: readScreenData(frame)?.bytes.byteLength }))).toEqual([
      { kind: protocol.screenData.kind, stream: 0xfedcba98, bytes: protocol.screenData.maxBytes },
      { kind: protocol.screenData.kind, stream: 0xfedcba98, bytes: 5 },
    ]);
    expect(readScreenData(Buffer.from('{"id":"x"}'))).toBeNull();
  });
});
