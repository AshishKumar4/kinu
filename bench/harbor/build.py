"""Host-side build of the Kinu CLI as a single self-contained binary.

The DeepSWE and Terminal-Bench task images are network-isolated
(``allow_internet = false``), and the install phase runs under the environment
baseline policy — before any agent-phase allowlist applies. So installing bun
and the Kinu sources from inside the container is not an option: nothing
can be downloaded there.

``bun build --compile`` embeds the bun runtime (including ``bun:sqlite``, which
Kinu's local backend needs) into one x86-64 ELF binary, which is uploaded
into the container instead. That also pins the measurement to the working tree
under test rather than to whatever a package registry happens to serve.
"""

from __future__ import annotations

import asyncio
import atexit
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_ENTRYPOINT = Path("packages/cli/bin/cli.ts")

_build_lock = asyncio.Lock()
_built: dict[Path, Path] = {}


async def build_kinu_binary(repo_root: Path) -> Path:
    """Compile the CLI once per process and return the binary's host path.

    Concurrent trials share one build: the compile is deterministic for a given
    working tree, and 120 MB per trial is not worth re-emitting.
    """
    async with _build_lock:
        cached = _built.get(repo_root)
        if cached is not None and cached.exists():
            return cached
        binary = await asyncio.to_thread(_compile, repo_root)
        _built[repo_root] = binary
        return binary


BUILD_SCRATCH_PREFIX = ".harbor-build-"

#: A sweep only removes a leaked directory once nothing can still be using it.
#: One hour is far longer than a `bun build --compile` (seconds) and far shorter
#: than the interval between bench runs, so a concurrent build is never touched.
BUILD_SCRATCH_MAX_AGE_SECONDS = 3600.0


def sweep_build_scratch(
    repo_root: Path, now: float, max_age_seconds: float = BUILD_SCRATCH_MAX_AGE_SECONDS
) -> list[Path]:
    """Remove `.harbor-build-*` directories this repo leaked, and name them.

    The mint below registers an ``atexit`` removal, which covers a normal exit
    and nothing else: a SIGKILL, an OOM kill, or a container torn down mid-build
    leaves the directory behind. It is minted INSIDE the repository root on
    purpose — ``bun build --compile`` writes a sparse file that does not survive
    landing on another device, and ``/tmp`` is usually a separate mount — so it
    is also outside every existing sweeper: ``SCRATCH_PREFIXES`` in
    ``packages/test-utils/src/scratch.ts`` catalogues ``$TMPDIR`` prefixes and
    ``scripts/preflight.ts`` reclaims from there, neither of which can see a
    sibling of ``package.json``. ``.gitignore`` hides the leak rather than
    removing it, which is why it accumulated unnoticed.

    Age-based, and it never touches the directory the caller is about to mint:
    this runs BEFORE the mint. Errors are swallowed per entry — a sweep that
    aborts a bench run because someone else's leftovers are unreadable has made
    things worse — but every removal is returned so the caller can report it.
    """
    swept: list[Path] = []
    for candidate in sorted(repo_root.glob(f"{BUILD_SCRATCH_PREFIX}*")):
        if not candidate.is_dir():
            continue
        try:
            if now - candidate.stat().st_mtime < max_age_seconds:
                continue
            shutil.rmtree(candidate, ignore_errors=True)
        except OSError:
            continue
        if not candidate.exists():
            swept.append(candidate)
    return swept



def _compile(repo_root: Path) -> Path:
    entrypoint = repo_root / CLI_ENTRYPOINT
    if not entrypoint.exists():
        raise FileNotFoundError(
            f"Kinu CLI entrypoint not found at {entrypoint}. "
            "Point the agent at a Kinu checkout with kinu_repo=<path>."
        )
    if shutil.which("bun") is None:
        raise RuntimeError(
            "bun is required on the host to build the Kinu binary. "
            "See https://bun.com/docs/installation."
        )

    # Emit into the repo's own filesystem: bun's --compile writes a sparse file
    # that does not survive landing on a different device, and /tmp is often a
    # separate mount.
    #
    # Sweep BEFORE minting, so a directory this repo leaked to a SIGKILL is gone
    # and the one we are about to create is never a candidate. `atexit` alone
    # covers a normal exit and nothing else.
    for leaked in sweep_build_scratch(repo_root, time.time()):
        print(f"harbor: swept stale build scratch {leaked.name}", file=sys.stderr)
    out_dir = Path(tempfile.mkdtemp(prefix=BUILD_SCRATCH_PREFIX, dir=repo_root))
    atexit.register(shutil.rmtree, out_dir, True)
    binary = out_dir / "kinu"

    result = subprocess.run(
        ["bun", "build", "--compile", str(entrypoint), "--outfile", str(binary)],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not binary.exists():
        raise RuntimeError(
            f"bun build --compile failed (exit {result.returncode})\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return binary
