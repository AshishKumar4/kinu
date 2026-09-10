/**
 * The prefix devbox's own suites mint scratch directories under.
 *
 * A CONSTANT AND NOTHING ELSE, deliberately. Two forces meet here:
 *
 * `tests/independence.test.ts` refuses a workspace dependency, so these suites
 * cannot use `scratchDir` from `@kinu.run/test-utils` — and `gate:undeclared-imports`
 * refuses importing it without declaring it, so the import had to go rather than
 * be declared. Meanwhile `gate:scratch-ownership` asks that the file which MINTS
 * is the file that REMOVES, because the mint site is where the name is chosen.
 *
 * A helper that minted here and left the `afterAll` to its importers satisfies
 * that gate's pattern (`rmSync` and `afterAll` both present in this file) while
 * the hook never fires — a module-scope `afterAll` in an imported file
 * registers with no suite. Measured 2026-09-10: ten directories survived one
 * run of `snapshot-chain.test.ts` from a cleaned `/tmp`. So the executable half
 * lives in each suite, where `afterAll` is real, and only the NAME is shared —
 * which is the part that must not drift, since `SCRATCH_PREFIXES` in test-utils
 * is what `scripts/preflight.ts` counts and reclaims.
 *
 * `kinu-` opens that catalogue and its own comment calls it "deliberately
 * coarse", so this prefix is already counted without test-utils naming it.
 * The failure that list exists for is at `test-utils/src/scratch.ts:168`:
 * 5,489 directories in `/tmp`, each uniquely named, "unowned and
 * unattributable".
 */
export const DEVBOX_SCRATCH_PREFIX = 'kinu-devbox-scratch-';
