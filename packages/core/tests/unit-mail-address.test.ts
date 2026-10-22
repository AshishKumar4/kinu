import { describe, expect, test } from 'bun:test';
import { mailAddressOf, mailDeploymentAliases, mailLabelOf, mailUsernameRefusal, parseMailRecipient, suggestedMailUsername } from '../src/mail/address';

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

  test('a workspace\'s name becomes its label: lowercased, dots and underscores as hyphens, cut to twenty', () => {
    expect(mailLabelOf('API Worker')).toBe('api-worker');
    expect(mailLabelOf('kinu.run_site')).toBe('kinu-run-site');
    expect(mailLabelOf('handwrought-walnut-4166c321')).toBe('handwrought-walnut-4');
    expect(mailLabelOf('Router firmware in Ghidra -')).toBe('router-firmware-in-g');
    expect(mailLabelOf('---')).toBeNull();
    expect(mailLabelOf('ab-------------------cd')).toBe('ab-cd');
  });
});

describe('the username a person is offered, and the ones they may not have', () => {
  test('is their first name, lowercased, as it reads in an address; else their email\'s local part', () => {
    expect(suggestedMailUsername({ displayName: 'Ashish Kumar Singh', email: 'me@ashishkumarsingh.com' })).toBe('ashish');
    expect(suggestedMailUsername({ displayName: 'José Ramírez', email: 'jr@example.com' })).toBe('jose');
    expect(suggestedMailUsername({ displayName: '  Priya ', email: 'priya.raman@raman.dev' })).toBe('priya');
    expect(suggestedMailUsername({ displayName: null, email: 'priya.raman@raman.dev' })).toBe('priya-raman');
    expect(suggestedMailUsername({ displayName: '李', email: 'dana_w@northwind.io' })).toBe('dana-w');
    expect(suggestedMailUsername({ displayName: 'Admin', email: 'postmaster@example.com' })).toBeNull();
  });

  test('a username is a label no one else may need: the mail systems\' names are reserved', () => {
    expect(mailUsernameRefusal('ashish')).toBeNull();
    expect(mailUsernameRefusal('')).toBe('invalid');
    expect(mailUsernameRefusal('Ashish')).toBe('invalid');
    expect(mailUsernameRefusal('-ashish')).toBe('invalid');
    expect(mailUsernameRefusal('a'.repeat(21))).toBe('invalid');
    expect(['postmaster', 'abuse', 'noreply', 'dmarc', 'admin'].map(mailUsernameRefusal)).toEqual(['reserved', 'reserved', 'reserved', 'reserved', 'reserved']);
  });
});

describe("the deployment's own addresses", () => {
  test('are read from MAIL_ALIASES as labels to usernames; unset is none, and anything else is refused, never read as none', () => {
    expect(mailDeploymentAliases(undefined)).toEqual(new Map());
    expect(mailDeploymentAliases('{"privacy": "ashish"}')).toEqual(new Map([['privacy', 'ashish']]));

    for (const raw of ['privacy=ashish', '["privacy"]', '{"privacy": 1}', '{"Privacy": "ashish"}', '{"privacy": "privacy"}', '{"privacy": "ash ish"}']) {
      expect(mailDeploymentAliases(raw)).toBe('malformed');
    }
  });
});
