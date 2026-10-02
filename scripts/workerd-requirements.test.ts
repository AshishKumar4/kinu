import { expect, test } from 'bun:test';
import { workerdRequirements } from './workerd-requirements';

const targets = new Map<string, string | undefined>([
  ['LOCAL', undefined], ['PROBE', 'probe'], ['OTHER', 'other'], ['API', 'probe'],
]);

const workers = new Set(['probe', 'other']);

const root = 'packages/cf-backend';

test.each(['cloudflare:workers', 'cloudflare:test'])('native %s env reads select the worker, not guest text or a shadowed parameter', origin => {
  const file = `${root}/tests/workerd/consumer.test.ts`;
  
  const sources = new Map([[file, `
    import { env as nativeEnv } from '${origin}';
    const ns = nativeEnv.PROBE;
    (nativeEnv as typeof nativeEnv).API.fetch('/');
    const guest = 'nativeEnv.OTHER.get("guest")';
    function local(nativeEnv) { return nativeEnv.OTHER; }
  `]]);

  expect([...workerdRequirements(sources, targets, workers, root)]).toEqual([
    ['tests/workerd/consumer.test.ts', ['probe']],
  ]);
});

test('a binding read in an imported runtime helper selects its worker, while type-only imports select none', () => {
  const sources = new Map([
    [`${root}/tests/workerd/consumer.test.ts`, `import { request } from '../helpers/request'; request();`],
    [`${root}/tests/helpers/request.ts`, `import { env } from 'cloudflare:workers'; export const request = () => env.API.fetch('/');`],
    [`${root}/tests/workerd/local.test.ts`, `import type { Request } from '../helpers/request'; import { env } from 'cloudflare:test'; env.LOCAL.get('local');`],
  ]);

  expect([...workerdRequirements(sources, targets, workers, root)]).toEqual([
    ['tests/workerd/consumer.test.ts', ['probe']],
    ['tests/workerd/local.test.ts', []],
  ]);
});

test('undeclared bindings and missing Worker targets fail with the suite and missing name', () => {
  const file = `${root}/tests/workerd/missing.test.ts`;

  expect(() => workerdRequirements(new Map([[file, `import { env } from 'cloudflare:workers'; env.MISSING.get('x');`]]), targets, workers, root))
    .toThrow(`${file}: workerd binding MISSING is not declared`);

  expect(() => workerdRequirements(new Map([[file, `import { env } from 'cloudflare:workers'; env.PROBE.get('x');`]]), targets, new Set(['other']), root))
    .toThrow(`${file}: Worker probe for binding PROBE is not declared`);
});

test('two suites needing different probes preserve the union while named destructuring and namespace imports remain scoped', () => {
  const sources = new Map([
    [`${root}/tests/workerd/first.test.ts`, `import { env } from 'cloudflare:test'; const { PROBE: selected } = env; selected.get('x');`],
    [`${root}/tests/workerd/second.test.ts`, `import * as platform from 'cloudflare:workers'; platform.env.OTHER.get('x');`],
  ]);

  expect([...workerdRequirements(sources, targets, workers, root)]).toEqual([
    ['tests/workerd/first.test.ts', ['probe']],
    ['tests/workerd/second.test.ts', ['other']],
  ]);
});
