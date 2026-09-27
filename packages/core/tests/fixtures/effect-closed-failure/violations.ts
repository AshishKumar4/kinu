// Each `// [n]` case must fail to compile; unit-effect-closed-failure.test.ts names the diagnostic.
import { Data, Effect } from 'effect';
import { settle } from '../../../src/obs/index';

class OtherError extends Data.TaggedError('OtherError')<{ readonly message: string }> {}

declare const fetchText: () => Promise<string>;

// [1] a string failure
export const stringFailure = settle(Effect.fail('refused'));

// [2] a tagged error that is not KinuError
export const foreignFailure = settle(Effect.fail(new OtherError({ message: 'refused' })));

// [3] a rejection left unclassified
export const unclassified = settle(Effect.tryPromise(fetchText));

// [4] a plain Error
export const plainError = settle(Effect.fail(new Error('refused')));
