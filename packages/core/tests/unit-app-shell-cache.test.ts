import { describe, expect, test } from 'bun:test';
import { serveApp } from '../src/http/app-shell';

const env = (status = 200) => ({
  ASSETS: { fetch: async () => new Response(status === 304 ? null : 'export {};', { status, headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=0, must-revalidate' } }) },
});

/** The shell's document; the build stamp beside it is not deployed. */
const shell = {
  ASSETS: {
    fetch: async (request: Request) => (new URL(request.url).pathname === '/workspace/jarvis'
      ? new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' } })
      : new Response(null, { status: 404 })),
  },
};

describe("the client build's files", () => {
  test('the shell is never kept', async () => {
    const answer = await serveApp(new Request('https://kinu.example/workspace/jarvis'), shell);

    expect(answer.headers.get('content-type')).toContain('text/html');
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  test('a file named by its content is kept, and revalidated never', async () => {
    for (const path of ['/assets/app-BYNxAknq.js', '/assets/use-copy-DMm_TCDB.css', '/assets/chunk-QUQL4437-DWjwqNYD.js']) {
      const answer = await serveApp(new Request(`https://kinu.example${path}`), env());

      expect(answer.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  });

  test("a revalidation's answer says the same", async () => {
    const answer = await serveApp(new Request('https://kinu.example/assets/app-BYNxAknq.js'), env(304));

    expect(answer.status).toBe(304);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('a file kept under its own name, or one the build did not answer, keeps the assets answer', async () => {
    for (const [path, status] of [['/assets/fonts/schibsted-latin-var.woff2', 200], ['/assets/kinu-icon.svg', 200], ['/assets/app-BYNxAknq.js', 404], ['/workspace/jarvis', 200]] as const) {
      const answer = await serveApp(new Request(`https://kinu.example${path}`), env(status));

      expect(answer.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    }
  });
});

describe("the shell wears the account's theme", () => {
  const shellOf = async (answer: Response): Promise<string | null> => {
    let theme: string | null = null;

    await new HTMLRewriter().on('html', { element(element) { theme = element.getAttribute('data-theme'); } }).transform(answer).text();

    return theme;
  };

  const page = (): Request => new Request('https://kinu.example/workspace/jarvis');

  const html = {
    ASSETS: { fetch: async () => new Response('<!doctype html><html lang="en"><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
  };

  test("a signed-in page names the account's theme on the root, so it paints in it before any script runs", async () => {
    expect(await shellOf(await serveApp(page(), html, { theme: async () => 'warm' }))).toBe('warm');
  });

  test('a page served with no account names none, and wears the default', async () => {
    expect(await shellOf(await serveApp(page(), html))).toBeNull();
  });

  test('a file that is not a page never asks for the theme', async () => {
    const asked: string[] = [];

    const theme = async (): Promise<'warm'> => {
      asked.push('theme');

      return 'warm';
    };

    await serveApp(new Request('https://kinu.example/assets/app-BYNxAknq.js'), env(), { theme });

    expect(asked).toEqual([]);
  });
});
