"""Convert ``proteus exec --json`` output into an ATIF trajectory.

Proteus emits a line-delimited event stream (see ``jsonEvents`` in
``packages/cli/src/commands/run.ts``)::

    {"type":"session","id":...,"workspace":...,"backend":"local","cwd":...}
    {"type":"turn_start","kind":"user","text":...}
    {"type":"message_delta","role":"assistant","delta":...}
    {"type":"tool_call","toolName":...,"args":{...}}
    {"type":"tool_result","toolName":...,"result":...}
    {"type":"message_end","role":"assistant","text":...}
    {"type":"turn_end","steps":N,"durationMs":N,"hadError":false,"usage":{...}}
    {"type":"evolution","event":...,"message":...}
    {"type":"error","message":...}

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
    raise ImportError(f"Cannot load the Proteus event reader from {_EVENTS_PATH}")
_events = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_events)

parse_events = _events.parse_events
turn_usage = _events.turn_usage


@dataclass
class ProteusRunSummary:
    """What the event stream says about the turn, for AgentContext metadata."""

    turn_steps: int | None = None
    duration_ms: int | None = None
    had_error: bool | None = None
    tool_calls: int = 0
    errors: list[str] = field(default_factory=list)
    evolution_events: list[dict[str, str]] = field(default_factory=list)
    usage: dict[str, int] | None = None


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
            summary.evolution_events.append(record)
            builder.add_dispatch(record["message"], {"proteus_evolution": record["event"]})
        elif kind == "error":
            message = str(event.get("message") or "")
            summary.errors.append(message)
            builder.add_system(message, {"proteus_event": "error"})

    # Absent rather than zero when the provider reported nothing: a turn that
    # spent no tokens does not happen, so zeros here would mean "unmetered".
    usage = turn_usage(events)
    summary.usage = usage if any(usage.values()) else None

    extra = dict(agent_extra)
    if summary.evolution_events:
        extra["evolution_events"] = summary.evolution_events

    final_extra: dict[str, Any] = {}
    if summary.turn_steps is not None:
        final_extra["proteus_turn_steps"] = summary.turn_steps
    if summary.duration_ms is not None:
        final_extra["duration_ms"] = summary.duration_ms
    if summary.had_error is not None:
        final_extra["had_error"] = summary.had_error

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
            # Proteus prices nothing, so total_cost_usd stays unset.
            total_prompt_tokens=summary.usage["input"] if summary.usage else None,
            total_completion_tokens=summary.usage["output"] if summary.usage else None,
            total_cached_tokens=summary.usage["cached"] if summary.usage else None,
            extra=final_extra or None,
        ),
        notes="Converted from proteus exec --json events to ATIF",
    )
    return trajectory, summary


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)
