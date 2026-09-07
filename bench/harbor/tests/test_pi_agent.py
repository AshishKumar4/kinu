"""Credential-reference and model-metadata regressions; stdlib-only.

The real pi CLI / Harbor reader integration is a separate local smoke. This
suite does not mock Harbor's run method or make ordinary CI install Harbor.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from bench.model_endpoint import (
    DEFAULT_WORKERS_AI_MODEL_ID,
    PI_COMPARATOR_PROVIDER,
    pi_provider_config,
)


class ComparatorEndpointTest(unittest.TestCase):
    def test_command_backed_key_reads_a_quoted_path_without_embedding_the_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token with ' quote; and spaces"
            path.touch(mode=0o600)
            path.write_text("fixture-only-secret", encoding="utf-8")
            config = pi_provider_config("http://127.0.0.1:9/v1", DEFAULT_WORKERS_AI_MODEL_ID, path)
            self.assertNotIn("fixture-only-secret", json.dumps(config))
            key = config["providers"][PI_COMPARATOR_PROVIDER]["apiKey"]
            # pi's documented !command form; exercise the referenced command.
            result = subprocess.run(key[1:], shell=True, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "fixture-only-secret")

    def test_another_model_cannot_be_stamped_with_glm53_metadata(self) -> None:
        with self.assertRaises(ValueError):
            pi_provider_config("http://127.0.0.1:9/v1", "@cf/zai-org/glm-5.2", Path("token"))


if __name__ == "__main__":
    unittest.main()
