import { expect, test } from 'bun:test';
import { mailboxEmail } from '@kinu.run/core';
import { refuseUnlistedHeaders } from './helpers/email-service';

// What the Mailbox hands the Email Sending binding for a person's or an approved agent's message (docs/MAIL.md §5).

const REPLY = {
  from: 'ashish@kinu.run', to: ['dana@northwind.io'], cc: ['priya@raman.dev'], subject: 'Re: Webhook deliveries to /hooks/v2 failing with 500',
  text: 'It is on our side; the fix goes out today.', headerId: '5c1f0e6e@kinu.run', inReplyTo: '<hooks-v2@northwind.io>',
};

test('the binding takes it: no Message-ID of our own, which the service refuses and writes itself', () => {
  expect(() => { refuseUnlistedHeaders(mailboxEmail(REPLY).headers); }).not.toThrow();
  expect(() => { refuseUnlistedHeaders(mailboxEmail({ ...REPLY, inReplyTo: null }).headers); }).not.toThrow();
});

test('a reply threads on what it answers, and its Cc recipients are sent to', () => {
  expect(mailboxEmail(REPLY)).toMatchObject({
    from: 'ashish@kinu.run', to: ['dana@northwind.io'], cc: ['priya@raman.dev'],
    headers: { 'In-Reply-To': '<hooks-v2@northwind.io>', References: '<hooks-v2@northwind.io>' },
  });
  expect(mailboxEmail({ ...REPLY, cc: [] })).not.toHaveProperty('cc');
});
