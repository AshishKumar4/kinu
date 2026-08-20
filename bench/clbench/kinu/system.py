"""Kinu as a Continual Learning Bench system.

One benchmark turn is one `kinu exec` — the CLI's headless surface — against
a local workspace that lives in a throwaway ``KINU_HOME``. Kinu runs its
own agentic loop inside that turn (its tools, memory, CraftStore, scaffold);
the benchmark environment is reached the way every CL-Bench system reaches it,
by returning one structured action per turn.

Two axes are configurable, because "a stateful agent improves over a sequence"
is two claims and they need separating:

* **Workspace persistence** — whether the durable workspace (memory, lessons,
  crafted tools, evolved scaffold) carries across instances. CL-Bench already
  drives the between-arms half of this for free: the stateless baseline builds
  one system per instance, so each gets its own home. ``persist_workspace``
  additionally controls the *within-run* case, so a stateful rollout can be
  re-run with the workspace reset at every instance boundary.
* **Self-evolution** — ``auto_evolve`` maps to ``kinu exec
  --no-auto-evolve``, which turns off turn- and session-level evolution while
  leaving durable state intact. Persistent state without evolution is the
  control that says how much of any gain is evolution rather than memory.

``single_conversation`` is the direct analogue of the Codex adapter's flag: the
CLI session id is captured from the first turn and replayed with ``--resume``
so Kinu sees its own prior turns, not just the task's latest observation.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from ...interface import (
    ContinualLearningSystem,
    Observation,
    Query,
    Response,
    observation_marks_instance_complete,
)
from ...registry import register_system
from ...usage import build_usage_event
from ..common import cleanup_run_workspace, create_run_workspace
from ..utils.structured_output import (
    extract_json,
    schema_to_prompt_instruction,
    validate_with_coercion,
)
from .events import (
    Usage,
    add_usage,
    assistant_text,
    had_error,
    has_answer,
    parse_events,
    session_id,
    sum_usages,
    tool_calls,
    turn_usage,
    usage_reported,
)

logger = logging.getLogger(__name__)

# The one KINU_HOME rule, shared with the Harbor adapter. Loaded by path
# because this package is symlinked into a CL-Bench checkout, where `bench` is
# not importable — the same arrangement bench/harbor/trajectory.py uses to reach
# the event reader that lives here.
_ISOLATION_PATH = Path(__file__).resolve().parents[3] / "bench" / "isolation.py"
_SPEC = importlib.util.spec_from_file_location("kinu_bench_isolation", _ISOLATION_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Cannot load the benchmark isolation guard from {_ISOLATION_PATH}")
_isolation = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_isolation)
assert_throwaway_home = _isolation.assert_throwaway_home

_MODEL_ENDPOINT_PATH = Path(__file__).resolve().parents[3] / "bench" / "model_endpoint.py"
_MODEL_ENDPOINT_SPEC = importlib.util.spec_from_file_location(
    "kinu_bench_model_endpoint", _MODEL_ENDPOINT_PATH
)
if _MODEL_ENDPOINT_SPEC is None or _MODEL_ENDPOINT_SPEC.loader is None:
    raise ImportError(f"Cannot load benchmark model defaults from {_MODEL_ENDPOINT_PATH}")
_model_endpoint = importlib.util.module_from_spec(_MODEL_ENDPOINT_SPEC)
_MODEL_ENDPOINT_SPEC.loader.exec_module(_model_endpoint)
DEFAULT_KINU_AI_BASE_URL = _model_endpoint.DEFAULT_KINU_AI_BASE_URL
DEFAULT_WORKERS_AI_MODEL_ID = _model_endpoint.DEFAULT_WORKERS_AI_MODEL_ID
resolve_bearer_token = _model_endpoint.resolve_bearer_token
assert_eval_target = _model_endpoint.assert_eval_target

_WORKSPACE_NAME = "clbench"

_DEFAULT_PURPOSE = (
    "A benchmark agent solving a sequence of related tasks in one environment. "
    "Carry forward what you learn: durable facts about the environment, which "
    "approaches worked, and which were dead ends."
)


def _resolve_repo_root(explicit: Optional[str]) -> Path:
    """Locate the Kinu checkout holding the CLI entrypoint.

    Defaults to the repo this file lives in, resolved through any symlink —
    the package is normally linked into ``clbench/src/systems/kinu``.
    """
    candidate = explicit or os.environ.get("KINU_REPO")
    root = (
        Path(candidate).expanduser().resolve()
        if candidate
        else Path(__file__).resolve().parents[3]
    )
    if not (root / "packages" / "cli" / "bin" / "cli.ts").is_file():
        raise FileNotFoundError(
            f"No Kinu CLI at {root}/packages/cli/bin/cli.ts. "
            "Pass repo_root, or set KINU_REPO to the Kinu checkout."
        )
    return root


def _resolve_api_key(provider: str, base_url: str, api_key_env: Optional[str]) -> str:
    """Read the provider key for *base_url*, having proven the run may use it.

    Never accepted as a system param and never passed on argv — a benchmark
    config is a committed file and a command line is world-readable.

    The target is checked HERE because this is the one place every construction
    of the system passes through, and it runs before the credential is resolved:
    a run aimed at production must fail before a token is even read, let alone
    sent.
    """
    assert_eval_target(base_url)
    return resolve_bearer_token(
        base_url,
        provider,
        api_key_env=api_key_env,
        environ=os.environ,
    )


@register_system("kinu")
class KinuSystem(ContinualLearningSystem):
    """Kinu driven one benchmark turn at a time through `kinu exec`."""

    def __init__(
        self,
        model: str = DEFAULT_WORKERS_AI_MODEL_ID,
        base_url: str = DEFAULT_KINU_AI_BASE_URL,
        provider: str = "workers-ai",
        name: str = "kinu",
        timeout: int = 900,
        auto_evolve: bool = True,
        persist_workspace: bool = True,
        single_conversation: bool = True,
        purpose: str = _DEFAULT_PURPOSE,
        repo_root: Optional[str] = None,
        api_key_env: Optional[str] = None,
        bun: str = "bun",
    ):
        for flag, value in (
            ("auto_evolve", auto_evolve),
            ("persist_workspace", persist_workspace),
            ("single_conversation", single_conversation),
        ):
            if not isinstance(value, bool):
                raise ValueError(f"{flag} must be a bool, got {value!r}")
        if timeout <= 0:
            raise ValueError(f"timeout must be positive, got {timeout!r}")

        self._name = name
        self._model = model
        self._base_url = base_url
        self._provider = provider
        self._timeout = timeout
        self._auto_evolve = auto_evolve
        self._persist_workspace = persist_workspace
        self._single_conversation = single_conversation
        self._purpose = purpose
        self._bun = bun
        self._repo_root = _resolve_repo_root(repo_root)
        self._auth_header = f"Bearer {_resolve_api_key(provider, base_url, api_key_env)}"

        self._root = Path(create_run_workspace("kinu_bench"))
        self._workspace_ready = False
        self._clear_interaction_state()

    # ---- filesystem + process plumbing -------------------------------------

    @property
    def _home(self) -> Path:
        """Throwaway KINU_HOME: config, workspace database, durable state."""
        return Path(assert_throwaway_home(str(self._root / "home")))

    @property
    def _cwd(self) -> Path:
        """The agent's working directory — its scratch space across the run."""
        return self._root / "work"

    def _env(self) -> dict[str, str]:
        """A clean environment: the operator's own Kinu home can never leak
        into a measured run, and the key travels here rather than on argv."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("KINU_")}
        env["HOME"] = str(self._home)
        env["KINU_HOME"] = str(self._home)
        env["KINU_BASE_URL"] = self._base_url
        env["KINU_MODEL"] = self._model
        env["KINU_AUTH"] = self._auth_header
        env["CI"] = "1"
        return env

    def _run_cli(
        self,
        args: list[str],
        *,
        timeout: int,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                self._bun,
                str(self._repo_root / "packages" / "cli" / "bin" / "cli.ts"),
                *args,
            ],
            cwd=str(self._cwd),
            env=self._env(),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def _ensure_workspace(self) -> None:
        """Create the local workspace on first use.

        Lazy because the benchmark runner resets a freshly constructed system
        before the first turn; creating in ``__init__`` would build a workspace
        only to throw it away.
        """
        if self._workspace_ready:
            return
        self._home.mkdir(parents=True, exist_ok=True)
        self._cwd.mkdir(parents=True, exist_ok=True)
        result = self._run_cli(
            [
                "create",
                _WORKSPACE_NAME,
                "--mode",
                "local",
                "--purpose",
                self._purpose,
                "--no-alias-shim",
            ],
            timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"kinu create failed ({result.returncode}): "
                f"{(result.stderr or result.stdout).strip()[:500]}"
            )
        self._workspace_ready = True
        logger.info("Kinu workspace ready at %s", self._home / _WORKSPACE_NAME)

    def _destroy_workspace(self) -> None:
        """Stop the workspace daemon and delete every trace of the run's state."""
        if self._home.is_dir():
            try:
                self._run_cli(["daemon", "stop"], timeout=30)
            except (subprocess.SubprocessError, OSError) as exc:
                logger.warning("Could not stop the Kinu daemon: %s", exc)
        shutil.rmtree(self._home, ignore_errors=True)
        shutil.rmtree(self._cwd, ignore_errors=True)
        self._workspace_ready = False
        self._session_id = None

    # ---- one benchmark turn ------------------------------------------------

    def _build_prompt(self, query: Query) -> str:
        parts: list[str] = []
        if self._pending_feedback:
            parts.append(
                f"FEEDBACK FROM YOUR PREVIOUS ACTION:\n{self._pending_feedback}\n"
            )
        parts.append(query.prompt)
        parts.append(schema_to_prompt_instruction(query.response_schema))
        return "\n".join(parts)

    def _exec_args(self, prompt: str) -> list[str]:
        args = ["exec", "--workspace", _WORKSPACE_NAME, "--json"]
        if not self._auto_evolve:
            args.append("--no-auto-evolve")
        if self._single_conversation and self._session_id:
            args.extend(["--resume", self._session_id])
        # `--` so a prompt that opens with a dash is never read as a flag.
        args.extend(["--", prompt])
        return args

    def _run_turn(self, prompt: str) -> list[dict[str, Any]]:
        self._ensure_workspace()
        logger.info(
            "kinu exec (interaction %d, prompt %d chars, resume=%s)",
            self._interaction_count + 1,
            len(prompt),
            self._session_id if self._single_conversation else None,
        )
        result = self._run_cli(self._exec_args(prompt), timeout=self._timeout)
        events = parse_events(result.stdout)
        self._event_log.extend(events)

        resumed = session_id(events)
        if resumed:
            self._session_id = resumed

        # `kinu exec` exits 1 whenever any tool call in the turn failed, even
        # when the turn still produced its answer. Treat a stream that reached
        # an assistant message as a turn; only a stream that never did is fatal.
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[:500]
            if has_answer(events):
                logger.warning(
                    "kinu exec exited %d after a completed turn: %s",
                    result.returncode,
                    detail,
                )
            else:
                raise RuntimeError(
                    f"kinu exec failed ({result.returncode}): {detail}"
                )
        return events

    def _repair_prompt(self, prompt: str, answer: str, error: str) -> str:
        return "\n".join(
            [
                "Your previous response did not match the required benchmark schema.",
                f"Validation error: {error}",
                "Your previous response was:",
                answer,
                "Reply with ONLY a corrected JSON object for the same task.",
                "The original task was:",
                prompt,
            ]
        )

    def _parse_action(self, text: str, schema: type[Any]) -> Any:
        try:
            return validate_with_coercion(text, schema)
        except Exception:
            return validate_with_coercion(extract_json(text), schema)

    def _record_usage(self, usages: list[Usage]) -> Usage:
        for usage in usages:
            # Only a turn the provider actually metered becomes a priced row.
            # `.get(field, 0)` below is safe precisely because of this gate:
            # CL-Bench's UsageEvent is a plain integer ledger, so once the row
            # is known to be real an unreported part of it is genuinely zero.
            if not usage_reported(usage):
                continue
            self.record_usage_event(
                build_usage_event(
                    model=self._model,
                    provider=self._provider,
                    input_tokens=usage.get("input", 0),
                    output_tokens=usage.get("output", 0),
                    cached_input_tokens=usage.get("cacheRead", 0),
                    call_type="completion",
                )
            )
        total = sum_usages(usages)
        self._cumulative_usage = add_usage(self._cumulative_usage, total)
        return total

    def respond(self, query: Query) -> Response:
        prompt = self._build_prompt(query)
        events = self._run_turn(prompt)
        answer = assistant_text(events)
        usages = [turn_usage(events)]
        repaired = False

        try:
            action = self._parse_action(answer, query.response_schema)
        except Exception as exc:
            repaired = True
            repair_events = self._run_turn(
                self._repair_prompt(prompt, answer, str(exc))
            )
            usages.append(turn_usage(repair_events))
            action = self._parse_action(
                assistant_text(repair_events), query.response_schema
            )
            events = [*events, *repair_events]

        spent = self._record_usage(usages)
        self._pending_feedback = None
        self._interaction_count += 1
        # The report verbatim, absences and all: a fixed "in=%d out=%d cached=%d"
        # line had to invent a number for every field the provider never
        # mentioned.
        logger.info("Response parsed (usage %s)", spent or "unreported")

        return Response(
            action=action,
            metadata={
                "system_type": "kinu",
                "model": self._model,
                "provider": self._provider,
                "interaction_count": self._interaction_count,
                "auto_evolve": self._auto_evolve,
                "persist_workspace": self._persist_workspace,
                "single_conversation": self._single_conversation,
                "session_id": self._session_id,
                "token_usage": spent,
                "cumulative_tokens": dict(self._cumulative_usage),
                "tool_calls": tool_calls(events),
                "had_error": had_error(events),
                "repair_attempted": repaired,
            },
        )

    def observe(
        self, observation: Observation, next_query: Optional[Query] = None
    ) -> None:
        _ = next_query
        if not self._persist_workspace and observation_marks_instance_complete(
            observation
        ):
            # The within-run ablation: same rollout, but nothing durable
            # survives the instance boundary.
            self._destroy_workspace()
        content = observation.content.strip()
        if content:
            self._pending_feedback = content

    # ---- lifecycle ---------------------------------------------------------

    def _clear_interaction_state(self) -> None:
        self._interaction_count = 0
        self._session_id: str | None = None
        self._pending_feedback: str | None = None
        self._event_log: list[dict[str, Any]] = []
        self._cumulative_usage: Usage = {}

    def reset(self) -> None:
        self._destroy_workspace()
        self._clear_interaction_state()

    def _workspace_snapshot(self) -> dict[str, Any]:
        """The durable state the workspace ended with — SOUL, scaffold version,
        crafted tools, memory nodes. Reads the database; makes no model call."""
        if not self._workspace_ready:
            return {}
        try:
            result = self._run_cli(["state", _WORKSPACE_NAME, "--json"], timeout=120)
        except (subprocess.SubprocessError, OSError) as exc:
            return {"error": str(exc)}
        if result.returncode != 0:
            return {"error": (result.stderr or result.stdout).strip()[:500]}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            return {"error": f"unparseable state output: {exc}"}

    def get_run_artifacts(self) -> dict[str, Any]:
        return {
            "artifact_type": "kinu",
            "model": self._model,
            "provider": self._provider,
            "auto_evolve": self._auto_evolve,
            "persist_workspace": self._persist_workspace,
            "single_conversation": self._single_conversation,
            "interaction_count": self._interaction_count,
            "session_id": self._session_id,
            "cumulative_tokens": dict(self._cumulative_usage),
            "workspace_state": self._workspace_snapshot(),
            "events": self._event_log,
        }

    @property
    def name(self) -> str:
        return self._name

    def __del__(self) -> None:
        if getattr(self, "_workspace_ready", False):
            self._destroy_workspace()
        root = getattr(self, "_root", None)
        if root is not None:
            cleanup_run_workspace(str(root))
