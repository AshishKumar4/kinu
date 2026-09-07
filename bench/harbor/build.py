"""Host-side build of the Kinu CLI binary and its external runtime assets.

The DeepSWE and Terminal-Bench task images are network-isolated
(``allow_internet = false``), and the install phase runs under the environment
baseline policy — before any agent-phase allowlist applies. So installing bun
and the Kinu sources from inside the container is not an option: nothing
can be downloaded there.

``bun build --compile`` embeds the bun runtime (including ``bun:sqlite``, which
Kinu's local backend needs) into one x86-64 ELF binary, which is uploaded
into the container instead. That also pins the measurement to the working tree
under test rather than to whatever a package registry happens to serve.

Two packages stay OUT of that binary. ``@nimbus-sh/runtime-bash`` and
``@nimbus-sh/runtime-cpython`` read a manifest, then 39 MB of wasm32-wasi blobs,
from a path relative to their own ``import.meta.url`` — and they do it in a
module-scope initializer, so the read happens before the CLI parses its first
argument. ``--compile`` embeds JavaScript, not a blob tree, and inside the
binary ``import.meta.url`` is ``/$bunfs/root/``, so every invocation died with
``ENOENT: no such file or directory, open '/$bunfs/root/manifest.json'``. They
are marked external and their real directories are uploaded beside the binary;
``NODE_PATH`` is what lets the binary find them from any working directory.

The same failure was repaired on an unmerged branch in ``70c9aeb0e``. The
published baseline still reproduced it on 2026-09-07. Each new build must
therefore pass a credential-free startup probe before any container is opened.
"""

from __future__ import annotations

import asyncio
import atexit
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_ENTRYPOINT = Path("packages/cli/bin/cli.ts")

# Shared by the production artifact builder and the compiled benchmark build.
EXTERNAL_MODULES: tuple[str, ...] = tuple(json.loads(
    (REPO_ROOT / "scripts/cli-runtime-packages.json").read_text(encoding="utf-8")
))


@dataclass(frozen=True)
class KinuBuild:
    """What a trial has to install: one binary, plus the packages it cannot
    carry."""

    binary: Path
    #: Specifier → host directory, for every entry of `EXTERNAL_MODULES`.
    modules: dict[str, Path]
    source_sha: str | None
    source_dirty: bool
    binary_sha256: str


_build_lock = asyncio.Lock()
_built: dict[Path, KinuBuild] = {}


async def build_kinu_binary(repo_root: Path) -> KinuBuild:
    """Compile the CLI once per process and return what a trial installs.

    Concurrent trials share one build: the compile is deterministic for a given
    working tree, and 120 MB per trial is not worth re-emitting.
    """
    async with _build_lock:
        cached = _built.get(repo_root)
        if cached is not None and cached.binary.exists():
            return cached
        build = await asyncio.to_thread(_compile, repo_root)
        _built[repo_root] = build
        return build


def external_module_dirs(repo_root: Path) -> dict[str, Path]:
    """Where each externalised package lives in this checkout.

    Resolved BEFORE the compile so a missing install fails in seconds, rather
    than as `Cannot find module` inside every container after a 120 MB upload.
    """
    dirs: dict[str, Path] = {}
    for specifier in EXTERNAL_MODULES:
        path = repo_root / "node_modules" / Path(specifier)
        if not (path / "package.json").is_file():
            raise FileNotFoundError(
                f"{specifier} is not installed at {path}. It is kept out of the "
                "compiled binary and uploaded as a directory, so the binary "
                "cannot start without it. Run `bun install` in this checkout."
            )
        dirs[specifier] = path
    return dirs


def probe_binary(binary: Path, node_path: Path) -> str:
    """Start the artifact away from the checkout, using only its declared assets."""
    with tempfile.TemporaryDirectory(prefix="kinu-build-probe-") as cwd:
        result = subprocess.run(
            [str(binary), "--version"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=120,
            env={"NODE_PATH": str(node_path)},
        )
    if result.returncode != 0:
        raise RuntimeError(
            f"{binary} cannot start (exit {result.returncode}) — a compiled CLI that "
            "dies before parsing its first argument would fail every trial at "
            f"install, so it is refused here.\nstderr: {result.stderr[-2000:]}"
        )
    return result.stdout.strip()


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



def _compile(repo_root: Path) -> KinuBuild:
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
    modules = external_module_dirs(repo_root)
    git_env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    revision = subprocess.run(["git", "-C", str(repo_root), "rev-parse", "HEAD"], capture_output=True, text=True, env=git_env)
    source_sha = revision.stdout.strip() if revision.returncode == 0 else None
    status = subprocess.run(
        ["git", "-C", str(repo_root), "status", "--porcelain=v1", "--untracked-files=all"],
        capture_output=True, text=True, env=git_env,
    )
    source_dirty = status.returncode != 0 or bool(status.stdout)

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

    external_flags = [flag for name in EXTERNAL_MODULES for flag in ("--external", name)]
    result = subprocess.run(
        ["bun", "build", "--compile", str(entrypoint), "--outfile", str(binary),
         *external_flags],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not binary.exists():
        raise RuntimeError(
            f"bun build --compile failed (exit {result.returncode})\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    # The host is where the externals resolve from this checkout; the container
    # resolves them from the uploaded copy under the same variable.
    probe_binary(binary, repo_root / "node_modules")
    with binary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return KinuBuild(binary=binary, modules=modules, source_sha=source_sha, source_dirty=source_dirty, binary_sha256=digest)
