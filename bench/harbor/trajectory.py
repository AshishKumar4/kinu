"""Convert ``kinu exec --json`` output into an ATIF trajectory.

Kinu emits a line-delimited event stream (see ``jsonEvents`` in
``packages/cli/src/commands/run.ts``)::

    {"type":"session","id":...,"workspace":...,"backend":"local","cwd":...}
    {"type":"turn_start","kind":"user","text":...}
    {"type":"message_delta","role":"assistant","delta":...}
    {"type":"tool_call","toolName":...,"args":{...}}
    {"type":"tool_result","toolName":...,"result":...}
    {"type":"message_end","role":"assistant","text":...}
    {"type":"turn_end","steps":N,"durationMs":N,"hadError":false,"usage":{"input":N}}
    {"type":"evolution","event":...,"message":...}
    {"type":"run_event","event":{"type":"turn_steering","converted":...,...}}
    {"type":"error","message":...}

``usage`` is SPARSE, and missing entirely when the provider reported nothing.
Each field is present only if the provider reported it, spelled as
``events.USAGE_FIELDS`` spells it: ``input`` (cache-inclusive), ``output``,
``cacheRead``, ``cacheWrite``, ``cacheWrite1h``, ``reasoning``, ``neurons``. An
absent field means "not measured" and is never filled in with a zero, because a
zero is a measurement and would price an unmetered turn as a free one.

Reading that stream is ``bench/clbench/proteus/events.py`` — one reader for the
CLI's event contract, shared with the CL-Bench adapter, so a change to the
event shape breaks a test rather than quietly degrading two benchmark scores.
It is loaded by path because importing it as a package would run
``bench/clbench/proteus/__init__.py``, which pulls in the CL-Bench system
adapter and only resolves inside a CL-Bench checkout.

Tool calls carry no id, so results are paired to the oldest unanswered call —
exact for the local session, which runs tools one at a time.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

_EVENTS_PATH = Path(__file__).resolve().parents[1] / "clbench" / "proteus" / "events.py"
_SPEC = importlib.util.spec_from_file_location("proteus_events", _EVENTS_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Cannot load the Kinu event reader from {_EVENTS_PATH}")
_events = importlib.util.module_from_spec(_SPEC)
# Registered before execution because @dataclass resolves its own module to read
# annotations.
sys.modules[_SPEC.name] = _events
_SPEC.loader.exec_module(_events)

parse_events = _events.parse_events
read_grading = _events.read_grading
run_events = _events.run_events
turn_usage = _events.turn_usage
usage_reported = _events.usage_reported
split_activity = _events.split_activity
EVOLUTION_EVENTS = _events.EVOLUTION_EVENTS


@dataclass
class ProteusRunSummary:
    """What the event stream says about the turn, for AgentContext metadata."""

    turn_steps: int | None = None
    duration_ms: int | None = None
    had_error: bool | None = None
    tool_calls: int = 0
    errors: list[str] = field(default_factory=list)
    #: Everything on the CLI's activity channel, verbatim.
    activity_events: list[dict[str, str]] = field(default_factory=list)
    #: The subset that is actually evolution. This is the field a reader may
    #: use to decide whether the mechanism under test ran.
    evolution_events: list[dict[str, str]] = field(default_factory=list)
    usage: dict[str, int] | None = None
    #: The agent's durable run-event ledger, verbatim — the only copy that
    #: survives the container, and where a nudge/budget measurement lives.
    run_events: list[dict[str, Any]] = field(default_factory=list)


def read_events(path: Path) -> list[dict[str, Any]]:
    """Parse the JSONL log the adapter tees out of the container."""
    return parse_events(path.read_text(encoding="utf-8", errors="replace"))


class _StepBuilder:
    """Accumulates streamed deltas and pairs tool results with their calls."""

    def __init__(self, model_name: str | None) -> None:
        self.steps: list[Step] = []
        self._model_name = model_name
        self._text: list[str] = []
        self._pending: list[tuple[str, Step]] = []

    def _next_id(self) -> int:
        return len(self.steps) + 1

    def _flush_text(self) -> str:
        text = "".join(self._text)
        self._text.clear()
        return text

    def add_text(self, delta: str) -> None:
        self._text.append(delta)

    def add_user(self, text: str) -> None:
        self.steps.append(Step(step_id=self._next_id(), source="user", message=text))

    def add_system(self, message: str, extra: dict[str, Any] | None = None) -> None:
        self.steps.append(
            Step(step_id=self._next_id(), source="system", message=message, extra=extra)
        )

    def add_dispatch(self, message: str, extra: dict[str, Any]) -> None:
        """A deterministic, non-LLM agent step (ATIF v1.7 llm_call_count=0)."""
        self.steps.append(
            Step(
                step_id=self._next_id(),
                source="agent",
                message=message,
                llm_call_count=0,
                extra=extra,
            )
        )

    def add_tool_call(self, tool_name: str, arguments: Any) -> None:
        step_id = self._next_id()
        call_id = f"call_{step_id}"
        step = Step(
            step_id=step_id,
            source="agent",
            model_name=self._model_name,
            message=self._flush_text(),
            tool_calls=[
                ToolCall(
                    tool_call_id=call_id,
                    function_name=tool_name,
                    arguments=arguments if isinstance(arguments, dict) else {"input": arguments},
                )
            ],
            llm_call_count=1,
        )
        self.steps.append(step)
        self._pending.append((call_id, step))

    def add_tool_result(self, result: Any) -> None:
        if not self._pending:
            return
        call_id, step = self._pending.pop(0)
        content = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        step.observation = Observation(
            results=[ObservationResult(source_call_id=call_id, content=content)]
        )

    def add_final_message(self, text: str) -> None:
        message = self._flush_text() or text
        if not message:
            return
        self.steps.append(
            Step(
                step_id=self._next_id(),
                source="agent",
                model_name=self._model_name,
                message=message,
                llm_call_count=1,
            )
        )


def build_trajectory(
    events: list[dict[str, Any]],
    *,
    session_id: str,
    agent_name: str,
    agent_version: str,
    model_name: str | None,
    agent_extra: dict[str, Any],
) -> tuple[Trajectory, ProteusRunSummary]:
    summary = ProteusRunSummary()
    builder = _StepBuilder(model_name)
    stream_session_id: str | None = None

    for event in events:
        kind = event.get("type")
        if kind == "session":
            value = event.get("id")
            if isinstance(value, str):
                stream_session_id = value
        elif kind == "turn_start":
            builder.add_user(str(event.get("text") or ""))
        elif kind == "message_delta":
            builder.add_text(str(event.get("delta") or ""))
        elif kind == "tool_call":
            summary.tool_calls += 1
            builder.add_tool_call(str(event.get("toolName") or ""), event.get("args"))
        elif kind == "tool_result":
            builder.add_tool_result(event.get("result"))
        elif kind == "message_end":
            builder.add_final_message(str(event.get("text") or ""))
        elif kind == "turn_end":
            summary.turn_steps = _as_int(event.get("steps"))
            summary.duration_ms = _as_int(event.get("durationMs"))
            summary.had_error = bool(event.get("hadError"))
        elif kind == "evolution":
            record = {
                "event": str(event.get("event") or ""),
                "message": str(event.get("message") or ""),
            }
            summary.activity_events.append(record)
            if record["event"] in EVOLUTION_EVENTS:
                summary.evolution_events.append(record)
            builder.add_dispatch(record["message"], {"proteus_activity": record["event"]})
        elif kind == "error":
            message = str(event.get("message") or "")
            summary.errors.append(message)
            builder.add_system(message, {"proteus_event": "error"})

    # Instrumentation, not conversation: the ledger is recorded whole rather
    # than folded into ATIF steps, which describe what the agent said and did.
    summary.run_events = run_events(events)

    # Absent rather than zero when the provider reported nothing. The gate is
    # `usage_reported`, not "are any of the values non-zero": a turn that
    # genuinely reported zeros WAS metered, and calling that unmetered is the
    # same fabrication in the opposite direction.
    usage = turn_usage(events)
    summary.usage = usage if usage_reported(usage) else None

    extra = dict(agent_extra)
    if summary.activity_events:
        extra["activity_events"] = summary.activity_events
    if summary.evolution_events:
        extra["evolution_events"] = summary.evolution_events

    final_extra: dict[str, Any] = {}
    if summary.turn_steps is not None:
        final_extra["proteus_turn_steps"] = summary.turn_steps
    if summary.duration_ms is not None:
        final_extra["duration_ms"] = summary.duration_ms
    if summary.had_error is not None:
        final_extra["had_error"] = summary.had_error
    if summary.run_events:
        final_extra["run_events"] = summary.run_events

    trajectory = Trajectory(
        schema_version="ATIF-v1.7",
        session_id=stream_session_id or session_id,
        agent=Agent(
            name=agent_name,
            version=agent_version,
            model_name=model_name,
            extra=extra or None,
        ),
        steps=builder.steps,
        final_metrics=FinalMetrics(
            total_steps=len(builder.steps),
            # Kinu prices nothing, so total_cost_usd stays unset.
            total_prompt_tokens=summary.usage.get("input") if summary.usage else None,
            total_completion_tokens=summary.usage.get("output") if summary.usage else None,
            total_cached_tokens=summary.usage.get("cacheRead") if summary.usage else None,
            extra=final_extra or None,
        ),
        notes="Converted from kinu exec --json events to ATIF",
    )
    return trajectory, summary


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)
