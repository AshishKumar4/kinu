import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * The loopback leg of a browser sign-in: the code the redirect carrying this run's `state` brings, or null
 * when the port is taken. Any page can hit a loopback port, so a request without the state gets a 404 and
 * the listener stays up. Binds `127.0.0.1` only: `::` would put the leg on the LAN.
 */
export function awaitOAuthCallback(port: number, state: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', `http://localhost:${String(port)}`);
      const code = url.searchParams.get('code') ?? '';
      const problem = url.searchParams.get('error');

      if ((url.searchParams.get('state') ?? '') !== state) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('This is not the authorization this terminal started.');

        return;
      }

      const good = problem === null && code !== '';

      response.writeHead(good ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(good
        ? 'Authorized. Go back to your terminal.'
        : `That authorization did not complete${problem === null ? '' : `: ${problem}`}.`);
      server.close();

      if (good) resolve(code);
      else reject(new Error(problem ?? 'that callback carried no authorization code'));
    });

    signal?.addEventListener('abort', () => {
      server.close();
      reject(signal.reason);
    }, { once: true });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });

    server.listen(port, '127.0.0.1');
  });
}
