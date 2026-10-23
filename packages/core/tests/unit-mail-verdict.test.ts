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

// Cloudflare's own field copies what the sender controls into it: a DKIM signature's d= and s=, the envelope sender in
// SPF's comment and smtp.mailfrom (the PASS fixture's field, 2026-10-19). Read as RFC 8601 reads it, a `;` in a comment
// or a quoted string separates nothing, and only a result named `dmarc` is the DMARC verdict.
describe("text the sender put inside Cloudflare's field is never read as its verdict", () => {
  /** PASS with Cloudflare's results replaced by `results`, as its MX would write them for a crafted message. */
  const resultsOf = (results: string): string => {
    const start = PASS.indexOf('\r\nAuthentication-Results: mx.cloudflare.net;');
    const end = PASS.indexOf('\r\n', PASS.indexOf('arc=none', start));

    return withFrom(`${PASS.slice(0, start)}\r\nAuthentication-Results: mx.cloudflare.net;\r\n\t${results}${PASS.slice(end)}`, 'boss@victim.example');
  };

  test("a `;` inside SPF's comment of the envelope sender starts no result of its own", () => {
    const raw = resultsOf('dkim=none; spf=pass (mx.cloudflare.net: domain of "a;dmarc=pass header.from=victim.example x"@attacker.example designates 1.2.3.4) smtp.mailfrom=attacker.example');

    expect(mailVerdict(raw).verified).toBe(false);
  });

  test("a `;` inside a quoted property value starts no result of its own", () => {
    const raw = resultsOf('dkim=none; spf=pass smtp.mailfrom="a;dmarc=pass header.from=victim.example x"@attacker.example');

    expect(mailVerdict(raw).verified).toBe(false);
  });

  test("words that read `dmarc=pass` inside another method's result are not the DMARC result", () => {
    const raw = resultsOf('dkim=permerror header.d=attacker.example header.s=s1 dmarc=pass header.from=victim.example; dmarc=fail header.from=victim.example policy.dmarc=reject');

    expect(mailVerdict(raw).verified).toBe(false);
  });

  test('two DMARC results for one message decide nothing', () => {
    expect(mailVerdict(resultsOf('dmarc=pass header.from=victim.example; dmarc=fail header.from=victim.example')).verified).toBe(false);
  });

  test("a comment beside Cloudflare's own DMARC pass, as RFC 8601 allows one, still reads as that pass", () => {
    expect(mailVerdict(resultsOf('dkim=pass header.d=victim.example; dmarc=pass (p=reject) header.from=victim.example policy.dmarc=reject')).verified).toBe(true);
  });
});
