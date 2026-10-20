import { describe, expect, test } from 'bun:test';
import { KinuError } from '../src/obs/error';
import {
  ModelCatalogSession, assertToolsSupportedByModel, resolvePromptModelProfile, resolveEffectiveModelSpec,
  outputReserveTokens, stepContextLimit,
  type ModelInfo,
} from '../src/index';

// A model's window is its catalog row's, else the one a too-long refusal measured, else unknown: never a guessed figure.
describe('a model window has one source', () => {
  test('a model no row names, before or after its lookup lands, has an unknown window', async () => {
    const session = new ModelCatalogSession({ effectiveSpec: () => 'anthropic/claude-opus-5-5', lookup: async () => null, measured: () => null });

    expect(session.window()).toEqual({ contextWindow: null, modelOutputLimit: null });
    expect(await session.resolved()).toEqual({ contextWindow: null, modelOutputLimit: null });
    expect(stepContextLimit(session.window())).toBe(Number.POSITIVE_INFINITY);
  });

  test('the catalog row wins over a measured window, which answers only where no row names one', async () => {
    const measured = (spec: string) => (spec.startsWith('openai-compat:') ? 180_000 : 50_000);
    const listed = new ModelCatalogSession({ effectiveSpec: () => 'anthropic/claude-opus-5-5', lookup: async () => ({ id: 'claude-opus-5-5', contextWindow: 1_000_000 }), measured });
    const custom = new ModelCatalogSession({ effectiveSpec: () => 'openai-compat:house/qwen', lookup: async () => ({ id: 'qwen' }), measured });

    expect([(await listed.resolved()).contextWindow, (await custom.resolved()).contextWindow]).toEqual([1_000_000, 180_000]);
  });

  test('the whole Kimi family reads as Kimi without a catalog', () => {
    for (const id of ['moonshotai/kimi-k3', '@cf/moonshotai/kimi-k2.6', 'kimi-k2.7-code']) {
      expect(resolvePromptModelProfile({ id }).family).toBe('kimi');
    }
  });
});

// core-rest review P1-8: tools were refused by a name match ('o4-mini', 'deepseek-r1') whatever the catalog said.
describe('whether a model calls tools is its catalog row\'s answer', () => {
  const contextOf = async (spec: string, row: ModelInfo | null) =>
    new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async () => row, measured: () => null }).contextFor(spec);

  test('a row listing tool calling admits tools, one without refuses them, and no row says nothing', async () => {
    const listed = await contextOf('openai/o4-mini', { id: 'o4-mini', capabilities: ['tools', 'streaming', 'reasoning'] });
    const refused = await contextOf('workers-ai/@cf/house/plain', { id: '@cf/house/plain', capabilities: ['streaming'] });
    const unlisted = await contextOf('openai-compat:house/qwen', null);

    expect([listed.callsTools, refused.callsTools, unlisted.callsTools]).toEqual([true, false, undefined]);
    expect(() => assertToolsSupportedByModel(refused, ['shell'])).toThrow('does not support tool calling');
    // o4-mini, once refused by its name, is admitted: the gate returns and throws nothing.
    expect(assertToolsSupportedByModel(listed, ['shell'])).toBeUndefined();
  });
});

// Pricing is null until the catalog lands, so the budget ledger blends and says so.
// The SufficientKoala audit: the provider was the spec's first slash segment, so a model on a named account read as
// provider `anthropic@work`, outside the PDF-capable transports, and its turns sent a reference in place of the PDF.
describe("a model on a named account takes its provider's attachments", () => {
  test('a PDF reaches Claude on the work account as on main', async () => {
    const row: ModelInfo = { id: 'claude-opus-4-7', inputModalities: ['text', 'image', 'pdf'] };

    const accepted = await Promise.all(['anthropic/claude-opus-4-7', 'anthropic@work/claude-opus-4-7'].map(async (spec) => {
      const session = new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async () => row, measured: () => null });

      await session.resolved();

      return [...session.acceptedMedia()].sort();
    }));

    expect(accepted).toEqual([['image', 'pdf'], ['image', 'pdf']]);
  });
});

describe('ModelCatalogSession.pricing', () => {
  test('null until the lookup lands, then the catalog rates', async () => {
    let resolveLookup: (info: ModelInfo | null) => void = () => {};

    const landed = new Promise<ModelInfo | null>((r) => { resolveLookup = r; });

    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'anthropic/claude-sonnet-4-6',
      lookup: () => landed,
    });

    expect(session.pricing()).toBeNull();
    resolveLookup({ id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cacheRead: 0.3 } });
    await landed;
    expect(session.pricing()).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  });

  test('a model the catalog does not price stays null rather than guessing', async () => {
    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => ({ id: '@cf/moonshotai/kimi-k2.6', contextWindow: 262_144 }),
    });

    session.pricing();
    await Promise.resolve();
    expect(session.pricing()).toBeNull();
    expect(session.contextWindow()).toBe(262_144);
  });

  test('another model prices at its own rate once warmed, and never at the session model\u2019s', async () => {
    const rates = new Map<string, ModelInfo>([
      ['anthropic/claude-sonnet-4-6', { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15 } }],
      ['openai/gpt-5.5', { id: 'gpt-5.5', cost: { input: 5, output: 40 } }],
    ]);

    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'anthropic/claude-sonnet-4-6',
      lookup: async (spec) => rates.get(spec) ?? null,
    });

    await session.resolved();
    expect(session.pricing('openai/gpt-5.5')).toBeNull();
    await session.warm(['openai/gpt-5.5', 'openai/unlisted']);
    expect(session.pricing('openai/gpt-5.5')).toEqual({ input: 5, output: 40 });
    expect(session.pricing('openai/unlisted')).toBeNull();
    expect(session.pricing('anthropic/claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
  });
});

// The SufficientKoala audit: the selected spec and every other kept apart caches, so a warmed model was looked up again
// once selected, switching away and back looked the first up again, and meanwhile each read an unknown window and price.
describe('ModelCatalogSession keeps one entry per spec', () => {
  test('a model looked up once reads the same row whichever model is selected, with no second lookup', async () => {
    const rows = new Map<string, ModelInfo>([
      ['anthropic/claude-sonnet-4-6', { id: 'claude-sonnet-4-6', contextWindow: 1_000_000, cost: { input: 3, output: 15 } }],
      ['openai/gpt-5.5', { id: 'gpt-5.5', contextWindow: 400_000, cost: { input: 5, output: 40 } }],
    ]);

    let selected = 'anthropic/claude-sonnet-4-6';
    const asked: string[] = [];

    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => selected,
      lookup: async (spec) => {
        asked.push(spec);

        return rows.get(spec) ?? null;
      },
    });

    await session.resolved();
    await session.warm(['openai/gpt-5.5']);
    selected = 'openai/gpt-5.5';
    const switched = { window: session.contextWindow(), price: session.pricing() };
    selected = 'anthropic/claude-sonnet-4-6';
    const back = { window: session.contextWindow(), price: session.pricing() };

    expect({ switched, back, asked }).toEqual({
      switched: { window: 400_000, price: { input: 5, output: 40 } },
      back: { window: 1_000_000, price: { input: 3, output: 15 } },
      asked: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.5'],
    });
  });
});

// KINU-045: admission reserves the answer allowance, so the catalog reports it or nothing, never a guess.
describe('ModelCatalogSession.modelOutputLimit', () => {
  test('an operation awaits limits for its selected model instead of borrowing the chat cache', async () => {
    const selected = Promise.withResolvers<{ id: string; contextWindow: number; modelOutputLimit: number }>();
    const lookedUp: string[] = [];

    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'chat/fast',
      lookup: async spec => {
        lookedUp.push(spec);

        return spec === 'deep/selected'
          ? selected.promise
          : { id: spec, contextWindow: 8_000, modelOutputLimit: 1_000 };
      },
    });

    const pending = session.contextFor('deep/selected');
    selected.resolve({ id: 'deep/selected', contextWindow: 200_000, modelOutputLimit: 32_000 });

    expect(await pending).toEqual({ id: 'deep/selected', contextWindow: 200_000, modelOutputLimit: 32_000 });
    expect(lookedUp).toEqual(['deep/selected']);
  });

  test('the reported allowance is what admission reserves', async () => {
    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'anthropic/claude-opus-4-7',
      lookup: async () => ({
        id: 'claude-opus-4-7', contextWindow: 1_000_000, modelOutputLimit: 128_000,
      }),
    });

    session.info();
    await Promise.resolve();

    expect(session.window().modelOutputLimit).toBe(128_000);

    const limits = {
      contextWindow: session.contextWindow(),
      modelOutputLimit: session.window().modelOutputLimit,
    };

    expect(outputReserveTokens(limits)).toBe(128_000);
    expect(stepContextLimit(limits)).toBe(872_000);
  });

  test('an unanswered catalog reports NO allowance rather than the whole window', async () => {
    // Absent, not "all of it": `outputReserveTokens` would otherwise withhold half of every unpublished window.
    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => null,
    });

    session.info();
    await Promise.resolve();

    expect(session.contextWindow()).toBeNull();
    expect(session.window().modelOutputLimit).toBeNull();
    expect(outputReserveTokens({
      contextWindow: session.contextWindow(), modelOutputLimit: session.window().modelOutputLimit,
    })).toBe(0);
  });

  test('a catalog that reports a window but no allowance reserves nothing for the answer', async () => {
    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => ({ id: '@cf/moonshotai/kimi-k2.6', contextWindow: 262_144 }),
    });

    session.info();
    await Promise.resolve();

    expect(session.window().modelOutputLimit).toBeNull();
    expect(stepContextLimit({
      contextWindow: session.contextWindow(), modelOutputLimit: session.window().modelOutputLimit,
    })).toBe(262_144);
  });

  test('`resolved` waits for the lookup the synchronous reads answered without', async () => {
    // A gate that refuses work must wait for the catalog answer, not the stand-in table.
    const landed = Promise.withResolvers<ModelInfo>();

    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'some/unlisted-model',
      lookup: async () => landed.promise,
    });

    expect(session.contextWindow()).toBeNull();
    landed.resolve({ id: 'some/unlisted-model', contextWindow: 1_048_576, modelOutputLimit: 131_072 });

    expect(await session.resolved()).toEqual({ contextWindow: 1_048_576, modelOutputLimit: 131_072 });
  });

  test('a refused lookup armed by a synchronous read is no unhandled rejection; `resolved` answers the refusal', async () => {
    const unhandled: unknown[] = [];

    const record = (...rejection: [unknown]): void => {
      unhandled.push(rejection[0]);
    };

    process.on('unhandledRejection', record);

    try {
      const refused = Promise.withResolvers<ModelInfo>();

      const session = new ModelCatalogSession({
        measured: () => null,
        effectiveSpec: () => 'some/refused-model',
        lookup: async () => refused.promise,
      });

      expect(session.info()).toBeNull();
      refused.reject(new KinuError('denied', 'the catalog refused this key'));
      // The lookup has settled, and one event-loop turn later the runtime has reported this tick's unhandled rejections.
      await Promise.allSettled([refused.promise]);
      await new Promise<void>((turned) => { setImmediate(turned); });
      expect(unhandled).toEqual([]);
      await expect(session.resolved()).rejects.toThrow('the catalog refused this key');
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  test('a spec nothing has measured says so, and keeps saying so', async () => {
    const session = new ModelCatalogSession({
      measured: () => null,
      effectiveSpec: () => 'some/unlisted-model',
      lookup: async () => null,
    });

    expect(await session.resolved()).toEqual({ contextWindow: null, modelOutputLimit: null });
  });
});

// The one model spelling every model_call row is priced against; both backends resolve it here.
describe('resolveEffectiveModelSpec', () => {
  const canonical = (spec: string | null): string => {
    const trimmed = spec?.trim() ?? '';

    if (trimmed === '' || trimmed === 'house-model') return 'openai-compatible/house-model';

    if (trimmed === 'openai-compatible/house-model') return trimmed;
    throw new Error(`unknown model ${trimmed}`);
  };

  test('one model under two spellings resolves to one spec', () => {
    const spellings = ['house-model', 'openai-compatible/house-model', '  house-model '];

    const resolved = new Set(spellings.map((stored) => resolveEffectiveModelSpec({
      live: () => undefined, stored: () => stored, normalize: canonical,
    })));

    expect([...resolved]).toEqual(['openai-compatible/house-model']);
  });

  test('the claimed tier outranks the stored spec, and is normalized too', () => {
    expect(resolveEffectiveModelSpec({
      live: () => 'house-model', stored: () => 'openai-compatible/other', normalize: canonical,
    })).toBe('openai-compatible/house-model');
  });

  test('a spec the backend cannot resolve yet reads back raw rather than costing the caller', () => {
    expect(resolveEffectiveModelSpec({
      live: () => undefined, stored: () => 'vendor/unlisted', normalize: canonical,
    })).toBe('vendor/unlisted');
    expect(resolveEffectiveModelSpec({
      live: () => undefined, stored: () => null, normalize: () => { throw new Error('no registry yet'); },
    })).toBe('');
  });
});
