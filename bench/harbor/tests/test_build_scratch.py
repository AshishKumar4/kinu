"""Tests for the harbor build-scratch sweep.

Run from the repo root with no dependencies and no harbor install:

    python3 -m unittest discover -s bench/harbor/tests -t bench/harbor/tests

`-t` as well as `-s`: these directories carry no ``__init__.py``, so
``discover -s bench/harbor/tests -t .`` raises
``ImportError: Start directory is not importable`` and
``discover -s bench`` reports ``Ran 0 tests`` and exits 0. The gate that runs
this (``bun run gate:python-suites``) derives the same invocation from
``scripts/sources.ts``'s ``isPythonSuite``.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import time
import unittest
from pathlib import Path

# Loaded straight from the file, the way the corpus tests beside it are: the
# sweep must need nothing that a bench install provides.
_SPEC = importlib.util.spec_from_file_location(
    "harbor_build", Path(__file__).resolve().parents[1] / "build.py"
)
assert _SPEC is not None and _SPEC.loader is not None
_BUILD = importlib.util.module_from_spec(_SPEC)
sys.modules["harbor_build"] = _BUILD
_SPEC.loader.exec_module(_BUILD)

PREFIX = _BUILD.BUILD_SCRATCH_PREFIX
sweep = _BUILD.sweep_build_scratch


class BuildScratchSweep(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def _leak(self, name: str, age_seconds: float) -> Path:
        directory = self.root / f"{PREFIX}{name}"
        directory.mkdir()
        (directory / "kinu").write_bytes(b"binary")
        stamp = time.time() - age_seconds
        import os

        os.utime(directory, (stamp, stamp))
        return directory

    def test_sweeps_a_directory_older_than_the_window(self) -> None:
        """The SIGKILL case: atexit never ran, so nothing removed this."""
        leaked = self._leak("aaaa", age_seconds=7200)
        now = time.time()
        self.assertEqual(sweep(self.root, now), [leaked])
        self.assertFalse(leaked.exists())

    def test_keeps_a_directory_inside_the_window(self) -> None:
        """A concurrent build must never lose its own output directory."""
        fresh = self._leak("bbbb", age_seconds=1)
        self.assertEqual(sweep(self.root, time.time()), [])
        self.assertTrue(fresh.exists())

    def test_touches_nothing_that_lacks_the_prefix(self) -> None:
        """The sweep is minted inside the repository root, beside real source."""
        source = self.root / "packages"
        source.mkdir()
        (source / "keep.ts").write_text("export const x = 1;\n")
        stamp = time.time() - 7200
        import os

        os.utime(source, (stamp, stamp))
        self.assertEqual(sweep(self.root, time.time()), [])
        self.assertTrue((source / "keep.ts").exists())

    def test_ignores_a_prefixed_file(self) -> None:
        """Only directories are minted, so only directories are removed."""
        stray = self.root / f"{PREFIX}notadir"
        stray.write_text("")
        import os

        stamp = time.time() - 7200
        os.utime(stray, (stamp, stamp))
        self.assertEqual(sweep(self.root, time.time()), [])
        self.assertTrue(stray.exists())

    def test_reports_every_removal(self) -> None:
        """The caller prints what it swept; a silent sweep is a silent surprise."""
        first = self._leak("cccc", age_seconds=7200)
        second = self._leak("dddd", age_seconds=7200)
        self.assertEqual(sorted(sweep(self.root, time.time())), sorted([first, second]))

    def test_an_empty_root_sweeps_nothing_and_does_not_raise(self) -> None:
        self.assertEqual(sweep(self.root, time.time()), [])

    def test_the_window_is_a_parameter_the_caller_can_tighten(self) -> None:
        leaked = self._leak("eeee", age_seconds=5)
        self.assertEqual(sweep(self.root, time.time(), max_age_seconds=1.0), [leaked])


if __name__ == "__main__":
    unittest.main()
