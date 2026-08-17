/**
 * Observability primitives. Platform-agnostic by construction: nothing here imports a backend.
 *
 * `expected-failure` is the error-handling half — the pinned signatures of the failures a caller may
 * declare as tolerable, and `tolerate`, which absorbs exactly the declared one and propagates
 * everything else. It is what makes the anti-slop no-swallow rules satisfiable without exempting
 * anything: `tolerate`'s own catch classifies and rethrows, so it passes all four rules unaided.
 */
export {
  classify,
  tolerate,
  tolerateAsync,
  type ExpectedFailure,
} from './expected-failure.js';
