#!/bin/sh
# scratch enumeration helper for this slice
cd /home/mrwhite0racle/Proteus/.claude/worktrees/observability || exit 1
P="packages/cf-backend"
./node_modules/.bin/oxlint -c .oxlintrc.json -f json \
  $P/src/actor-agent.ts \
  $P/src/exploration.ts \
  $P/src/facet-spawn.ts \
  $P/src/runtime.ts \
  $P/src/crafted-tool-registry.ts \
  $P/src/gallery.tsx \
  $P/scripts/smoke-workspace.ts \
  $P/scripts/workers-ai-rest-poc.ts \
  $P/tests/unit-owned-model-services.test.ts \
  $P/tests/unit-install-script.test.ts \
  2>/dev/null \
  | sed -n '/^{ "diagnostics"/,/^}$/p' \
  | jq -r '.diagnostics[] | select(.code|test("no-empty-catch|no-sentinel-catch|require-cause-on-rethrow|no-ddl-in-catch")) | "\(.filename):\(.labels[0].span.line) \(.code)"'
