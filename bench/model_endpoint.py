"""Model endpoint defaults shared by Kinu benchmark adapters."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

DEFAULT_WORKERS_AI_MODEL_ID = "@cf/deepseek-ai/deepseek-v4-pro-0813"
DEFAULT_PROTEUS_ORIGIN = "https://proteus.ashishkumarsingh.com"
DEFAULT_PROTEUS_AI_BASE_URL = f"{DEFAULT_PROTEUS_ORIGIN}/api/user/ai/v1"

_PROVIDER_KEY_ENVS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
_CLOUDFLARE_AI_PATH = re.compile(r"^/client/v4/accounts/[^/]+/ai/v1/?$")


def provider_for_base_url(base_url: str) -> str:
    """Return the provider whose credential is valid for a known endpoint."""
    if _is_product_proxy(base_url) or _is_direct_workers_ai(base_url):
        return "workers-ai"
    hostname = urlsplit(base_url).hostname
    if hostname == "openrouter.ai":
        return "openrouter"
    if hostname == "api.openai.com":
        return "openai"
    if hostname == "api.anthropic.com":
        return "anthropic"
    return "custom"


def resolve_bearer_token(
    base_url: str,
    provider: str,
    *,
    api_key_env: str | None = None,
    environ: Mapping[str, str] | None = None,
    config_path: Path | None = None,
) -> str:
    """Resolve only the credential belonging to *base_url*.

    The product proxy uses a Kinu session/access token, direct Workers AI
    uses a Cloudflare API token, and explicitly selected BYO providers use
    their provider key. Unknown endpoints require ``api_key_env`` so an
    unrelated ambient credential can never be sent to them by accident.
    """
    env = os.environ if environ is None else environ
    config = _read_config(config_path or _default_config_path(env))
    endpoint_provider = provider_for_base_url(base_url)

    if endpoint_provider == "custom":
        if api_key_env:
            return _required_env(env, api_key_env, base_url)
        raise ValueError(
            f"No credential rule for provider '{provider}' at {base_url}. "
            "Set api_key_env to the exact environment variable this endpoint uses."
        )

    if provider != endpoint_provider:
        raise ValueError(
            f"Provider '{provider}' does not match the '{endpoint_provider}' endpoint "
            f"at {base_url}."
        )

    if api_key_env:
        return _required_env(env, api_key_env, base_url)

    if _is_product_proxy(base_url):
        token = env.get("PROTEUS_TOKEN", "").strip()
        if not token:
            token = _string_at(config, "accessToken")
            expires_at = _string_at(config, "tokenExpiresAt")
            if token and expires_at and _is_expired(expires_at):
                raise ValueError(
                    "The stored Kinu session has expired. Run `proteus auth` "
                    "again, or set PROTEUS_TOKEN to an access token with ai.proxy."
                )
        if token:
            return token
        raise ValueError(
            "No Kinu credential for the Workers AI proxy. Set PROTEUS_TOKEN "
            "(mint one with `proteus tokens create --name bench --scopes ai.proxy`) "
            "or run `proteus auth` to create a stored session."
        )

    if _is_direct_workers_ai(base_url):
        return _required_env(env, "CLOUDFLARE_API_TOKEN", base_url)

    env_name = _PROVIDER_KEY_ENVS.get(provider)
    if env_name:
        key = env.get(env_name, "").strip()
        if not key:
            key = _string_at(config, "providers", provider, "apiKey")
        if key:
            return key
        raise ValueError(
            f"No API key for provider '{provider}'. Set ${env_name}, or add "
            f"providers.{provider}.apiKey to {_default_config_path(env)}."
        )

    raise AssertionError(f"Unhandled credential rule for {endpoint_provider}")


def _is_product_proxy(base_url: str) -> bool:
    parsed = urlsplit(base_url)
    product = urlsplit(DEFAULT_PROTEUS_ORIGIN)
    return (
        parsed.scheme == product.scheme
        and parsed.netloc == product.netloc
        and parsed.path.rstrip("/") == "/api/user/ai/v1"
    )


def _is_direct_workers_ai(base_url: str) -> bool:
    parsed = urlsplit(base_url)
    return (
        parsed.scheme == "https"
        and parsed.hostname == "api.cloudflare.com"
        and _CLOUDFLARE_AI_PATH.fullmatch(parsed.path) is not None
    )


def _required_env(env: Mapping[str, str], name: str, base_url: str) -> str:
    value = env.get(name, "").strip()
    if value:
        return value
    raise ValueError(f"No credential for {base_url}. Set ${name}.")


def _is_expired(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed <= datetime.now(timezone.utc)


def _default_config_path(env: Mapping[str, str]) -> Path:
    configured_home = env.get("PROTEUS_HOME", "").strip()
    return (
        Path(configured_home).expanduser() / "config.json"
        if configured_home
        else Path.home() / ".proteus" / "config.json"
    )


def _read_config(path: Path) -> Mapping[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"Could not read {path}: {exc}") from exc
    return value if isinstance(value, dict) else {}


def _string_at(value: Mapping[str, Any], *path: str) -> str:
    current: Any = value
    for key in path:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return current.strip() if isinstance(current, str) else ""
