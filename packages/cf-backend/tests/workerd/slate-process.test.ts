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

it('each resident request retains its own app call chain across the loopback binding', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('binding-chain'));
  await subject.start([
    'export default { async fetch(request, env) {',
    '  return Response.json(await env.PEER.echo(new URL(request.url).pathname));',
    '} };',
  ].join('\n'), true);
  try {
    const answers = await Promise.all([subject.request('/deep', ['a', 'b', 'c']), subject.request('/one', ['z'])]);
    expect(answers.map((answer) => JSON.parse(answer.body))).toEqual([
      { chain: ['a', 'b', 'c', 'probe'], args: ['/deep'] }, { chain: ['z', 'probe'], args: ['/one'] },
    ]);
    const refused = await subject.request('/cycle', ['peer', 'other']);
    expect(refused.status).toBe(500);
    expect(JSON.parse(refused.body)).toMatchObject({ reason: 'denied', error: expect.stringContaining('re-enters slate peer') });
    expect(JSON.parse((await subject.request('/fresh')).body)).toEqual({ chain: ['probe'], args: ['/fresh'] });
  } finally {
    await subject.stop();
  }
});

it('authored code that keeps an old request\'s bindings cannot replay its call chain', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('binding-replay'));
  // The escape this closes: stash `env` on one request and use it on the next.
  // The stashed bindings carry the FIRST request's invocation id, and the host
  // retired that id when the first request settled.
  await subject.start([
    'let kept = null;',
    'export default { async fetch(request, env) {',
    '  const path = new URL(request.url).pathname;',
    '  if (path === "/keep") { kept = env; return Response.json(await env.PEER.echo("kept")); }',
    '  try { return Response.json(await kept.PEER.echo("replayed")); }',
    '  catch (cause) { return Response.json({ replayRefused: String(cause.message) }); }',
    '} };',
  ].join('\n'), true);
  try {
    // A shallow root call, whose bindings the slate keeps.
    expect(JSON.parse((await subject.request('/keep', [])).body)).toEqual({ chain: ['probe'], args: ['kept'] });
    // A DEEP call that replays them. Before the invocation record this answered
    // `chain: ['probe']` — the shallow lineage — which is how a slate re-entered
    // an ancestor the honest chain would have refused.
    const replayed = JSON.parse((await subject.request('/replay', ['peer', 'mid'])).body);
    expect(replayed.replayRefused).toContain('which this host is not running');
    expect(replayed.chain).toBeUndefined();
  } finally {
    await subject.stop();
  }
});

it('bindings kept from a PREVIEW request cannot stand in for a hop lineage', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('preview-replay'));
  // The preview arm of the same escape. A browser GET is a root lineage, so
  // bindings kept from one used to yield an empty chain when presented from
  // inside a hop — the ancestors the honest chain would have refused on.
  await subject.start([
    'let kept = null;',
    'export default { async fetch(request, env) {',
    '  const path = new URL(request.url).pathname;',
    '  if (path === "/visit") { kept = env; return Response.json({ visited: true }); }',
    '  try { return Response.json(await kept.PEER.echo("from-preview-bindings")); }',
    '  catch (cause) { return Response.json({ replayRefused: String(cause.message) }); }',
    '} };',
  ].join('\n'), true);
  try {
    // A preview visit: no chain argument, which is the browser shape.
    expect(JSON.parse((await subject.request('/visit')).body)).toEqual({ visited: true });
    const replayed = JSON.parse((await subject.request('/hop', ['peer', 'mid'])).body);
    expect(replayed.replayRefused).toContain('which this host is not running');
    expect(replayed.chain).toBeUndefined();
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

it('a compiler warmed with supplementary-group access does not lend it to another caller', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('compiler-groups'));
  await subject.seedGroupSource();
  const source = 'import text from "/shared/group.ts"; export default { fetch() { return new Response(text); } };';
  const first = await subject.compileProbe(source, { uid: 1000, gid: 1000, groups: [3000], umask: 0o022 });
  expect(first).toEqual({ status: 200, body: 'group-protected-source' });
  const revoked = await subject.compileProbe(source, { uid: 1000, gid: 1000, groups: [], umask: 0o022 });
  expect(revoked).toMatchObject({ code: 'bad_input' });
});

it('both sealed actor families answer the native binding RPC without making it browser-callable', async () => {
  const root = env.SLATE_FACET_ROOT.get(env.SLATE_FACET_ROOT.idFromName('native-slate-bindings'));
  const families: readonly ('subordinate' | 'exploration')[] = ['subordinate', 'exploration'];
  for (const family of families) {
    expect(await root.exercise(family)).toEqual({ answeredBy: 'facet', method: 'getExecutors', browserCallable: false });
  }
});
