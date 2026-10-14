/** What the chat reads out of an answer: the pictures it names, and a stopped turn's failure in the provider's words. */
import { describe, expect, test } from 'bun:test';
import { namedImages, turnFailureFacts } from '../src/index';

const AT = { home: '/home/main', roots: ['vfs', 'computer', 'laptop'] };

describe('the pictures an answer names', () => {
  test('a workspace path, a computer path, a device path and a web address, each once, in order', () => {
    const text = 'Saved `screenshots/example.com-20261013T203556Z-ux25.png`. The desktop is /computer/home/desktop.png, the laptop\'s '
      + '/pc/laptop/Desktop/cart.png, and the reference https://upload.wikimedia.org/a/b.png. Again: screenshots/example.com-20261013T203556Z-ux25.png.';

    expect(namedImages(text, AT).map((image) => (image.kind === 'file' ? [image.machine, image.path] : ['web', image.url]))).toEqual([
      ['workspace', '/home/main/screenshots/example.com-20261013T203556Z-ux25.png'],
      ['computer', '/computer/home/desktop.png'],
      ['device', '/pc/laptop/Desktop/cart.png'],
      ['web', 'https://upload.wikimedia.org/a/b.png'],
    ]);
  });

  test('a plane reference, a markdown image and a bare name in code', () => {
    expect(namedImages('See computer://home/x.jpg, ![chart](bench/latency.png) and `logo.svg`.', AT).map((image) => image.kind === 'file' && image.path)).toEqual([
      '/computer/home/x.jpg', '/home/main/bench/latency.png', '/home/main/logo.svg',
    ]);
  });

  test('a name with no folder in prose, a data address and a file that is not a picture name nothing', () => {
    expect(namedImages('Version v1.2.png shipped; data:image/png;base64,AAAA and notes/todo.md stay words.', AT)).toEqual([]);
  });
});

describe("a stopped turn's failure, read for the chat", () => {
  test("Workers AI's 429: its own description, and the facts its body states", () => {
    const facts = turnFailureFacts('calling the model: the provider refused the request (HTTP 429, workers-ai).: Workers AI API error (429 Too Many Requests): '
      + '{"name":"AiError","internalCode":3021,"httpCode":429,"message":"AiError: AiError: rate limiting: inference request per min rate reached (c24bf08b-a085-461b-8097-4668897f4a8e)",'
      + '"description":"rate limiting: inference request per min rate reached","requestId":"c24bf08b-a085-461b-8097-4668897f4a8e"}');

    expect({ provider: facts.provider, words: facts.words, facts: facts.facts }).toEqual({
      provider: 'Workers AI',
      words: 'rate limiting: inference request per min rate reached',
      facts: [['Status', '429 Too Many Requests'], ['Code', '3021'], ['Request', 'c24bf08b-a085-461b-8097-4668897f4a8e']],
    });
  });

  test("a refusal whose wait outlasts a call keeps the provider's words beside Kinu's", () => {
    const { words } = turnFailureFacts('calling the model: the provider refused the request (HTTP 429, ai-gateway).: ai-gateway is rate-limited until '
      + '2026-10-21 23:12 UTC (in 8d): Go usage limit exceeded: ai-gateway declared a wait until 2026-10-21 23:12 UTC, past the 1m a call waits');

    expect(words).toContain('Go usage limit exceeded');
    expect(words).toContain('in 8d');
  });

  test("an envelope's own type is not the error's code", () => {
    const { facts } = turnFailureFacts('calling the model: the provider refused the request (HTTP 429, rate_limit_error, anthropic).: '
      + '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}');

    expect(facts).toContainEqual(['Code', 'rate_limit_error']);
  });
});
