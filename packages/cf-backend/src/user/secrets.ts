/**
 * The account's secrets (`core/safety/egress-vault.ts`) on the owner's object: the owner adds, replaces and grants them;
 * a workspace reads only its own grants; the egress opens one for each request that names its placeholder.
 */
import {
  createCredentialCipher, deleteSecret, grantedSecrets, grantSecret, listSecrets, objectNamed, putSecrets, resolveEgressInjection,
  revealedSecrets, revokeSecretGrant, setSecretHosts,
  type EgressInjectionResult, type EgressRequestFacts, type EgressVaultDeps, type GrantedSecrets, type SecretInput,
  type SecretSummary, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';
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
  async listSecrets(caller: UserCaller): Promise<SecretSummary[]> {
    await this.host.requireTier(caller, 'secrets.manage');

    return listSecrets(this.host.ctx.storage.sql);
  }

  async putSecrets(caller: UserCaller, entries: readonly SecretInput[], grantTo: readonly string[]): Promise<void> {
    await this.host.requireTier(caller, 'secrets.manage');
    await this.moved(await putSecrets(await this.deps(), entries, grantTo));
  }

  async setSecretHosts(caller: UserCaller, name: string, hosts: readonly string[]): Promise<void> {
    await this.host.requireTier(caller, 'secrets.manage');
    await this.moved(await setSecretHosts(this.host.ctx.storage.sql, name, hosts));
  }

  async deleteSecret(caller: UserCaller, name: string): Promise<void> {
    await this.host.requireTier(caller, 'secrets.manage');
    await this.moved(await deleteSecret(this.host.ctx.storage.sql, name));
  }

  async grantSecret(caller: UserCaller, input: { readonly name: string; readonly workspace: string; readonly reveal: boolean }): Promise<void> {
    await this.host.requireTier(caller, 'secrets.manage');
    await grantSecret(this.host.ctx.storage.sql, input);
    await this.moved([input.workspace]);
  }

  async revokeSecretGrant(caller: UserCaller, input: { readonly name: string; readonly workspace: string }): Promise<void> {
    await this.host.requireTier(caller, 'secrets.manage');

    if (revokeSecretGrant(this.host.ctx.storage.sql, input)) await this.moved([input.workspace]);
  }

  /** The calling workspace's own grants; the owner capability names no workspace, so it has none to read. */
  async grantedSecrets(caller: UserCaller): Promise<GrantedSecrets> {
    return grantedSecrets(this.host.ctx.storage.sql, await this.callingWorkspace(caller));
  }

  /** The values the calling workspace's agents may read; asked for each command and never kept there. */
  async revealedSecrets(caller: UserCaller): Promise<Record<string, string>> {
    return revealedSecrets(await this.deps(), await this.callingWorkspace(caller));
  }

  /** `workspace` comes from the egress's own sealed props, never from the program whose request this is. */
  async resolveEgressInjection(caller: UserCaller, facts: EgressRequestFacts, workspace: string): Promise<EgressInjectionResult> {
    await this.host.requireTier(caller, 'secrets.inject');

    return resolveEgressInjection(await this.deps(), facts, workspace);
  }

  private async callingWorkspace(caller: UserCaller): Promise<string> {
    const resolved = await this.host.requireTier(caller, 'secrets.read_self');

    if (resolved.kind !== 'workspace') throw new KinuError('denied', 'Only a workspace reads its own secrets; this call named none.');

    return resolved.workspace;
  }

  /** Each workspace whose secrets changed drops what it holds of them, so its next command reads them as they stand. */
  private async moved(workspaces: readonly string[]): Promise<void> {
    await Promise.all(workspaces.map(async (workspace) => {
      try {
        await objectNamed(this.host.env.OrchestratorAgent, workspace).secretsMoved();
      } catch (cause) {
        diagnostics.event('secrets.workspace_unreachable', { workspace, error: renderThrownChain({ cause }) });
      }
    }));
  }
}
