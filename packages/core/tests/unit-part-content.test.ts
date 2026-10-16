import { describe, expect, test } from 'bun:test';
import { sealedPartDocument } from '../src/slates/part-content';

describe("a part's drawn document", () => {
  test('keeps text and plain structure, and nothing that runs, loads, links or styles', async () => {
    const drawn = await sealedPartDocument([
      '<h2 style="color:red" onclick="steal()">Issues</h2>',
      '<table><tr><td colspan="2" data-x="1">a</td><td rowspan="x9">b</td></tr></table>',
      '<script>steal()</script><style>body{background:url(https://author.example/x)}</style>',
      '<img src="https://author.example/i.png"><a href="https://author.example/">more</a><form action="/x"><input name="q"></form>',
      '<iframe src="https://author.example/"></iframe><svg><image href="https://author.example/s"/></svg><br>',
    ].join(''));

    const body = drawn.slice(drawn.indexOf('<body>'));

    expect(body).toBe('<body><h2>Issues</h2><table><tr><td colspan="2">a</td><td>b</td></tr></table>more<br></body></html>');
    expect(drawn).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">`);
  });

  test("an attribute is never copied, even one that closes the tag it is in", async () => {
    const drawn = await sealedPartDocument('<p title="x"><img src=1 onerror=steal()>">text</p>');

    expect(drawn).toContain('<body><p>');
    expect(drawn).not.toContain('onerror');
    expect(drawn).not.toContain('title');
  });
});
