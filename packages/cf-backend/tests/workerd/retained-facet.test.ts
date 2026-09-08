import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { SubordinateInspectionResultSchema } from '@kinu.run/core';

const INITIAL = { kind: 'retained', marker: 'retained', state: [{ kind: 'starts', value: 1 }], owed: 1 };
const RECOVERED = { kind: 'retained', marker: 'retained', state: [{ kind: 'recovered', value: 1 }, { kind: 'starts', value: 2 }], owed: 0 };

/** Real SDK facets exercise the distinction between direct native reads and bootstrap. */
describe('retained facet inspection lifecycle', () => {
  it('an absent registered child stays absent', async () => {
    const root = env.RETAINED_FACET_SDK.get(env.RETAINED_FACET_SDK.idFromName('missing'));
    expect(await root.exercise('missing')).toEqual({ present: false, registry: 0 });
  });

  it('warm and cold reads retain owed work until normal bootstrap recovers it once', async () => {
    const root = env.RETAINED_FACET_SDK.get(env.RETAINED_FACET_SDK.idFromName('cold'));
    expect(await root.exercise('seed')).toEqual(INITIAL);
    expect(await root.exercise('raw')).toEqual(INITIAL);
    expect(await root.exercise('normal')).toEqual(INITIAL);
    await root.exercise('abort');
    expect(await root.exercise('raw')).toEqual(INITIAL);
    expect(await root.exercise('normal')).toEqual(RECOVERED);
    expect(await root.exercise('normal')).toEqual(RECOVERED);
  });

  it('nested reads preserve a grandchild through a cold ancestor without recovery', async () => {
    const root = env.RETAINED_FACET_SDK.get(env.RETAINED_FACET_SDK.idFromName('nested'));
    await root.exercise('seed');
    expect(await root.exercise('nested-seed')).toEqual(INITIAL);
    expect(await root.exercise('nested-raw')).toEqual(INITIAL);
    await root.exercise('abort');
    expect(await root.exercise('nested-raw')).toEqual(INITIAL);
    expect(await root.exercise('nested-normal')).toEqual(RECOVERED);
  });

  it('a stale registry over wiped application identity reports missing history', async () => {
    const root = env.RETAINED_FACET_SDK.get(env.RETAINED_FACET_SDK.idFromName('wiped'));
    await root.exercise('seed');
    await root.exercise('wipe');
    await root.exercise('abort');
    expect(await root.exercise('raw')).toEqual({ kind: 'missing-history' });
  });

  it('the production actor native read remains non-callable and adds no events or fibers', async () => {
    const root = env.RETAINED_FACET_ACTOR.get(env.RETAINED_FACET_ACTOR.idFromName('workspace'));
    await root.exercise('seed');
    const before = { events: 2, fibers: 0, callable: false };
    await expect.poll(() => root.exercise('counts')).toEqual(before);
    await root.exercise('abort');
    const inspected = v.parse(SubordinateInspectionResultSchema, await root.exercise('inspect'));
    expect(inspected.view).toBe('events');
    if (inspected.view !== 'events') throw new Error('The retained event read failed');
    expect(inspected.page.status).toBe('more');
    expect(inspected.page.items[0]?.type).toBe('run_start');
    expect(await root.exercise('counts')).toEqual(before);
  });
});
