// Kinu PC agent — the PC's screen over the device tunnel (1014-t).
//
// The daemon serves RFB itself, from a screen source, to the viewer the hub
// pairs with one stream: no screen server listens on this machine. The hub
// relays the viewer's bytes unread; both directions cross the tunnel as binary
// messages (a kind byte, the stream as a big-endian u32, then RFB), and every
// other frame stays JSON text. One stream at a time: a second open ends the
// first, since one person drives one pointer.
'use strict';

const zlib = require('node:zlib');

const protocol = require('../device-protocol.json');

const SCREEN_DATA = protocol.screenData;

const SCREEN_CLOSE_FRAME = protocol.frames.screenClose;

const RFB_VERSION = 'RFB 003.008\n';

const SECURITY_NONE = 1;

const MESSAGE = { setPixelFormat: 0, setEncodings: 2, updateRequest: 3, key: 4, pointer: 5, cutText: 6 };

/** What the Environment's client (KasmVNC's) sends any server unasked, read and dropped: its video encoders and relay
 *  subscriptions at connect, the largest video it takes once it knows the screen's layout, its clipboard as it changes,
 *  keepalives, and the answers to stats a server asked for. The
 *  first of them names the viewer as KasmVNC's, whose pointer event is its own (see `pointerEvent`). */
const KASM_MESSAGE = { stats: 178, frameStats: 179, clipboard: 180, subscribeRelay: 182, relayData: 183, videoEncoders: 184, keepAlive: 185, directMouse: 188, maxVideoResolution: 252 };

/** A viewer's bytes not yet read past this are not a viewer's, and end the stream. */
const PENDING_MAX_BYTES = 16 * 1024 * 1024;

const ENCODING = { raw: 0, tight: 7, desktopSize: -223, lastRect: -224, extendedDesktopSize: -308 };

/** Tight's compression-control byte for a JPEG rectangle. */
const TIGHT_JPEG = 0x90;

/** Tight's compression-control byte for basic compression on zlib stream 0, reset first, with no filter: each
 *  rectangle's pixels deflated on their own. */
const TIGHT_BASIC_RESET = 0x01;

/** Tight sends fewer bytes than this uncompressed. */
const TIGHT_MIN_TO_COMPRESS = 12;

/** A raw frame goes as Tight a band of rows at a time, each band's pixels at most this many bytes before deflating, so
 *  every band's compressed length fits Tight's three-byte length. */
const TIGHT_BAND_BYTES = 256 * 1024;

/** The server's pixel format: 32 bits, depth 24, little-endian, true colour, red in bits 16-23 — the BGRX a frame's
 *  `raw` holds. */
const SERVER_FORMAT = { bitsPerPixel: 32, depth: 24, bigEndian: false, trueColour: true, redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0 };

/** A viewer that has not spoken this long after its stream opened never attached; its capture stops. */
const VIEWER_ATTACH_MS = 30_000;

const NO_SCREEN = 'this PC shares no screen';

const OPENED_ELSEWHERE = 'the screen opened in another tab';

const NO_VIEWER = 'no viewer attached to the screen';

/** The binary messages carrying `bytes` on `stream`. */
function screenFrames(stream, bytes) {
  const frames = [];

  for (let at = 0; at < bytes.byteLength; at += SCREEN_DATA.maxBytes) {
    const part = bytes.subarray(at, at + SCREEN_DATA.maxBytes);
    const frame = Buffer.alloc(SCREEN_DATA.headerBytes + part.byteLength);

    frame.writeUInt8(SCREEN_DATA.kind, 0);
    frame.writeUInt32BE(stream, 1);
    frame.set(part, SCREEN_DATA.headerBytes);
    frames.push(frame);
  }

  return frames;
}

/** A binary message from the hub as screen data; null when it is not. */
function readScreenData(data) {
  const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);

  if (bytes.byteLength < SCREEN_DATA.headerBytes || bytes[0] !== SCREEN_DATA.kind) return null;

  return { stream: bytes.readUInt32BE(1), bytes: bytes.subarray(SCREEN_DATA.headerBytes) };
}

function pixelFormatBytes(format) {
  const bytes = Buffer.alloc(16);

  bytes.writeUInt8(format.bitsPerPixel, 0);
  bytes.writeUInt8(format.depth, 1);
  bytes.writeUInt8(format.bigEndian ? 1 : 0, 2);
  bytes.writeUInt8(format.trueColour ? 1 : 0, 3);
  bytes.writeUInt16BE(format.redMax, 4);
  bytes.writeUInt16BE(format.greenMax, 6);
  bytes.writeUInt16BE(format.blueMax, 8);
  bytes.writeUInt8(format.redShift, 10);
  bytes.writeUInt8(format.greenShift, 11);
  bytes.writeUInt8(format.blueShift, 12);

  return bytes;
}

function readPixelFormat(bytes) {
  return {
    bitsPerPixel: bytes.readUInt8(0), depth: bytes.readUInt8(1), bigEndian: bytes.readUInt8(2) !== 0, trueColour: bytes.readUInt8(3) !== 0,
    redMax: bytes.readUInt16BE(4), greenMax: bytes.readUInt16BE(6), blueMax: bytes.readUInt16BE(8),
    redShift: bytes.readUInt8(10), greenShift: bytes.readUInt8(11), blueShift: bytes.readUInt8(12),
  };
}

/** Tight's compact length: seven bits a byte, low first, the high bit saying another follows. */
function compactLength(length) {
  const bytes = [length & 0x7f];

  if (length > 0x7f) {
    bytes[0] |= 0x80;
    bytes.push((length >> 7) & 0x7f);

    if (length > 0x3fff) {
      bytes[1] |= 0x80;
      bytes.push((length >> 14) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/** KasmVNC's clipboard message: a count, then each entry's mime type and data, each with its length. */
function clipboardLength(bytes) {
  if (bytes.byteLength < 2) return null;
  let at = 2;

  for (let entry = 0; entry < bytes[1]; entry += 1) {
    if (bytes.byteLength < at + 1) return null;
    at += 1 + bytes[at];

    if (bytes.byteLength < at + 4) return null;
    at += 4 + bytes.readUInt32BE(at);
  }

  return at;
}

/** Each client message's whole length, from as much of it as has arrived; null until that is enough to say. */
const MESSAGE_LENGTH = {
  [MESSAGE.setPixelFormat]: () => 20,
  [MESSAGE.setEncodings]: (bytes) => (bytes.byteLength < 4 ? null : 4 + 4 * bytes.readUInt16BE(2)),
  [MESSAGE.updateRequest]: () => 10,
  [MESSAGE.key]: () => 8,
  [MESSAGE.pointer]: (_bytes, kasm) => (kasm ? 11 : 6),
  [MESSAGE.cutText]: (bytes) => (bytes.byteLength < 8 ? null : 8 + Math.abs(bytes.readInt32BE(4))),
  [KASM_MESSAGE.stats]: () => 4,
  [KASM_MESSAGE.frameStats]: () => 12,
  [KASM_MESSAGE.clipboard]: clipboardLength,
  [KASM_MESSAGE.subscribeRelay]: (bytes) => (bytes.byteLength < 2 ? null : 2 + bytes[1]),
  [KASM_MESSAGE.relayData]: (bytes) => (bytes.byteLength < 2 || bytes.byteLength < 6 + bytes[1] ? null : 6 + bytes[1] + bytes.readUInt32BE(2 + bytes[1])),
  [KASM_MESSAGE.videoEncoders]: (bytes) => (bytes.byteLength < 2 ? null : 2 + 4 * bytes[1]),
  [KASM_MESSAGE.keepAlive]: () => 1,
  [KASM_MESSAGE.directMouse]: () => 10,
  [KASM_MESSAGE.maxVideoResolution]: () => 5,
};

/**
 * A pointer event. RFB's is a button mask byte and the position; KasmVNC's client widens the mask to 16 bits and adds
 * the wheel's two deltas (`We.messages.pointerEvent` in its bundle, 11 bytes), whichever server it talks to.
 */
function pointerEvent(message, kasm) {
  if (!kasm) return { mask: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4), wheel: { x: 0, y: 0 } };

  return { mask: message.readUInt16BE(1), x: message.readUInt16BE(3), y: message.readUInt16BE(5), wheel: { x: message.readInt16BE(7), y: message.readInt16BE(9) } };
}

/** The screen's layout as ExtendedDesktopSize says it: one screen, the whole frame. A viewer that names the encoding is
 *  owed one in its first update, and KasmVNC's client maps its pointer to the screen by it. */
function screenLayout(width, height) {
  const layout = Buffer.alloc(4 + 16);

  layout.writeUInt8(1, 0);
  layout.writeUInt16BE(width, 4 + 8);
  layout.writeUInt16BE(height, 4 + 10);

  return [rectHead({ width, height }, ENCODING.extendedDesktopSize), layout];
}

/** A rectangle's header: where it is, its size, and how its bytes are encoded. */
function rectHead({ x = 0, y = 0, width, height }, encoding) {
  const head = Buffer.alloc(12);

  head.writeUInt16BE(x, 0);
  head.writeUInt16BE(y, 2);
  head.writeUInt16BE(width, 4);
  head.writeUInt16BE(height, 6);
  head.writeInt32BE(encoding, 8);

  return head;
}

/** Tight's TPIXEL is three bytes, red, green, blue, for the 24-bit true colour every viewer this PC serves asks for;
 *  another format goes as Raw. */
function tightPixels(format) {
  return format.bitsPerPixel === 32 && format.depth === 24 && format.redMax === 255 && format.greenMax === 255 && format.blueMax === 255;
}

/**
 * A raw frame as Tight basic rectangles, one per band of rows, each band deflated alone. KasmVNC's client is the one
 * viewer the Environment opens, and its Raw decoder draws every chunk of a rectangle from the start of its receive
 * buffer: a raw frame drew its first rows down the whole screen (measured 2026-10-19,
 * `tests/browser/pc-desktop-client.test.ts`).
 */
function tightBands(frame) {
  const { width, height, raw } = frame;
  const rows = Math.max(1, Math.floor(TIGHT_BAND_BYTES / (width * 3)));
  const parts = [];
  let rects = 0;

  for (let top = 0; top < height; top += rows) {
    const band = Math.min(rows, height - top);
    const rgb = Buffer.alloc(width * band * 3);

    for (let at = 0; at < width * band; at += 1) {
      const from = (top * width + at) * 4;

      rgb[at * 3] = raw[from + 2];
      rgb[at * 3 + 1] = raw[from + 1];
      rgb[at * 3 + 2] = raw[from];
    }

    const compressed = rgb.byteLength >= TIGHT_MIN_TO_COMPRESS;
    const data = compressed ? zlib.deflateSync(rgb, { level: 1 }) : rgb;

    parts.push(rectHead({ y: top, width, height: band }, ENCODING.tight), Buffer.from([TIGHT_BASIC_RESET]), ...(compressed ? [compactLength(data.byteLength)] : []), data);
    rects += 1;
  }

  return { parts, rects };
}

/** A frame's BGRX pixels in the viewer's format: 32-bit true colour, any channel order and byte order. */
function rawPixels(frame, format) {
  const { width, height, raw } = frame;
  const out = Buffer.alloc(width * height * 4);

  for (let at = 0; at < width * height; at += 1) {
    const b = raw[at * 4], g = raw[at * 4 + 1], r = raw[at * 4 + 2];

    const value = ((Math.round(r * format.redMax / 255) << format.redShift)
      | (Math.round(g * format.greenMax / 255) << format.greenShift)
      | (Math.round(b * format.blueMax / 255) << format.blueShift)) >>> 0;

    if (format.bigEndian) out.writeUInt32BE(value, at * 4);
    else out.writeUInt32LE(value, at * 4);
  }

  return out;
}

/**
 * One viewer's RFB session (RFB 3.8, no security: the hub's route already
 * authenticated the owner and checked this workspace's grant). `send` takes the
 * server's bytes; `end(reason)` closes the stream. The source opens once the
 * viewer finishes its handshake, and its frames go out one per update the viewer
 * asks for, so a slow tunnel slows the frame rate rather than filling memory.
 */
function createRfbSession({ source, send, end, log }) {
  let pending = Buffer.alloc(0);
  let phase = 'version';
  let format = SERVER_FORMAT;
  let encodings = new Set([ENCODING.raw]);
  let screen = null;
  let latest = null;
  /** The size the viewer last learned: ServerInit's, then each DesktopSize's. */
  let size = null;
  let layoutSent = false;
  /** The viewer is KasmVNC's client, which says so with its first message of its own. */
  let kasm = false;
  let sentSerial = -1;
  let asked = null;
  let ended = false;

  /** @param {unknown} error */
  function reportOpenFailure(error) {
    log('device.screen_open_failed', error instanceof Error ? error.message : String(error));
  }

  function stop(reason) {
    if (ended) return;
    ended = true;
    screen?.close();
    end(reason);
  }

  /** One FramebufferUpdate: the screen's new size first if it changed, then the whole frame. */
  function sendUpdate(frame) {
    const parts = [];
    let rects = 0;

    const resized = size.width !== frame.width || size.height !== frame.height;

    if (encodings.has(ENCODING.extendedDesktopSize) && (resized || !layoutSent)) {
      parts.push(...screenLayout(frame.width, frame.height));
      rects += 1;
      layoutSent = true;
    } else if (resized) {
      if (!encodings.has(ENCODING.desktopSize)) return stop("the PC's screen changed size, and this viewer can't follow it");
      parts.push(rectHead(frame, ENCODING.desktopSize));
      rects += 1;
    }

    size = { width: frame.width, height: frame.height };

    if (frame.jpeg) {
      if (!encodings.has(ENCODING.tight)) return stop("this viewer can't draw the PC's screen: it lacks Tight encoding");
      parts.push(rectHead(frame, ENCODING.tight), Buffer.from([TIGHT_JPEG]), compactLength(frame.jpeg.byteLength), Buffer.from(frame.jpeg));
      rects += 1;
    } else if (encodings.has(ENCODING.tight) && tightPixels(format)) {
      const bands = tightBands(frame);

      parts.push(...bands.parts);
      rects += bands.rects;
    } else {
      parts.push(rectHead(frame, ENCODING.raw), rawPixels(frame, format));
      rects += 1;
    }

    const head = Buffer.alloc(4);
    // A viewer that reads LastRect is told where the update ends instead of how many rectangles it has. KasmVNC's
    // client shows an update of one counted rectangle only once the next update arrives, so on a still screen never.
    const lastRect = encodings.has(ENCODING.lastRect);

    head.writeUInt16BE(lastRect ? 0xffff : rects, 2);
    sentSerial = frame.serial;
    send(Buffer.concat([head, ...parts, ...(lastRect ? [rectHead({ width: 0, height: 0 }, ENCODING.lastRect)] : [])]));
  }

  function maybeUpdate() {
    if (ended || asked === null || latest === null) return;

    if (asked.incremental && latest.serial === sentSerial) return;
    asked = null;
    sendUpdate(latest);
  }

  async function openScreen() {
    try {
      screen = await source.open({
        onFrame(frame) {
          latest = frame;
          maybeUpdate();
        },
        onEnd(reason) { stop(reason); },
      });
    } catch (err) {
      return stop(`the PC's screen did not open: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (ended) return screen.close();
    const name = Buffer.from(screen.name, 'utf8');
    const init = Buffer.alloc(4);

    init.writeUInt16BE(screen.width, 0);
    init.writeUInt16BE(screen.height, 2);
    size = { width: screen.width, height: screen.height };
    const nameLength = Buffer.alloc(4);

    nameLength.writeUInt32BE(name.byteLength, 0);
    send(Buffer.concat([init, pixelFormatBytes(SERVER_FORMAT), nameLength, name]));
    phase = 'normal';
    parse();
  }

  /** The length of the client message at the front of `pending`: null until all of it has arrived, -1 for a type no
   *  viewer this PC serves sends. */
  function nextMessage() {
    const measure = MESSAGE_LENGTH[pending[0]];

    if (measure === undefined) return -1;
    const length = measure(pending, kasm);

    return length === null || pending.byteLength < length ? null : length;
  }

  function handleMessage(message) {
    const type = message[0];

    if (type === MESSAGE.setPixelFormat) {
      const wanted = readPixelFormat(message.subarray(4));

      if (wanted.bitsPerPixel !== 32 || !wanted.trueColour) return stop(`this viewer asked for ${wanted.bitsPerPixel}-bit ${wanted.trueColour ? '' : 'colour-mapped '}pixels; the PC sends 32-bit true colour`);
      format = wanted;
    } else if (type === MESSAGE.setEncodings) {
      encodings = new Set(Array.from({ length: message.readUInt16BE(2) }, (_, at) => message.readInt32BE(4 + at * 4)));
    } else if (type === MESSAGE.updateRequest) {
      asked = { incremental: message[1] !== 0 };
      maybeUpdate();
    } else if (type === MESSAGE.key) {
      screen.key(message[1] !== 0, message.readUInt32BE(4));
    } else if (type === MESSAGE.pointer) {
      const pointer = pointerEvent(message, kasm);

      screen.pointer(pointer.mask, pointer.x, pointer.y, pointer.wheel);
    } else if (type >= KASM_MESSAGE.stats) {
      kasm = true;
    }
    // Cut text and KasmVNC's own messages are read and dropped: the clipboard is not shared.
  }

  function parse() {
    while (!ended) {
      if (phase === 'version') {
        if (pending.byteLength < 12) return;
        const version = pending.subarray(0, 12).toString('latin1');

        pending = pending.subarray(12);

        if (version !== RFB_VERSION) return stop(`this viewer speaks ${JSON.stringify(version.trim())}; the PC speaks RFB 3.8`);
        send(Buffer.from([1, SECURITY_NONE]));
        phase = 'security';
      } else if (phase === 'security') {
        if (pending.byteLength < 1) return;
        const chosen = pending[0];

        pending = pending.subarray(1);

        if (chosen !== SECURITY_NONE) return stop(`this viewer chose security type ${chosen}; the PC offers none other than ${SECURITY_NONE}`);
        send(Buffer.alloc(4));
        phase = 'init';
      } else if (phase === 'init') {
        if (pending.byteLength < 1) return;
        pending = pending.subarray(1);
        phase = 'opening';
        openScreen().catch(reportOpenFailure);

        return;
      } else if (phase === 'normal') {
        if (pending.byteLength === 0) return;
        const length = nextMessage();

        if (length === null) return;

        if (length < 0) return stop(`the viewer sent a message the PC doesn't speak (type ${pending[0]})`);
        const message = Buffer.from(pending.subarray(0, length));

        pending = pending.subarray(length);
        handleMessage(message);
      } else {
        return;
      }
    }
  }

  send(Buffer.from(RFB_VERSION, 'latin1'));

  return {
    /** The viewer's bytes, as the hub relayed them. */
    receive(bytes) {
      pending = Buffer.concat([pending, bytes]);

      if (pending.byteLength > PENDING_MAX_BYTES) return stop('the viewer sent more than a screen viewer sends');
      parse();
    },
    stop,
  };
}

/** Runs `fn` after `ms`; the answer cancels it. */
function afterTimer(ms, fn) {
  const timer = setTimeout(fn, ms);

  return () => clearTimeout(timer);
}

/**
 * The daemon's screen streams. `source` is this machine's screen, or null when
 * it shares none; `desktop()` is what the HELLO reports.
 */
function createScreens({ source, log, after = afterTimer }) {
  let open = null;

  function close(stream, reason, { tell }) {
    if (open === null || open.stream !== stream) return;
    const ending = open;

    open = null;
    ending.cancelAttach();
    ending.session.stop(reason);

    if (tell) sendJson(ending.ws, { type: SCREEN_CLOSE_FRAME, stream, reason });
  }

  function sendJson(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log('device.screen_frame_unsent', frame.type, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    desktop() {
      return source === null ? { state: 'none' } : source.desktop();
    },

    /** `screenOpen`: a stream numbered by the hub, on the socket that asked. */
    open(stream, ws) {
      if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new Error('screenOpen expects a stream number');

      if (source === null) throw new Error(NO_SCREEN);

      if (open !== null) close(open.stream, OPENED_ELSEWHERE, { tell: true });
      let ended = false;

      const session = createRfbSession({
        source,
        log,
        send(bytes) {
          if (ended) return;

          for (const frame of screenFrames(stream, bytes)) {
            try {
              ws.send(frame);
            } catch (err) {
              log('device.screen_data_unsent', stream, err instanceof Error ? err.message : String(err));

              return;
            }
          }
        },
        end(reason) {
          if (ended) return;
          ended = true;

          if (open !== null && open.stream === stream) {
            open.cancelAttach();
            open = null;
            sendJson(ws, { type: SCREEN_CLOSE_FRAME, stream, reason });
          }
        },
      });

      open = { stream, ws, session, spoke: false, cancelAttach: () => {} };
      const opened = open;

      opened.cancelAttach = after(VIEWER_ATTACH_MS, () => {
        if (!opened.spoke) close(stream, NO_VIEWER, { tell: true });
      });

      return { stream };
    },

    /** Screen data from the hub; bytes for a stream this daemon no longer holds are dropped. */
    receive(stream, bytes) {
      if (open === null || open.stream !== stream) return false;
      open.spoke = true;
      open.session.receive(bytes);

      return true;
    },

    /** The hub's SCREEN_CLOSE: the viewer went away. */
    closed(stream) {
      close(stream, 'the viewer closed the screen', { tell: false });
    },

    /** The socket carrying the stream is gone. */
    closeAll() {
      if (open === null) return [];
      const stream = open.stream;

      close(stream, 'the tunnel closed', { tell: false });

      return [stream];
    },
  };
}

module.exports = { createScreens, readScreenData, screenFrames, SCREEN_CLOSE_FRAME };
