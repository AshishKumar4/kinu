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


class CrossReleaseSamenessTest(unittest.TestCase):
    """The denominator a cross-release flip rate needs.

    2.1 migrated every task.toml from schema 1.0 to 1.1, so NO task directory is
    byte-identical across the releases even where the work and the verifier are
    unchanged. A flip rate quoted over the graded definition therefore has a
    denominator of zero identical tasks, while the scored definition -- what the
    agent must do and how it is judged -- keeps the tasks that really are the
    same task. Both are reported; neither is guessed.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_a_manifest_schema_migration_changes_graded_but_not_scored(self) -> None:
        a, b = self.root / "r20", self.root / "r21"
        for d in (a, b):
            d.mkdir()
            make_task(d, "alpha")
        (b / "alpha" / "task.toml").write_text('schema_version = "1.1"\n[task]\nname = "alpha"\n')
        (b / "alpha" / "README.md").write_text("added in 2.1\n")
        [row] = corpus.compare(a, b)
        self.assertEqual(row.name, "alpha")
        self.assertTrue(row.in_both)
        self.assertFalse(row.graded_same)
        self.assertTrue(row.scored_same)

    def test_a_rewritten_instruction_is_not_the_same_task(self) -> None:
        a, b = self.root / "r20", self.root / "r21"
        a.mkdir(); b.mkdir()
        make_task(a, "alpha")
        make_task(b, "alpha", instruction="do the thing, precisely, with a signature")
        [row] = corpus.compare(a, b)
        self.assertFalse(row.scored_same)

    def test_a_task_present_in_only_one_release_is_marked_absent(self) -> None:
        a, b = self.root / "r20", self.root / "r21"
        a.mkdir(); b.mkdir()
        make_task(a, "alpha")
        make_task(a, "gone")
        make_task(b, "alpha")
        rows = {r.name: r for r in corpus.compare(a, b)}
        self.assertFalse(rows["gone"].in_both)
        self.assertTrue(rows["alpha"].in_both)


class SeededSampleTest(unittest.TestCase):
    """`-l 10` took the alphabetical head, so the same ten of eighty-nine were
    measured every time. A sample has to be a sample."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "tb"
        self.root.mkdir(parents=True)
        for i in range(20):
            make_task(self.root, f"task-{i:02d}")

    def test_the_same_seed_draws_the_same_tasks(self) -> None:
        self.assertEqual(corpus.sample(self.root, 5, 42), corpus.sample(self.root, 5, 42))

    def test_a_different_seed_draws_a_different_subset(self) -> None:
        self.assertNotEqual(corpus.sample(self.root, 5, 42), corpus.sample(self.root, 5, 43))

    def test_it_is_not_the_alphabetical_head(self) -> None:
        names = sorted(p.name for p in corpus.task_dirs(self.root))
        drawn = corpus.sample(self.root, 5, 42)
        self.assertEqual(len(drawn), 5)
        self.assertTrue(set(drawn) <= set(names))
        self.assertNotEqual(drawn, names[:5])

    def test_a_size_at_or_above_the_corpus_returns_everything(self) -> None:
        names = sorted(p.name for p in corpus.task_dirs(self.root))
        self.assertEqual(corpus.sample(self.root, 20, 42), names)
        self.assertEqual(corpus.sample(self.root, 99, 42), names)


if __name__ == "__main__":
    unittest.main()
