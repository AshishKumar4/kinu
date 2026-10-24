/** GitHub's REST API through the account's GitHub connection, reading only: a watcher's check reads it as a program does. */
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { defineOperation, described } from './operation';

/** A path on api.github.com, with no host, query or fragment of its own: `/notifications`, `/repos/{owner}/{repo}/pulls`. */
const GitHubPathSchema = v.pipe(v.string(), v.regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/), v.check((path) => !path.split('/').includes('..'), 'a path never climbs (`..`)'));

export const GitHubReadSchema = v.object({
  path: GitHubPathSchema,
  query: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()]))),
  /** A conditional read: GitHub answers 304 with no body while nothing changed since. */
  ifModifiedSince: v.optional(v.string()),
});

export type GitHubRead = v.InferOutput<typeof GitHubReadSchema>;

/** GitHub's answer to one read, whatever its status: its JSON (or its text, where it sent none), and its pacing. */
export interface GitHubAnswer {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers: { readonly lastModified?: string; readonly pollInterval?: number; readonly retryAfter?: string };
}

export const GITHUB = {
  read: defineOperation({
    ns: 'github', slate: false, name: 'read', impact: 'observe',
    help: 'GET a path of GitHub\'s REST API (docs.github.com/rest) as the owner\'s GitHub connection. Its answer is GitHub\'s JSON, with `lastModified` to send back as `ifModifiedSince`: an unchanged answer is a 304 with no body, at no cost to the rate limit.',
    input: v.strictObject({
      path: described(GitHubPathSchema, 'As `/notifications`, or `/repos/{owner}/{repo}/pulls/{number}`.'),
      query: v.optional(described(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])), 'Its query parameters: `{ per_page: 50, since: "2026-10-24T00:00:00Z" }`.')),
      ifModifiedSince: v.optional(described(v.string(), 'A `lastModified` an earlier answer gave.')),
    }),
    output: v.strictObject({
      status: v.number(),
      body: JsonValueSchema,
      lastModified: v.optional(v.string()),
      /** GitHub's `X-Poll-Interval`, in seconds: how soon it asks to be read again. */
      pollInterval: v.optional(v.number()),
    }),
  }),
} as const;
