import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

it('runs an authored class: the prototype is the surface and the reserved storage round-trips', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('resident-class'));
  await subject.start();

  try {
    // `__storage` is the reserved handle, never part of the guest's env map:
    // only the declared PEER binding is visible to the slate.
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

  await subject.start(source);

  try {
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":1}' });
    await subject.stop();
    // The durable application re-attaches to its pinned facet's SQLite, so the
    // probe table survives the release exactly as this.storage does.
    await subject.start(source);
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":2,"stored":2}' });
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

  // The defaults spelled out: a private process is the durable application's
  // call surface minus the port and the pinned facet — `app: null`.
  await subject.start(source, true, undefined, undefined, undefined, null);

  try {
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":1}' });
    await subject.stop();
    await subject.start(source, true, undefined, undefined, undefined, null);
    expect(await subject.call('bump', [])).toEqual({ ok: true, value: '{"rows":1,"stored":2}' });
  } finally {
    await subject.stop();
  }
});

it('a slate declaring a browser surface serves the shell, the client bundle, and the kinu:slate module', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('browser-surface'));
  // Single file: main and browser are the same module, so the generated
  // entries do the splitting — the server bundle keeps the class and the
  // client bundle keeps the component.
  await subject.start([
    'import { useState } from "react";',
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    '  async ping() { return "server-only-marker-1c9e"; }',
    '}',
    'export default function App() {',
    '  const [n] = useState(1);',
    '  return <button>{"client-only-marker-7f3a"}</button>;',
    '}',
  ].join('\n'), false, undefined, undefined,
    { main: 'app.tsx', browser: 'app.tsx', slate: { title: 'Notes' } });

  try {
    const shell = await subject.route('/');

    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<title>Notes</title>');
    expect(shell.body).toContain('/__kinu/client.js');
    // The shell's import map is the module surface the client bundle resolves
    // against — exact JSON, and every path it names must answer.
    const importMap = shell.body.match(/<script type="importmap">\s*(\{[^<]*?)\s*<\/script>/)?.[1];

    expect(importMap).toBeDefined();
    expect(JSON.parse(importMap!)).toEqual({
      imports: {
        'react': '/__kinu/react.js',
        'react-dom/client': '/__kinu/react.js',
        'react/jsx-runtime': '/__kinu/react.js',
        'capnweb': '/__kinu/capnweb.js',
        'kinu:slate': '/__kinu/slate.js',
      },
    });

    const mapped = Object.values(v.parse(v.object({ imports: v.record(v.string(), v.string()) }), JSON.parse(importMap!)).imports)
      .concat('/__kinu/client.js');

    for (const path of mapped) {
      expect(await subject.route(path)).toMatchObject({ status: 200, contentType: 'text/javascript; charset=utf-8' });
    }

    const slateModule = await subject.route('/__kinu/slate.js');

    expect(slateModule.status).toBe(200);
    expect(slateModule.body).toContain('newWebSocketRpcSession');
    expect(await subject.call('ping', [])).toEqual({ ok: true, value: 'server-only-marker-1c9e' });


    // The generated entries are kernel tooling under the runtime dir, never
    // authored files inside the slate's own tree.
    expect(await subject.paths()).toEqual({ kinuInSlateRoot: false, entries: ['client.js', 'server.js'] });

    // Single-file mode: the marker strings prove which half survived each
    // bundle — the server bundle keeps the class's method bodies and drops
    // the component's, the client bundle the reverse.
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

it('binding calls never run outside a slate method invocation', async () => {
  const subject = env.SLATE_PROCESS_PROBE.get(env.SLATE_PROCESS_PROBE.idFromName('invocation-scope'));
  // The constructor runs under startProcess, which no invocation wraps: the
  // call queued there must still be refused when a later method drains it.
  // (A timer INSIDE a method keeps its lineage on purpose — async context
  // propagation attributes the call to the invocation it runs under.)
  await subject.start([
    'import { SlateObject } from "kinu:slate";',
    'export class Slate extends SlateObject {',
    '  #early;',
    '  constructor(ctx, env) { super(ctx, env); this.#early = this.env.PEER.echo("x"); }',
    '  async replay() {',
    '    try { await this.#early; return "unexpected"; }',
    '    catch (cause) { return String(cause); }',
    '  }',
    '}',
  ].join('\n'));

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
