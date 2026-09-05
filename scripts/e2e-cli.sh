#!/usr/bin/env bash
# Kinu CLI E2E tests — exercises the CLI commands against a local agent DB.
# Tests create, list, status, export, and import via direct module imports
# rather than through the TUI.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"
exec bun run scripts/cli-test-runner.ts
