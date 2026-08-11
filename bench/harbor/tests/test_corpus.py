"""Tests for benchmark corpus identity.

Run from the repo root with no dependencies and no harbor install:

    python3 -m unittest discover -s bench/harbor/tests
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Loaded straight from the file so the suite needs no harbor SDK: the sibling
# adapter imports it, and the point of corpus.py is that it needs nothing.
# Registered in sys.modules before execution because @dataclass resolves its
# own module to read annotations.
_SPEC = importlib.util.spec_from_file_location(
    "bench_corpus", Path(__file__).resolve().parents[1] / "corpus.py"
)
assert _SPEC and _SPEC.loader
corpus = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = corpus
_SPEC.loader.exec_module(corpus)


def make_task(root: Path, name: str, *, instruction: str = "do the thing") -> Path:
    task = root / name
    (task / "tests").mkdir(parents=True)
    (task / "solution").mkdir()
    (task / "task.toml").write_text('version = "1.0"\n')
    (task / "instruction.md").write_text(instruction)
    (task / "tests" / "test_outputs.py").write_text("def test_x(): pass\n")
    (task / "solution" / "solve.sh").write_text("#!/bin/sh\ntrue\n")
    return task


class CorpusIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, dirname: str, **kwargs: object) -> Path:
        d = self.root / dirname
        d.mkdir()
        make_task(d, "alpha")
        make_task(d, "beta")
        corpus.write_manifest(
            d,
            name=str(kwargs.get("name", "terminal-bench")),
            version=str(kwargs.get("version", "2.1")),
            registry_ref="terminal-bench/terminal-bench-2-1@6",
            fetched_at="2026-08-10",
        )
        return d

    def test_a_fresh_corpus_verifies_and_reports_its_release(self) -> None:
        identity = corpus.load(self.write("tb"))
        self.assertTrue(identity.verified)
        self.assertEqual(identity.version, "2.1")
        self.assertEqual(identity.n_tasks, 2)
        self.assertIn("terminal-bench 2.1", str(identity))

    def test_editing_a_graded_file_breaks_verification(self) -> None:
        d = self.write("tb")
        (d / "alpha" / "instruction.md").write_text("something else")
        identity = corpus.load(d)
        self.assertFalse(identity.verified)
        self.assertIn("MODIFIED", str(identity))

    def test_the_reference_solution_is_not_graded_content(self) -> None:
        """2.1 rewrote solutions without changing what the agent is scored on."""
        d = self.write("tb")
        before = corpus.load(d).content_hash
        (d / "alpha" / "solution" / "solve.sh").write_text("#!/bin/sh\necho different\n")
        self.assertEqual(corpus.load(d).content_hash, before)
        self.assertTrue(corpus.load(d).verified)

    def test_same_task_names_but_different_content_are_different_corpora(self) -> None:
        """The 2.0-vs-2.1 trap: identical name sets, different benchmark."""
        a = self.write("tb20", version="2.0")
        b = self.root / "tb21"
        b.mkdir()
        make_task(b, "alpha", instruction="do the thing, precisely, with a signature")
        make_task(b, "beta")
        corpus.write_manifest(
            b, name="terminal-bench", version="2.1", fetched_at="2026-08-10"
        )
        self.assertEqual(
            sorted(p.name for p in corpus.task_dirs(a)),
            sorted(p.name for p in corpus.task_dirs(b)),
        )
        self.assertNotEqual(corpus.load(a).content_hash, corpus.load(b).content_hash)

    def test_a_corpus_without_a_manifest_is_refused_not_guessed(self) -> None:
        d = self.root / "unmarked"
        d.mkdir()
        make_task(d, "alpha")
        with self.assertRaises(corpus.CorpusError):
            corpus.load(d)

    def test_identity_is_recovered_from_a_task_inside_the_corpus(self) -> None:
        d = self.write("tb")
        self.assertEqual(corpus.resolve_for_task(d / "alpha").version, "2.1")

    def test_a_task_outside_any_corpus_resolves_to_nothing(self) -> None:
        self.assertIsNone(corpus.resolve_for_task(self.root / "nowhere" / "alpha"))

    def test_a_trial_reports_the_corpus_its_harbor_config_names(self) -> None:
        d = self.write("tb")
        trial = self.root / "trial"
        (trial / "agent").mkdir(parents=True)
        (trial / "config.json").write_text(
            json.dumps({"task": {"path": str(d / "alpha")}})
        )
        identity = corpus.resolve_for_trial(trial / "agent")
        self.assertIsNotNone(identity)
        self.assertEqual(identity.version, "2.1")

    def test_a_trial_with_no_config_does_not_invent_an_identity(self) -> None:
        trial = self.root / "bare"
        (trial / "agent").mkdir(parents=True)
        self.assertIsNone(corpus.resolve_for_trial(trial / "agent"))


if __name__ == "__main__":
    unittest.main()
