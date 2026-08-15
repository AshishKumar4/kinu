"""Harbor agent adapter — runs Proteus inside a Harbor task container.

    PYTHONPATH=<proteus-repo> harbor run \
        --agent bench.harbor.proteus_agent:ProteusAgent \
        --path ./terminal-bench-2.1 \
        --ak evolve=false \
        --allow-agent-host proteus.ashishkumarsingh.com

The adapter defaults to native Workers AI DeepSeek V4 Pro 0813 through
Proteus's signed-in inference proxy. Export ``PROTEUS_TOKEN`` before launching
Harbor; a long-lived token needs the ``ai.proxy`` scope. ``-m`` and
``PROTEUS_BASE_URL`` remain explicit override surfaces for comparison runs.

``./terminal-bench-2.1`` is the corpus of record: 2.0 is kept alongside as
``./terminal-bench-2.0`` so older scores stay interpretable, but it is not what
new runs measure. Each corpus carries a ``corpus.json`` and every trial logs and
records which one it ran (see ``bench/harbor/corpus.py``).

Glue only: the adapter installs the CLI, creates a local workspace, and hands
the task instruction to ``proteus exec``. It changes nothing about how the
agent reasons — the only knob it exposes is ``evolve``, the switch a paired
evolving/non-evolving comparison needs.

Two things it is deliberate about. The run environment travels into the
container as a file, not as ``exec -e KEY=VALUE`` — Harbor renders per-exec env
onto the ``docker compose`` command line, where anything on the host can read
the model credential out of ``ps``. And ``PROTEUS_HOME`` is set explicitly to a
path under the agent install root, checked by ``bench.isolation``, so the
container's own home is never what a trial writes into.
"""

from __future__ import annotations

import json
import shlex
import tempfile
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
from bench.isolation import assert_throwaway_home
from bench.model_endpoint import (
    DEFAULT_PROTEUS_AI_BASE_URL,
    DEFAULT_WORKERS_AI_MODEL_ID,
    provider_for_base_url,
    resolve_bearer_token,
)

INSTALL_ROOT = PurePosixPath("/installed-agent")
INSTALL_PATH = INSTALL_ROOT / "proteus"
#: The trial's PROTEUS_HOME. One per container, and a container is one trial —
#: fixed rather than randomized so a resumed trial finds the state it left.
HOME_PATH = INSTALL_ROOT / "proteus-home"
#: The run environment, sourced by every Proteus invocation. Never on argv.
ENV_PATH = INSTALL_ROOT / "proteus.env"
LOG_NAME = "proteus.jsonl"
STDERR_LOG_NAME = "proteus-stderr.txt"
CREATE_LOG_NAME = "proteus-create.txt"

DEFAULT_BASE_URL = DEFAULT_PROTEUS_AI_BASE_URL
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
        if not self.model_name:
            self.model_name = DEFAULT_WORKERS_AI_MODEL_ID
            self._init_model_info()
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
        """The environment every Proteus invocation in the container runs under.

        Proteus reads ``PROTEUS_BASE_URL``/``PROTEUS_AUTH``/``PROTEUS_MODEL`` as
        a direct-endpoint override, which needs no ``~/.proteus/config.json``
        and no account — exactly what a throwaway container wants. ``PROTEUS_HOME``
        completes it: without one, everything durable a trial writes lands in
        whatever home the container user happens to have.
        """
        env = dict(self._resolved_env_vars)

        auth = self._get_env("PROTEUS_AUTH")
        if not auth:
            credential_env = {
                name: value
                for name in (
                    "PROTEUS_TOKEN",
                    "PROTEUS_HOME",
                    "CLOUDFLARE_API_TOKEN",
                    "OPENROUTER_API_KEY",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                )
                if (value := self._get_env(name)) is not None
            }
            token = resolve_bearer_token(
                env["PROTEUS_BASE_URL"],
                provider_for_base_url(env["PROTEUS_BASE_URL"]),
                environ=credential_env,
            )
            auth = f"Bearer {token}"
        env["PROTEUS_AUTH"] = auth
        env["PROTEUS_MODEL"] = self.model_name
        env["PROTEUS_HOME"] = assert_throwaway_home(str(HOME_PATH))
        return env

    async def _place_run_env(self, environment: BaseEnvironment) -> None:
        """Place the run environment in the container as a file only the agent
        user can read, and create the home it points at.

        Harbor renders every per-exec env var as ``docker compose exec -e
        KEY=VALUE``, so passing the model credential that way publishes it to
        every ``ps`` on the host and to Harbor's own command log. Uploading it
        instead keeps the command line to a path: the secret crosses over inside
        a tar stream and lands at mode 0600.

        Done here rather than in ``install`` because Harbor scopes the task's
        agent user around ``run`` alone — during setup ``exec_as_agent`` is still
        the container's default user, so a uid read there could own the file to
        somebody the turn does not run as.
        """
        uid = (await self.exec_as_agent(environment, command="id -u")).stdout.strip()
        if not uid.isdigit():
            raise RuntimeError(f"Could not resolve the agent user's uid, got {uid!r}")

        body = "".join(f"{k}={shlex.quote(v)}\n" for k, v in sorted(self._env.items()))
        with tempfile.TemporaryDirectory() as staging:
            local = Path(staging) / ENV_PATH.name
            local.touch(mode=0o600)
            local.write_text(body, encoding="utf-8")
            await environment.upload_file(local, str(ENV_PATH))

        await self.exec_as_root(
            environment,
            command=(
                f"chown {uid} {ENV_PATH} && chmod 0600 {ENV_PATH} && "
                f"mkdir -p {HOME_PATH} && chown {uid} {HOME_PATH} && chmod 0700 {HOME_PATH}"
            ),
        )

    @staticmethod
    def _with_run_env(command: str) -> str:
        """Run *command* under the uploaded environment. The one way this
        adapter gives Proteus its configuration, so there is no second path a
        credential could take back onto the command line."""
        return f"set -a; . {ENV_PATH}; set +a; {command}"

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
        await self._place_run_env(environment)
        workspace = shlex.quote(self._workspace)

        # A workspace per container, created fresh: nothing carries over between
        # trials, so each task is scored on the same starting state.
        await self.exec_as_agent(
            environment,
            command=self._with_run_env(
                f"{INSTALL_PATH} create {workspace} --mode local "
                f"--purpose {shlex.quote(self._mission)} --no-alias-shim "
                f"2>&1 | tee {EnvironmentPaths.agent_dir / CREATE_LOG_NAME}"
            ),
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
            command=self._with_run_env(
                f"{INSTALL_PATH} exec --workspace {workspace} --json {evolve_flag}"
                f"-- {shlex.quote(instruction)} "
                f"</dev/null 2>{EnvironmentPaths.agent_dir / STDERR_LOG_NAME} "
                f"| tee {EnvironmentPaths.agent_dir / LOG_NAME}"
            ),
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
            "run_events": summary.run_events,
        }
