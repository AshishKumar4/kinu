// Repository hooks for a workspace's push watchers, made with the account's GitHub connection so its token never leaves
// the account: each delivers only to the deployment's own signed webhook route of the workspace that asked, is kept by
// name, and is deleted while the token still holds when the GitHub connection goes.
// docs.github.com/rest/repos/webhooks (create: POST /repos/{owner}/{repo}/hooks, 201; delete: 204), read 2026-10-23.
import { Effect } from 'effect';
import * as v from 'valibot';
import { matchWebhookDeliveryPath, parseJsonValue, plainFetch, type JsonValue, type ResolvedCaller } from '@kinu.run/core';
import { diagnostics, KinuError, settle, tolerate } from '@kinu.run/core/obs';

const GitHubHookAskSchema = v.object({
  /** `owner/repo`, as GitHub names them. */
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u)),
  /** The trigger's signed delivery route on this deployment. */
  url: v.pipe(v.string(), v.url()),
  /** What GitHub signs each delivery with (`X-Hub-Signature-256`). */
  secret: v.pipe(v.string(), v.minLength(32)),
  /** One event: a signature covers the body alone, so a hook delivering one event is what says which a body is. */
  events: v.pipe(v.array(v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/u))), v.length(1)),
});

export type GitHubHookAsk = v.InferOutput<typeof GitHubHookAskSchema>;

/** A hook made, by where it delivers; `stale` once deleting it failed as GitHub went, to be deleted again on reconnect. */
const KeptHookSchema = v.object({ repo: v.string(), hookId: v.number(), workspace: v.string(), stale: v.optional(v.literal(true)) });

type KeptHook = v.InferOutput<typeof KeptHookSchema>;

const HOOK_KEY = 'github-hook:';

const keyOf = (hook: KeptHook) => `${HOOK_KEY}${hook.workspace}:${hook.repo}:${hook.hookId}`;

export interface GitHubHooksHost {
  readonly storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  /** The deployment's public origin, which every hook delivers to. */
  readonly origin: string | undefined;
  /** The GitHub connection's token; null with none held. */
  readonly token: () => Promise<string | null>;
}

const NOT_CONNECTED = 'GitHub is not connected to this account. Connect it in Settings > Connections; then ask again.';

interface GitHubAnswer {
  readonly status: number;
  readonly body: JsonValue;
}

function askGitHub(token: string, method: 'POST' | 'DELETE', path: string, body?: JsonValue): Effect.Effect<GitHubAnswer> {
  return Effect.promise(async () => {
    const response = await plainFetch(fetch)(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Kinu',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    const text = await response.text();

    return { status: response.status, body: text === '' ? null : tolerate(() => parseJsonValue(text), 'malformed-input') ?? text };
  });
}

/** GitHub's refusal in its words: its `message`, else its status. */
function saidBy(answer: GitHubAnswer): string {
  const said = v.safeParse(v.object({ message: v.string() }), answer.body);

  return said.success ? said.output.message : `HTTP ${answer.status}`;
}

export class GitHubHooks {
  /** Moves each time the GitHub connection goes: a hook GitHub made while it went is deleted, not kept. */
  private generation = 0;
  /** From the connection starting to go until a token holds again: no hook is made meanwhile. */
  private closing = false;

  constructor(private readonly host: GitHubHooksHost) {}

  /** A hook on `repo` delivering `events` to the asking workspace's own signed route; its id. */
  create(caller: ResolvedCaller, asked: GitHubHookAsk): Promise<{ readonly hookId: number }> {
    const { host, closing } = this;
    const started = this.generation;
    const gone = () => this.generation !== started;

    return settle(Effect.gen(function* () {
      const ask = v.parse(GitHubHookAskSchema, asked);
      const workspace = yield* deliveredTo(host.origin, caller, ask.url);
      const token = closing ? null : yield* Effect.promise(() => host.token());

      if (token === null) return yield* new KinuError('denied', NOT_CONNECTED);

      const answer = yield* askGitHub(token, 'POST', `/repos/${ask.repo}/hooks`, {
        name: 'web', active: true, events: ask.events, config: { url: ask.url, content_type: 'json', secret: ask.secret, insecure_ssl: '0' },
      });

      const made = v.safeParse(v.object({ id: v.number() }), answer.body);

      if (answer.status !== 201 || !made.success) {
        // GitHub answers 404 to a repository the token cannot administer, as to one that does not exist.
        const admin = answer.status === 404 ? ' (the GitHub connection needs admin rights on it)' : '';

        return yield* new KinuError(answer.status === 422 ? 'bad_input' : 'denied', `GitHub would not make a hook on ${ask.repo}: ${saidBy(answer)}${admin}`);
      }

      // GitHub went while the hook was made: no disconnect will delete it, so it is deleted now, with the token it was
      // made with, and kept as stale first, so one GitHub will not delete is deleted again on reconnect.
      if (gone()) {
        const late: KeptHook = { repo: ask.repo, hookId: made.output.id, workspace, stale: true };

        yield* Effect.promise(() => host.storage.put(keyOf(late), late));
        yield* deleteHook(host, token, late);

        return yield* new KinuError('denied', `GitHub was disconnected while the hook on ${ask.repo} was made, so it is not kept. ${NOT_CONNECTED}`);
      }

      const kept: KeptHook = { repo: ask.repo, hookId: made.output.id, workspace };

      yield* Effect.promise(() => host.storage.put(keyOf(kept), kept));

      return { hookId: kept.hookId };
    }));
  }

  /** The hook the asking workspace made, deleted at GitHub and forgotten here; one GitHub no longer has is forgotten. */
  delete(caller: ResolvedCaller, repo: string, hookId: number): Promise<void> {
    const { host } = this;

    return settle(Effect.gen(function* () {
      const kept = yield* Effect.promise(async () => (await host.storage.list({ prefix: HOOK_KEY })).values());

      const hook = [...kept].map((value) => v.parse(KeptHookSchema, value))
        .find((held) => held.repo === repo && held.hookId === hookId && (caller.kind === 'owner_session' || held.workspace === caller.workspace));

      if (hook === undefined) return yield* new KinuError('missing', `No hook ${hookId} on ${repo} was made for this workspace.`);
      const token = yield* Effect.promise(() => host.token());

      if (token === null) return yield* new KinuError('denied', NOT_CONNECTED);
      const answer = yield* askGitHub(token, 'DELETE', `/repos/${repo}/hooks/${hookId}`);

      if (answer.status !== 204 && answer.status !== 404) return yield* new KinuError('unavailable', `GitHub would not delete hook ${hookId} on ${repo}: ${saidBy(answer)}`);
      yield* Effect.promise(() => host.storage.delete(keyOf(hook)));
    }));
  }

  /** Every hook made, deleted while the connection's token still holds: called as the GitHub connection goes. One GitHub
   *  will not delete is kept as stale, deleted again once GitHub is connected ({@link connectionsMoved}). The workspaces
   *  they delivered to. */
  deleteAll(): Promise<readonly string[]> {
    this.generation += 1;
    this.closing = true;

    return settle(this.deleteKept(() => true));
  }

  /**
   * The account's connections changed, and a GitHub token is `held` or not; whether hooks may be made now. None held ends
   * a disconnect. One held while GitHub is still going (another connection moved meanwhile) changes nothing; otherwise the
   * hooks GitHub would not delete as it went are deleted first.
   */
  connectionsMoved(held: boolean): Promise<boolean> {
    if (!held) this.closing = false;

    if (!held || this.closing) return Promise.resolve(false);

    return settle(Effect.as(this.deleteKept((hook) => hook.stale === true), true));
  }

  private deleteKept(which: (hook: KeptHook) => boolean): Effect.Effect<readonly string[]> {
    const { host } = this;

    return Effect.gen(function* () {
      const listed = yield* Effect.promise(() => host.storage.list({ prefix: HOOK_KEY }));
      const kept = [...listed.values()].map((value) => v.parse(KeptHookSchema, value)).filter(which);

      if (kept.length === 0) return [];
      const token = yield* Effect.promise(() => host.token());

      for (const hook of kept) yield* deleteHook(host, token, hook);

      return [...new Set(kept.map((hook) => hook.workspace))];
    });
  }
}

/** A kept hook deleted at GitHub, then forgotten; one GitHub will not delete, or with no token, is kept as stale. */
function deleteHook(host: GitHubHooksHost, token: string | null, hook: KeptHook): Effect.Effect<void> {
  return Effect.gen(function* () {
    const answer = token === null ? null : yield* askGitHub(token, 'DELETE', `/repos/${hook.repo}/hooks/${hook.hookId}`);

    if (answer !== null && (answer.status === 204 || answer.status === 404)) {
      yield* Effect.promise(() => host.storage.delete(keyOf(hook)));

      return;
    }

    diagnostics.event('github.hook_not_deleted', { repo: hook.repo, hookId: hook.hookId, workspace: hook.workspace, said: answer === null ? 'no token' : saidBy(answer) });
    yield* Effect.promise(() => host.storage.put(keyOf(hook), { ...hook, stale: true }));
  });
}

/** The workspace a hook may deliver to: this deployment's signed webhook route, of the workspace that asks. */
function deliveredTo(origin: string | undefined, caller: ResolvedCaller, url: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    if (origin === undefined || origin === '') return yield* new KinuError('unavailable', 'This deployment names no public origin (CLI_PUBLIC_ORIGIN), so GitHub has nowhere to deliver.');
    const target = new URL(url);
    const route = matchWebhookDeliveryPath(target.pathname);

    if (target.origin !== new URL(origin).origin || route === null || route.kind !== 'signed') {
      return yield* new KinuError('bad_input', 'A hook delivers only to this deployment\'s own webhook route.');
    }

    if (caller.kind === 'workspace' && route.workspaceName !== caller.workspace) return yield* new KinuError('denied', 'A hook delivers only to the workspace that asks for it.');

    return route.workspaceName;
  });
}
