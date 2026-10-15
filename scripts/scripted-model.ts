/**
 * The model behind a live-app run: an OpenAI-compatible endpoint whose answers
 * are a script. Everything else in the run is the product — the real Worker in
 * workerd, real Durable Objects, the real client — so the one thing a local run
 * cannot have (a provider) is the one thing stood in for here.
 *
 * A script reads the request, not a counter: the same server answers a
 * workspace's titling call, a row's throwaway turn and the plan walkthrough's
 * four steps, and each is decided by what the request carries. Counters break
 * the moment two rows share the server, which they do. The wire is
 * `scripted-protocol.ts`'s; this server adds the paced answers a row holds.
 */
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import * as v from 'valibot';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';
import { apiJson } from './live-app-harness';
import { settleCatalog, type CatalogNeed } from '../evals/src/workspace-roster';
import { SCRIPTED_MODELS_BODY, pacedStream, rateLimitedAnswer, readScriptedRequest, scriptedBody, type ScriptedAnswer, type ScriptedModel, type ScriptedPace, type ScriptedRequest } from './scripted-protocol';


/** The account credential a scripted run's workspaces are served through. */
export const SCRIPTED_CREDENTIAL = 'openai-compat.default';

/** Wrap a script so the run's FIRST request gets `first` — the caller knows
 *  by construction which turn opens the run (a fresh workspace's create
 *  queues its genesis turn before anything else can speak), while matching
 *  on the request's text would guess. */
export function countingScript(script: ScriptedModel, first: ScriptedAnswer): ScriptedModel {
  let seen = 0;

  return (request) => {
    seen += 1;

    return seen === 1 ? first : script(request);
  };
}

/** Write a paced answer onto the socket; a hold that fails cuts the call, as a provider that drops the socket does. */
function writePaced(response: ServerResponse, answer: ScriptedAnswer, pace: ScriptedPace, request: ScriptedRequest): void {
  void (async () => {
    for await (const chunk of pacedStream(answer, pace, request, sleep)) response.write(chunk);
    response.end();
  })().catch(() => { response.destroy(); });
}

export interface ScriptedModelServer {
  /** Where the server answers, as an account's `openai-compat` credential names it. */
  readonly baseURL: string;
  /** Every answer this server gave, in order — what a failing row reads first. */
  readonly answers: readonly ScriptedAnswer[];
  stop(): Promise<void>;
}

/** Bind the scripted endpoint on an ephemeral port. */
export async function startScriptedModel(script: ScriptedModel): Promise<ScriptedModelServer> {
  const answers: ScriptedAnswer[] = [];

  const http = createHttpServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');

      if (url.pathname === '/models' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(SCRIPTED_MODELS_BODY);

        return;
      }

      if (url.pathname === '/chat/completions' && request.method === 'POST') {
        const read = readScriptedRequest(body);

        if ('refusal' in read) {
          process.stderr.write(`scripted-model: refused ${read.refusal.body}\n`);
          response.statusCode = read.refusal.status;
          response.setHeader('content-type', 'application/json');
          response.end(read.refusal.body);

          return;
        }

        const asked = read.request;
        const answer = script(asked);
        // Every request's surface, on the run's own log: a script that answered
        // prose where a tool call was meant is read here first.
        process.stderr.write(`scripted-model: tools=${asked.available.join(',')} called=${asked.called.join(',')} users=${JSON.stringify(asked.userTexts)}\n`);
        answers.push(answer);

        if (answer.rateLimited !== undefined) {
          const limited = rateLimitedAnswer(answer.rateLimited);

          response.writeHead(limited.status, limited.headers);
          response.end(limited.body);

          return;
        }

        if (asked.streamed && answer.pace !== undefined) {
          response.setHeader('content-type', 'text/event-stream');
          writePaced(response, answer, answer.pace, asked);

          return;
        }

        const { contentType, body: answered } = scriptedBody(answer, asked);
        response.setHeader('content-type', contentType);
        response.end(answered);

        return;
      }

      response.statusCode = 404;
      response.end('nope');
    });
  });

  const listening = Promise.withResolvers<void>();

  http.once('error', listening.reject);
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;

  const address = v.parse(v.object({ port: v.number() }), http.address());

  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    answers,
    stop: async () => {
      const closed = Promise.withResolvers<void>();
      http.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** Point the `openai-compat` credential of the account `headers` name at the scripted model at `baseURL`: a local
 *  server's, or the deployed tiers' Worker. */
export async function registerScriptedModel(
  origin: string, baseURL: string, headers: Record<string, string> = {}, apiKey = 'fake-key',
): Promise<void> {
  await apiJson(origin, `/api/user/credentials/${SCRIPTED_CREDENTIAL}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'openai-compat', baseURL, apiKey }),
  });
}

/** Point the account's `tavily` search credential at the scripted search the tiers' Worker serves (scripted-search.ts),
 *  so a `web` search takes the keyed path end to end without a real provider. */
export async function registerScriptedSearch(origin: string, baseURL: string, headers: Record<string, string>, token: string): Promise<void> {
  await apiJson(origin, '/api/user/credentials/tavily', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'bearer', token, baseURL }),
  });
}

/** The scripted model as the account's default tier, so every workspace it makes runs on it, the ones made from the
 *  home page included. */
const SCRIPTED_DEFAULT: CatalogNeed = (catalog) => catalog.tiers.default.model === SCRIPTED_MODEL_SPEC
  ? null
  : { ...catalog, tiers: { ...catalog.tiers, default: { ...catalog.tiers.default, model: SCRIPTED_MODEL_SPEC } } };

/** Make the scripted model the default tier of the account `headers` name. Its credential must be registered first. */
export async function defaultToScriptedModel(origin: string, headers: Record<string, string> = {}): Promise<void> {
  await settleCatalog(origin, headers, [SCRIPTED_DEFAULT]);
}
