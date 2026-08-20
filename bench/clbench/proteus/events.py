"""Reading what `proteus exec --json` and `proteus alignment --json` hand back.

This is the contract between two repos, so it lives on its own with no
CL-Bench imports and is covered by `bench/clbench/tests` — a silent change to
the CLI's event shape would otherwise show up as a mysteriously bad benchmark
score rather than as a failing test. Both benchmark adapters read it, so the
turn stream and the grading ledger are parsed in one place: whether a turn was
graded is the question both of them turned out to need, and two readers would
have drifted.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Every field the CLI's usage payload can carry, mirroring ``USAGE_FIELDS`` in
#: packages/core/src/usage.ts. Read through this list rather than a hardcoded
#: three-key dict so a field the emitter learns to report is not dropped here.
USAGE_FIELDS: tuple[str, ...] = (
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "reasoning",
    "neurons",
)

#: One turn's token usage. SPARSE on purpose: a field that is absent means the
#: provider did not report it, and a field that is 0 means the provider reported
#: zero. Zero-filling the two together is how a run nobody metered came out
#: looking free.
Usage = dict[str, int]

Event = dict[str, Any]

#: The CLI's ``type: "evolution"`` stream is a general ACTIVITY channel, not an
#: evolution channel: ``packages/cli-backend/src/local-session.ts`` publishes
#: ``bg_job_started``, ``bg_jobs_settling``, ``bg_jobs_abandoned``, ``mcp`` and
#: ``system_prompt_hash`` on it alongside the real thing. So a trial configured
#: ``evolve=false`` can and does report a non-zero "evolution" count -- the
#: 2026-08-10 Terminal-Bench 2.1 run recorded 7, every one of them
#: ``bg_job_started`` -- which makes the one field an operator would read to
#: answer "was the distinctive mechanism live?" say nothing about evolution.
#:
#: These are the event names that ARE evolution. Source of truth is
#: ``EvolutionEvent['type']`` in packages/core/src/evolution/types.ts plus the
#: two shadow-eval outcomes emitted directly by local-session.ts; the drift gate
#: in scripts/bench.test.ts fails if this set and that union diverge.
EVOLUTION_EVENTS = frozenset({
    "reflection",
    "craft_discovered",
    "scaffold_proposed",
    "consolidation",
    "mcts_started",
    "mcts_complete",
    "turn_complete",
    "replay_eval",
    "changelog_digest",
    "experience_import",
    "scaffold_promotion",
    "scaffold_rollback",
})


def split_activity(events: list[Event]) -> tuple[list[Event], list[Event]]:
    """Partition the activity channel into (everything, the evolution subset).

    Returned as two lists rather than one filtered list because both are
    evidence: the activity count says the agent was busy, and only the evolution
    subset says the mechanism under test ran.
    """
    activity = [
        {"event": str(e.get("event") or ""), "message": str(e.get("message") or "")}
        for e in events
        if e.get("type") == "evolution"
    ]
    return activity, [e for e in activity if e["event"] in EVOLUTION_EVENTS]


@dataclass(frozen=True)
class TurnGrading:
    """How many of this trial's turns reached a verdict, from the ledger that
    owns the answer rather than from the prose the activity channel carries.

    ``proteus alignment --json`` reads ``turn_outcomes``, the table
    ``packages/core/src/evolution/outcomes.ts`` writes. A benchmark container
    holds no person, so ``user_graded`` is 0 by construction and
    ``execution_graded`` — rows the ENVIRONMENT graded — is the number that says
    whether the turn was graded at all. Reading the first as the second would
    report every headless run as ungraded.
    """

    user_graded: int
    execution_graded: int
    abandoned: int

    def as_dict(self) -> dict[str, int]:
        return {
            "user_graded": self.user_graded,
            "execution_graded": self.execution_graded,
            "abandoned": self.abandoned,
        }


def read_grading(path: Path) -> TurnGrading | None:
    """The trial's grading counts, or None when the probe left no readable answer.

    None means MISSING EVIDENCE and is not the same as three zeros: a probe that
    never ran and a turn that graded nothing are different findings, and
    collapsing them would let a broken probe read as a healthy inert arm.
    """
    try:
        overall = json.loads(path.read_text(encoding="utf-8"))["alignment"]["overall"]
        return TurnGrading(
            user_graded=int(overall["turns"]),
            execution_graded=int(overall["executionGraded"]),
            abandoned=int(overall["abandoned"]),
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def parse_events(stdout: str) -> list[Event]:
    """Parse the NDJSON stream, skipping blank and malformed lines."""
    events: list[Event] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("Skipping malformed NDJSON line: %.120s", line)
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def assistant_text(events: list[Event]) -> str:
    """The turn's final assistant message.

    Raises ValueError when the stream carries no assistant message at all — a
    turn without an answer is a failed turn, not an empty one.
    """
    texts = [
        str(event.get("text", ""))
        for event in events
        if event.get("type") == "message_end"
    ]
    if not texts:
        raise ValueError("No assistant message in proteus exec output")
    return texts[-1]


def session_id(events: list[Event]) -> str | None:
    """The CLI session id from the stream header, replayed by `--resume`."""
    for event in events:
        if event.get("type") == "session":
            value = event.get("id")
            if isinstance(value, str) and value:
                return value
    return None


def usage_reported(usage: Usage) -> bool:
    """Whether the provider reported anything at all — the gate for pricing a
    row. A turn served by a provider that says nothing carries no usage rather
    than a fabricated set of zeros."""
    return any(field in usage for field in USAGE_FIELDS)


def usage_total(usage: Usage) -> int | None:
    """Billable tokens, or None when neither half was reported.

    Derived rather than stored, exactly as ``usageTotal`` derives it: cacheRead
    and cacheWrite are SUBSETS of ``input`` and reasoning is a subset of
    ``output``, so ``input + output`` is the total.
    """
    if "input" not in usage and "output" not in usage:
        return None
    return usage.get("input", 0) + usage.get("output", 0)


def add_usage(first: Usage, second: Usage) -> Usage:
    """Accumulate, preserving absence — the Python half of ``addUsage``.

    A field neither side reported stays absent; a field only one side reported
    carries that one's number. This is what keeps "every turn reported a zero
    cache read" distinguishable from "no turn mentioned caching".
    """
    total: Usage = {}
    for field in USAGE_FIELDS:
        left = first.get(field)
        right = second.get(field)
        if left is None and right is None:
            continue
        total[field] = (0 if left is None else left) + (0 if right is None else right)
    return total


def _reported_fields(usage: dict[str, Any]) -> Usage:
    """The counts a `turn_end` payload actually carries. The parse boundary: an
    absent key stays absent, and a value that is not a number is not a count
    (``bool`` is an ``int`` in Python, so it is excluded explicitly)."""
    reported: Usage = {}
    for field in USAGE_FIELDS:
        value = usage.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        reported[field] = int(value)
    return reported


def turn_usage(events: list[Event]) -> Usage:
    """Token usage, summed over every `turn_end` in the stream.

    Kinu reports per turn rather than cumulatively, so these add rather than
    delta. ``input`` is cache-inclusive and ``cacheRead`` is its cache-read
    share, which is the convention CL-Bench's ``build_usage_event`` prices
    against.

    A field the provider did not report is ABSENT from the result, because the
    emitter omits the key (`jsonEvents` in packages/cli/src/commands/run.ts) and
    nothing here puts it back as a zero. An empty dict therefore means "nobody
    metered this run", which is what ``usage_reported`` answers.
    """
    total: Usage = {}
    for event in events:
        if event.get("type") != "turn_end":
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            continue
        total = add_usage(total, _reported_fields(usage))
    return total


def sum_usages(usages: list[Usage]) -> Usage:
    """Combine the usage of several exec invocations in one benchmark turn."""
    total: Usage = {}
    for usage in usages:
        total = add_usage(total, usage)
    return total


def had_error(events: list[Event]) -> bool:
    """Whether any turn in the stream reported an error.

    Advisory only: `proteus exec` reports an error — and exits nonzero — when
    any tool call in the turn failed, even when the turn still produced its
    answer, so this cannot stand in for "the turn failed".
    """
    return any(
        event.get("type") == "turn_end" and event.get("hadError") is True
        for event in events
    )


def has_answer(events: list[Event]) -> bool:
    """Whether the stream reached an assistant message."""
    return any(event.get("type") == "message_end" for event in events)


def run_events(events: list[Event], *kinds: str) -> list[Event]:
    """The durable run-event ledger carried on the stream, in order.

    Each `run_event` line wraps one row of the agent's own `run_events` table —
    delegation nudges, the turn's context budget, refused mission budgets, the
    run bracket. The table lives in the agent's database, which a benchmark
    container destroys on exit, so the stream is the only copy a harness gets.
    Filter with `kinds` (the row's own `type`); no argument returns everything.
    """
    rows = [
        row
        for event in events
        if event.get("type") == "run_event"
        and isinstance(row := event.get("event"), dict)
    ]
    return rows if not kinds else [row for row in rows if row.get("type") in kinds]


def tool_calls(events: list[Event]) -> list[str]:
    """Names of the tools Kinu called, in order."""
    return [
        str(event.get("toolName", ""))
        for event in events
        if event.get("type") == "tool_call"
    ]
