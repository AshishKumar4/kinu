// KINU-086 egress destination classifier, a pure judgment over a URL. The CF adapter's
// boundary is asserted in the cf-backend suite.
import { describe, expect, test } from 'bun:test';
import { refusedHostname } from '../src/safety/egress-destination';
import { present } from '@kinu.run/test-utils';

const judged = (url: string) => refusedHostname(new URL(url).hostname);

function judgesFamily(denied: readonly string[], allowed: readonly string[]): void {
  for (const url of denied) expect(judged(url)).toMatchObject({ reason: 'denied' });

  for (const url of allowed) expect(judged(url)).toBeNull();
}

describe('IPv4 literals of every refused family', () => {
  test('RFC1918 — 10/8, 172.16/12, 192.168/16', () => {
    expect(judged('http://10.0.0.5/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://172.16.0.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://172.31.255.255/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://192.168.1.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://172.15.0.1/')).toBeNull();
    expect(judged('http://172.32.0.1/')).toBeNull();
  });

  test('loopback — 127/8 in all canonical spellings', () => {
    expect(judged('http://127.0.0.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://127.8.8.8/')).toMatchObject({ reason: 'denied' });
    // WHATWG canonicalization collapses obfuscated spellings before the classifier sees them.
    expect(new URL('http://127.1/').hostname).toBe('127.0.0.1');
    expect(new URL('http://0x7f000001/').hostname).toBe('127.0.0.1');
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1');
    expect(new URL('http://0177.0.0.1/').hostname).toBe('127.0.0.1');

    for (const spelling of ['127.1', '0x7f000001', '2130706433', '0177.0.0.1']) {
      expect(judged(`http://${spelling}/`)).toMatchObject({ reason: 'denied' });
    }
  });

  test('link-local 169.254/16 including the cloud-metadata address', () => {
    judgesFamily(
      ['http://169.254.169.254/latest/meta-data/', 'http://169.254.0.1/'],
      ['http://169.255.0.1/'],
    );
  });

  test('CGNAT 100.64/10 boundaries', () => {
    expect(judged('http://100.64.0.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://100.127.255.255/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://100.63.0.1/')).toBeNull();
    expect(judged('http://100.128.0.1/')).toBeNull();
  });

  test('this-network 0.0.0.0/8', () => {
    expect(judged('http://0.0.0.0/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://0.1.2.3/')).toMatchObject({ reason: 'denied' });
  });
});

describe('IPv6 literal forms', () => {
  test('loopback ::1 and unspecified ::', () => {
    expect(judged('http://[::1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[0:0:0:0:0:0:0:1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::]/')).toMatchObject({ reason: 'denied' });
    // The 1 is in the last group; reading the first group would match `1::` instead.
    expect(judged('http://[1::]/')).toBeNull();
  });

  test('link-local fe80::/10 — full range, any interface', () => {
    judgesFamily(['http://[fe80::a]/', 'http://[febf::1]/'], ['http://[fec0::1]/']);
  });

  test('unique-local fc00::/7 (the private-fabric ULA)', () => {
    judgesFamily(['http://[fc00::1]/', 'http://[fdff::1]/'], ['http://[fb00::1]/']);
  });

  test('IPv4-mapped and IPv4-compatible forms are classified by the embedded IPv4', () => {
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(judged('http://[::ffff:169.254.169.254]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::ffff:127.0.0.1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::ffff:10.0.0.5]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::127.0.0.1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::ffff:8.8.8.8]/')).toBeNull();
  });
});

describe('reserved names', () => {
  test('metadata hostnames and bare localhost', () => {
    expect(judged('http://metadata.google.internal/computeMetadata/v1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://metadata.goog/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://metadata:80/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://localhost:8080/admin')).toMatchObject({ reason: 'denied' });
    expect(judged('http://localhost./')).toMatchObject({ reason: 'denied' });
  });

  test('the RFC 6761 .localhost domain resolves to loopback, so it is refused', () => {
    expect(judged('http://api.service.localhost/')).toMatchObject({ reason: 'denied' });
    expect(new URL('http://foo.%6Co%63alhost/').hostname).toBe('foo.localhost');
    expect(judged('http://foo.%6Co%63alhost/')).toMatchObject({ reason: 'denied' });
  });
});

describe('the public control still succeeds', () => {
  test('ordinary public destinations answer null', () => {
    expect(judged('https://example.com/')).toBeNull();
    expect(judged('https://api.stripe.com/v1/charges')).toBeNull();
    expect(judged('http://172.15.9.9/')).toBeNull();
    expect(judged('http://169.255.1.1/')).toBeNull();
    expect(judged('http://[2606:4700:4700::1111]/')).toBeNull();
    expect(judged('http://[::ffff:8.8.8.8]/')).toBeNull();
  });

  test('the refusal payload is the shared wire shape, never a bare string', () => {
    const refusal = present(judged('http://169.254.169.254/'), 'the metadata-address refusal');

    expect(Object.keys(refusal)).toEqual(['reason', 'error']);
    expect(refusal.reason).toBe('denied');
    expect(refusal.error.length).toBeGreaterThan(0);
  });
});

describe('fail closed on anything not fully judged', () => {
  test('a bracketed literal that does not re-parse as IPv6 is refused, not passed', () => {
    // Only reachable by callers that bypass the URL parser.
    expect(refusedHostname('[not-an-ipv6]')).toMatchObject({ reason: 'denied' });
  });

  test('a short numeric form is refused rather than expanded', () => {
    // WHATWG URLs never produce this form, and permissive expansions disagree on its target.
    expect(new URL('http://10.1/').hostname).toBe('10.0.0.1');
    expect(judged('http://10.1/')).toMatchObject({ reason: 'denied' });
    expect(refusedHostname('169.254')).toMatchObject({ reason: 'denied' });
    expect(refusedHostname('4294967295')).toMatchObject({ reason: 'denied' });
    expect(refusedHostname('12345678901')).toMatchObject({ reason: 'denied' });
  });

  test('an empty hostname is refused', () => {
    expect(refusedHostname('')).toMatchObject({ reason: 'denied' });
  });
});
