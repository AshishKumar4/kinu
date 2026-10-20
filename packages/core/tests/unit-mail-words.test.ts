import { expect, test } from 'bun:test';
import { splitQuotedReply, stripQuotedReply } from '../src/index';

// A message's own words and the history quoted under them, cut by the one set of reply markers the Mail page folds and
// an instruction sets aside.

const OWN = 'Ship the fix to staging first.';

test.each([
  ['Gmail', 'On Tue, 20 Oct 2026 at 14:12, Dana Whitfield <dana@northwind.io> wrote:\n> Every delivery gets a 500.'],
  ['Outlook classic', '-----Original Message-----\nFrom: Dana Whitfield\nEvery delivery gets a 500.'],
  ['an Outlook top-post block', 'From: Dana Whitfield <dana@northwind.io>\nSent: Tuesday, 20 October 2026 14:12\nEvery delivery gets a 500.'],
  ['French clients', 'Le mar. 20 oct. 2026 à 14:12, Dana Whitfield a écrit :\n> Every delivery gets a 500.'],
  ['a signature', '--\nAshish Kumar Singh'],
])('%s is folded under the message\'s own words', (_client, history) => {
  expect(splitQuotedReply(`${OWN}\n\n${history}`)).toEqual({ own: OWN, quote: expect.stringContaining(history.split('\n')[0] ?? '') });
  expect(stripQuotedReply(`${OWN}\n\n${history}`)).toBe(OWN);
});

test('a message with no quote is all its own; one that is all quote keeps its words for an instruction', () => {
  expect(splitQuotedReply(OWN)).toEqual({ own: OWN, quote: null });
  expect(stripQuotedReply('> Every delivery gets a 500.')).toBe('> Every delivery gets a 500.');
});
