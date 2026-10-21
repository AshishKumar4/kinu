"""Which OMP login a model's run takes, read from OMP's store without touching it. Stdlib only, so the bench's
Python tests import it without Harbor (``bench/harbor/tests``)."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: Each model's OMP provider, by the first part of its OMP name; a bare Claude name is Anthropic's.
PROVIDERS = {"openai-codex": "openai-codex", "google-antigravity": "google-antigravity", "anthropic": "anthropic"}

#: The one host each provider's model calls go to: what ``--allow-agent-host`` names for its runs.
API_HOSTS = {"openai-codex": "chatgpt.com", "anthropic": "api.anthropic.com", "google-antigravity": "cloudcode-pa.googleapis.com"}

#: What of a login, besides its access token and end, names the account a call is for: never a secret.
IDENTITY_FIELDS = ("accountId", "orgId", "projectId")

#: OMP's store of its logins on this machine.
OMP_STORE = Path.home() / ".omp" / "agent" / "agent.db"


def provider_of(model: str) -> str:
    head = model.split("/", 1)[0] if "/" in model else ("anthropic" if model.startswith("claude-") else model)

    if head not in PROVIDERS:
        raise ValueError(f"no OMP provider is known for {model!r}; known: {sorted(PROVIDERS)}")

    return PROVIDERS[head]


@dataclass(frozen=True)
class Grant:
    """A login's access token, when it ends (ms since the epoch) and the account it names: no refresh token."""

    provider: str
    access: str
    expires: int
    identity: tuple[tuple[str, str], ...] = ()


def grant_from_store(store: Path, provider: str, valid_for_ms: int, now_ms: int | None = None) -> Grant:
    """The provider's enabled login whose access token lasts longest, read-only. Refused when even that one ends within
    `valid_for_ms`: OMP renews it under its own lease, and this harness never does."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    db = sqlite3.connect(f"file:{store}?mode=ro", uri=True)

    try:
        rows = db.execute("SELECT data FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL", (provider,)).fetchall()
    finally:
        db.close()

    held = [json.loads(data) for (data,) in rows]
    usable = sorted((h for h in held if isinstance(h.get("access"), str) and isinstance(h.get("expires"), int)), key=lambda h: h["expires"])

    if not usable:
        raise RuntimeError(f"OMP holds no enabled {provider} login with an access token")

    best = usable[-1]

    if best["expires"] - now < valid_for_ms:
        minutes = (best["expires"] - now) // 60_000
        raise RuntimeError(f"the {provider} access token ends in {minutes} min, before this run could finish; let OMP renew it")

    identity = tuple((name, best[name]) for name in IDENTITY_FIELDS if isinstance(best.get(name), str))

    return Grant(provider, best["access"], best["expires"], identity)


def import_document(grant: Grant) -> dict[str, Any]:
    """What ``omp auth import`` takes: the one login, its access token, end and account, and an empty refresh token
    (the import requires the field; with none, OMP cannot renew it, which is the point)."""
    credential = {"type": "oauth", "access": grant.access, "refresh": "", "expires": grant.expires, **dict(grant.identity)}

    return {"version": 1, "credentials": [{"provider": grant.provider, "credential": credential}]}

