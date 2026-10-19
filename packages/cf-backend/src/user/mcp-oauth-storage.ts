/**
 * The Agents SDK keeps an MCP server's OAuth tokens, client registration and PKCE state in the storage its provider is
 * handed (`agents/mcp/do-oauth-client-provider`). Handed this, each value is sealed with the credential cipher as it
 * lands and opened as it is read, so a stored login carries the same envelope as every other credential.
 */
import { Effect } from 'effect';
import { createCredentialCipher, parseJsonValue, type CredentialEncryptionEnv, type JsonValue } from '@kinu.run/core';
import { attempt, diagnostics, KinuError, settle, tolerate } from '@kinu.run/core/obs';

/** The storage members the SDK's provider reads and writes values through (agents 0.26.0); `delete` reads none. */
type SealedMember = 'get' | 'put' | 'list';

/**
 * The account object's storage as every OAuth provider of its MCP servers is handed it, the SDK's restore included
 * (`UserDO.createMcpOAuthProvider`). The AAD names the object and never the key: the SDK's `migrateServerId` copies
 * values between keys over the raw storage, and a value it moved must still open.
 */
export function mcpOAuthStorage(ctx: { readonly storage: DurableObjectStorage; readonly id: DurableObjectId }, env: CredentialEncryptionEnv): DurableObjectStorage {
  const sealed = new SealedValues(ctx.storage, env, `${ctx.id.toString()}:mcp-oauth`);

  return new Proxy(ctx.storage, {
    get(target, property) {
      if (property === 'get' || property === 'put' || property === 'list') return sealed[property].bind(sealed);

      if (!isMember(target, property)) return undefined;
      const member = target[property];

      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** The value reads and writes the SDK's provider makes, sealed; typed loosely, as no sealed read can be any `<T>` asked. */
class SealedValues implements Record<SealedMember, (...args: never[]) => Promise<JsonValue | Map<string, JsonValue> | undefined | void>> {
  constructor(private readonly storage: DurableObjectStorage, private readonly env: CredentialEncryptionEnv, private readonly aad: string) {}

  get(keys: string | string[]): Promise<JsonValue | Map<string, JsonValue> | undefined> {
    return settle(Effect.gen({ self: this }, function* () {
      if (typeof keys !== 'string') return yield* this.openAll(yield* Effect.promise(() => this.storage.get<JsonValue>(keys)));
      const stored = yield* Effect.promise(() => this.storage.get<JsonValue>(keys));

      return stored === undefined ? undefined : yield* this.open(keys, stored);
    }));
  }

  async put(entries: string | Record<string, JsonValue>, value?: JsonValue): Promise<void> {
    if (typeof entries === 'string') return this.storage.put(entries, await this.seal(value ?? null));

    return this.storage.put(Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, entry]) => [key, await this.seal(entry)]))));
  }

  list(options?: DurableObjectListOptions): Promise<Map<string, JsonValue>> {
    return settle(Effect.flatMap(Effect.promise(() => this.storage.list<JsonValue>(options)), (stored) => this.openAll(stored)));
  }

  private async seal(value: JsonValue): Promise<string> {
    return (await createCredentialCipher(this.env)).seal(this.aad, JSON.stringify(value));
  }

  /**
   * A value that does not open (stored before logins were sealed, or under another key) reads as no value: to the SDK
   * that is a server with no login, which it shows as needing sign-in, with the link to sign in again.
   */
  private open(key: string, stored: JsonValue): Effect.Effect<JsonValue | undefined> {
    const { env, aad } = this;

    return Effect.catch(
      Effect.gen(function* () {
        if (typeof stored !== 'string') return yield* new KinuError('bad_input', `the stored MCP sign-in at ${key} is not a sealed envelope`);
        const plaintext = yield* attempt({ doing: `opening the stored MCP sign-in at ${key}`, otherwise: 'bad_input' }, async () => (await createCredentialCipher(env)).open(aad, stored));

        return tolerate(() => parseJsonValue(plaintext), 'malformed-input');
      }),
      (failure) => Effect.sync(() => {
        diagnostics.failure('mcp.oauth_unopened', failure, { server: key.split('/')[2] ?? '' });

        return undefined;
      }),
    );
  }

  private openAll(stored: Map<string, JsonValue>): Effect.Effect<Map<string, JsonValue>> {
    return Effect.reduce(stored, () => new Map<string, JsonValue>(), (opened, [key, value]) => Effect.map(this.open(key, value), (read) => {
      if (read !== undefined) opened.set(key, read);

      return opened;
    }));
  }
}

function isMember(storage: DurableObjectStorage, property: string | symbol): property is keyof DurableObjectStorage {
  return property in storage;
}
