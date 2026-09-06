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

it('each resident request retains its own app depth across the loopback binding', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('binding-depth'));
  await subject.start([
    'export default { async fetch(request, env) {',
    '  return Response.json(await env.PEER.echo(new URL(request.url).pathname));',
    '} };',
  ].join('\n'), true);
  try {
    const answers = await Promise.all([subject.request('/seven', 7), subject.request('/two', 2)]);
    expect(answers.map((answer) => JSON.parse(answer.body))).toEqual([
      { depth: 7, args: ['/seven'] }, { depth: 2, args: ['/two'] },
    ]);
    const refused = await subject.request('/cycle', 8);
    expect(refused.status).toBe(500);
    expect(JSON.parse(refused.body)).toMatchObject({ reason: 'denied', error: expect.stringContaining('app hop 9') });
    expect(JSON.parse((await subject.request('/fresh')).body)).toEqual({ depth: 0, args: ['/fresh'] });
  } finally {
    await subject.stop();
  }
});

it('authored fetch failures preserve their cause chain and leave the process callable', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('authored-cause'));
  await subject.start([
    'export default { fetch(request) {',
    '  if (new URL(request.url).pathname === "/fail") throw new Error("outer", { cause: new Error("inner") });',
    '  return new Response("alive");',
    '} };',
  ].join('\n'));
  try {
    const failed = await subject.request('/fail');
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ reason: 'io', error: 'outer: inner' });
    expect(await subject.request('/')).toEqual({ status: 200, body: 'alive' });
  } finally { await subject.stop(); }
});
