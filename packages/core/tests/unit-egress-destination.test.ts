// KINU-086 — the egress destination classifier: which destinations untrusted
// code must never reach, as a pure judgment over a URL.
//
// The families and the public control that must still succeed, plus the
// fail-closed cases. The CF adapter's own boundary (refusal → Worker
// Response, redirect hops re-checked) is asserted in the cf-backend suite;
// what belongs here is the JUDGMENT itself, which compiles in core.
import { describe, expect, test } from 'bun:test';
import { refusedHostname } from '../src/safety/egress-destination';

const judged = (url: string) => refusedHostname(new URL(url).hostname);

describe('IPv4 literals of every refused family', () => {
  test('RFC1918 — 10/8, 172.16/12, 192.168/16', () => {
    expect(judged('http://10.0.0.5/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://172.16.0.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://172.31.255.255/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://192.168.1.1/')).toMatchObject({ reason: 'denied' });
    // The 172/12 boundaries: 172.15 and 172.32 are public.
    expect(judged('http://172.15.0.1/')).toBeNull();
    expect(judged('http://172.32.0.1/')).toBeNull();
  });

  test('loopback — 127/8 in all canonical spellings', () => {
    expect(judged('http://127.0.0.1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://127.8.8.8/')).toMatchObject({ reason: 'denied' });
    // WHATWG canonicalization collapses the obfuscated spellings before the
    // classifier sees them — measured under Bun, asserted at the boundary.
    expect(new URL('http://127.1/').hostname).toBe('127.0.0.1');
    expect(new URL('http://0x7f000001/').hostname).toBe('127.0.0.1');
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1');
    expect(new URL('http://0177.0.0.1/').hostname).toBe('127.0.0.1');
    for (const spelling of ['127.1', '0x7f000001', '2130706433', '0177.0.0.1']) {
      expect(judged(`http://${spelling}/`)).toMatchObject({ reason: 'denied' });
    }
  });

  test('link-local 169.254/16 including the cloud-metadata address', () => {
    expect(judged('http://169.254.169.254/latest/meta-data/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://169.254.0.1/')).toMatchObject({ reason: 'denied' });
    // 169.255 is outside the /16 and public.
    expect(judged('http://169.255.0.1/')).toBeNull();
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
    // The 1 sits in the LAST group. A check reading the FIRST group instead
    // matches `1::` and not loopback at all, which is what this pins.
    expect(judged('http://[1::]/')).toBeNull();
  });

  test('link-local fe80::/10 — full range, any interface', () => {
    expect(judged('http://[fe80::a]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[febf::1]/')).toMatchObject({ reason: 'denied' });
    // fc00 is ULA, not link-local, and separately refused below.
    expect(judged('http://[fec0::1]/')).toBeNull();
  });

  test('unique-local fc00::/7 (the private-fabric ULA)', () => {
    expect(judged('http://[fc00::1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[fdff::1]/')).toMatchObject({ reason: 'denied' });
    // fb00 is outside fc00::/7.
    expect(judged('http://[fb00::1]/')).toBeNull();
  });

  test('IPv4-mapped and IPv4-compatible forms are classified by the embedded IPv4', () => {
    // Canonicalized to compressed group form; the classifier re-expands.
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(judged('http://[::ffff:169.254.169.254]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::ffff:127.0.0.1]/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://[::ffff:10.0.0.5]/')).toMatchObject({ reason: 'denied' });
    // Compatible (deprecated) form: ::127.0.0.1 — the whole address is the
    // embedded IPv4.
    expect(judged('http://[::127.0.0.1]/')).toMatchObject({ reason: 'denied' });
    // A mapped public IPv4 is fine.
    expect(judged('http://[::ffff:8.8.8.8]/')).toBeNull();
  });
});

describe('reserved names', () => {
  test('metadata hostnames and bare localhost', () => {
    expect(judged('http://metadata.google.internal/computeMetadata/v1/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://metadata.goog/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://metadata:80/')).toMatchObject({ reason: 'denied' });
    expect(judged('http://localhost:8080/admin')).toMatchObject({ reason: 'denied' });
    // Trailing-dot spelling addresses the same host.
    expect(judged('http://localhost./')).toMatchObject({ reason: 'denied' });
  });

  test('the RFC 6761 .localhost domain resolves to loopback, so it is refused', () => {
    expect(judged('http://api.service.localhost/')).toMatchObject({ reason: 'denied' });
    // Percent-escapes decode to the same name (measured: %6C → l).
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
    const refusal = judged('http://169.254.169.254/');
    expect(Object.keys(refusal!)).toEqual(['reason', 'error']);
    expect(refusal!.reason).toBe('denied');
    expect(refusal!.error.length).toBeGreaterThan(0);
  });
});

describe('fail closed on anything not fully judged', () => {
  test('a bracketed literal that does not re-parse as IPv6 is refused, not passed', () => {
    // Reachable only through a caller that bypasses the URL parser; the
    // parser itself throws on garbage. The hostname string form is the seam.
    expect(refusedHostname('[not-an-ipv6]')).toMatchObject({ reason: 'denied' });
  });

  test('a short numeric form is refused rather than expanded', () => {
    // A WHATWG URL never produces one (it expands `10.1` → `10.0.0.1`,
    // measured), so one arriving means a non-parser caller — refused because
    // permissive expansions disagree about what it addresses.
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
