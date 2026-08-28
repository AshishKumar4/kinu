/**
 * ONE Bun resolution, inlined by both the served installer and the launcher
 * that installer writes.
 *
 * The two used to resolve Bun independently. The installer ran
 * `command -v bun`, and on a miss installed Bun, did
 * `export PATH="$HOME/.bun/bin:$PATH"` **in its own process**, re-checked
 * there and printed "Kinu CLI is ready." Nothing persisted that directory to
 * any profile — only `$KINU_HOME/bin` was appended — so the next shell ran the
 * launcher, which re-derived Bun from whatever ambient PATH it happened to
 * have, missed the same Bun sitting on disk and answered "Bun is required."
 * One runtime, two resolutions, and the install transcript said the opposite
 * of the first command the user typed.
 *
 * So there is one resolution and both scripts inline this text. Its candidate
 * order is fixed and PATH-independent, which is what makes the launcher reach
 * the binary the installer verified without any recorded state between them:
 * Kinu's own managed install is tried first, at an absolute path the installer
 * controls, and only then whatever Bun the user already has.
 *
 * Presence is not the question either — compatibility is. Both sides used to
 * accept any `bun` on PATH, so a Bun too old for this tree passed the gate and
 * failed later inside `bun install` with a message about neither Bun nor Kinu.
 * The check reads the candidate's own `--version`.
 *
 * There is no second runtime to fall back to: the CLI imports `bun:sqlite` and
 * `Bun.stdin` (packages/cli/src/config.ts, commands/run.ts), so an
 * unresolvable Bun is a hard stop that names the one command that fixes it.
 */

/**
 * The approved Bun. `tests/unit-install-script.test.ts` asserts this equals the
 * repository's own `packageManager` pin: two spellings of one version is how a
 * shipped installer drifts from the tree it installs.
 */
export const KINU_BUN_VERSION = '1.4.0';

/**
 * A `major.minor.patch` version as one comparable integer. Anything that is not
 * three dot-separated numbers is not comparable, and the shell half treats that
 * as incompatible rather than guessing.
 */
export function bunVersionKey(version: string): number {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts) throw new Error(`Not a major.minor.patch version: ${version}`);
  return Number(parts[1]) * 1_000_000 + Number(parts[2]) * 1_000 + Number(parts[3]);
}

/** Where the installer puts the Bun it installs, relative to `$KINU_HOME`. */
export const KINU_MANAGED_BUN_SUBPATH = 'runtime/bin/bun';

/**
 * The shared resolution, as shell. Requires `$KINU_HOME` to be set already and
 * leaves the resolved absolute path in `$KINU_BUN`.
 */
export function bunResolutionShell(): string {
  return `KINU_BUN_VERSION="${KINU_BUN_VERSION}"
KINU_BUN_MIN_KEY=${bunVersionKey(KINU_BUN_VERSION)}
KINU_MANAGED_BUN="$KINU_HOME/${KINU_MANAGED_BUN_SUBPATH}"
KINU_BUN=""

# A candidate's own version as one comparable integer. A version that is not
# three dot-separated numbers is not comparable, so it does not qualify.
kinu_bun_key() {
  case "$1" in *.*.*) ;; *) return 1 ;; esac
  kb_major="\${1%%.*}"
  kb_rest="\${1#*.}"
  kb_minor="\${kb_rest%%.*}"
  kb_patch="\${kb_rest#*.}"
  kb_patch="\${kb_patch%%[!0-9]*}"
  case "$kb_major$kb_minor$kb_patch" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$(( kb_major * 1000000 + kb_minor * 1000 + kb_patch ))"
}

# An ABSOLUTE path or nothing: an executable test on a bare name resolves
# against the working directory, so a file named bun sitting wherever the user
# happened to run this would qualify as the runtime.
kinu_bun_compatible() {
  [ -n "\${1:-}" ] || return 1
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -x "$1" ] || return 1
  kc_version="$("$1" --version 2>/dev/null)" || return 1
  kc_key="$(kinu_bun_key "$kc_version")" || return 1
  [ "$kc_key" -ge "$KINU_BUN_MIN_KEY" ]
}

# Kinu's managed Bun first. It is an absolute path the installer controls, so
# the launcher resolves the binary the installer verified whatever PATH the
# user's next shell has — that disagreement is what printed "Kinu CLI is ready."
# and then "Bun is required."
kinu_resolve_bun() {
  KINU_BUN=""
  for kr_candidate in "$KINU_MANAGED_BUN" "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun"; do
    if kinu_bun_compatible "$kr_candidate"; then
      KINU_BUN="$kr_candidate"
      return 0
    fi
  done
  return 1
}
`;
}
