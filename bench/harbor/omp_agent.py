"""OMP, headless, as a Harbor agent: one harness for every model, so only ``-m`` varies.

    PYTHONPATH=<kinu-repo> harbor run \\
        --agent bench.harbor.omp_agent:OmpAgent -m openai-codex/gpt-6.1-sol \\
        -p <kinu-envs>/tasks/<task> --allow-agent-host chatgpt.com

Built for kinu-envs' review tasks (its DESIGN.md), and usable on any Harbor task whose instruction OMP can follow.

OMP runs inside the task's container, never on this host, where it could read the task's key from the kinu-envs
checkout. It is the operator's own compiled OMP (``omp_binary``, default ``~/.bun/bin/omp``), uploaded as it is. Its
model login is read here from OMP's store, read-only and the access token alone: OMP renews its logins under its own
lease, which nothing here touches, and no refresh token leaves the store. A token that would end before the agent's
timeout is refused rather than renewed. The token crosses into the container as a file (Harbor renders per-exec env
onto the ``docker compose`` command line, where ``ps`` reads it, as ``kinu_agent.py`` says), is imported into a home of
the run's own and deleted, and that home is deleted when the run ends, before Harbor collects anything.

Egress is the task's: run with ``--allow-agent-host`` set to the provider's API host (``API_HOSTS``) and nothing else.
"""

from __future__ import annotations

import json
import shlex
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from bench.harbor.omp_login import OMP_STORE, grant_from_store, import_document, provider_of

AGENT_DIR = PurePosixPath("/installed-agent/omp")
INSTALL_PATH = AGENT_DIR / "omp"
CREDENTIAL_PATH = AGENT_DIR / "credential.json"
HOME_PATH = AGENT_DIR / "home"
LOG_NAME = "omp.jsonl"
STDERR_LOG_NAME = "omp.stderr"

class OmpAgent(BaseInstalledAgent):
    """OMP in print mode, one session, every tool call approved: the model is the variable."""

    def __init__(self, *args: Any, omp_binary: str | None = None, max_time: str = "55m", agent_timeout_sec: float | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._timeout_ms = int((agent_timeout_sec or 3600) * 1000)

        if not self.model_name:
            raise ValueError("name the model with -m, as OMP names it (e.g. openai-codex/gpt-6.1-sol)")

        self._binary = Path(omp_binary).expanduser() if omp_binary else Path.home() / ".bun" / "bin" / "omp"
        self._max_time = max_time
        self._provider = provider_of(self.model_name)

    @staticmethod
    @override
    def name() -> str:
        return "omp"

    @override
    def get_version_command(self) -> str | None:
        return f"HOME={HOME_PATH} {INSTALL_PATH} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._binary.is_file():
            raise RuntimeError(f"no OMP binary at {self._binary}")

        await environment.upload_file(self._binary, str(INSTALL_PATH))
        await self.exec_as_root(environment, command=f"chmod 0755 {INSTALL_PATH}")

    async def _place_credential(self, environment: BaseEnvironment) -> None:
        """The login as a 0600 file the agent user owns, and the empty home it is imported into."""
        grant = grant_from_store(OMP_STORE, self._provider, self._timeout_ms)
        uid = (await self.exec_as_agent(environment, command="id -u")).stdout.strip()

        if not uid.isdigit():
            raise RuntimeError(f"could not resolve the agent user's uid, got {uid!r}")

        with tempfile.TemporaryDirectory(dir="/mnt/local/kinu/tmp") as staging:
            local = Path(staging) / CREDENTIAL_PATH.name
            local.touch(mode=0o600)
            local.write_text(json.dumps(import_document(grant)), encoding="utf-8")
            await environment.upload_file(local, str(CREDENTIAL_PATH))

        await self.exec_as_root(environment, command=(
            f"chown {uid} {CREDENTIAL_PATH} && chmod 0600 {CREDENTIAL_PATH} && "
            f"rm -rf {HOME_PATH} && mkdir -p {HOME_PATH} && chown {uid} {HOME_PATH} && chmod 0700 {HOME_PATH}"))

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self._place_credential(environment)
        logs = EnvironmentPaths.agent_dir
        omp = f"HOME={HOME_PATH} {INSTALL_PATH}"

        try:
            await self.exec_as_agent(environment, command=f"{omp} auth import {CREDENTIAL_PATH} >/dev/null && rm -f {CREDENTIAL_PATH}")
            # `</dev/null`: print mode reads a piped stdin into the prompt. stderr apart, so no diagnostic tears a JSON line.
            await self.exec_as_agent(environment, cwd="/repo", command=(
                f"{omp} -p --mode json --no-session --model {shlex.quote(self.model_name)} --approval-mode yolo "
                f"--no-extensions --no-skills --no-rules --no-title --no-lsp --max-time {shlex.quote(self._max_time)} "
                f"-- {shlex.quote(self.render_instruction(instruction))} </dev/null 2>{logs / STDERR_LOG_NAME} | tee {logs / LOG_NAME}"))
        finally:
            # The login goes with the run, before Harbor collects a thing; an agent-phase timeout still reaches this.
            await self.exec_as_root(environment, command=f"rm -rf {CREDENTIAL_PATH} {HOME_PATH}")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Tokens and cost from OMP's JSON events, where they say them: each message's `usage`, summed."""
        log = self.logs_dir / LOG_NAME

        if not log.exists():
            return

        inputs = outputs = 0
        cost = 0.0
        seen = False

        for line in log.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            usage = event.get("message", {}).get("usage") if isinstance(event.get("message"), dict) else None

            if event.get("type") != "message_end" or not isinstance(usage, dict):
                continue

            seen = True
            inputs += int(usage.get("input", 0)) + int(usage.get("cacheRead", 0)) + int(usage.get("cacheWrite", 0))
            outputs += int(usage.get("output", 0))
            cost += float((usage.get("cost") or {}).get("total", 0.0))

        if seen:
            context.n_input_tokens, context.n_output_tokens, context.cost_usd = inputs, outputs, cost
