/**
 * What the owner's account says that a workspace's turns read: its memory, its settings revision, its profile catalog,
 * the secrets granted to it. Each is asked of the owner's user object as this workspace, and the settings and grants are
 * held under their refresh rule.
 */
import { Effect } from 'effect';
import type { AccountMemory, AccountProposer, CommandEnvironment, Fact, GrantedSecrets, ProfileCatalogEnvelope, UserCaller } from '@kinu.run/core';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import type { UserDO } from './user/user-do';
import type { UserDoRpcMethod } from './rpc-surface';

/** Only RPC methods rpc-surface.ts declares reachable; any other is a compile error. */
export type UserHubClient = Pick<UserDO, UserDoRpcMethod>;

/** One read held until dropped; a failed read is not held, so the next need asks again. */
export class HeldRead<A> {
  #held: Promise<A> | null = null;
  #value: A | undefined = undefined;

  get(read: () => Promise<A>): Promise<A> {
    const held = this.#held ?? read();

    this.#held = held;

    return settle(attempt({ doing: 'reading what the account says', otherwise: 'unavailable' }, () => held).pipe(
      Effect.tap((value) => Effect.sync(() => { if (this.#held === held) this.#value = value; })),
      Effect.tapError(() => Effect.sync(() => { if (this.#held === held) this.#held = null; })),
    ));
  }

  /** Reads again, holding what it held until the new read answers; a failed read leaves that standing. */
  again(read: () => Promise<A>): Promise<A> {
    this.#held = null;

    return this.get(read);
  }

  /** What it holds once read; none until a first read answers. */
  get current(): A | undefined {
    return this.#value;
  }

  /** Holds what the account already said. */
  hold(value: A): void {
    this.#held = Promise.resolve(value);
    this.#value = value;
  }

  drop(): void {
    this.#held = null;
    this.#value = undefined;
  }
}

export interface AccountReadsHost {
  /** The owner's user object and the caller this workspace reads it as; refused while the workspace has no owner. */
  hub(): Promise<{ stub: UserHubClient; caller: UserCaller }>;
  owned(): boolean;
  /** The workspace's name, which a failed read is reported under. */
  workspace(): string;
}

export class AccountReads {
  /**
   * The account's reads a turn makes, held under their refresh rule (design v2 §3, §8): read at their first need, and
   * read again only once the account's settings moved: it says so to a workspace awake when they change (`expire`), and
   * one at rest, which a change does not wake, asks as a turn opens (`settingsAtOpen`).
   */
  private readonly heldRevision = new HeldRead<number>();

  private readonly heldCatalog = new HeldRead<ProfileCatalogEnvelope>();

  /** Names, hosts and placeholders only: a value this workspace's agents may read is asked for at each use. */
  private readonly heldSecrets = new HeldRead<GrantedSecrets>();

  constructor(private readonly host: AccountReadsHost) {}

  /** One read of the account, as this workspace. */
  private async ask<A>(read: (stub: UserHubClient, caller: UserCaller) => Promise<A>): Promise<A> {
    const { stub, caller } = await this.host.hub();

    return await read(stub, caller);
  }

  /**
   * The account's memory as `proposer` reaches it; each call finds the hub then, so a toolset built before the workspace
   * was claimed reaches it once it is. `proposer` is who a proposal names.
   */
  memory(proposer: AccountProposer): AccountMemory {
    return {
      facts: async () => await this.ask((stub, caller) => stub.accountMemory_facts(caller)),
      searchNotes: async (query, limit) => await this.ask((stub, caller) => stub.accountMemory_searchNotes(caller, query, limit)),
      propose: async (proposal, delivery) => await this.ask((stub, caller) => stub.accountMemory_propose(caller, proposal, proposer, delivery)),
    };
  }

  /** The account's memory, or none where this workspace has no owner to hold it. */
  ownedMemory(proposer: AccountProposer): AccountMemory | undefined {
    return this.host.owned() ? this.memory(proposer) : undefined;
  }

  /** The account's facts for one turn of `agent`'s memory block; a user object that does not answer costs the turn that
   *  block's account lines, never the turn. */
  factsForTurn(agent: string): Promise<readonly Fact[]> {
    return settle(Effect.catch(attempt({ doing: "reading the account's facts for the turn", otherwise: 'unavailable' }, async () => await this.memory({ by: 'agent', agent }).facts()),
      (failure) => Effect.sync(() => {
        diagnostics.failure('memory.account_read_failed', failure, { workspace: this.host.workspace() });

        return [];
      })));
  }

  catalog(): Promise<ProfileCatalogEnvelope> {
    return this.heldCatalog.get(() => this.ask((stub, caller) => stub.getWorkspaceProfileCatalog(caller)));
  }

  /** The account says its model settings changed: what it said before is read again at its next need. */
  expire(): void {
    this.heldRevision.drop();
    this.heldCatalog.drop();
  }

  /**
   * A turn opens: one call asks the account its settings revision, and the catalog held here is read again only if its
   * version moved; the credentials' revision is the answer itself. A turn opens on what the account says now, though a
   * change made while this workspace rested never reached it.
   */
  settingsAtOpen(): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const [now] = yield* Effect.all([Effect.promise(() => this.ask((stub, caller) => stub.getSettingsRevision(caller))), this.secretsAtOpen()], { concurrency: 'unbounded' });

      if (this.heldCatalog.current?.version !== now.catalog) this.heldCatalog.drop();
      this.heldRevision.hold(now.credentials);
    }));
  }

  /** The account's credentials revision a turn's open last read; null before one opened in this activation. */
  openedCredentialsRevision(): number | null {
    return this.heldRevision.current ?? null;
  }

  /** The owner's secrets granted to this workspace, held until the account says they moved (`secretsMoved`). */
  grantedSecrets(): Promise<GrantedSecrets> {
    return this.heldSecrets.get(() => this.ask((stub, caller) => stub.grantedSecrets(caller)));
  }

  /**
   * The secrets as a command's variables; a workspace with no owner has none. An account that does not answer costs the
   * command its secrets, never the command: one that needs none runs as it would (8c56762c6), and the next asks again.
   */
  commandEnvironment(use: Parameters<CommandEnvironment>[0]): ReturnType<CommandEnvironment> {
    return settle(Effect.catch(attempt({ doing: "reading this workspace's secrets for a command", otherwise: 'unavailable' }, async (): Promise<Record<string, string>> => {
      if (!this.host.owned()) return {};
      const { granted } = await this.grantedSecrets();
      const placeholders = Object.fromEntries(granted.map((secret) => [secret.name, secret.placeholder]));

      if (use === 'keep' || !granted.some((secret) => secret.reveal)) return placeholders;

      return { ...placeholders, ...await this.ask((stub, caller) => stub.revealedSecrets(caller)) };
    }), (failure) => Effect.sync(() => {
      diagnostics.failure('secrets.environment_unread', failure, { workspace: this.host.workspace() });

      return {};
    })));
  }

  /**
   * Read as a turn opens, so its context names the secrets granted here before any command ran (`secretsHeld`); an
   * account that does not answer costs the turn that section, never the turn.
   */
  private secretsAtOpen(): Effect.Effect<void> {
    if (!this.host.owned()) return Effect.void;

    return Effect.catch(attempt({ doing: "reading this workspace's secrets as a turn opens", otherwise: 'unavailable' }, async () => {
      await this.grantedSecrets();
    }), (failure) => Effect.sync(() => {
      diagnostics.failure('secrets.grants_unread', failure, { workspace: this.host.workspace() });
    }));
  }

  /** The grants as this workspace last read them, for a step's context; none before a first read answered. */
  get secretsHeld(): GrantedSecrets | undefined {
    return this.heldSecrets.current;
  }

  /** The account changed this workspace's secrets: they are read again at their next need. */
  secretsMoved(): void {
    this.heldSecrets.drop();
  }

  /** The account's credentials revision as this workspace holds it, read at its first need. */
  credentialsRevision(): Promise<number> {
    return this.heldRevision.get(() => this.ask((stub, caller) => stub.getCredentialsRevision(caller)));
  }
}
