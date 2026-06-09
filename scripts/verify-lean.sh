#!/usr/bin/env bash
# Verify Lean proofs compile and check for TS interface drift.
# Run: bun run verify:lean
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

MANIFEST="lean/generated/.ts-checksums"

# Check TS interface drift
echo -e "${YELLOW}Checking TS interface checksums...${NC}"
CURRENT=$(cat \
  packages/core/src/types/primitives.ts \
  packages/core/src/types/agent-runtime.ts \
  packages/core/src/types/craft.ts \
  packages/core/src/evolution/types.ts \
  packages/core/src/config.ts \
  2>/dev/null | sha256sum | cut -d' ' -f1)

if [ -f "$MANIFEST" ]; then
  STORED=$(cat "$MANIFEST")
  if [ "$CURRENT" != "$STORED" ]; then
    echo -e "${RED}TS interfaces changed since Lean types were generated.${NC}"
    echo "  Current: $CURRENT"
    echo "  Stored:  $STORED"
    echo -e "${RED}Regenerate with TSLean, update generated Lean, and update the manifest:${NC}"
    echo "  echo \"$CURRENT\" > $MANIFEST"
    exit 1
  else
    echo -e "${GREEN}TS checksums match.${NC}"
  fi
else
  echo -e "${RED}No checksum manifest found at $MANIFEST.${NC}"
  echo "Regenerate Lean types and commit the manifest."
  exit 1
fi

# Check elan/lake availability
if ! command -v lake &> /dev/null; then
  echo -e "${RED}lake not found. Install elan: https://leanprover.github.io/lean4/doc/setup.html${NC}"
  exit 1
fi

# Build
echo -e "\n${YELLOW}Running lake build...${NC}"
cd lean
lake build

# Sorry check
SORRIES=$(grep -rn '\bsorry\b' Proteus/ --include='*.lean' | grep -v '^\-\-' | grep -v '0 sorry' | wc -l || true)
if [ "$SORRIES" -gt 0 ]; then
  echo -e "\n${RED}Found $SORRIES sorry placeholder(s):${NC}"
  grep -rn '\bsorry\b' Proteus/ --include='*.lean' | grep -v '^\-\-' | grep -v '0 sorry'
  exit 1
else
  echo -e "\n${GREEN}All proofs verified — zero sorry.${NC}"
fi
