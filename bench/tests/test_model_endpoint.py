"""Public contracts for benchmark model endpoint selection and credentials."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from bench.model_endpoint import (
    DEFAULT_PROTEUS_AI_BASE_URL,
    DEFAULT_PROTEUS_ORIGIN,
    DEFAULT_WORKERS_AI_MODEL_ID,
    provider_for_base_url,
    resolve_bearer_token,
)


class ModelEndpointTest(unittest.TestCase):
    def test_default_is_native_deepseek_through_the_signed_in_proxy(self) -> None:
        self.assertEqual(
            DEFAULT_WORKERS_AI_MODEL_ID,
            "@cf/deepseek-ai/deepseek-v4-pro-0813",
        )
        self.assertEqual(
            DEFAULT_PROTEUS_AI_BASE_URL,
            f"{DEFAULT_PROTEUS_ORIGIN}/api/user/ai/v1",
        )

    def test_default_model_matches_the_product_source_of_truth(self) -> None:
        source = (
            Path(__file__).resolve().parents[2]
            / "packages/core/src/providers/workers-ai.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(
            f"DEFAULT_WORKERS_AI_MODEL_ID = '{DEFAULT_WORKERS_AI_MODEL_ID}'",
            source,
        )

    def test_product_proxy_uses_proteus_token_before_stored_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text(
                json.dumps({"accessToken": "ptc_stored"}), encoding="utf-8"
            )
            token = resolve_bearer_token(
                DEFAULT_PROTEUS_AI_BASE_URL,
                "workers-ai",
                environ={"PROTEUS_TOKEN": " pta_ci "},
                config_path=config_path,
            )
        self.assertEqual(token, "pta_ci")

    def test_product_proxy_falls_back_to_stored_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text(
                json.dumps({"accessToken": "ptc_stored"}), encoding="utf-8"
            )
            token = resolve_bearer_token(
                DEFAULT_PROTEUS_AI_BASE_URL,
                "workers-ai",
                environ={},
                config_path=config_path,
            )
        self.assertEqual(token, "ptc_stored")

    def test_product_proxy_rejects_an_expired_stored_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "accessToken": "ptc_expired",
                        "tokenExpiresAt": "2000-01-01T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "expired"):
                resolve_bearer_token(
                    DEFAULT_PROTEUS_AI_BASE_URL,
                    "workers-ai",
                    environ={},
                    config_path=config_path,
                )

    def test_direct_workers_ai_uses_cloudflare_api_token(self) -> None:
        token = resolve_bearer_token(
            "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1",
            "workers-ai",
            environ={"CLOUDFLARE_API_TOKEN": " cf_token "},
        )
        self.assertEqual(token, "cf_token")

    def test_explicit_byo_provider_keeps_its_own_key(self) -> None:
        token = resolve_bearer_token(
            "https://openrouter.ai/api/v1",
            "openrouter",
            environ={"OPENROUTER_API_KEY": " sk_or "},
        )
        self.assertEqual(token, "sk_or")

    def test_endpoint_provider_classification_keeps_byo_explicit(self) -> None:
        self.assertEqual(provider_for_base_url(DEFAULT_PROTEUS_AI_BASE_URL), "workers-ai")
        self.assertEqual(
            provider_for_base_url(
                "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1"
            ),
            "workers-ai",
        )
        self.assertEqual(
            provider_for_base_url("https://openrouter.ai/api/v1"), "openrouter"
        )
        self.assertEqual(provider_for_base_url("https://models.example/v1"), "custom")

    def test_custom_endpoint_requires_an_explicit_credential_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "api_key_env"):
            resolve_bearer_token(
                "https://models.example/v1",
                "custom",
                environ={"OPENAI_API_KEY": "must-not-leak"},
            )

    def test_proxy_path_on_an_untrusted_origin_never_receives_proteus_auth(self) -> None:
        hostile = "https://attacker.example/api/user/ai/v1"
        self.assertEqual(provider_for_base_url(hostile), "custom")
        with self.assertRaisesRegex(ValueError, "api_key_env"):
            resolve_bearer_token(
                hostile,
                "custom",
                environ={"PROTEUS_TOKEN": "must-not-leak"},
            )

    def test_known_endpoint_rejects_a_mismatched_provider(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not match"):
            resolve_bearer_token(
                "https://openrouter.ai/api/v1",
                "openai",
                environ={
                    "OPENAI_API_KEY": "must-not-leak",
                    "OPENROUTER_API_KEY": "correct-but-config-is-invalid",
                },
            )


if __name__ == "__main__":
    unittest.main()
