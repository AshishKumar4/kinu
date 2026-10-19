/**
 * The account's secrets (`core/safety/egress-vault.ts`) on the owner's object: the owner adds, replaces and grants them;
 * a workspace reads only its own grants; the egress opens one for each request that names its placeholder.
 */
import {
  createCredentialCipher, deleteSecret, grantedSecrets, grantSecret, listSecrets, objectNamed, putSecrets, resolveEgressInjection,
  revealedSecrets, revokeSecretGrant, setSecretDestination,
  type EgressInjectionResult, type EgressRequestFacts, type EgressVaultDeps, type GrantedSecrets, type SecretInput,
  type ResolvedCaller, type SecretDestination, type SecretSummary, type UserCaller,
} from '@kinu.run/core';
import { Effect } from 'effect';
import { attempt, diagnostics, KinuError, settle } from '@kinu.run/core/obs';
import type { UserObjectHost } from './user-host';

export class UserSecrets {
  constructor(private readonly host: UserObjectHost) {}

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
    return settle(Effect.map(this.callingWorkspace(caller), (workspace) => grantedSecrets(this.host.ctx.storage.sql, workspace)));
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

      return yield* Effect.promise(() => resolveEgressInjection(deps, facts, workspace));
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
