"""Harbor's pi agent with isolated file-based auth for the GLM-5.3 comparison.

Use --ak version=<pinned pi version>. The adapter leaves pi's agent loop,
installation and result reader intact. Its stock request cap is recorded, not
claimed to match Kinu's uncapped request. List prices are not account charges.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import CliFlag, EnvVar
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from bench.model_endpoint import (
    DEFAULT_KINU_AI_BASE_URL,
    DEFAULT_WORKERS_AI_MODEL_ID,
    assert_eval_target,
    resolve_trial_bearer,
    PI_COMPARATOR_PROVIDER,
    pi_provider_config,
)

AGENT_DIR = PurePosixPath("/installed-agent/pi")
MODELS_PATH = AGENT_DIR / "models.json"
TOKEN_PATH = AGENT_DIR / "token"


class PiComparator(Pi):
    ENV_VARS = [EnvVar(
        "base_url", env="KINU_BASE_URL", env_fallback="KINU_BASE_URL",
        default=DEFAULT_KINU_AI_BASE_URL,
    )]
    CLI_FLAGS = [CliFlag(
        "thinking", cli="--thinking", type="enum",
        choices=["off", "minimal", "low", "medium", "high", "xhigh"], default="medium",
    )]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        if not self._version:
            raise ValueError("Pin the comparator package with --ak version=<pi version>")
        if not self.model_name:
            self.model_name = f"{PI_COMPARATOR_PROVIDER}/{DEFAULT_WORKERS_AI_MODEL_ID}"
            self._init_model_info()
        if self.model_name != f"{PI_COMPARATOR_PROVIDER}/{DEFAULT_WORKERS_AI_MODEL_ID}":
            raise ValueError('The comparator metadata does not describe the requested model')
        self._base_url = assert_eval_target(self._resolved_env_vars['KINU_BASE_URL'])
        self._token = resolve_trial_bearer(self._base_url, self._get_env)

    @staticmethod
    @override
    def name() -> str:
        return "pi-kinu-proxy"

    @override
    async def exec_as_agent(
        self, environment: BaseEnvironment, command: str,
        env: dict[str, str] | None = None, cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        return await super().exec_as_agent(
            environment, command,
            env={**(env or {}), "PI_CODING_AGENT_DIR": str(AGENT_DIR)},
            cwd=cwd, timeout_sec=timeout_sec,
        )

    @override
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext,
    ) -> None:
        await self._place_provider_config(environment)
        await super().run(instruction, environment, context)

    async def _place_provider_config(self, environment: BaseEnvironment) -> None:
        # Harbor applies the task's agent user around run(), not install().
        # A token in exec env would appear in docker compose's -e arguments.
        uid = (await self.exec_as_agent(environment, command="id -u")).stdout.strip()
        if not uid.isdigit():
            raise RuntimeError("Could not resolve the agent user's uid")
        await self.exec_as_root(
            environment, command=f"install -d -m 0700 -o {uid} {AGENT_DIR}",
        )
        config = pi_provider_config(self._base_url, DEFAULT_WORKERS_AI_MODEL_ID, TOKEN_PATH)
        with tempfile.TemporaryDirectory() as staging:
            for name, body in (
                (MODELS_PATH.name, json.dumps(config, indent=2)), (TOKEN_PATH.name, self._token),
            ):
                local = Path(staging) / name
                local.touch(mode=0o600)
                local.write_text(body, encoding="utf-8")
                await environment.upload_file(local, str(AGENT_DIR / name))
        await self.exec_as_root(
            environment,
            command=f"chown {uid} {MODELS_PATH} {TOKEN_PATH} && chmod 0600 {MODELS_PATH} {TOKEN_PATH}",
        )
