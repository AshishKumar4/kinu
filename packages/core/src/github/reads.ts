// One read of GitHub's REST API through the account's GitHub connection, made by the account so its token never leaves
// it: GET only, only to api.github.com. Every answer GitHub gives comes back as it is, with what a caller revalidates and
// paces by (`Last-Modified`, `X-Poll-Interval`, `Retry-After`); an agent's operation says a refusal in GitHub's words
// (`tools/github-operations.ts`). docs.github.com/rest/activity/notifications, read 2026-10-24.
import { Effect } from 'effect';
import { KinuError, settle, tolerate } from '../obs/index';
import type { GitHubAnswer, GitHubRead } from '../operations/github';
import { plainFetch } from '../providers/fetch-shim';
import { parseJsonValue, type JsonValue } from '../utils/json';

const API = 'https://api.github.com';

const NOT_CONNECTED = 'GitHub is not connected to this account. Its owner connects it in Settings > Connections; then call again.';

/** `token`: the connection's, or null with none. */
export function readGitHub(asked: GitHubRead, token: () => Promise<string | null>, fetchFn: typeof fetch = fetch): Promise<GitHubAnswer> {
  return settle(Effect.gen(function* () {
    const url = new URL(asked.path, API);

    for (const [name, value] of Object.entries(asked.query ?? {})) url.searchParams.set(name, String(value));

    if (url.origin !== API) return yield* new KinuError('denied', 'The GitHub connection reads only api.github.com.');
    const held = yield* Effect.promise(() => token());

    if (held === null) return yield* new KinuError('denied', NOT_CONNECTED);

    const response = yield* Effect.promise(() => plainFetch(fetchFn)(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${held}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Kinu',
        ...(asked.ifModifiedSince !== undefined && { 'if-modified-since': asked.ifModifiedSince }),
      },
      redirect: 'error',
    }));

    const text = yield* Effect.promise(() => response.text());
    const body: JsonValue = text === '' ? null : tolerate(() => parseJsonValue(text), 'malformed-input') ?? text;
    const lastModified = response.headers.get('last-modified');
    const pollInterval = Number(response.headers.get('x-poll-interval') ?? Number.NaN);
    const retryAfter = response.headers.get('retry-after');

    return {
      status: response.status, body,
      headers: { ...(lastModified !== null && { lastModified }), ...(Number.isFinite(pollInterval) && { pollInterval }), ...(retryAfter !== null && { retryAfter }) },
    };
  }));
}
