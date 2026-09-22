import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

it('runs an authored class: the prototype is the surface and the reserved storage round-trips', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('resident-class'));
  await subject.start();

  try {
    // `__storage` is the reserved handle, never in the guest's env map.
    expect(await subject.call('envKeys', [])).toEqual({ ok: true, value: '["PEER"]' });
    expect(await subject.call('greet', ['kinu'])).toEqual({ ok: true, value: 'hello kinu #1 [probe]' });
    expect(await subject.call('greet', ['kinu'])).toEqual({ ok: true, value: 'hello kinu #2 [probe]' });
    expect(await subject.call('missing', [])).toMatchObject({ ok: false, error: expect.stringContaining('has no method missing') });
    expect(await subject.socket('greet', ['browser'])).toEqual({ ok: true, value: 'hello browser #3 [probe]' });
  } finally {
    await subject.stop();
  }
});

it('the durable application keeps this.sql and this.storage across a process restart', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('storage-survival'));

  const source = [
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    '  async bump() {',
    '    this.sql.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER NOT NULL)");',
    '    this.sql.exec("INSERT INTO probe (n) VALUES (1)");',
    '    const rows = this.sql.exec("SELECT count(*) AS n FROM probe").toArray()[0].n;',
    '    const stored = (await this.storage.get("n")) ?? 0;',
    '    await this.storage.put("n", stored + 1);',
    '    return { rows, stored: stored + 1 };',
    '  }',
    '}',
  ].join('\n');

  await subject.start({ source });

  try {
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":1}' });
    await subject.stop();
    // The durable application re-attaches to its pinned facet's SQLite.
    await subject.start({ source });
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":2,"stored":2}' });
  } finally {
    await subject.stop();
  }
});

it('a slate edited and rebooted leaves no image of the source it no longer runs', async () => {
  // Every boot writes module texts as content-addressed images and Nimbus sweeps only its own, so an edited
  // `application.js` would grow one image per edit for the life of the SQLite.
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('image-sweep'));

  const version = (n: number) => [
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    `  async which() { return ${String(n)}; }`,
    '}',
  ].join('\n');

  try {
    await subject.start({ source: version(1) });
    const first = await subject.facetImages();
    expect(first.length).toBeGreaterThan(0);

    await subject.start({ source: version(2) });
    const second = await subject.facetImages();
    expect(await subject.call('which', [])).toEqual({ ok: true, value: '2' });
    expect(second.length).toBe(first.length);
    expect(second).not.toEqual(first);
  } finally {
    await subject.stop();
  }
});

it('a private process gets an ephemeral facet: this.storage survives, this.sql does not', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('storage-survival-private'));

  const source = [
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    '  async bump() {',
    '    this.sql.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER NOT NULL)");',
    '    this.sql.exec("INSERT INTO probe (n) VALUES (1)");',
    '    const rows = this.sql.exec("SELECT count(*) AS n FROM probe").toArray()[0].n;',
    '    const stored = (await this.storage.get("n")) ?? 0;',
    '    await this.storage.put("n", stored + 1);',
    '    return { rows, stored: stored + 1 };',
    '  }',
    '}',
  ].join('\n');

  // A private process is the durable application's surface minus the port and pinned facet.
  await subject.start({ source, app: null });

  try {
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":1}' });
    await subject.stop();
    await subject.start({ source, app: null });
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":2}' });
  } finally {
    await subject.stop();
  }
});

it('a slate declaring a browser surface serves the shell, the client bundle, and the kinu:slate module', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('browser-surface'));
  // Single file: the generated entries split it, server keeps the class, client keeps the component.
  await subject.start({
    source: [
      'import { useState } from "react";',
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async ping() { return "server-only-marker-1c9e"; }',
      '}',
      'export default function App() {',
      '  const [n] = useState(1);',
      '  return <button>{"client-only-marker-7f3a"}</button>;',
      '}',
  ].join('\n'),
    bindChain: false,
    project: { main: 'app.tsx', browser: 'app.tsx', slate: { title: 'Notes' } },
  });

  try {
    const shell = await subject.route('/');

    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<title>Notes</title>');
    expect(shell.body).toContain('/__kinu/client.js');
    const importMap = shell.body.match(/<script type="importmap">\s*(\{[^<]*?)\s*<\/script>/)?.[1];

    if (importMap === undefined) throw new Error('the shell carries no import map');

    expect(JSON.parse(importMap)).toEqual({
      imports: {
        'react': '/__kinu/react.js',
        'react-dom/client': '/__kinu/react.js',
        'react/jsx-runtime': '/__kinu/react.js',
        'capnweb': '/__kinu/capnweb.js',
        'kinu:slate': '/__kinu/slate.js',
      },
    });

    const mapped = Object.values(v.parse(v.object({ imports: v.record(v.string(), v.string()) }), JSON.parse(importMap)).imports)
      .concat('/__kinu/client.js');

    for (const path of mapped) {
      expect(await subject.route(path)).toMatchObject({ status: 200, contentType: 'text/javascript; charset=utf-8' });
    }

    const slateModule = await subject.route('/__kinu/slate.js');

    expect(slateModule.status).toBe(200);
    expect(slateModule.body).toContain('newWebSocketRpcSession');
    expect(await subject.call('ping', [])).toEqual({ ok: true, value: 'server-only-marker-1c9e' });

    expect(await subject.paths()).toEqual({ kinuInSlateRoot: false, entries: ['client.js', 'server.js'] });

    const artifacts = await subject.artifacts();

    expect(artifacts.application).not.toContain('client-only-marker-7f3a');
    expect(artifacts.application).not.toContain('createRoot');
    expect(artifacts.application).toContain('server-only-marker-1c9e');
    expect(artifacts.client).toBeDefined();
    expect(artifacts.client).toContain('client-only-marker-7f3a');
    expect(artifacts.client).not.toContain('server-only-marker-1c9e');
    expect(artifacts.client).not.toContain('this.storage');
    expect(artifacts.shell).toBe(shell.body);
  } finally {
    await subject.stop();
  }
});

it('serves only registered assets and the authored fetch; everything else is 404', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('routing'));
  await subject.start();

  try {
    expect((await subject.route('/__kinu/index.js')).status).toBe(404);
    const fetched = await subject.route('/');

    expect(fetched.status).toBe(404);
    expect(fetched.body).toBe('not found');
    expect((await subject.route('/__rpc')).status).toBe(400);
  } finally {
    await subject.stop();
  }
});

it('a class that is not the slate contract fails to boot, and the authored fetch is never the app surface', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('contract'));
  const missing = await subject.compileProbe('export class NotSlate { }');

  expect(missing.code).toBe('bad_input');
  expect(missing.detail).toContain('must export class Slate extends SlateObject');

  try {
    expect(await subject.compileProbe('import { SlateObject } from "kinu:slate"; export class Slate extends SlateObject { }')).toEqual({ ok: true });
    expect(await subject.route('/')).toMatchObject({ status: 404, body: 'Not found' });
    expect(await subject.call('fetch', [])).toMatchObject({ ok: false, error: expect.stringContaining('has no method fetch') });
    expect(await subject.call('_private', [])).toMatchObject({ ok: false, error: expect.stringContaining('has no method _private') });
  } finally {
    await subject.stop();
  }
});

it('boots the class whether main exports it as Slate or as default, and the refusal names what it found', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('export-shapes'));
  // The exact source a first-run eval model wrote: SlateObject from kinu:slate, class as default export.
  await subject.start({
    source: [
      'import { SlateObject } from "kinu:slate";',
      '',
      'export default class Slate extends SlateObject {',
      '  async fetch(request, env) {',
      '    const url = new URL(request.url);',
      '    if (request.method === "GET" && url.pathname === "/ping") {',
      '      return new Response(',
      '        JSON.stringify({ message: "pong", method: request.method, path: url.pathname }),',
      '        { status: 200, headers: { "content-type": "application/json" } },',
      '      );',
      '    }',
      '    return new Response("Not Found", { status: 404 });',
      '  }',
      '}',
    ].join('\n'),
  });

  try {
    const ping = await subject.route('/ping');

    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toEqual({ message: 'pong', method: 'GET', path: '/ping' });
    expect(await subject.route('/nope')).toMatchObject({ status: 404, body: 'Not Found' });
  } finally {
    await subject.stop();
  }

  await subject.start({
    source: [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async fetch() { return new Response("named ok"); }',
      '}',
    ].join('\n'),
  });

  try {
    expect(await subject.route('/anything')).toMatchObject({ status: 200, body: 'named ok' });
  } finally {
    await subject.stop();
  }

  // The refusal must say it found a non-class default export, not just repeat the contract.
  const plainObject = await subject.compileProbe('export default { async fetch() { return new Response("ok"); } };');

  expect(plainObject.code).toBe('bad_input');
  expect(plainObject.detail).toContain('must export class Slate extends SlateObject');
  expect(plainObject.detail).toContain('default');

  const notExtended = await subject.compileProbe('export class Slate {}');

  expect(notExtended.code).toBe('bad_input');
  expect(notExtended.detail).toContain('Slate');
  expect(notExtended.detail).toContain('SlateObject');

  // The refusal reports the module threw with the real error, not a bare io fault.
  const noImport = await subject.compileProbe('export default class Slate extends SlateObject { async fetch() { return new Response("x"); } }');

  expect(noImport.code).toBe('bad_input');
  expect(noImport.detail).toContain('SlateObject is not defined');
});

it('binding calls never run outside a slate method invocation', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('invocation-scope'));
  // The constructor runs under startProcess, which no invocation wraps: its queued call must still be refused.
  // A timer inside a method keeps its lineage on purpose.
  await subject.start({
    source: [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  #early;',
      '  constructor(ctx, env) { super(ctx, env); this.#early = this.env.PEER.echo("x"); }',
      '  async replay() {',
      '    try { await this.#early; return "unexpected"; }',
      '    catch (cause) { return String(cause); }',
      '  }',
      '}',
    ].join('\n'),
  });

  try {
    const result = await subject.call('replay', []);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : '').toContain('there is no invocation to run it under');
  } finally {
    await subject.stop();
  }
});

it('Slate compilation requires Nimbus credentialed EsbuildService reads', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('compiler-authority'));
  await subject.seedPrivateSource();
  await subject.seedGroupSource();
  expect(await subject.readPrivateSourceAsAgent()).toMatchObject({ error: expect.stringContaining('EACCES') });

  const denied = await subject.compileProbe([
    'import secret from "/root/private.ts";',
    'export default secret;',
  ].join('\n'), { uid: 1000, gid: 1000, groups: [], umask: 0o022 });

  expect(denied.code).toBe('bad_input');
  expect(denied.detail).toContain('EACCES');

  const grouped = await subject.compileProbe([
    'import secret from "/shared/group.ts";',
    'export default secret;',
  ].join('\n'), { uid: 1000, gid: 1000, groups: [], umask: 0o022 });

  expect(grouped.code).toBe('bad_input');
});
