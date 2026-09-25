// Logs no header or body: both carry a token.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { forwardedHeaders, HOP_BY_HOP, refusal, TARGET_HEADER } from './policy.mjs';

const PORT = 8080;

function refuse(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
}

createServer(async (req, res) => {
  const target = String(req.headers[TARGET_HEADER] ?? '');
  const refused = refusal(req.method, target);

  if (refused !== null) {
    refuse(res, refused.status, refused.text);

    return;
  }

  const upstreamAbort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) upstreamAbort.abort(); });

  let upstream;

  try {
    upstream = await fetch(new URL(target), {
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
