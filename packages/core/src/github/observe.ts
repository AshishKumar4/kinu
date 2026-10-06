/**
 * The devbox's GitHub writes, read on their way back so the workspace records what its agents did there. Forwarding
 * never waits on the reading: the answer goes back as it came, and the record is written after.
 */
import { Effect } from 'effect';
import { attempt, diagnostics, settle } from '../obs/index';
import { recognizeGitHubHttp, type GitHubFact } from './recognize';

/** Where the egress hands the facts: the workspace object, in work that outlives the answer. */
export interface GitHubRecorder {
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly record: (facts: readonly GitHubFact[]) => Promise<void>;
}

/** Past this nothing is read, and nothing recorded. */
const BODY_LIMIT = 256 * 1024;

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GitHubObserved {
  /** The request to forward: the same one, or one rebuilt from the body read for a GraphQL mutation. */
  readonly request: Request;
  readonly answered: (response: Response) => Response;
}

/** The whole stream as text, or null past `limit`: the rest is cancelled, never drained into memory. */
function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Effect.Effect<string | null> {
  return attempt({ doing: 'reading a GitHub answer to record it', otherwise: 'unavailable' }, async () => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.byteLength;

      if (total > limit) {
        await reader.cancel('past what a GitHub write answers with');

        return null;
      }

      chunks.push(read.value);
    }

    const whole = new Uint8Array(total);
    let at = 0;

    for (const chunk of chunks) {
      whole.set(chunk, at);
      at += chunk.byteLength;
    }

    return new TextDecoder().decode(whole);
  }).pipe(Effect.catch((failed) => Effect.sync(() => {
    diagnostics.failure('egress.github_answer_unread', failed);

    return null;
  })));
}

/** Null for anything that cannot be GitHub work: another host, or a read. */
export function observeGitHub(request: Request, url: URL, recorder: GitHubRecorder | undefined): Effect.Effect<GitHubObserved | null> {
  return Effect.gen(function* () {
    const method = request.method.toUpperCase();

    if (recorder === undefined || (url.hostname !== 'api.github.com' && url.hostname !== 'github.com') || READS.has(method)) return null;
    const graphQl = url.hostname === 'api.github.com' && url.pathname === '/graphql' && request.body !== null;
    // Only a GraphQL mutation names in its request what its answer leaves out: a title, a branch.
    const sent = graphQl ? yield* attempt({ doing: 'reading a GraphQL request to record it', otherwise: 'unavailable' }, async () => request.arrayBuffer()) : null;
    const body = sent === null || sent.byteLength > BODY_LIMIT ? undefined : new TextDecoder().decode(sent);
    const forwarded = sent === null ? request : new Request(request, { method, body: sent });
    // A clone needs no answer read: a 2xx from upload-pack is the whole fact, and its answer is the pack.
    const readsAnswer = url.hostname === 'api.github.com' || url.pathname.endsWith('/git-receive-pack');

    const record = (status: number, answer: string | undefined) => recorder.record(recognizeGitHubHttp(
      { method, url: url.toString(), ...(body !== undefined && { body }) }, { status, ...(answer !== undefined && { body: answer }) },
    ));

    return {
      request: forwarded,
      answered: (response: Response): Response => {
        if (!response.ok) return response;

        if (!readsAnswer || response.body === null) {
          recorder.waitUntil(record(response.status, undefined));

          return response;
        }

        const [back, seen] = response.body.tee();

        recorder.waitUntil(settle(boundedText(seen, BODY_LIMIT).pipe(
          Effect.flatMap((answer) => (answer === null ? Effect.void : Effect.promise(async () => record(response.status, answer)))),
        )));

        return new Response(back, response);
      },
    };
  }).pipe(Effect.catch((failed) => Effect.sync(() => {
    diagnostics.failure('egress.github_observe_failed', failed, { host: url.hostname });

    return null;
  })));
}
