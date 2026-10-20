import { describe, expect, test } from 'bun:test';
import { mailAddressOf, mailLabelOf, mailPathOf, parseMailRecipient } from '../src/mail/address';

const DOMAIN = 'kinu.run';

describe('a recipient names one box: the person, a workspace or an agent, under a username', () => {
  test('a bare username is the person\'s own box', () => {
    expect(parseMailRecipient('ashish@kinu.run', DOMAIN)).toEqual({ username: 'ashish', path: '', tag: null });
  });

  test('a workspace under the username, and an agent under the workspace', () => {
    expect(parseMailRecipient('api-worker.ashish@kinu.run', DOMAIN)).toEqual({ username: 'ashish', path: 'api-worker', tag: null });
    expect(parseMailRecipient('scout.api-worker.ashish@kinu.run', DOMAIN)).toEqual({ username: 'ashish', path: 'scout.api-worker', tag: null });
  });

  test('a +tag reaches the same box and is kept; case and the domain\'s case do not matter', () => {
    expect(parseMailRecipient('Ashish+Receipts@Kinu.Run', DOMAIN)).toEqual({ username: 'ashish', path: '', tag: 'receipts' });
    expect(parseMailRecipient('scout.api-worker.ashish+ci@kinu.run', DOMAIN)).toEqual({ username: 'ashish', path: 'scout.api-worker', tag: 'ci' });
  });

  test('another domain, no domain, more than three labels, or a malformed label is no box', () => {
    for (const address of [
      'ashish@example.com', 'ashish', 'a.b.c.ashish@kinu.run', '.ashish@kinu.run', 'api..ashish@kinu.run',
      '-x.ashish@kinu.run', 'x-.ashish@kinu.run', 'ash ish@kinu.run', `${'a'.repeat(21)}@kinu.run`, 'ashish+@kinu.run', '@kinu.run',
    ]) {
      expect(parseMailRecipient(address, DOMAIN)).toBeNull();
    }
  });

  test('a box\'s address is its path under the username, and reads back to the same box', () => {
    for (const path of ['', 'api-worker', 'scout.api-worker']) {
      const address = mailAddressOf('ashish', path, DOMAIN);

      expect(parseMailRecipient(address, DOMAIN)).toEqual({ username: 'ashish', path, tag: null });
    }

    expect(mailAddressOf('ashish', 'scout.api-worker', DOMAIN)).toBe('scout.api-worker.ashish@kinu.run');
  });

  test('a workspace\'s box path is its name; an agent\'s is the agent\'s name under it', () => {
    expect(mailPathOf({ kind: 'person' })).toBe('');
    expect(mailPathOf({ kind: 'workspace', workspace: 'api-worker' })).toBe('api-worker');
    expect(mailPathOf({ kind: 'agent', workspace: 'api-worker', agent: 'scout' })).toBe('scout.api-worker');
  });

  test('a workspace\'s name becomes its label: lowercased, dots and underscores as hyphens, cut to twenty', () => {
    expect(mailLabelOf('API Worker')).toBe('api-worker');
    expect(mailLabelOf('kinu.run_site')).toBe('kinu-run-site');
    expect(mailLabelOf('handwrought-walnut-4166c321')).toBe('handwrought-walnut-4');
    expect(mailLabelOf('Router firmware in Ghidra -')).toBe('router-firmware-in-g');
    expect(mailLabelOf('---')).toBeNull();
    expect(mailLabelOf('ab-------------------cd')).toBe('ab-cd');
  });
});
