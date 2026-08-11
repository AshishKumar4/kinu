"""Tests for the shared PROTEUS_HOME guard.

Run from the repo root with no dependencies and no benchmark harness installed:

    python3 -m unittest discover -s bench/tests
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

# Loaded straight from the file, the way both adapters that can only reach it by
# path do — the guard's whole point is that it needs nothing.
_SPEC = importlib.util.spec_from_file_location(
    "bench_isolation", Path(__file__).resolve().parents[1] / "isolation.py"
)
assert _SPEC and _SPEC.loader
isolation = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = isolation
_SPEC.loader.exec_module(isolation)

assert_throwaway_home = isolation.assert_throwaway_home


class ThrowawayHomeTest(unittest.TestCase):
    def test_refuses_an_unset_home(self) -> None:
        # The defect this guard exists for: no PROTEUS_HOME means ~/.proteus.
        for empty in ("", "   ", None):
            with self.assertRaises(ValueError) as caught:
                assert_throwaway_home(empty)  # type: ignore[arg-type]
            self.assertIn(isolation.REAL_HOME, str(caught.exception))

    def test_refuses_a_relative_home(self) -> None:
        with self.assertRaisesRegex(ValueError, "absolute"):
            assert_throwaway_home("scratch/home")

    def test_refuses_the_real_proteus_home(self) -> None:
        with self.assertRaisesRegex(ValueError, "real Proteus home"):
            assert_throwaway_home(isolation.REAL_HOME)
        with self.assertRaisesRegex(ValueError, "real Proteus home"):
            assert_throwaway_home(os.path.join(isolation.REAL_HOME, "sessions"))
        # Normalized before it is judged, so a detour cannot walk back in.
        with self.assertRaisesRegex(ValueError, "real Proteus home"):
            assert_throwaway_home(os.path.join(isolation.REAL_HOME, "x", "..", "y"))

    def test_refuses_a_home_inside_the_repo(self) -> None:
        with self.assertRaisesRegex(ValueError, "inside the repo"):
            assert_throwaway_home(os.path.join(isolation.REPO_ROOT, "bench-home"))

    def test_a_sibling_of_the_real_home_is_not_the_real_home(self) -> None:
        # Prefix matching without a separator would reject this one.
        sibling = isolation.REAL_HOME + "-bench"
        self.assertEqual(assert_throwaway_home(sibling), sibling)

    def test_accepts_a_throwaway_path_and_returns_it_normalized(self) -> None:
        self.assertEqual(assert_throwaway_home("/tmp/bench-run/./home/"), "/tmp/bench-run/home")

    def test_accepts_the_container_path_the_harbor_adapter_uses(self) -> None:
        self.assertEqual(
            assert_throwaway_home("/installed-agent/proteus-home"),
            "/installed-agent/proteus-home",
        )


if __name__ == "__main__":
    unittest.main()
