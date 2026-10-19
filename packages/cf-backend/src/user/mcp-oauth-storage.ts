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
  const { storage } = ctx;
  const aad = `${ctx.id.toString()}:mcp-oauth`;

  const seal = async (value: JsonValue): Promise<string> => (await createCredentialCipher(env)).seal(aad, JSON.stringify(value));

  /**
   * A value that does not open (stored before logins were sealed, or under another key) reads as no value: to the SDK
   * that is a server with no login, which it shows as needing sign-in, with the link to sign in again.
   */
  const open = (key: string, stored: JsonValue): Promise<JsonValue | undefined> => settle(Effect.catch(
    attempt({ doing: `opening the stored MCP sign-in at ${key}`, otherwise: 'bad_input' }, async () => {
      if (typeof stored !== 'string') throw new KinuError('bad_input', 'the stored value is not a sealed envelope');
      const plaintext = await (await createCredentialCipher(env)).open(aad, stored);

      return tolerate(() => parseJsonValue(plaintext), 'malformed-input');
    }),
    (failure) => Effect.sync(() => {
      diagnostics.failure('mcp.oauth_unopened', failure, { server: key.split('/')[2] ?? '' });

      return undefined;
    }),
  ));

  const openAll = async (stored: Map<string, JsonValue>): Promise<Map<string, JsonValue>> => {
    const opened = new Map<string, JsonValue>();

    for (const [key, value] of stored) {
      const read = await open(key, value);

      if (read !== undefined) opened.set(key, read);
    }

    return opened;
  };

  // Untyped as the platform's members: their `<T>` overloads promise any type a caller names, which no sealed read can.
  const sealed: Record<SealedMember, (...args: never[]) => Promise<JsonValue | Map<string, JsonValue> | undefined | void>> = {
    get: async (keys: string | string[]) => {
      if (typeof keys !== 'string') return openAll(await storage.get<JsonValue>(keys));
      const stored = await storage.get<JsonValue>(keys);

      return stored === undefined ? undefined : open(keys, stored);
    },
    put: async (entries: string | Record<string, JsonValue>, value?: JsonValue) => {
      if (typeof entries === 'string') return storage.put(entries, await seal(value ?? null));

      return storage.put(Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, entry]) => [key, await seal(entry)]))));
    },
    list: async (options?: DurableObjectListOptions) => openAll(await storage.list<JsonValue>(options)),
  };

  return new Proxy(storage, {
    get(target, property) {
      if (property === 'get' || property === 'put' || property === 'list') return sealed[property];

      if (!isMember(target, property)) return undefined;
      const member = target[property];

      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function isMember(storage: DurableObjectStorage, property: string | symbol): property is keyof DurableObjectStorage {
  return property in storage;
}
