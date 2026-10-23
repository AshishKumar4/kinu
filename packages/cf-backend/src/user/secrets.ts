/**
 * The account's secrets (`core/safety/egress-vault.ts`) on the owner's object: the owner adds, replaces and grants them;
 * a workspace reads only its own grants; the egress opens one for each request that names its placeholder.
 */
import {
  createCredentialCipher, deleteSecret, grantedSecrets, grantSecret, listSecrets, mintEgressPlaceholder, objectNamed, putSecrets,
  resolveEgressInjection, revealedSecrets, revokeSecretGrant, setSecretDestination,
  type ConnectionSecret, type EgressInjectionResult, type EgressRequestFacts, type EgressSecretBinding, type EgressVaultDeps,
  type GrantedSecrets, type SecretInput, type ResolvedCaller, type SecretDestination, type SecretSummary, type UserCaller,
} from '@kinu.run/core';
import { Effect } from 'effect';
import { attempt, diagnostics, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { UserObjectHost } from './user-host';

/** The account's GitHub connection, as the git credential its workspaces hold. */
export interface GitHubGitSource {
  /** Whether a GitHub connection is configured, signed in or not. */
  readonly configured: () => boolean;
  /** The connection's token as git sends it (Basic's password), or null when it holds none. */
  readonly token: () => Promise<string | null>;
}

/** Where the GitHub connection's git placeholder is kept: minted once per account, so a workspace's copy stays good. */
const GITHUB_GIT_PLACEHOLDER_KEY = 'secrets:github-git-placeholder';

/** The connection's own variable, which no owner secret may take: the computer's git helper reads it
 *  (`connectionEnvironment`), and `GIT_TOKEN` carries it for Nimbus's git where the owner set none. */
const GITHUB_GIT_SECRET = 'KINU_GITHUB_TOKEN';

export class UserSecrets {
  constructor(private readonly host: UserObjectHost, private readonly github: GitHubGitSource | null = null) {}

  /**
   * The GitHub connection's git credential as a binding: github.com only, in the Authorization header (git's Basic). Its
   * placeholder is read, or minted and kept, in one synchronous step, so two first reads cannot mint two.
   */
  private githubBinding(): EgressSecretBinding {
    const kept = this.host.ctx.storage.kv.get(GITHUB_GIT_PLACEHOLDER_KEY);
    const placeholder = typeof kept === 'string' ? kept : mintEgressPlaceholder();

    if (placeholder !== kept) this.host.ctx.storage.kv.put(GITHUB_GIT_PLACEHOLDER_KEY, placeholder);

    return { name: GITHUB_GIT_SECRET, hosts: ['github.com'], position: { kind: 'authorization' }, placeholder };
  }

  /** The connection-held secrets a request may carry: the GitHub connection's, which is refused clearly once it is gone. */
  private connectionSecrets(): ConnectionSecret[] {
    const { github } = this;

    if (github === null) return [];

    return [{
      binding: this.githubBinding(),
      open: async () => github.token(),
      gone: github.configured()
        ? 'GitHub is connected but not signed in, so git cannot reach your GitHub repositories. Finish its sign-in in '
          + 'Settings > Connections; the next git command uses it.'
        : 'GitHub is not connected to this account any more, so git cannot reach your GitHub repositories. Connect GitHub '
          + 'again in Settings > Connections; the next git command uses it.',
    }];
  }

  /** The GitHub connection's binding while it holds a token. A token that cannot be read now offers nothing: a grant read
   *  never fails for the connection's health. */
  private heldConnections(): Effect.Effect<EgressSecretBinding[]> {
    const { github } = this;

    if (github === null) return Effect.succeed([]);

    return Effect.catch(
      Effect.tryPromise({ try: async () => (await github.token() === null ? [] : [this.githubBinding()]), catch: (cause) => cause }),
      (cause) => Effect.sync(() => {
        diagnostics.event('secrets.github_credential_unread', { cause: renderThrownChain({ cause }) });

        return [];
      }),
    );
  }

  /** Every workspace of the account drops its secrets: a connection that bears one came or went. */
  connectionsMoved(): Promise<void> {
    return settle(this.moved(this.host.sqlx<{ name: string }>(`SELECT name FROM user_workspaces`).map((row) => row.name)));
  }

  /** AAD names this secret in this object, so a ciphertext cannot be replayed in another row or account. */
  private async deps(): Promise<EgressVaultDeps> {
    return {
      sql: this.host.ctx.storage.sql,
      cipher: await createCredentialCipher(this.host.env),
      aad: (name) => `${this.host.ctx.id.toString()}:secret:${name}`,
    };
  }

  /** Never a value or a placeholder. */
  listSecrets(caller: UserCaller): Promise<SecretSummary[]> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');

      return listSecrets(this.host.ctx.storage.sql);
    }));
  }

  putSecrets(caller: UserCaller, entries: readonly SecretInput[], grantTo: readonly string[]): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');
      const deps = yield* Effect.promise(() => this.deps());

      yield* this.moved(yield* Effect.promise(() => putSecrets(deps, entries, grantTo)));
    }));
  }

  setSecretDestination(caller: UserCaller, name: string, destination: SecretDestination): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');
      yield* this.moved(yield* Effect.promise(() => setSecretDestination(this.host.ctx.storage.sql, name, destination)));
    }));
  }

  deleteSecret(caller: UserCaller, name: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');
      yield* this.moved(yield* Effect.promise(() => deleteSecret(this.host.ctx.storage.sql, name)));
    }));
  }

  grantSecret(caller: UserCaller, input: { readonly name: string; readonly workspace: string; readonly reveal: boolean }): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');
      yield* Effect.promise(() => grantSecret(this.host.ctx.storage.sql, input));
      yield* this.moved([input.workspace]);
    }));
  }

  revokeSecretGrant(caller: UserCaller, input: { readonly name: string; readonly workspace: string }): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.manage');

      if (revokeSecretGrant(this.host.ctx.storage.sql, input)) yield* this.moved([input.workspace]);
    }));
  }

  /** The calling workspace's own grants; the owner capability names no workspace, so it has none to read. */
  grantedSecrets(caller: UserCaller): Promise<GrantedSecrets> {
    return settle(Effect.gen({ self: this }, function* () {
      const workspace = yield* this.callingWorkspace(caller);
      const connections = yield* this.heldConnections();

      return grantedSecrets(this.host.ctx.storage.sql, workspace, connections);
    }));
  }

  /** The values the calling workspace's agents may read; asked for each command and never kept there. */
  revealedSecrets(caller: UserCaller): Promise<Record<string, string>> {
    return settle(Effect.gen({ self: this }, function* () {
      const workspace = yield* this.callingWorkspace(caller);
      const deps = yield* Effect.promise(() => this.deps());

      return yield* Effect.promise(() => revealedSecrets(deps, workspace));
    }));
  }

  /**
   * The values `workspace`'s agents may read, for its computer to hand a supervised job it starts or restarts by
   * itself, in memory: the box holds the owner capability and names the workspace from its own configuration.
   */
  revealedSecretsFor(caller: UserCaller, workspace: string): Promise<Record<string, string>> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.inject');
      const deps = yield* Effect.promise(() => this.deps());

      return yield* Effect.promise(() => revealedSecrets(deps, workspace));
    }));
  }

  /** `workspace` comes from the egress's own sealed props, never from the program whose request this is. */
  resolveEgressInjection(caller: UserCaller, facts: EgressRequestFacts, workspace: string): Promise<EgressInjectionResult> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.require(caller, 'secrets.inject');
      const deps = yield* Effect.promise(() => this.deps());
      const connections = this.connectionSecrets();

      return yield* Effect.promise(() => resolveEgressInjection(deps, facts, workspace, connections));
    }));
  }

  /** The caller's tier, refused as the owner's object refuses any call: its refusal is the caller's answer. */
  private require(caller: UserCaller, capability: 'secrets.manage' | 'secrets.inject' | 'secrets.read_self'): Effect.Effect<ResolvedCaller> {
    return Effect.promise(() => this.host.requireTier(caller, capability));
  }

  private callingWorkspace(caller: UserCaller): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const resolved = yield* this.require(caller, 'secrets.read_self');

      if (resolved.kind !== 'workspace') return yield* new KinuError('denied', 'Only a workspace reads its own secrets; this call named none.');

      return resolved.workspace;
    });
  }

  /**
   * Each workspace whose secrets changed drops what it holds of them, so its next command reads them as they stand. One
   * that does not answer keeps its placeholders until its next restart; the egress still judges each request afresh.
   */
  private moved(workspaces: readonly string[]): Effect.Effect<void> {
    return Effect.asVoid(Effect.forEach(workspaces, (workspace) => Effect.catch(
      attempt({ doing: `telling ${workspace} its secrets moved`, otherwise: 'unavailable' }, () => objectNamed(this.host.env.OrchestratorAgent, workspace).secretsMoved()),
      (failure) => Effect.sync(() => { diagnostics.failure('secrets.workspace_unreachable', failure, { workspace }); }),
    ), { concurrency: 'unbounded' }));
  }
}
