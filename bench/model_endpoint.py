"""Model endpoint defaults shared by Kinu benchmark adapters.

Two rules govern every scored run, and they are the Python half of
``packages/test-utils/src/eval-identity.ts`` — the same two rules, stated once
per language because a benchmark adapter is symlinked into checkouts where the
TypeScript is not importable:

1. IDENTITY. A run authenticates as the ``eval-service`` account, from
   ``$KINU_EVAL_TOKEN``. It never reads the signed-in session in
   ``~/.kinu/config.json``. It used to, and that is how twenty-two ``drill*``
   workspaces and a ``settle-probe`` came to sit on the owner's PRODUCTION
   account among his own twenty-eight, with nothing on the account able to say
   which harness made them.
2. TARGET. A run reaches the staging deployment or a loopback dev server.
   Production is refused unless ``KINU_EVAL_ALLOW_PROD=1`` names the
   exception. The default target used to BE production, so a benchmark that
   named no origin measured the live system by default.

The target rule is an allowlist. A denylist of production hostnames permits
every origin nobody has thought of yet, which is the mistake being repaired.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

DEFAULT_WORKERS_AI_MODEL_ID = "@cf/zai-org/glm-5.3"

#: The production deployment. Named here for ONE purpose — deciding that an
#: origin is a Kinu deployment and may therefore receive a Kinu
#: credential — and never as a denylist entry. Mirrors the top-level
#: CLI_PUBLIC_ORIGIN in wrangler.jsonc, pinned by bench/tests/test_model_endpoint.py.
PRODUCTION_ORIGIN = "https://kinu.run"
#: The eval target. Mirrors EVAL_STAGING_ORIGIN in eval-identity.ts and
#: env.staging's CLI_PUBLIC_ORIGIN, pinned by the same test.
EVAL_STAGING_ORIGIN = "https://staging.kinu.run"
#: The account every scored run acts as. Mirrors EVAL_SERVICE_ACCOUNT.
EVAL_SERVICE_ACCOUNT = "eval-service"
#: The credential variable. Mirrors EVAL_IDENTITY_ENV.token.
EVAL_TOKEN_ENV = "KINU_EVAL_TOKEN"
#: The one exception, named explicitly. Mirrors EVAL_IDENTITY_ENV.allowProd.
EVAL_ALLOW_PROD_ENV = "KINU_EVAL_ALLOW_PROD"

DEFAULT_KINU_AI_BASE_URL = f"{EVAL_STAGING_ORIGIN}/api/user/ai/v1"

#: Hosts that can only be the operator's own machine. ``urlsplit`` strips IPv6
#: brackets from ``hostname``, unlike the WHATWG parser the TypeScript uses.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})

#: Origins that ARE a Kinu deployment, and so may be sent a Kinu bearer.
#:
#: A DIFFERENT QUESTION from "may an eval point here", and keeping the two apart
#: is load-bearing. Conflating them means ``KINU_EVAL_ALLOW_PROD=1`` — a
#: statement about policy — would also declare every origin on earth a trusted
#: credential sink, and `https://attacker.example/api/user/ai/v1` would receive
#: the token. Policy is ``eval_target_allowed``; trust is this set, and no
#: environment variable widens it.
_KINU_ORIGINS = frozenset({PRODUCTION_ORIGIN, EVAL_STAGING_ORIGIN})

_PROVIDER_KEY_ENVS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
_CLOUDFLARE_AI_PATH = re.compile(r"^/client/v4/accounts/[^/]+/ai/v1/?$")


def eval_target_allowed(origin: str, environ: Mapping[str, str] | None = None) -> bool:
    """Whether a scored run may point at *origin*.

    The override is checked first and is exact: a variable set to ``0``, to the
    empty string, or to ``false`` is not somebody choosing production.
    """
    env = os.environ if environ is None else environ
    if env.get(EVAL_ALLOW_PROD_ENV, "").strip() == "1":
        return True
    parsed = urlsplit(origin.strip().rstrip("/"))
    if parsed.hostname in _LOOPBACK_HOSTS:
        return True
    return f"{parsed.scheme}://{parsed.netloc}" == EVAL_STAGING_ORIGIN


def assert_eval_target(base_url: str, environ: Mapping[str, str] | None = None) -> str:
    """Return *base_url* unchanged, having proven a scored run may use it.

    Called by every adapter before a trial starts, so the refusal arrives before
    the run rather than in a workspace list afterwards.
    """
    raw = (base_url or "").strip()
    if not raw:
        raise ValueError("No endpoint: a scored run must name where it goes.")
    if eval_target_allowed(raw, environ):
        return raw
    parsed = urlsplit(raw)
    raise ValueError(
        f"{parsed.scheme}://{parsed.netloc} is not an eval target. Benchmarks run "
        f"against {EVAL_STAGING_ORIGIN}, or a loopback dev server, so they can "
        f"never write into a deployment that serves real users. To make this run "
        f"anyway, set {EVAL_ALLOW_PROD_ENV}=1 — which records that somebody chose it."
    )


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

    A Kinu proxy uses the eval-service access token, direct Workers AI uses a
    Cloudflare API token, and explicitly selected BYO providers use their
    provider key. Unknown endpoints require ``api_key_env`` so an unrelated
    ambient credential can never be sent to them by accident.
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
        # $KINU_EVAL_TOKEN and NOTHING ELSE. This branch used to fall back to
        # ``accessToken`` in ~/.kinu/config.json — the operator's own signed-in
        # session — which made every scored run act as him on whatever account
        # that session belonged to. The stored session is not read here at all
        # now, so there is no path by which a benchmark becomes a person.
        token = env.get(EVAL_TOKEN_ENV, "").strip()
        if token:
            return token
        raise ValueError(
            f"No {EVAL_SERVICE_ACCOUNT} credential for {base_url}. Mint one against "
            f"{EVAL_STAGING_ORIGIN} (`kinu auth --origin {EVAL_STAGING_ORIGIN}` then "
            f"`kinu tokens create --name bench --scopes ai.proxy`) and export it as "
            f"${EVAL_TOKEN_ENV}. A signed-in session is deliberately never borrowed."
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
    """Whether *base_url* is a Kinu deployment's own inference proxy.

    Membership of ``_KINU_ORIGINS`` (or a loopback dev server), never equality
    with one origin: production, staging and localhost are all Kinu proxies
    and all must receive the Kinu credential, while
    ``https://attacker.example/api/user/ai/v1`` must not — and no environment
    variable can change that, which is why this does not consult
    ``eval_target_allowed``. The path is checked too, so a trusted origin does
    not turn every path on it into a credential sink.
    """
    parsed = urlsplit(base_url)
    if parsed.path.rstrip("/") != "/api/user/ai/v1":
        return False
    if parsed.hostname in _LOOPBACK_HOSTS:
        return True
    return f"{parsed.scheme}://{parsed.netloc}" in _KINU_ORIGINS


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


def _default_config_path(env: Mapping[str, str]) -> Path:
    configured_home = env.get("KINU_HOME", "").strip()
    return (
        Path(configured_home).expanduser() / "config.json"
        if configured_home
        else Path.home() / ".kinu" / "config.json"
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
