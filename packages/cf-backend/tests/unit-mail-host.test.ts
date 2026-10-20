import { describe, expect, test } from 'bun:test';
import { isPreviewHostRequest } from '@kinu.run/core';
import { mailHostRedirect } from '../src/mail/host';

// mail.<domain> is a permanent redirect into the app (docs/MAIL.md §7): the session cookie is host-only by design, so
// Mail is served from the app's own origin, and `mail` is never a preview host.
const ENV = { CLI_PUBLIC_ORIGIN: 'https://kinu.run', PREVIEW_HOST_SUFFIX: 'kinu.run' };

describe('mail.<domain>', () => {
  test('lands on /mail in the app, the path and query kept, permanently', () => {
    const home = mailHostRedirect(new URL('https://mail.kinu.run/'), ENV);
    const thread = mailHostRedirect(new URL('http://mail.kinu.run/t-dana?view=all'), ENV);

    expect([home?.status, home?.headers.get('location')]).toEqual([301, 'https://kinu.run/mail']);
    expect(thread?.headers.get('location')).toBe('https://kinu.run/mail/t-dana?view=all');
  });

  test('the app\'s own host, a preview host, and another domain are not redirected', () => {
    for (const url of ['https://kinu.run/mail', 'https://p-3000-x7k2.kinu.run/', 'https://mail.example.com/']) {
      expect(mailHostRedirect(new URL(url), ENV)).toBeNull();
    }
  });

  test('a deployment with no published origin redirects nothing', () => {
    expect(mailHostRedirect(new URL('https://mail.kinu.run/'), { CLI_PUBLIC_ORIGIN: undefined })).toBeNull();
  });

  test('mail is never a preview host, though it ends with the preview suffix', () => {
    expect(isPreviewHostRequest(new URL('https://mail.kinu.run/'), ENV)).toBe(false);
    expect(isPreviewHostRequest(new URL('https://p-3000-x7k2.kinu.run/'), ENV)).toBe(true);
  });
});
