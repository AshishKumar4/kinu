import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mailVerdict } from '../src/mail/verdict';

// The three messages are real deliveries through Cloudflare's MX to a routed address, captured by a Worker on
// 2026-10-19 (docs/MAIL.md §4). Each starts with the fields Cloudflare prepends; the forged one carries its own
// Authentication-Results claiming kinu.run passed, above its From and again in its body.
const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures/mail', `${name}.eml`), 'utf8');

const PASS = fixture('cloudflare-pass');

const FORGED = fixture('forged-ar-above-and-in-body');

const SECOND_MAILBOX = fixture('second-local-part-pass');

/** The message with its From field replaced: what a sender can choose, unlike the fields Cloudflare added. */
const withFrom = (raw: string, from: string): string => raw.replace(/\r\nFrom: [^\r\n]*/u, `\r\nFrom: ${from}`);

/** The message with `from` replaced by `to` in Cloudflare's Authentication-Results field (its ARC copy, above it, untouched). */
function inVerdict(raw: string, from: string, to: string): string {
  const at = raw.indexOf('\r\nAuthentication-Results: mx.cloudflare.net;');

  return raw.slice(0, at) + raw.slice(at).replace(from, to);
}

/** The message as it would read had Cloudflare added nothing: its own fields only. */
const unstamped = (raw: string): string => raw.slice(raw.indexOf('\r\nAuthentication-Results: mx.cloudflare.net;\r\n\tdkim=pass header.d=kinu.run') + 2);

describe('the verdict is Cloudflare\'s, read from the first Authentication-Results field', () => {
  test('a message Cloudflare passed for its From domain is verified, and names that domain', () => {
    expect(mailVerdict(PASS)).toMatchObject({ verified: true, from: 'probe@ashishkumarsingh.com', domain: 'ashishkumarsingh.com' });
  });

  test('the verdict names a domain, not a mailbox: another address on the same domain passes the same way', () => {
    expect(mailVerdict(SECOND_MAILBOX)).toMatchObject({ verified: true, from: 'kinu-probe-b@ashishkumarsingh.com', domain: 'ashishkumarsingh.com' });
  });

  test('a sender\'s own Authentication-Results, above its From or in its body, is not the verdict', () => {
    const verdict = mailVerdict(FORGED);

    expect(verdict).toMatchObject({ verified: true, domain: 'ashishkumarsingh.com' });
    expect(verdict.auth?.startsWith('mx.cloudflare.net;')).toBe(true);
    expect(verdict.auth).not.toContain('header.from=kinu.run');
  });

  test('a From on a domain Cloudflare did not pass is not verified, whatever lower fields claim', () => {
    expect(mailVerdict(withFrom(FORGED, 'Ashish Kumar Singh <ashish@kinu.run>'))).toMatchObject({ verified: false, from: 'ashish@kinu.run', domain: 'kinu.run' });
  });

  test('without Cloudflare\'s fields at the top, nothing is verified, though the first field claims a pass', () => {
    const bare = unstamped(FORGED);

    expect(bare.startsWith('Authentication-Results: mx.cloudflare.net;')).toBe(true);
    expect(mailVerdict(bare).verified).toBe(false);
  });

  test('a DMARC result other than pass is not verified', () => {
    for (const result of ['fail', 'none', 'temperror', 'permerror', 'bestguesspass']) {
      expect(mailVerdict(inVerdict(PASS, 'dmarc=pass', `dmarc=${result}`)).verified).toBe(false);
    }
  });

  test('a pass for another domain than the From\'s is not verified', () => {
    expect(mailVerdict(inVerdict(PASS, 'header.from=ashishkumarsingh.com', 'header.from=example.com')).verified).toBe(false);
  });

  test('a From with two addresses, or two From fields, is not verified', () => {
    expect(mailVerdict(withFrom(PASS, 'probe@ashishkumarsingh.com, other@ashishkumarsingh.com')).verified).toBe(false);
    expect(mailVerdict(PASS.replace(/\r\nFrom: /u, '\r\nFrom: second@ashishkumarsingh.com\r\nFrom: ')).verified).toBe(false);
  });

  test('a display name with a comma or an address in quotes does not change the From address', () => {
    expect(mailVerdict(withFrom(PASS, '"Singh, Ashish <ashish@kinu.run>" <probe@ashishkumarsingh.com>'))).toMatchObject({ verified: true, from: 'probe@ashishkumarsingh.com' });
  });

  test('case does not matter in names or domains; bare LF line ends read as CRLF ones do', () => {
    const shouted = inVerdict(PASS.replace('\r\nFrom: ', '\r\nFROM: '), 'header.from=ashishkumarsingh.com', 'header.from=AshishKumarSingh.COM');

    expect(mailVerdict(shouted).verified).toBe(true);
    expect(mailVerdict(PASS.replaceAll('\r\n', '\n')).verified).toBe(true);
  });

  test('a message with no header block, or no From, is not verified', () => {
    expect(mailVerdict('').verified).toBe(false);
    expect(mailVerdict(PASS.replace(/\r\nFrom: [^\r\n]*/u, '')).verified).toBe(false);
  });
});
