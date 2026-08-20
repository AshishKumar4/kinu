"""The isolation boundary every benchmark launch of Kinu stands on.

``packages/cli-backend/src/home.ts`` resolves everything a local run writes —
config, workspace databases, sessions, shadow-git checkpoints — under
``$PROTEUS_HOME``, falling back to ``~/.proteus``. So a harness that leaves the
variable unset does not merely lose tidiness: it measures the operator's own
workspaces and writes into them.

``assertScratchRoot`` in ``scripts/bench-sandbox.ts`` enforces that rule for the
TypeScript harness. This is its Python counterpart, and the reason it exists as
a module rather than a convention: both Python launchers resolve their home
through it, so a launcher that forgets fails loudly instead of quietly landing
in the real home.

Dependency-free on purpose. The CL-Bench adapter is symlinked into a CL-Bench
checkout, where ``bench`` is not importable, so it loads this file by path — the
same arrangement ``bench/harbor/trajectory.py`` uses for the event reader.
"""

from __future__ import annotations

import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: Where Kinu keeps real state when nothing overrides it.
REAL_HOME = os.path.join(os.path.expanduser("~"), ".proteus")


def _within(parent: str, child: str) -> bool:
    return child == parent or child.startswith(parent + os.sep)


def assert_throwaway_home(home: str) -> str:
    """Return *home* normalized, having proven it cannot be real state.

    Refuses the three ways a run reaches the operator's own files: an empty or
    relative path (which is the silent fallback to ``~/.proteus``), a path at or
    under the real Kinu home, and a path inside this checkout.

    Container paths pass the last two trivially, which is correct rather than
    vacuous — a trial's home is disposable because its container is. What the
    check buys there is the first rule, the one the Harbor adapter was missing,
    plus a hard stop on any future arrangement that mounts a host directory in.
    """
    raw = (home or "").strip()
    if not raw:
        raise ValueError(
            "PROTEUS_HOME is empty: an unset home falls back to "
            f"{REAL_HOME}, and a benchmark must never run there."
        )
    if not os.path.isabs(raw):
        raise ValueError(f"PROTEUS_HOME must be an absolute path, got {raw!r}")

    resolved = os.path.normpath(raw)
    if _within(REAL_HOME, resolved):
        raise ValueError(
            f"PROTEUS_HOME {resolved} is the real Kinu home — a benchmark "
            "must use a throwaway home so it can neither read nor write real state."
        )
    if _within(REPO_ROOT, resolved):
        raise ValueError(
            f"PROTEUS_HOME {resolved} is inside the repo under test — agent "
            "state must not be written into the tree being measured."
        )
    return resolved
