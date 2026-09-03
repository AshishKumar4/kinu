"""Tests for reading the `kinu exec --json` NDJSON stream.

Run from the repo root with no dependencies and no CL-Bench checkout:

    python3 -m unittest discover -s bench/clbench/tests
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Loaded straight from the file: the package's __init__ pulls in the system
# adapter, which only imports inside a CL-Bench checkout, and the point of
# events.py is that it needs nothing.
_SPEC = importlib.util.spec_from_file_location(
    "kinu_events", Path(__file__).resolve().parents[1] / "kinu" / "events.py"
)
assert _SPEC and _SPEC.loader
events = importlib.util.module_from_spec(_SPEC)
# Registered before execution because @dataclass resolves its own module to read
# annotations, the same reason test_corpus.py does it.
sys.modules[_SPEC.name] = events
_SPEC.loader.exec_module(events)

assistant_text = events.assistant_text
had_error = events.had_error
has_answer = events.has_answer
parse_events = events.parse_events
run_events = events.run_events
session_id = events.session_id
add_usage = events.add_usage
sum_usages = events.sum_usages
tool_calls = events.tool_calls
turn_usage = events.turn_usage
usage_reported = events.usage_reported
usage_total = events.usage_total

# One real turn as `kinu exec --json` emitted it, text-deltas elided.
REAL_TURN = "\n".join(
    json.dumps(event)
    for event in [
        {
            "type": "session",
            "id": "20260727060006-687f10fb",
            "workspace": "clbench",
            "backend": "local",
            "cwd": "/home/u/.cache/kinu_bench/run_s14u5q8a/work",
        },
        {"type": "turn_start", "kind": "user", "text": "=== Brief ===\nObjective: ..."},
        {"type": "message_delta", "role": "assistant", "delta": "```json"},
        {"type": "message_end", "role": "assistant", "text": '{"action": "CALL"}'},
        {
            "type": "turn_end",
            "steps": 1,
            "durationMs": 5129,
            "hadError": False,
            # Two fields, because two is what the provider reported. The old
            # capture read `"cached": 0`, but that zero was structural rather
            # than measured: the accumulator initialised `cached` to 0 on every
            # turn (turn-accumulator.ts reset()) and emitted the field whenever
            # either half was non-zero, so it said nothing about whether the
            # provider had mentioned caching. What it actually said is
            # unrecoverable from the capture, so the fixture states only what is
            # true; a genuinely REPORTED zero is covered by its own test below.
            "usage": {"input": 5642, "output": 387},
        },
    ]
)


class ParseEvents(unittest.TestCase):
    def test_reads_a_real_turn(self) -> None:
        events = parse_events(REAL_TURN)
        self.assertEqual(len(events), 5)
        self.assertEqual(events[0]["type"], "session")

    def test_skips_blank_and_malformed_lines_without_losing_the_rest(self) -> None:
        stdout = '\n\n{"type": "session", "id": "s1"}\nnot json at all\n  \n{"type": "turn_end"}\n'
        self.assertEqual(
            parse_events(stdout),
            [{"type": "session", "id": "s1"}, {"type": "turn_end"}],
        )

    def test_skips_non_object_lines(self) -> None:
        self.assertEqual(parse_events('"a string"\n42\n[1, 2]\n'), [])

    def test_empty_stdout_is_no_events_not_an_error(self) -> None:
        self.assertEqual(parse_events(""), [])


class AssistantText(unittest.TestCase):
    def test_returns_the_message(self) -> None:
        self.assertEqual(assistant_text(parse_events(REAL_TURN)), '{"action": "CALL"}')

    def test_returns_the_last_message_when_a_repair_turn_followed(self) -> None:
        events = [
            {"type": "message_end", "text": "first"},
            {"type": "turn_end"},
            {"type": "message_end", "text": "corrected"},
        ]
        self.assertEqual(assistant_text(events), "corrected")

    def test_a_turn_with_no_answer_raises_rather_than_returning_empty(self) -> None:
        with self.assertRaises(ValueError):
            assistant_text([{"type": "session", "id": "s1"}, {"type": "error"}])

    def test_an_empty_answer_is_returned_not_raised(self) -> None:
        self.assertEqual(assistant_text([{"type": "message_end", "text": ""}]), "")


class SessionId(unittest.TestCase):
    def test_reads_the_stream_header(self) -> None:
        self.assertEqual(session_id(parse_events(REAL_TURN)), "20260727060006-687f10fb")

    def test_absent_or_empty_session_is_none_so_resume_is_skipped(self) -> None:
        self.assertIsNone(session_id([{"type": "turn_end"}]))
        self.assertIsNone(session_id([{"type": "session", "id": ""}]))
        self.assertIsNone(session_id([{"type": "session", "id": 17}]))


class UsageReading(unittest.TestCase):
    def test_reads_the_reported_usage(self) -> None:
        self.assertEqual(
            turn_usage(parse_events(REAL_TURN)),
            {"input": 5642, "output": 387},
        )

    def test_an_unreported_field_stays_absent_rather_than_arriving_as_zero(self) -> None:
        # The half of the contract this reader exists for: `cacheRead` is not in
        # the payload, so it is not in the result. A zero here would claim the
        # provider measured no cache reads, which it never said.
        usage = turn_usage(parse_events(REAL_TURN))
        self.assertNotIn("cacheRead", usage)
        self.assertEqual(sorted(usage), ["input", "output"])

    def test_sums_across_turns_because_kinu_reports_per_turn(self) -> None:
        turns = [
            {"type": "turn_end", "usage": {"input": 10, "output": 2, "cacheRead": 1}},
            {"type": "turn_end", "usage": {"input": 20, "output": 3, "cacheRead": 4}},
        ]
        self.assertEqual(turn_usage(turns), {"input": 30, "output": 5, "cacheRead": 5})

    def test_carries_every_field_the_emitter_can_report(self) -> None:
        # Not a hardcoded three: the emitter can report cache writes, the 1h
        # retention split, reasoning tokens and Cloudflare's neurons, and a
        # reader that knows only in/out/cached drops the rest silently.
        reported = {
            "input": 1,
            "output": 2,
            "cacheRead": 3,
            "cacheWrite": 4,
            "cacheWrite1h": 5,
            "reasoning": 6,
            "neurons": 7,
        }
        self.assertEqual(turn_usage([{"type": "turn_end", "usage": reported}]), reported)

    def test_a_turn_that_reported_no_usage_is_not_a_turn_that_reported_zeros(self) -> None:
        # The inverted invariant. This used to assert three zeros, which is the
        # defect: it made an unmetered turn indistinguishable from a free one,
        # and CL-Bench priced the difference.
        usage = turn_usage([{"type": "turn_end", "hadError": False}])
        self.assertEqual(usage, {})
        self.assertFalse(usage_reported(usage))
        self.assertIsNone(usage_total(usage))

    def test_a_turn_that_reported_zeros_still_reads_as_zeros(self) -> None:
        # The other half of the same distinction, guarded separately so the two
        # cannot be collapsed back into one: a provider that says "zero" DID
        # measure the turn (Workers AI sends prompt_tokens_details.cached_tokens
        # as an explicit 0), and that measurement must survive.
        zeroed = turn_usage(
            [{"type": "turn_end", "usage": {"input": 0, "output": 0, "cacheRead": 0}}]
        )
        self.assertEqual(zeroed, {"input": 0, "output": 0, "cacheRead": 0})
        self.assertTrue(usage_reported(zeroed))
        self.assertEqual(usage_total(zeroed), 0)

    def test_partial_usage_keeps_the_unreported_buckets_absent(self) -> None:
        usage = turn_usage([{"type": "turn_end", "usage": {"input": 9}}])
        self.assertEqual(usage, {"input": 9})
        self.assertEqual(usage_total(usage), 9)

    def test_a_non_numeric_count_is_not_a_count(self) -> None:
        self.assertEqual(
            turn_usage([{"type": "turn_end", "usage": {"input": "lots", "output": 4}}]),
            {"output": 4},
        )

    def test_add_usage_keeps_a_field_neither_side_reported_absent(self) -> None:
        self.assertEqual(
            add_usage({"input": 1}, {"output": 2, "cacheRead": 0}),
            {"input": 1, "output": 2, "cacheRead": 0},
        )
        self.assertEqual(add_usage({}, {}), {})

    def test_sum_usages_combines_invocations(self) -> None:
        self.assertEqual(
            sum_usages(
                [
                    {"input": 1, "output": 2, "cacheRead": 3},
                    {"input": 10, "output": 20, "cacheRead": 30},
                ]
            ),
            {"input": 11, "output": 22, "cacheRead": 33},
        )

    def test_a_run_where_nothing_was_metered_is_distinguishable_from_zeros(self) -> None:
        # What `_record_usage` asks before it prices anything. Nothing to sum is
        # nothing reported — it used to be three zeros, i.e. a free run.
        self.assertEqual(sum_usages([]), {})
        self.assertFalse(usage_reported(sum_usages([{}, {}])))
        self.assertTrue(usage_reported(sum_usages([{"input": 0}])))


class TurnSignals(unittest.TestCase):
    def test_had_error_tracks_the_flag(self) -> None:
        self.assertFalse(had_error(parse_events(REAL_TURN)))
        self.assertTrue(had_error([{"type": "turn_end", "hadError": True}]))
        # A stream-level error event without a turn_end is not a turn verdict.
        self.assertFalse(had_error([{"type": "error", "message": "boom"}]))

    def test_has_answer_distinguishes_a_failed_turn_from_a_noisy_one(self) -> None:
        self.assertTrue(has_answer(parse_events(REAL_TURN)))
        self.assertFalse(has_answer([{"type": "error", "message": "boom"}]))

    def test_tool_calls_are_listed_in_order(self) -> None:
        events = [
            {"type": "tool_call", "toolName": "run", "args": {}},
            {"type": "tool_result", "toolName": "run", "result": "ok"},
            {"type": "tool_call", "toolName": "memory", "args": {}},
        ]
        self.assertEqual(tool_calls(events), ["run", "memory"])
        self.assertEqual(tool_calls(parse_events(REAL_TURN)), [])


class RunEvents(unittest.TestCase):
    LEDGER = [
        {"type": "run_event", "event": {"type": "run_start", "runId": "r1", "agentId": "a"}},
        {"type": "tool_call", "toolName": "run", "args": {}},
        {
            "type": "run_event",
            "event": {
                "type": "turn_steering", "runId": "r1", "eventIndex": 4,
                "trigger": "repeated_failure", "step": 3, "converted": True,
            },
        },
        {"type": "run_event", "event": {"type": "run_end", "runId": "r1", "reason": "completed"}},
    ]

    def test_unwraps_the_ledger_in_order(self) -> None:
        self.assertEqual(
            [row["type"] for row in run_events(self.LEDGER)],
            ["run_start", "turn_steering", "run_end"],
        )

    def test_filters_by_row_kind(self) -> None:
        steers = run_events(self.LEDGER, "turn_steering")
        self.assertEqual(len(steers), 1)
        self.assertIs(steers[0]["converted"], True)
        self.assertEqual(steers[0]["trigger"], "repeated_failure")

    def test_a_stream_without_a_ledger_reads_as_empty_not_an_error(self) -> None:
        self.assertEqual(run_events(parse_events(REAL_TURN)), [])
        self.assertEqual(run_events([{"type": "run_event", "event": "not-an-object"}]), [])


class ActivityVersusEvolutionTest(unittest.TestCase):
    """The activity channel is not the evolution channel.

    Both prior Terminal-Bench runs were made with ``evolve=false`` and later read
    as if evolution had been on. The field a reader would have consulted to catch
    that counted every event on the CLI's ``type:"evolution"`` stream -- which
    also carries ``bg_job_started``, ``mcp`` and ``system_prompt_hash``. The
    2026-08-10 2.1 run recorded 7 of them, every one ``bg_job_started``, on a
    trial configured with evolution off.
    """

    def test_background_job_notices_are_activity_and_not_evolution(self) -> None:
        activity, evolution = events.split_activity([
            {"type": "evolution", "event": "bg_job_started", "message": f"run -> bgjob-{i}"}
            for i in range(7)
        ])
        self.assertEqual(len(activity), 7)
        self.assertEqual(evolution, [])

    def test_mcp_and_prompt_hash_notices_are_activity_too(self) -> None:
        activity, evolution = events.split_activity([
            {"type": "evolution", "event": "mcp", "message": "connected"},
            {"type": "evolution", "event": "system_prompt_hash", "message": "changed -> abc"},
            {"type": "evolution", "event": "bg_jobs_settling", "message": "1 job"},
            {"type": "evolution", "event": "bg_jobs_abandoned", "message": "gave up"},
        ])
        self.assertEqual(len(activity), 4)
        self.assertEqual(evolution, [])

    def test_real_evolution_is_recorded_as_evolution(self) -> None:
        activity, evolution = events.split_activity([
            {"type": "evolution", "event": "mcts_started", "message": "4 branches"},
            {"type": "evolution", "event": "mcts_complete", "message": "settled"},
            {"type": "evolution", "event": "scaffold_promotion", "message": "promoted"},
            {"type": "evolution", "event": "bg_job_started", "message": "run -> bgjob-x"},
        ])
        self.assertEqual(len(activity), 4)
        self.assertEqual(
            [e["event"] for e in evolution],
            ["mcts_started", "mcts_complete", "scaffold_promotion"],
        )

    def test_non_activity_events_are_ignored_entirely(self) -> None:
        activity, evolution = events.split_activity([
            {"type": "tool_call", "toolName": "run"},
            {"type": "error", "message": "boom"},
        ])
        self.assertEqual(activity, [])
        self.assertEqual(evolution, [])


class ReadGrading(unittest.TestCase):
    """Whether the turn was graded, and the difference between 0 and unknown.

    A benchmark container holds nobody to ask, so ``executionGraded`` is the
    only count that can be non-zero. Reading ``turns`` instead would report
    every headless trial as ungraded, which is the shape of the finding this
    field exists to test for.
    """

    def write(self, payload: object) -> Path:
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "alignment.json"
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload))
        return path

    def test_an_execution_graded_turn_is_read_from_the_ledger(self) -> None:
        # Verbatim shape of `kinu alignment <ws> --json` on a live flash turn
        # that edited a file and ran its own verifier: two graded turns, no user.
        grading = events.read_grading(self.write({
            "alignment": {"overall": {"turns": 0, "negatives": 0, "abandoned": 0,
                                      "executionGraded": 2}},
            "calibration": {"universe": 0},
        }))
        assert grading is not None
        self.assertEqual(grading.execution_graded, 2)
        self.assertEqual(grading.user_graded, 0)
        self.assertEqual(grading.as_dict(),
                         {"user_graded": 0, "execution_graded": 2, "abandoned": 0})

    def test_an_inert_arm_reads_as_zero_and_is_not_missing(self) -> None:
        grading = events.read_grading(self.write({
            "alignment": {"overall": {"turns": 0, "abandoned": 0, "executionGraded": 0}},
        }))
        self.assertIsNotNone(grading)
        assert grading is not None
        self.assertEqual(grading.execution_graded, 0)

    def test_a_probe_that_left_nothing_readable_is_none_and_not_zero(self) -> None:
        # Each of these is a probe failure, and none of them may look like an
        # arm that ran and graded nothing: a broken measurement reading as a
        # healthy inert arm is how an unmeasured claim gets published.
        self.assertIsNone(events.read_grading(Path("/nonexistent/alignment.json")))
        self.assertIsNone(events.read_grading(self.write('{"alignment":{"over')))
        self.assertIsNone(events.read_grading(self.write({"alignment": {}})))
        self.assertIsNone(events.read_grading(self.write({"alignment": {"overall": {}}})))
        self.assertIsNone(events.read_grading(self.write(
            {"alignment": {"overall": {"turns": 0, "abandoned": 0, "executionGraded": None}}})))


if __name__ == "__main__":
    unittest.main()
