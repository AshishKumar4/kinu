import { describe, expect, it } from 'vitest';
import { bridgeSockets } from '../../src/socket-bridge';

// The desktop probe's RFB through the preview bridge arrived as the text "[object Blob]" (2026-10-04).

/** The next message `socket` receives: its bytes, or its text when it is not binary. */
function next(socket: WebSocket): Promise<string | number[]> {
  const { promise, resolve } = Promise.withResolvers<string | number[]>();
  socket.addEventListener('message', (event) => { resolve(event.data instanceof ArrayBuffer ? [...new Uint8Array(event.data)] : String(event.data)); }, { once: true });

  return promise;
}

describe('preview socket bridge', () => {
  it('carries a binary frame intact both ways', async () => {
    const [app, upstream] = Object.values(new WebSocketPair());
    const visitor = bridgeSockets(upstream, new Headers(), () => undefined).webSocket;

    if (visitor === null) throw new Error('the bridge answered without a socket');

    for (const socket of [app, visitor]) {
      socket.accept();
      socket.binaryType = 'arraybuffer';
    }

    const atApp = next(app);
    visitor.send(new Uint8Array([0x52, 0x46, 0x42, 0x00, 0xff]));
    const up = await atApp;
    const atVisitor = next(visitor);
    app.send(new Uint8Array([0x01, 0x02, 0x00, 0xfe]));
    const down = await atVisitor;

    expect({ up, down }).toEqual({ up: [0x52, 0x46, 0x42, 0x00, 0xff], down: [0x01, 0x02, 0x00, 0xfe] });
  });
});
