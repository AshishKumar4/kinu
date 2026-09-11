"""Public contracts for benchmark model endpoint selection and credentials.

Two of them decide whether a scored run may happen at all — whose credential it
uses, and which deployment it reaches — and both are written against measured
damage rather than a hypothesis. On 2026-08-20 the owner's production account
held 28 workspaces of which 23 were test debris, because this module's default
endpoint WAS production and its credential fallback WAS his signed-in session.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from bench.model_endpoint import (
    DEFAULT_KINU_AI_BASE_URL,
    DEFAULT_WORKERS_AI_MODEL_ID,
    EVAL_ALLOW_PROD_ENV,
    EVAL_DEPLOYMENT_ORIGIN,
    EVAL_STAGING_ORIGIN,
    PRODUCTION_ORIGIN,
    assert_eval_target,
    eval_target_allowed,
    provider_for_base_url,
    resolve_bearer_token,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
WRANGLER = (REPO_ROOT / "packages/cf-backend/wrangler.jsonc").read_text(encoding="utf-8")


class ModelEndpointTest(unittest.TestCase):
    def test_the_default_endpoint_is_the_deployment(self) -> None:
        """Single environment: the default names the deployment itself."""
        self.assertEqual(
            DEFAULT_WORKERS_AI_MODEL_ID,
            "@cf/zai-org/glm-5.3",
        )
        self.assertEqual(
            DEFAULT_KINU_AI_BASE_URL,
            f"{EVAL_DEPLOYMENT_ORIGIN}/api/user/ai/v1",
        )
        self.assertEqual(EVAL_DEPLOYMENT_ORIGIN, PRODUCTION_ORIGIN)

    def test_default_model_matches_the_product_source_of_truth(self) -> None:
        source = (
            Path(__file__).resolve().parents[2]
            / "packages/core/src/providers/workers-ai.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(
            f"DEFAULT_WORKERS_AI_MODEL_ID = '{DEFAULT_WORKERS_AI_MODEL_ID}'",
            source,
        )

    def test_product_proxy_uses_the_eval_service_token(self) -> None:
        token = resolve_bearer_token(
            DEFAULT_KINU_AI_BASE_URL,
            "workers-ai",
            environ={"KINU_EVAL_TOKEN": " pta_eval "},
        )
        self.assertEqual(token, "pta_eval")

    def test_product_proxy_never_reads_the_operators_signed_in_session(self) -> None:
        """The defect this whole module exists to prevent.

        A stored session sitting in the config file is a person's credential,
        and a fallback to it here is how twenty-two ``drill*`` workspaces and a
        ``settle-probe`` could come to sit on the owner's PRODUCTION account.
        Present-and-ignored is the assertion; an absent config file would pass
        whether or not the fallback exists.
        """
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text(
                json.dumps(
                    {"accessToken": "ptc_the_owners_session", "origin": "https://kinu.run"}
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "KINU_EVAL_TOKEN"):
                resolve_bearer_token(
                    DEFAULT_KINU_AI_BASE_URL,
                    "workers-ai",
                    environ={},
                    config_path=config_path,
                )

    def test_a_bare_kinu_token_is_not_the_eval_credential(self) -> None:
        """``KINU_TOKEN`` is whatever the operator's shell happens to hold.

        The eval identity has its own variable precisely so that a signed-in
        developer's exported session cannot become the identity a scored run acts
        as by accident.
        """
        with self.assertRaisesRegex(ValueError, "KINU_EVAL_TOKEN"):
            resolve_bearer_token(
                DEFAULT_KINU_AI_BASE_URL,
                "workers-ai",
                environ={"KINU_TOKEN": "pta_the_operators_shell"},
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
        self.assertEqual(provider_for_base_url(DEFAULT_KINU_AI_BASE_URL), "workers-ai")
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

    def test_proxy_path_on_an_untrusted_origin_never_receives_kinu_auth(self) -> None:
        hostile = "https://attacker.example/api/user/ai/v1"
        self.assertEqual(provider_for_base_url(hostile), "custom")
        with self.assertRaisesRegex(ValueError, "api_key_env"):
            resolve_bearer_token(
                hostile,
                "custom",
                environ={"KINU_EVAL_TOKEN": "must-not-leak"},
            )

    def test_no_override_widens_who_may_receive_the_credential(self) -> None:
        """Policy and trust are separate questions, and this is why.

        There is no override flag anymore. If any flag decided which origins are Kinu deployments,
        it would declare every host on earth a trusted credential sink — so
        no flag value turns a hostile proxy path into one.
        """
        hostile = "https://attacker.example/api/user/ai/v1"
        self.assertFalse(eval_target_allowed(hostile, {EVAL_ALLOW_PROD_ENV: "1"}))
        self.assertFalse(eval_target_allowed(hostile, {}))
        self.assertEqual(provider_for_base_url(hostile), "custom")
        with self.assertRaisesRegex(ValueError, "api_key_env"):
            resolve_bearer_token(
                hostile,
                "custom",
                environ={
                    "KINU_EVAL_TOKEN": "must-not-leak",
                    EVAL_ALLOW_PROD_ENV: "1",
                },
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


class EvalTargetTest(unittest.TestCase):
    """Where a scored run is allowed to go."""

    def test_the_deployment_is_allowed(self) -> None:
        url = f"{PRODUCTION_ORIGIN}/api/user/ai/v1"
        self.assertEqual(assert_eval_target(url, {}), url)

    def test_an_unknown_origin_is_refused_whatever_the_environment_carries(self) -> None:
        url = "https://attacker.example/api/user/ai/v1"
        for env in ({}, {EVAL_ALLOW_PROD_ENV: "1"}, {EVAL_ALLOW_PROD_ENV: ""}):
            with self.subTest(env=env):
                with self.assertRaises(ValueError):
                    assert_eval_target(url, env)

    def test_deployment_and_loopback_are_the_allowlist(self) -> None:
        for url in (
            f"{EVAL_DEPLOYMENT_ORIGIN}/api/user/ai/v1",
            "http://localhost:5173/api/user/ai/v1",
            "http://127.0.0.1:8787/api/user/ai/v1",
        ):
            with self.subTest(url=url):
                self.assertEqual(assert_eval_target(url, {}), url)

    def test_direct_workers_ai_is_not_a_kinu_deployment(self) -> None:
        endpoint = "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1"
        self.assertEqual(assert_eval_target(endpoint, {}), endpoint)
        for refused in (
            endpoint.replace("https:", "http:"),
            endpoint.replace("api.cloudflare.com", "api.cloudflare.com.evil.example"),
            endpoint.replace("/ai/v1", "/workers/scripts"),
        ):
            with self.subTest(url=refused), self.assertRaises(ValueError):
                assert_eval_target(refused, {})

    def test_a_near_miss_of_the_deployment_host_is_not_the_deployment(self) -> None:
        for url in (
            "https://kinu.run.evil.example/api/user/ai/v1",
            "https://evil.kinu.run/api/user/ai/v1",
            "https://staging.kinu.run/api/user/ai/v1",
            f"http://{EVAL_DEPLOYMENT_ORIGIN.removeprefix('https://')}/api/user/ai/v1",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    assert_eval_target(url, {})

    def test_an_empty_endpoint_is_refused_rather_than_defaulted(self) -> None:
        with self.assertRaisesRegex(ValueError, "must name where it goes"):
            assert_eval_target("", {})


class SourceOfTruthTest(unittest.TestCase):
    """These origins are copies of facts in ``wrangler.jsonc``.

    Read out of the deployment rather than restated, so a rename there fails here
    instead of silently pointing every benchmark at a host that is gone. Single
    environment since 2026-09-10: there is no staging block, and the one
    deployment origin is the eval target.
    """

    def test_production_origin_is_the_one_wrangler_serves_users_from(self) -> None:
        self.assertNotIn('"staging": {', WRANGLER)
        self.assertIn(f'"CLI_PUBLIC_ORIGIN": "{PRODUCTION_ORIGIN}"', WRANGLER)

    def test_the_two_languages_agree_on_the_deployment_origin(self) -> None:
        source = (
            REPO_ROOT / "packages/test-utils/src/eval-identity.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(f"EVAL_DEPLOYMENT_ORIGIN = '{EVAL_DEPLOYMENT_ORIGIN}'", source)


if __name__ == "__main__":
    unittest.main()
