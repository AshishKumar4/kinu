import { describe, expect, test } from 'bun:test';
import { asFetchFunction, LimitCache, limitLines, type LimitSource } from '../src/index';
import { workerdFetch } from '@kinu.run/test-utils';

const NOW = Date.parse('2026-09-25T10:00:00Z');

function providers(overrides: Readonly<Record<string, () => Response>> = {}) {
  const asked: Array<{ url: string; headers: Headers }> = [];

  const answers = new Map<string, () => Response>(Object.entries({
    'https://api.anthropic.com/api/oauth/usage': () => Response.json({
      five_hour: { utilization: 62, resets_at: '2026-09-25T12:03:00Z' },
      seven_day: { utilization: 18.4, resets_at: '2026-09-29T00:00:00Z' },
      seven_day_opus: null,
    }),
    'https://chatgpt.com/backend-api/wham/usage': () => Response.json({ rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: Date.parse('2026-09-25T11:00:00Z') / 1000 },
      secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_at: Date.parse('2026-10-01T00:00:00Z') / 1000 },
    } }),
    'https://openrouter.ai/api/v1/key': () => Response.json({ data: { limit: 10, limit_remaining: 4.12, limit_reset: 'monthly' } }),
    // As OpenCode Go answered on 2026-10-19: the windows under `usage`.
    'https://opencode.ai/zen/go/v1/usage': () => Response.json({ usage: {
      rolling: { percent: 12, status: 'ok', resetsAt: '2026-09-25T13:00:00Z' },
      weekly: { percent: 55, status: 'ok', resetsAt: '2026-09-28T00:00:00Z' },
      monthly: { percent: 100, status: 'rate-limited', resetsAt: '2026-10-03T14:56:00Z' },
    } }),
    ...overrides,
  }));

  const fetchImpl = asFetchFunction(async (input, init) => {
    const url = new Request(input).url;

    asked.push({ url, headers: new Headers(init?.headers) });
    const answer = answers.get(url);

    if (answer === undefined) throw new Error(`unexpected ${url}`);

    return answer();
  });

  return { fetch: fetchImpl, asked };
}

const source = (key: string): LimitSource => ({ key, headers: async () => ({ Authorization: `Bearer ${key}` }) });

describe('what each provider account has left', () => {
  // Production walkthrough, rc28: Settings › Usage showed "Illegal invocation" for the OpenCode Go quota.
  test("a deployment's own fetch reads every quota, given as the cache's or as a source's", async () => {
    const { fetch } = providers();
    const keys = ['claude.oauth', 'opencode-go.bearer'];
    const viaCache = await new LimitCache(() => NOW).read(keys.map(source), { fetch: workerdFetch(fetch) });
    const viaSource = await new LimitCache(() => NOW).read(keys.map((key) => ({ ...source(key), fetch: workerdFetch(fetch) })));

    expect([viaCache, viaSource].map(({ limits, limitsUnread }) => ({ read: limits.map((report) => report.provider), unread: limitsUnread })))
      .toEqual([{ read: ['claude', 'opencode-go'], unread: [] }, { read: ['claude', 'opencode-go'], unread: [] }]);
  });

  test('each reader turns its provider\'s answer into named windows, used and left', async () => {
    const { fetch } = providers();
    const cache = new LimitCache(() => NOW);

    const { limits, limitsUnread } = await cache.read(
      ['claude.oauth', 'codex.oauth@work', 'openrouter.bearer', 'opencode-go.bearer', 'anthropic.bearer'].map(source),
      { fetch },
    );

    expect(limitsUnread).toEqual([]);
    expect(limits.map((report) => [report.provider, report.account, report.windows.map((window) => window.name), report.undocumented ?? false])).toEqual([
      ['claude', 'main', ['5h', 'weekly'], false],
      ['codex', 'work', ['5h', 'weekly'], false],
      ['openrouter', 'main', ['credit'], false],
      ['opencode-go', 'main', ['5h', 'weekly', 'monthly'], true],
    ]);

    const lines = limitLines(limits, [], NOW).join('\n');

    expect(lines).toContain('5h  62% used · 38% left · resets');
    expect(lines).toContain('(in 2h 3m)');
    expect(lines).toContain('credit  $5.88 used · $4.12 of $10.00 left · resets monthly');
    expect(lines).toContain('monthly  100% used · 0% left');
    expect(lines).toContain('OpenCode Go · main · undocumented source');
  });

  test('a read inside five minutes is served from the last answer; a refresh asks again', async () => {
    let now = NOW;
    const { fetch, asked } = providers();
    const cache = new LimitCache(() => now);

    await cache.read([source('openrouter.bearer')], { fetch });
    now += 60_000;
    await cache.read([source('openrouter.bearer')], { fetch });
    expect(asked).toHaveLength(1);

    await cache.read([source('openrouter.bearer')], { fetch, refresh: true });
    now += 5 * 60_000;
    await cache.read([source('openrouter.bearer')], { fetch });
    expect(asked).toHaveLength(3);
  });

  test('a failed read shows the last answer with its age, and with none it is named, never zero', async () => {
    let now = NOW;
    let down = false;

    const { fetch } = providers({
      'https://chatgpt.com/backend-api/wham/usage': () => (down ? new Response('blocked', { status: 403 }) : Response.json({ rate_limit: { primary_window: { used_percent: 40 } } })),
    });

    const cache = new LimitCache(() => now);

    await cache.read([source('codex.oauth')], { fetch });
    down = true;
    now += 10 * 60_000;

    const stale = await cache.read([source('codex.oauth'), source('claude.oauth@work')], {
      fetch: asFetchFunction(async (input, init) => (new Request(input).url.includes('anthropic') ? new Response('no', { status: 401 }) : fetch(input, init))),
    });

    expect(stale.limits.map((report) => report.provider)).toEqual(['codex']);
    expect(stale.limits[0]).toMatchObject({ at: NOW, windows: [{ usedPercent: 40 }] });
    expect(stale.limitsUnread.map((entry) => [entry.provider, entry.account])).toEqual([['claude', 'work']]);
    expect(stale.limitsUnread[0]?.reason).toContain('401');
  });

  test('the Claude and ChatGPT reads carry the account\'s own sign-in, and a route of its own when given one', async () => {
    const { fetch, asked } = providers();
    const routed: string[] = [];

    await new LimitCache(() => NOW).read([
      source('claude.oauth'),
      { key: 'codex.oauth', headers: async () => ({ Authorization: 'Bearer codex' }), fetch: asFetchFunction(async (input, init) => {
        routed.push(new Request(input).url);

        return fetch(input, init);
      }) },
    ], { fetch });

    expect(asked.find((call) => call.url.includes('anthropic'))?.headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(routed).toEqual(['https://chatgpt.com/backend-api/wham/usage']);
  });

  test('Claude\'s per-model weekly caps come from scoped limits, not the retired buckets', async () => {
    // OMP usage/claude.ts's live shape: the Fable cap binding at 100% beside a 77% shared weekly.
    const { fetch } = providers({
      'https://api.anthropic.com/api/oauth/usage': () => Response.json({
        five_hour: { utilization: 12, resets_at: '2026-09-25T13:00:00Z' },
        seven_day: { utilization: 77, resets_at: '2026-09-29T00:00:00Z' },
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: [
          { kind: 'weekly', percent: 77, resets_at: '2026-09-29T00:00:00Z', is_active: false },
          { kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-28T00:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_scoped', percent: 5, resets_at: '2026-09-28T00:00:00Z', is_active: false, scope: { model: { display_name: 'Opus' } } },
          { kind: 'weekly_scoped', percent: 9, is_active: false, scope: { model: {} } },
        ],
      }),
    });

    const { limits } = await new LimitCache(() => NOW).read([source('claude.oauth')], { fetch });

    expect(limits[0]?.windows.map((window) => [window.name, window.usedPercent])).toEqual([
      ['5h', 12], ['weekly', 77], ['weekly Fable', 100], ['weekly Opus', 5],
    ]);
  });

  test('a Codex window with only reset_after_seconds resets that far from now', async () => {
    const { fetch } = providers({
      'https://chatgpt.com/backend-api/wham/usage': () => Response.json({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_after_seconds: 3_600 } } }),
    });

    const { limits } = await new LimitCache(() => NOW).read([source('codex.oauth')], { fetch });

    expect(limits[0]?.windows[0]?.resetsAt).toBe(NOW + 3_600_000);
  });

  test('a long-lived cache drops answers past five minutes', async () => {
    let now = NOW;
    const { fetch } = providers();
    const cache = new LimitCache(() => now);

    await cache.read([source('openrouter.bearer'), source('codex.oauth')], { fetch });
    expect(cache.size).toBe(2);
    now += 5 * 60_000;
    cache.prune();
    expect(cache.size).toBe(0);
  });
});
