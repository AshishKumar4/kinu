"""Harbor agent adapter — runs Kinu inside a Harbor task container.

    PYTHONPATH=<kinu-repo> harbor run \
        --agent bench.harbor.kinu_agent:KinuAgent \
        --path ./terminal-bench-2.1 \
        --ak evolve=false \
        --allow-agent-host staging.kinu.run

The adapter defaults to Workers AI GLM-5.3 through the staging inference proxy
as ``eval-service`` (``KINU_EVAL_TOKEN``, ``ai.proxy`` scope). For direct
Workers AI, explicitly set ``KINU_BASE_URL`` to the account
``https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`` endpoint and
provide ``CLOUDFLARE_API_TOKEN``; allow ``api.cloudflare.com`` in the task
network policy. No signed-in Kinu session is borrowed. Production Kinu
targets still require ``KINU_EVAL_ALLOW_PROD=1`` and their own credential.
See ``bench/model_endpoint.py``; ``-m`` selects the model independently.

``./terminal-bench-2.1`` is the corpus of record: 2.0 is kept alongside as
``./terminal-bench-2.0`` so older scores stay interpretable, but it is not what
new runs measure. Each corpus carries a ``corpus.json`` and every trial logs and
records which one it ran (see ``bench/harbor/corpus.py``).

Glue only: the adapter installs the CLI, creates a local workspace, and hands
the task instruction to ``kinu exec``. It changes nothing about how the
agent reasons — the only knob it exposes is ``evolve``, the switch a paired
evolving/non-evolving comparison needs.

Two things it is deliberate about. The run environment travels into the
container as a file, not as ``exec -e KEY=VALUE`` — Harbor renders per-exec env
onto the ``docker compose`` command line, where anything on the host can read
the model credential out of ``ps``. And ``KINU_HOME`` is set explicitly to a
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

from bench.harbor.build import REPO_ROOT, KinuBuild, build_kinu_binary
from bench.harbor.corpus import CorpusIdentity, resolve_for_trial
from bench.harbor.trajectory import build_trajectory, read_events, read_grading, read_spend
from bench.isolation import assert_throwaway_home
from bench.model_endpoint import (
    DEFAULT_KINU_AI_BASE_URL,
    DEFAULT_WORKERS_AI_MODEL_ID,
    assert_eval_target,
    resolve_trial_bearer,
)

INSTALL_ROOT = PurePosixPath("/installed-agent")
INSTALL_PATH = INSTALL_ROOT / "kinu"
#: Where the packages the binary cannot embed are uploaded. `NODE_PATH` points
#: the binary here, because bun resolves an external specifier against the
#: process's working directory and the turn runs in the task's, not this one.
RUNTIME_MODULES = INSTALL_ROOT / "node_modules"
#: The trial's KINU_HOME. One per container, and a container is one trial —
#: fixed rather than randomized so a resumed trial finds the state it left.
HOME_PATH = INSTALL_ROOT / "kinu-home"
#: The run environment, sourced by every Kinu invocation. Never on argv.
ENV_PATH = INSTALL_ROOT / "kinu.env"
LOG_NAME = "kinu.jsonl"
STDERR_LOG_NAME = "kinu-stderr.txt"
CREATE_LOG_NAME = "kinu-create.txt"
#: The turn_outcomes read taken after the turn. A benchmark cannot ask a person
#: whether the turn was any good, so whether the turn was GRADED AT ALL is the
#: measurement that decides if this trial's arm state means anything.
ALIGNMENT_NAME = "kinu-alignment.json"
SPEND_NAME = "kinu-spend.json"

DEFAULT_BASE_URL = DEFAULT_KINU_AI_BASE_URL
DEFAULT_WORKSPACE = "harbor"
DEFAULT_MISSION = (
    "Complete software engineering tasks in this container's working directory."
)


class KinuAgent(BaseInstalledAgent):
    """Kinu, driven headlessly through ``kinu exec`` in local mode."""

    SUPPORTS_ATIF: bool = True

    ENV_VARS = [
        EnvVar(
            "base_url",
            env="KINU_BASE_URL",
            env_fallback="KINU_BASE_URL",
            default=DEFAULT_BASE_URL,
        ),
    ]

    def __init__(
        self,
        *args: Any,
        evolve: Any = True,
        workspace: str = DEFAULT_WORKSPACE,
        mission: str = DEFAULT_MISSION,
        kinu_repo: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if not self.model_name:
            self.model_name = DEFAULT_WORKERS_AI_MODEL_ID
            self._init_model_info()
        self._evolve = parse_bool_env_value(evolve, name="evolve", default=True)
        self._workspace = workspace
        self._mission = mission
        self._repo_root = Path(kinu_repo).resolve() if kinu_repo else REPO_ROOT
        self._corpus_identity: CorpusIdentity | None = None
        self._build: KinuBuild | None = None
        # Resolved eagerly so a misconfigured job fails before it builds a
        # container and installs into it.
        self._env = self._resolve_run_env()

    @staticmethod
    @override
    def name() -> str:
        return "kinu"

    #: One spelling of the module path, used by the install-phase probe below
    #: and by the run environment. The env file is not in place during install,
    #: so the probe carries it inline rather than sourcing it.
    _NODE_PATH = f"NODE_PATH={RUNTIME_MODULES}"

    @override
    def get_version_command(self) -> str | None:
        return f"{self._NODE_PATH} {INSTALL_PATH} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # `/installed-agent` is created by BaseInstalledAgent.setup() as root.
        build = await build_kinu_binary(self._repo_root)
        if build.source_sha is None or build.source_dirty:
            raise RuntimeError("A scored Kinu trial requires a committed source tree")
        self._build = build
        await environment.upload_file(build.binary, str(INSTALL_PATH))
        for specifier, source in build.modules.items():
            await environment.upload_dir(source, str(RUNTIME_MODULES / specifier))
        await self.exec_as_root(environment, command=f"chmod 0755 {INSTALL_PATH}")
        # Runs the version probe rather than trusting the upload: the two
        # externalised runtime packages are read in a module-scope initializer,
        # so a missing one is not a degraded turn later, it is a CLI that cannot
        # print its own version. Failing here costs no model call.
        await self.exec_as_agent(
            environment, command=f"{self._NODE_PATH} {INSTALL_PATH} --version"
        )

    def _resolve_run_env(self) -> dict[str, str]:
        """The environment every Kinu invocation in the container runs under.

        Kinu reads ``KINU_BASE_URL``/``KINU_AUTH``/``KINU_MODEL`` as
        a direct-endpoint override, which needs no ``~/.kinu/config.json``
        and no account — exactly what a throwaway container wants. ``KINU_HOME``
        completes it: without one, everything durable a trial writes lands in
        whatever home the container user happens to have.
        """
        env = dict(self._resolved_env_vars)

        # WHERE, before the credential. A scored run against production writes
        # into the live account: this adapter's own default USED to be the
        # production origin, so a trial that named no endpoint measured the real
        # system by default. Refused here, before the trial starts, rather than
        # discovered in a workspace list afterwards.
        # The override is read from the LAUNCHING shell (os.environ, the default)
        # rather than from the trial's rendered vars: consenting to production is
        # an operator's act, not a per-trial parameter.
        assert_eval_target(env["KINU_BASE_URL"])
        auth = self._get_env("KINU_AUTH")
        if not auth:
            auth = f"Bearer {resolve_trial_bearer(env['KINU_BASE_URL'], self._get_env)}"
        env["KINU_AUTH"] = auth
        env["KINU_MODEL"] = self.model_name
        env["KINU_HOME"] = assert_throwaway_home(str(HOME_PATH))
        env["NODE_PATH"] = str(RUNTIME_MODULES)
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
        adapter gives Kinu its configuration, so there is no second path a
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
        # `</dev/null` is required, not defensive: `kinu exec` folds piped
        # stdin into the prompt, so an open stdin would block the turn forever.
        # stderr goes to its own file rather than into the pipe: a tool result
        # longer than PIPE_BUF can be interleaved with a diagnostic line, and a
        # torn JSON line silently drops a step from the trajectory. Model and
        # turn errors arrive on stdout as `{"type":"error"}`, so Harbor's error
        # classification still sees them.
        try:
            await self.exec_as_agent(
                environment,
                command=self._with_run_env(
                    f"{INSTALL_PATH} exec --workspace {workspace} --json {evolve_flag}"
                    f"-- {shlex.quote(instruction)} "
                    f"</dev/null 2>{EnvironmentPaths.agent_dir / STDERR_LOG_NAME} "
                    f"| tee {EnvironmentPaths.agent_dir / LOG_NAME}"
                ),
            )
        finally:
            # Read the turn_outcomes ledger the turn just wrote, before the
            # container is destroyed with it. An arm's `evolve` kwarg says what
            # was CONFIGURED; this says whether the machinery reached a verdict on
            # the turn at all, which is the difference between a contrast and an
            # inert one.
            #
            # In `finally` because Harbor runs the whole of `run()` under
            # `asyncio.wait_for` (harbor/trial/trial.py:450-462), so an
            # agent-phase timeout cancels everything sequenced after the turn.
            # That lost the probe on exactly the trials that most need
            # explaining: `make-doom-for-mips` timed out in both arms and neither
            # could say whether its turn had been graded. A `finally` await runs
            # to completion and the TimeoutError still reaches Harbor unchanged,
            # measured on this asyncio version rather than assumed.
            await self._probe_evidence(environment, workspace)

    async def _probe_evidence(self, environment: BaseEnvironment, workspace: str) -> None:
        """Read the existing grading and whole-workspace spend commands on every exit.

        One missing channel must not prevent the other, or replace the original
        agent exception. The native spend ledger includes completed model calls
        even when an interrupted turn never emitted a turn_end.
        """
        for command, filename in (("alignment", ALIGNMENT_NAME), ("spend", SPEND_NAME)):
            try:
                await self.exec_as_agent(
                    environment,
                    command=self._with_run_env(
                        f"{INSTALL_PATH} {command} {workspace} --json "
                        f"</dev/null 2>>{EnvironmentPaths.agent_dir / STDERR_LOG_NAME} "
                        f"| tee {EnvironmentPaths.agent_dir / filename}"
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - keep the agent failure and mark this channel missing
                self.logger.warning(f"{command} probe failed, evidence will read as missing: {exc}")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        log_path = self.logs_dir / LOG_NAME
        if not log_path.exists():
            self.logger.debug(f"No Kinu event log at {log_path}")
            return

        events = read_events(log_path)
        if not events:
            self.logger.debug(f"Kinu event log {log_path} held no events")
            return

        trajectory, summary = build_trajectory(
            events,
            session_id=self.session_id or str(uuid.uuid4()),
            agent_name=self.name(),
            agent_version=self.version() or "unknown",
            model_name=self.model_name,
            agent_extra={"evolve": self._evolve, "workspace": self._workspace},
            workspace_spend=read_spend(self.logs_dir / SPEND_NAME),
        )

        try:
            (self.logs_dir / "trajectory.json").write_text(
                json.dumps(trajectory.to_json_dict(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError as exc:
            self.logger.debug(f"Failed to write Kinu trajectory: {exc}")

        grading = read_grading(self.logs_dir / ALIGNMENT_NAME)
        if grading is None:
            self.logger.warning(
                f"grading: UNREADABLE — no parseable {ALIGNMENT_NAME}. This trial "
                "cannot say whether its turn was graded, so it cannot support a "
                "claim about its arm's mechanism."
            )
        else:
            self.logger.info(
                f"grading: {grading.execution_graded} execution-graded, "
                f"{grading.user_graded} user-graded, {grading.abandoned} abandoned"
            )

        # Only the fields the provider actually reported: the usage dict is
        # sparse, so an absent field leaves the context's own default alone
        # instead of raising KeyError or landing there as a measured 0.
        if summary.usage is not None:
            if "input" in summary.usage:
                context.n_input_tokens = summary.usage["input"]
            if "cacheRead" in summary.usage:
                context.n_cache_tokens = summary.usage["cacheRead"]
            if "output" in summary.usage:
                context.n_output_tokens = summary.usage["output"]
        # cost_usd stays unset: Kinu reports tokens, not prices, and an
        # invented number is worse than a missing one.
        context.metadata = {
            "build": {
                "source_sha": self._build.source_sha,
                "source_dirty": self._build.source_dirty,
                "binary_sha256": self._build.binary_sha256,
            } if self._build is not None else None,
            "corpus": self._corpus_identity.as_dict() if self._corpus_identity else None,
            "evolve": self._evolve,
            "usage_complete": summary.usage_complete,
            "usage_source": summary.usage_source,
            "model_calls": summary.model_calls,
            "catalog_usd": summary.catalog_usd,
            "tool_calls": summary.tool_calls,
            "tool_outcomes": summary.tool_outcomes,
            "turn_steps": summary.turn_steps,
            "duration_ms": summary.duration_ms,
            "had_error": summary.had_error,
            "errors": summary.errors,
            # Two fields, because they answer different questions. `activity`
            # is the CLI's whole `type:"evolution"` channel, which also carries
            # background-job and MCP notices; `evolution` is the subset that is
            # really evolution. Reading the first as the second is how a trial
            # configured evolve=false came to report 7 "evolution events".
            "activity_events": summary.activity_events,
            "evolution_events": summary.evolution_events,
            "evolution_fired": len(summary.evolution_events) > 0,
            # How many turns reached a verdict, from turn_outcomes rather than
            # from any event's wording. `null` is missing evidence — the probe
            # left nothing readable — and is deliberately not three zeros, which
            # is what a live but inert arm looks like.
            "turn_grading": grading.as_dict() if grading else None,
            "turns_completed": sum(
                1 for e in summary.evolution_events if e["event"] == "turn_complete"
            ),
            "run_events": summary.run_events,
        }
