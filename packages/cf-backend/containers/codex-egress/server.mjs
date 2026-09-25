// Logs no header or body: both carry a token.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = 8080;

const ALLOWED_HOST = 'chatgpt.com';

const TARGET_HEADER = 'x-kinu-target';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'host', 'content-length',
]);

function forwardedHeaders(incoming) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith('cf-') || name.startsWith('x-kinu-') || name === 'x-forwarded-for') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  return headers;
}

function refuse(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
}

createServer(async (req, res) => {
  const target = URL.parse(String(req.headers[TARGET_HEADER] ?? ''));

  if (target === null || target.protocol !== 'https:' || target.hostname !== ALLOWED_HOST || target.port !== '') {
    refuse(res, 403, 'target refused');

    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    refuse(res, 405, 'method refused');

    return;
  }

  const upstreamAbort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) upstreamAbort.abort(); });

  let upstream;

  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardedHeaders(req.headers),
      body: req.method === 'POST' ? Readable.toWeb(req) : undefined,
      duplex: 'half',
      redirect: 'manual',
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'codex_egress.upstream_unreachable', error: String(error), cause: String(error.cause ?? '') }));

    if (!res.headersSent) refuse(res, 502, 'chatgpt.com unreachable from the egress container');

    return;
  }

  const headers = {};

  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') headers[name] = value;
  }

  res.writeHead(upstream.status, headers);

  if (upstream.body === null) {
    res.end();

    return;
  }

  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}).listen(PORT);
