// The shapes product code uses; none may draw a diagnostic.
import { Effect } from 'effect';
import { attempt, KinuError, settle } from '../../../src/obs/index';
import { makeVfsError } from '../../../src/vfs/errno';

declare const fetchText: () => Promise<string>;

export const refused = settle(Effect.fail(new KinuError('denied', 'refused')));

export const classified = settle(attempt({ doing: 'fetching the page', otherwise: 'io' }, fetchText));

export const composed = settle(Effect.gen(function* () {
  const text = yield* attempt({ doing: 'fetching the page', otherwise: 'io' }, fetchText);

  if (text.length === 0) return yield* new KinuError('missing', 'the page is empty');

  return text;
}));

export const outcome = settle(Effect.result(Effect.succeed(1)));

export const fileRefused = settle(Effect.fail(makeVfsError('EROFS', 'read-only file system', '/mnt/ro/a.txt')));
