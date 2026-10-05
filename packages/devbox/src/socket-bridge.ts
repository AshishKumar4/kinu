export function bridgeSockets(upstream: WebSocket, headers: Headers, closed: () => void): Response {
  const [visitor, held] = Object.values(new WebSocketPair());
  let open = true;

  const end = (code: number, reason: string): void => {
    if (!open) return;
    open = false;
    closed();

    for (const socket of [held, upstream]) socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  };

  held.accept();
  upstream.accept();
  held.binaryType = 'arraybuffer';
  upstream.binaryType = 'arraybuffer';
  held.addEventListener('message', (event) => { if (open) upstream.send(event.data); });
  upstream.addEventListener('message', (event) => { if (open) held.send(event.data); });

  for (const socket of [held, upstream]) {
    socket.addEventListener('close', (event) => end(event.code, event.reason));
    socket.addEventListener('error', () => end(1011, 'preview socket failed'));
  }

  return new Response(null, { status: 101, headers, webSocket: visitor });
}
