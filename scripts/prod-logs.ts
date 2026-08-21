/**
 * Production log access for the deployed workers.
 *
 * Two halves, by access:
 *  - `live` spawns `wrangler tail` (the OAuth session can do this) and filters
 *    the stream to typed events / substrings. Live-only: Workers keeps no
 *    scrollback for a tail.
 *  - `query` reads HISTORY through the Workers Observability telemetry API,
 *    which refuses the wrangler OAuth token (measured 2026-08-21: HTTP 403,
 *    code 10000). It needs a real API token in KINU_OBS_TOKEN with
 *    "Account > Workers Observability > Read". Mint once: dash.cloudflare.com
 *    -> My Profile -> API Tokens -> Create Token.
 *
 * Usage:
 *   bun scripts/prod-logs.ts live [--worker kinu] [--seconds 120] [--grep swarm]
 *   bun scripts/prod-logs.ts query [--worker kinu] [--since 6h] [--grep head.]
 */
import { spawn } from 'node:child_process';
import * as v from 'valibot';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

interface Args {
  readonly mode: 'live' | 'query';
  readonly worker: string;
  readonly seconds: number;
  readonly since: number;
  readonly grep: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const mode = argv[0];
  if (mode !== 'live' && mode !== 'query') {
    throw new Error('usage: prod-logs.ts <live|query> [--worker kinu] [--seconds 120] [--since 6h] [--grep text]');
  }
  const opt = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : null;
  };
  const sinceRaw = opt('since') ?? '6h';
  const sinceMatch = /^(\d+)([hm])$/.exec(sinceRaw);
  if (sinceMatch === null) throw new Error(`--since takes 30m / 6h shapes, got ${sinceRaw}`);
  const sinceMs = Number(sinceMatch[1]) * (sinceMatch[2] === 'h' ? 3_600_000 : 60_000);
  return {
    mode,
    worker: opt('worker') ?? 'kinu',
    seconds: Number(opt('seconds') ?? '120'),
    since: sinceMs,
    grep: opt('grep'),
  };
}

/** The slice of a tail event this tool reads; everything else passes through. */
const TailEventSchema = v.looseObject({
  logs: v.optional(v.array(v.looseObject({
    level: v.optional(v.string()),
    // A part is prose or a structured value; the schema renders the value, so
    // downstream code only ever holds strings.
    message: v.optional(v.array(v.union([
      v.string(),
      v.pipe(v.unknown(), v.transform((part) => JSON.stringify(part))),
    ]))),
  }))),
  exceptions: v.optional(v.array(v.unknown())),
});

/** Every log line of one tail event, joined the way the dashboard renders it. */
function linesOf(event: v.InferOutput<typeof TailEventSchema>): string[] {
  const out = (event.logs ?? []).map((lg) => {
    return `${lg.level ?? '?'} ${(lg.message ?? []).join(' ')}`;
  });
  return out.concat((event.exceptions ?? []).map((ex) => `EXCEPTION ${JSON.stringify(ex)}`));
}

async function live(args: Args): Promise<void> {
  const child = spawn('bunx', ['wrangler', 'tail', args.worker, '--format', 'json'], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stop = setTimeout(() => child.kill('SIGINT'), args.seconds * 1000);
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let brace = buffer.indexOf('\n');
    while (brace >= 0) {
      const line = buffer.slice(0, brace).trim();
      buffer = buffer.slice(brace + 1);
      brace = buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue; // a split frame; the remainder arrives with the next chunk
      }
      const event = v.safeParse(TailEventSchema, raw);
      if (!event.success) continue;
      for (const rendered of linesOf(event.output)) {
        if (args.grep === null || rendered.includes(args.grep)) console.log(rendered);
      }
    }
  });
  await new Promise<void>((resolve) => child.on('exit', () => { clearTimeout(stop); resolve(); }));
}

async function query(args: Args): Promise<void> {
  const tokenFile = `${process.env['HOME']}/.config/kinu/obs-token`;
  const token = process.env['KINU_OBS_TOKEN']
    ?? (await Bun.file(tokenFile).exists() ? (await Bun.file(tokenFile).text()).trim() : undefined);
  if (token === undefined || token === '') {
    throw new Error(
      'historical queries need KINU_OBS_TOKEN, an API token with "Account > Workers '
      + 'Observability > Read" (the wrangler OAuth token answers 403 here — measured '
      + '2026-08-21). Mint once at dash.cloudflare.com -> My Profile -> API Tokens.',
    );
  }
  const now = Date.now();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        timeframe: { from: now - args.since, to: now },
        view: 'events',
        limit: 500,
        parameters: {
          datasets: ['cloudflare-workers'],
          filters: [
            { key: '$metadata.service', operation: 'eq', value: args.worker, type: 'string' },
            ...(args.grep === null ? [] : [{ key: '$metadata.message', operation: 'includes', value: args.grep, type: 'string' }]),
          ],
        },
      }),
    },
  );
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`telemetry query answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  console.log(JSON.stringify(body, null, 1));
}

const args = parseArgs(process.argv.slice(2));
await (args.mode === 'live' ? live(args) : query(args));
