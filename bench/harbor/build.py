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
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_ENTRYPOINT = Path("packages/cli/bin/cli.ts")

_build_lock = asyncio.Lock()
_built: dict[Path, Path] = {}


async def build_proteus_binary(repo_root: Path) -> Path:
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


def _compile(repo_root: Path) -> Path:
    entrypoint = repo_root / CLI_ENTRYPOINT
    if not entrypoint.exists():
        raise FileNotFoundError(
            f"Kinu CLI entrypoint not found at {entrypoint}. "
            "Point the agent at a Kinu checkout with proteus_repo=<path>."
        )
    if shutil.which("bun") is None:
        raise RuntimeError(
            "bun is required on the host to build the Kinu binary. "
            "See https://bun.com/docs/installation."
        )

    # Emit into the repo's own filesystem: bun's --compile writes a sparse file
    # that does not survive landing on a different device, and /tmp is often a
    # separate mount.
    out_dir = Path(tempfile.mkdtemp(prefix=".harbor-build-", dir=repo_root))
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
