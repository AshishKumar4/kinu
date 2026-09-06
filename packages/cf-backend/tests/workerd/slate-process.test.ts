import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('compiled authored TypeScript answers through a resident process until stopped', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('resident-server'));
  await subject.start();
  try {
    const first = await subject.request('/first');
    const second = await subject.request('/second');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ calls: 1, path: '/first' });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ calls: 2, path: '/second' });
  } finally {
    await subject.stop();
  }
  expect((await subject.request('/stopped')).status).toBe(404);
});

it('Slate compilation requires Nimbus credentialed EsbuildService reads', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('compiler-authority'));
  await subject.seedPrivateSource();
  expect(await subject.readPrivateSourceAsAgent()).toMatchObject({ error: expect.stringContaining('EACCES') });
  const result = await subject.compileProbe([
    'import secret from "/root/private.ts";',
    'export default { fetch() { return new Response(secret); } };',
  ].join('\n'));
  expect(result).toMatchObject({ code: 'bad_input' });
});
