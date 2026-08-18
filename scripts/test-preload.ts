// `bun test`'s entry, named by `bunfig.toml`'s `preload`.
//
// Three lines on purpose: the throwaway PROTEUS_HOME, the release and the
// SIGKILL backstop all live in `./test-scratch-home.ts`, which vitest's entry
// imports too. All this file contributes is the `afterAll` that belongs to THIS
// runner — `bun:test`'s, which throws if called under any other.
import { afterAll } from 'bun:test';

import { release } from './test-scratch-home';

afterAll(release);
