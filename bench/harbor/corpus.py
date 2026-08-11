"""Benchmark corpus identity — which task set a score actually measured.

A Terminal-Bench score is meaningless without the release it was measured on:
2.1 repaired 28 of 2.0's 89 tasks (underspecified instructions, dead external
dependencies, resource budgets too small for the reference solution), and the
task *names* are identical across both, so a name list cannot tell them apart.
A corpus that carries no provenance therefore silently invalidates every
comparison drawn from it — which is exactly what happened to the 56.2% figure,
measured on 2.0 and compared against a 2.1 leaderboard.

So every corpus directory carries a ``corpus.json`` written at fetch time, and
every run resolves and reports it. ``content_hash`` is computed from the task
files themselves, so an edited corpus stops matching its own manifest and says
so rather than quietly scoring a different benchmark under the old name.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

MANIFEST_NAME = "corpus.json"

# Task-directory contents that define the benchmark. `solution/` is excluded:
# it is the reference solve, never shown to the agent, and 2.1 rewrote several
# solutions without changing the task the agent is scored on.
_GRADED = ("instruction.md", "task.toml", "environment", "tests")


class CorpusError(RuntimeError):
    """The corpus on disk is missing, unreadable, or not what it claims."""


@dataclass(frozen=True)
class CorpusIdentity:
    """What a result must state to be traceable to the task set that produced it."""

    name: str
    version: str
    registry_ref: str | None
    upstream_commit: str | None
    n_tasks: int
    fetched_at: str
    content_hash: str
    path: Path
    #: False when the tasks on disk no longer hash to the manifest's record.
    verified: bool
    recorded_hash: str

    def __str__(self) -> str:
        mark = "" if self.verified else "  !! MODIFIED — does not match manifest"
        ref = f" ref={self.registry_ref}" if self.registry_ref else ""
        return (
            f"corpus: {self.name} {self.version}{ref} "
            f"tasks={self.n_tasks} hash={self.content_hash[:12]} "
            f"fetched={self.fetched_at}{mark}"
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "version": self.version,
            "registry_ref": self.registry_ref,
            "upstream_commit": self.upstream_commit,
            "n_tasks": self.n_tasks,
            "fetched_at": self.fetched_at,
            "content_hash": self.content_hash,
            "recorded_hash": self.recorded_hash,
            "verified": self.verified,
            "path": str(self.path),
        }


def task_dirs(corpus_dir: Path) -> list[Path]:
    return sorted(
        p for p in corpus_dir.iterdir() if p.is_dir() and (p / "task.toml").is_file()
    )


def content_hash(corpus_dir: Path) -> tuple[str, int]:
    """Hash the graded task content. Returns (hash, n_tasks)."""
    tasks = task_dirs(corpus_dir)
    digest = hashlib.sha256()
    for task in tasks:
        digest.update(task.name.encode())
        for entry in _GRADED:
            target = task / entry
            for file in sorted(
                (target.rglob("*") if target.is_dir() else [target]),
                key=lambda p: p.as_posix(),
            ):
                if not file.is_file():
                    continue
                digest.update(file.relative_to(task).as_posix().encode())
                digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest(), len(tasks)


def load(corpus_dir: Path) -> CorpusIdentity:
    """Read a corpus's manifest and check the tasks on disk still match it."""
    corpus_dir = Path(corpus_dir).resolve()
    manifest_path = corpus_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        raise CorpusError(
            f"No {MANIFEST_NAME} in {corpus_dir}. A benchmark corpus without "
            "provenance cannot be reported on; write one with "
            "`python -m bench.harbor.corpus init`."
        )
    m = json.loads(manifest_path.read_text())
    actual, n_tasks = content_hash(corpus_dir)
    recorded = str(m.get("content_hash", ""))
    return CorpusIdentity(
        name=m["name"],
        version=str(m["version"]),
        registry_ref=m.get("registry_ref"),
        upstream_commit=m.get("upstream_commit"),
        n_tasks=n_tasks,
        fetched_at=m.get("fetched_at", "unknown"),
        content_hash=actual,
        path=corpus_dir,
        verified=(actual == recorded),
        recorded_hash=recorded,
    )


def resolve_for_task(task_path: Path) -> CorpusIdentity | None:
    """Identify the corpus a task directory belongs to, or None if unmarked.

    Harbor hands the adapter a trial, not a corpus, so identity is recovered by
    walking up from the task to the directory that carries the manifest.
    """
    for parent in Path(task_path).resolve().parents:
        if (parent / MANIFEST_NAME).is_file():
            try:
                return load(parent)
            except (CorpusError, KeyError, ValueError):
                return None
    return None


def resolve_for_trial(logs_dir: Path) -> CorpusIdentity | None:
    """Identify the corpus behind a running trial, from its own harbor config.

    The agent is handed ``<trial>/agent`` as its log directory and never the
    task path, so the task is read back from the trial config harbor wrote —
    its record of what it resolved, rather than a second guess at it.
    """
    config = Path(logs_dir).resolve().parent / "config.json"
    if not config.is_file():
        return None
    try:
        task_path = (json.loads(config.read_text()).get("task") or {}).get("path")
    except (OSError, ValueError):
        return None
    return resolve_for_task(Path(task_path)) if task_path else None


def write_manifest(
    corpus_dir: Path,
    *,
    name: str,
    version: str,
    registry_ref: str | None = None,
    upstream_commit: str | None = None,
    fetched_at: str,
) -> CorpusIdentity:
    corpus_dir = Path(corpus_dir).resolve()
    digest, n_tasks = content_hash(corpus_dir)
    (corpus_dir / MANIFEST_NAME).write_text(
        json.dumps(
            {
                "name": name,
                "version": version,
                "registry_ref": registry_ref,
                "upstream_commit": upstream_commit,
                "n_tasks": n_tasks,
                "fetched_at": fetched_at,
                "content_hash": digest,
            },
            indent=2,
        )
        + "\n"
    )
    return load(corpus_dir)


def _main() -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="bench.harbor.corpus", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    show = sub.add_parser("show", help="Print a corpus's identity.")
    show.add_argument("path", type=Path)
    show.add_argument("--json", action="store_true")
    init = sub.add_parser("init", help="Write a corpus manifest.")
    init.add_argument("path", type=Path)
    init.add_argument("--name", required=True)
    init.add_argument("--version", required=True)
    init.add_argument("--registry-ref")
    init.add_argument("--upstream-commit")
    init.add_argument("--fetched-at", required=True)

    args = parser.parse_args()
    if args.cmd == "init":
        identity = write_manifest(
            args.path,
            name=args.name,
            version=args.version,
            registry_ref=args.registry_ref,
            upstream_commit=args.upstream_commit,
            fetched_at=args.fetched_at,
        )
        print(identity)
        return 0

    identity = load(args.path)
    print(json.dumps(identity.as_dict(), indent=2) if args.json else identity)
    return 0 if identity.verified else 1


if __name__ == "__main__":
    raise SystemExit(_main())
