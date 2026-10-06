// A listing that takes two seconds or more names the provider that held it, so a slow read in production says where
// its time went (2026-10-05: one GET /api/user/models ran 5.2 s before the client dropped it, and nothing said why).
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createProviderRegistry, type ModelProvider, type ProviderDeps } from '../src/index';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';

afterEach(() => { setSystemTime(); });

function provider(id: string, heldMs: number): ModelProvider {
  return {
    id,
    label: id,
    isAvailable: async () => true,
    unavailableReason: () => undefined,
    listModels: async () => {
      if (heldMs > 0) {
        // The quick providers settle first, then this one holds the listing.
        const turn = Promise.withResolvers<void>();
        setImmediate(turn.resolve);
        await turn.promise;
        setSystemTime(new Date(Date.now() + heldMs));
      }

      return [{ id: `${id}-model` }];
    },
    createModel: () => { throw new Error('not called'); },
  };
}

const deps: ProviderDeps = { env: {}, getAuth: async () => null, hasCredential: async () => true, listCredentialKeys: async () => [] };

async function listed(providers: readonly ModelProvider[], catalogHeldMs = 0) {
  const registry = createProviderRegistry();

  for (const p of providers) registry.register(p);
  registry.registerDynamic({
    get: () => undefined,
    listIds: async () => {
      setSystemTime(new Date(Date.now() + catalogHeldMs));

      return [];
    },
  });
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  try {
    await registry.listAllModels(deps);
  } finally {
    restore();
  }

  return log.emitted.filter((row) => row.event === 'models.listing_slow');
}

describe('a slow model listing', () => {
  test('names the provider that held it', async () => {
    setSystemTime(new Date('2026-10-05T17:27:23Z'));

    expect(await listed([provider('quick', 0), provider('claude', 4_800)])).toMatchObject([{ fields: { provider: 'claude', ms: 4_800 } }]);
  });

  // The models.dev read that names the catalog's providers runs before any of them is probed.
  test('names the catalog when its read held the listing', async () => {
    setSystemTime(new Date('2026-10-05T17:27:23Z'));

    expect(await listed([provider('quick', 0)], 4_800)).toMatchObject([{ fields: { provider: 'catalog', ms: 4_800 } }]);
  });

  test('a quick listing says nothing', async () => {
    setSystemTime(new Date('2026-10-05T17:27:23Z'));

    expect(await listed([provider('quick', 300), provider('steady', 1_200)])).toEqual([]);
  });
});
