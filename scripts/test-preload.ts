// Every test process gets a throwaway PROTEUS_HOME.
//
// `proteusHome()` falls back to `~/.proteus`, and a test that drives the local
// runtime writes there for real: `createCLIRuntime` builds a shadow-git
// checkpoint engine rooted at `$PROTEUS_HOME/checkpoints`, and every /pc or
// /workspace write snapshots into it. That is how packages/cli-backend/tests/
// mount-plane.test.ts put ~580 checkpoint stores — keyed by its own /tmp
// scratch directories — into the developer's real home.
//
// Setting it per suite would be one more thing to remember in each of the
// eleven test files that build a runtime, so it is set once, here, for every
// `bun test` process. Tests that need the fallback still delete the variable
// themselves.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'proteus-test-home-'));
process.env.PROTEUS_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
