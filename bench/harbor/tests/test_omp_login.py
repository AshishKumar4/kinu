"""The OMP agent's login choice: read-only, the access token alone, and refused rather than renewed. Stdlib only."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from bench.harbor.omp_login import grant_from_store, import_document, provider_of

NOW = 1_800_000_000_000
HOUR = 3_600_000


def store(directory: str, rows: list[tuple[str, str | None, dict]]) -> Path:
    path = Path(directory) / "agent.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, disabled_cause TEXT, data TEXT)")
    db.executemany("INSERT INTO auth_credentials (provider, disabled_cause, data) VALUES (?, ?, ?)", [(p, d, json.dumps(data)) for p, d, data in rows])
    db.commit()
    db.close()

    return path


class OmpLoginTest(unittest.TestCase):
    def test_each_model_names_its_provider(self) -> None:
        self.assertEqual([provider_of(m) for m in ("openai-codex/gpt-6.1-sol", "claude-opus-5-5", "google-antigravity/gemini-4-argon")],
                         ["openai-codex", "anthropic", "google-antigravity"])
        self.assertRaises(ValueError, provider_of, "muse")

    def test_the_longest_lasting_enabled_login_is_taken_and_only_its_access_token_leaves(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = store(directory, [
                ("anthropic", None, {"access": "short", "refresh": "r1", "expires": NOW + 2 * HOUR}),
                ("anthropic", None, {"access": "long", "refresh": "r2", "expires": NOW + 5 * HOUR, "accountId": "acct-1", "email": "owner@example.com"}),
                ("anthropic", "revoked", {"access": "disabled", "refresh": "r3", "expires": NOW + 9 * HOUR}),
                ("openai-codex", None, {"access": "other", "refresh": "r4", "expires": NOW + 9 * HOUR}),
            ])
            before = path.read_bytes()
            grant = grant_from_store(path, "anthropic", HOUR, NOW)
            document = json.dumps(import_document(grant))

            credential = import_document(grant)["credentials"][0]["credential"]
            self.assertEqual((grant.access, grant.expires), ("long", NOW + 5 * HOUR))
            self.assertEqual((credential["refresh"], credential["accountId"]), ("", "acct-1"))
            self.assertNotIn("r2", document)
            self.assertNotIn("owner@example.com", document)
            self.assertEqual(path.read_bytes(), before)

    def test_a_token_ending_within_the_run_is_refused_not_renewed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = store(directory, [("anthropic", None, {"access": "soon", "refresh": "r", "expires": NOW + HOUR // 2})])

            with self.assertRaisesRegex(RuntimeError, "let OMP renew it"):
                grant_from_store(path, "anthropic", HOUR, NOW)


if __name__ == "__main__":
    unittest.main()
