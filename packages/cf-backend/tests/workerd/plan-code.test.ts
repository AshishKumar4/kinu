import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('hosted Plan analysis reads files and keeps research state without writes or raw network', async () => {
  const root = env.SLATE_ACTOR_ROOT.get(env.SLATE_ACTOR_ROOT.idFromName('plan-analysis'));

  const planned = await root.code('plan', [
    'const text = await workspace.readFile();',
    'const write = await workspace.writeFile();',
    'await state.set("analysis", [3, 1, 2].sort());',
    'let network;',
    'try { await globalThis.fetch("https://network.example.test/"); network = { blocked: false }; }',
    'catch (cause) { if (!(cause instanceof Error)) throw cause; network = { blocked: true, error: cause.message }; }',
    'return { text, write, analysis: await state.get("analysis"), network };',
  ].join('\n'));

  expect(planned.file).toBe('original');
  expect(JSON.parse(planned.answer)).toMatchObject({ result: {
    text: 'original', write: { reason: 'denied' }, analysis: [1, 2, 3], network: { blocked: true },
  } });

  const built = await root.code('build', [
    'await workspace.writeFile();',
    'return await (await fetch("https://network.example.test/")).text();',
  ].join('\n'));

  expect(built.file).toBe('changed');
  expect(JSON.parse(built.answer)).toMatchObject({ result: 'network allowed' });
});
