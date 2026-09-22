// One PATH-independent Bun resolution, inlined by both the installer and its launcher so they cannot disagree.
// The CLI needs `bun:sqlite` and `Bun.stdin`, so an unresolvable or too-old Bun is a hard stop.

/** `tests/unit-install-script.test.ts` asserts this equals the repo's `packageManager` pin. */
const KINU_BUN_VERSION = '1.4.0';

/** Non-`major.minor.patch` input is not comparable; the shell half treats it as incompatible. */
function bunVersionKey(version: string): number {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (!parts) throw new Error(`Not a major.minor.patch version: ${version}`);

  return Number(parts[1]) * 1_000_000 + Number(parts[2]) * 1_000 + Number(parts[3]);
}

/** Relative to `$KINU_HOME`. */
const KINU_MANAGED_BUN_SUBPATH = 'runtime/bin/bun';

/** Requires `$KINU_HOME`; leaves the resolved absolute path in `$KINU_BUN`. */
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
# user's next shell has — a PATH disagreement is what prints "Kinu CLI is ready."
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

/** Requires `$KINU_ORIGIN`; leaves `$TARBALL_URL`. Names must equal `CLI_DIST_PLATFORMS` in lib/deployed-assets.ts
 *  (asserted by tests/unit-install-script.test.ts); an unpublished `uname` pair stops here instead of fetching a 404. */
export function cliPlatformShell(): string {
  return `case "$(uname -s)" in
  Darwin) KINU_OS=darwin ;;
  Linux) KINU_OS=linux ;;
  *) echo "Kinu supports macOS and Linux. This is $(uname -s)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) KINU_ARCH=arm64 ;;
  x86_64|amd64) KINU_ARCH=x64 ;;
  *) echo "Kinu supports arm64 and x86_64. This is $(uname -m)." >&2; exit 1 ;;
esac
TARBALL_URL="\${KINU_ORIGIN}/downloads/kinu-cli-\${KINU_OS}-\${KINU_ARCH}.tar.gz"`;
}
