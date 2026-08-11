"""Reading the NDJSON stream that `proteus exec --json` writes to stdout.

This is the contract between two repos, so it lives on its own with no
CL-Bench imports and is covered by `bench/clbench/tests` — a silent change to
the CLI's event shape would otherwise show up as a mysteriously bad benchmark
score rather than as a failing test.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

EMPTY_USAGE: dict[str, int] = {"input": 0, "output": 0, "cached": 0}

Event = dict[str, Any]


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


def turn_usage(events: list[Event]) -> dict[str, int]:
    """Token usage, summed over every `turn_end` in the stream.

    Proteus reports per turn rather than cumulatively, so these add rather than
    delta. ``input`` is cache-inclusive and ``cached`` is its cache-read share,
    which is the convention CL-Bench's ``build_usage_event`` prices against. A
    provider that reports nothing omits the field, and that reads as zero.
    """
    total = dict(EMPTY_USAGE)
    for event in events:
        if event.get("type") != "turn_end":
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            continue
        for key in total:
            total[key] += int(usage.get(key, 0) or 0)
    return total


def sum_usages(usages: list[dict[str, int]]) -> dict[str, int]:
    """Combine the usage of several exec invocations in one benchmark turn."""
    return {key: sum(usage.get(key, 0) for usage in usages) for key in EMPTY_USAGE}


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
    """Names of the tools Proteus called, in order."""
    return [
        str(event.get("toolName", ""))
        for event in events
        if event.get("type") == "tool_call"
    ]
