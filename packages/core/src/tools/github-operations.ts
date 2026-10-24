/** `github.*` for an agent's programs and its watchers' checks: GitHub's REST API, read as the owner's connection. */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { CodemodeProvider } from '../types/codemode';
import { KinuError } from '../obs/index';
import { serve } from '../operations/operation';
import { GITHUB, type GitHubAnswer, type GitHubRead } from '../operations/github';
import { codemodeNamespace } from './operation-surfaces';

export interface GitHubDeps {
  /** One read through the account's GitHub connection, made by the account: the token never reaches the workspace. */
  readonly read: (request: GitHubRead) => Promise<GitHubAnswer>;
}

/** GitHub's refusal in its own words: its JSON's `message`, else its status; a rate limit says when to try again. */
function refusalOf(answer: GitHubAnswer): KinuError {
  const said = v.safeParse(v.object({ message: v.string() }), answer.body);
  const words = said.success ? said.output.message : `HTTP ${String(answer.status)}`;
  const later = answer.headers.retryAfter === undefined ? '' : ` Try again after ${answer.headers.retryAfter} s.`;
  const limited = answer.status === 429 || (answer.status === 403 && /rate limit/iu.test(words));

  return new KinuError(limited ? 'budget' : 'unavailable', `GitHub refused it: ${words}${later}`);
}

export function createGitHubCodemodeProvider(deps: GitHubDeps): CodemodeProvider {
  return codemodeNamespace('github', 'GitHub\'s REST API through the account\'s GitHub connection, reading only.', [
    // A 304 is an answer: nothing changed since `ifModifiedSince`.
    serve(GITHUB.read, (asked) => Effect.flatMap(Effect.promise(() => deps.read(asked)), (answer) => (
      (answer.status >= 200 && answer.status < 300) || answer.status === 304
        ? Effect.succeed({
          status: answer.status, body: answer.body,
          ...(answer.headers.lastModified !== undefined && { lastModified: answer.headers.lastModified }),
          ...(answer.headers.pollInterval !== undefined && { pollInterval: answer.headers.pollInterval }),
        })
        : Effect.fail(refusalOf(answer))
    ))),
  ]);
}
