"""Harbor agent adapter — runs Proteus inside a Harbor task container.

    PYTHONPATH=<proteus-repo> harbor run \
        --agent bench.harbor.proteus_agent:ProteusAgent \
        --path ./terminal-bench-2.1 \
        -m deepseek/deepseek-v4-flash \
        --ak evolve=false \
        --allow-agent-host openrouter.ai

``./terminal-bench-2.1`` is the corpus of record: 2.0 is kept alongside as
``./terminal-bench-2.0`` so older scores stay interpretable, but it is not what
new runs measure. Each corpus carries a ``corpus.json`` and every trial logs and
records which one it ran (see ``bench/harbor/corpus.py``).

Glue only: the adapter installs the CLI, creates a local workspace, and hands
the task instruction to ``proteus exec``. It changes nothing about how the
agent reasons — the only knob it exposes is ``evolve``, the switch a paired
evolving/non-evolving comparison needs.
"""

from __future__ import annotations

import json
import shlex
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, EnvVar, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.env import parse_bool_env_value

from bench.harbor.build import REPO_ROOT, build_proteus_binary
from bench.harbor.corpus import CorpusIdentity, resolve_for_trial
from bench.harbor.trajectory import build_trajectory, read_events

INSTALL_PATH = PurePosixPath("/installed-agent/proteus")
LOG_NAME = "proteus.jsonl"
STDERR_LOG_NAME = "proteus-stderr.txt"
CREATE_LOG_NAME = "proteus-create.txt"

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_WORKSPACE = "harbor"
DEFAULT_MISSION = (
    "Complete software engineering tasks in this container's working directory."
)


class ProteusAgent(BaseInstalledAgent):
    """Proteus, driven headlessly through ``proteus exec`` in local mode."""

    SUPPORTS_ATIF: bool = True

    ENV_VARS = [
        EnvVar(
            "base_url",
            env="PROTEUS_BASE_URL",
            env_fallback="PROTEUS_BASE_URL",
            default=DEFAULT_BASE_URL,
        ),
    ]

    def __init__(
        self,
        *args: Any,
        evolve: Any = True,
        workspace: str = DEFAULT_WORKSPACE,
        mission: str = DEFAULT_MISSION,
        proteus_repo: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._evolve = parse_bool_env_value(evolve, name="evolve", default=True)
        self._workspace = workspace
        self._mission = mission
        self._repo_root = Path(proteus_repo).resolve() if proteus_repo else REPO_ROOT
        self._corpus_identity: CorpusIdentity | None = None
        # Resolved eagerly so a misconfigured job fails before it builds a
        # container and installs into it.
        self._env = self._resolve_run_env()

    @staticmethod
    @override
    def name() -> str:
        return "proteus"

    @override
    def get_version_command(self) -> str | None:
        return f"{INSTALL_PATH} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # `/installed-agent` is created by BaseInstalledAgent.setup() as root.
        binary = await build_proteus_binary(self._repo_root)
        await environment.upload_file(binary, str(INSTALL_PATH))
        await self.exec_as_root(environment, command=f"chmod 0755 {INSTALL_PATH}")
        await self.exec_as_agent(environment, command=f"{INSTALL_PATH} --version")

    def _resolve_run_env(self) -> dict[str, str]:
        """Model access for the container, resolved from the run environment.

        Proteus reads ``PROTEUS_BASE_URL``/``PROTEUS_AUTH``/``PROTEUS_MODEL`` as
        a direct-endpoint override, which needs no ``~/.proteus/config.json``
        and no account — exactly what a throwaway container wants.
        """
        env = dict(self._resolved_env_vars)

        auth = self._get_env("PROTEUS_AUTH")
        if not auth:
            api_key = self._get_env("OPENROUTER_API_KEY") or self._get_env("OPENAI_API_KEY")
            if not api_key:
                raise ValueError(
                    "No model credentials. Set OPENROUTER_API_KEY (or OPENAI_API_KEY), "
                    "or pass a complete header with PROTEUS_AUTH. "
                    "Use --ae KEY=VALUE to forward one into the agent."
                )
            auth = f"Bearer {api_key}"
        env["PROTEUS_AUTH"] = auth

        if not self.model_name:
            raise ValueError(
                "A model is required: pass -m <model-id> as the provider serving "
                f"{env['PROTEUS_BASE_URL']} names it (e.g. deepseek/deepseek-v4-flash)."
            )
        env["PROTEUS_MODEL"] = self.model_name
        return env

    def _corpus(self) -> CorpusIdentity | None:
        """The task set this trial is scored on, announced once per trial.

        A Terminal-Bench score means nothing without its release — 2.0 and 2.1
        share all 89 task names but differ in 28 tasks — so identity is logged
        and stamped into the result rather than left for a reader to guess.
        """
        identity = resolve_for_trial(self.logs_dir)
        if identity is None:
            self.logger.warning(
                "corpus: UNIDENTIFIED — no corpus.json above this task. "
                "Results from this run cannot be attributed to a benchmark release."
            )
        elif not identity.verified:
            self.logger.warning(str(identity))
        else:
            self.logger.info(str(identity))
        return identity

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        self._corpus_identity = self._corpus()
        workspace = shlex.quote(self._workspace)

        # A workspace per container, created fresh: nothing carries over between
        # trials, so each task is scored on the same starting state.
        await self.exec_as_agent(
            environment,
            command=(
                f"{INSTALL_PATH} create {workspace} --mode local "
                f"--purpose {shlex.quote(self._mission)} --no-alias-shim "
                f"2>&1 | tee {EnvironmentPaths.agent_dir / CREATE_LOG_NAME}"
            ),
            env=self._env,
        )

        evolve_flag = "" if self._evolve else "--no-auto-evolve "
        # `</dev/null` is required, not defensive: `proteus exec` folds piped
        # stdin into the prompt, so an open stdin would block the turn forever.
        # stderr goes to its own file rather than into the pipe: a tool result
        # longer than PIPE_BUF can be interleaved with a diagnostic line, and a
        # torn JSON line silently drops a step from the trajectory. Model and
        # turn errors arrive on stdout as `{"type":"error"}`, so Harbor's error
        # classification still sees them.
        await self.exec_as_agent(
            environment,
            command=(
                f"{INSTALL_PATH} exec --workspace {workspace} --json {evolve_flag}"
                f"-- {shlex.quote(instruction)} "
                f"</dev/null 2>{EnvironmentPaths.agent_dir / STDERR_LOG_NAME} "
                f"| tee {EnvironmentPaths.agent_dir / LOG_NAME}"
            ),
            env=self._env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        log_path = self.logs_dir / LOG_NAME
        if not log_path.exists():
            self.logger.debug(f"No Proteus event log at {log_path}")
            return

        events = read_events(log_path)
        if not events:
            self.logger.debug(f"Proteus event log {log_path} held no events")
            return

        trajectory, summary = build_trajectory(
            events,
            session_id=self.session_id or str(uuid.uuid4()),
            agent_name=self.name(),
            agent_version=self.version() or "unknown",
            model_name=self.model_name,
            agent_extra={"evolve": self._evolve, "workspace": self._workspace},
        )

        try:
            (self.logs_dir / "trajectory.json").write_text(
                json.dumps(trajectory.to_json_dict(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError as exc:
            self.logger.debug(f"Failed to write Proteus trajectory: {exc}")

        if summary.usage is not None:
            context.n_input_tokens = summary.usage["input"]
            context.n_cache_tokens = summary.usage["cached"]
            context.n_output_tokens = summary.usage["output"]
        # cost_usd stays unset: Proteus reports tokens, not prices, and an
        # invented number is worse than a missing one.
        context.metadata = {
            "corpus": self._corpus_identity.as_dict() if self._corpus_identity else None,
            "evolve": self._evolve,
            "tool_calls": summary.tool_calls,
            "turn_steps": summary.turn_steps,
            "duration_ms": summary.duration_ms,
            "had_error": summary.had_error,
            "errors": summary.errors,
            "evolution_events": summary.evolution_events,
        }
