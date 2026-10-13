// D86: a Worker routes its preview zone with one call. `previewBox` reads the zone from the Worker's own env, so this
// file gives `cloudflare:workers` an env holding only `DEVBOX_PREVIEW_HOST`.
import { expect, mock, test } from 'bun:test';

/** The Worker env `previewBox` reads. */
interface PreviewEnv {
  DEVBOX_PREVIEW_HOST?: string;
}

const workers = await import('cloudflare:workers');

const zone: PreviewEnv = {};

await mock.module('cloudflare:workers', () => ({ ...workers, env: zone }));

const { previewBox } = await import('../src/preview');

/** A namespace that records the names it is asked for; `getByName` is the only member `previewBox` reaches. */
function recordingNamespace(asked: string[]): DurableObjectNamespace {
  // SAFETY: constructed against the namespace contract for its one member `previewBox` calls.
  return Object.create({
    getByName: (name: string) => {
      asked.push(name);

      return { name };
    },
  });
}

function routed(url: string): readonly string[] {
  const asked: string[] = [];
  const stub = previewBox(new Request(url), recordingNamespace(asked));

  return stub === null ? [] : asked;
}

test('a host under DEVBOX_PREVIEW_HOST reaches the box it names, and no other host reaches any', () => {
  zone.DEVBOX_PREVIEW_HOST = 'Preview.Example.com';

  expect({
    named: routed('https://3000-demo-abc123.preview.example.com/app?x=1'),
    hyphenated: routed('https://8080-my-box-1-abc123.preview.example.com/'),
    otherZone: routed('https://3000-demo-abc123.preview.example.org/'),
    zoneItself: routed('https://preview.example.com/'),
    deeper: routed('https://a.3000-demo-abc123.preview.example.com/'),
    noToken: routed('https://3000-demo.preview.example.com/'),
    portZero: routed('https://0-demo-abc123.preview.example.com/'),
    portTooHigh: routed('https://65536-demo-abc123.preview.example.com/'),
  }).toEqual({
    named: ['demo'], hyphenated: ['my-box-1'],
    otherZone: [], zoneItself: [], deeper: [], noToken: [], portZero: [], portTooHigh: [],
  });
});

test('without DEVBOX_PREVIEW_HOST no host reaches a box', () => {
  delete zone.DEVBOX_PREVIEW_HOST;

  expect(routed('https://3000-demo-abc123.preview.example.com/')).toEqual([]);
});
