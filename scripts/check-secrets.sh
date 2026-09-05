#!/usr/bin/env bash
# Pre-commit secret scan — run before committing to catch leaks locally.
#
# Install as a git hook:
#   cp scripts/check-secrets.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or run manually:
#   bash scripts/check-secrets.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PATTERNS=(
  # Bearer tokens with real-looking values (40+ chars)
  'Bearer\s+[A-Za-z0-9_-]{30,}'
  # Cloudflare AI Gateway auth in source
  'cf-aig-authorization.*[A-Za-z0-9_-]{30,}'
  # AWS access keys
  'AKIA[A-Z0-9]{16}'
  # Private keys
  '-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY'
  # Generic secret assignments with literal values
  '(password|secret_key|api_key|api_secret|auth_token)\s*[:=]\s*"[A-Za-z0-9_/+=-]{12,}"'
  # Connection strings with embedded passwords
  '(mongodb|postgres|mysql|redis)://[^:]+:[^@]{8,}@'
)

EXCLUDE_PATTERNS=(
  '\.env\.example'
  '\.secretscanignore'
  'process\.env\.'
  '<your-'
  'check-secrets\.sh'
)

COMBINED_PATTERN=$(IFS='|'; echo "${PATTERNS[*]}")
EXCLUDE_COMBINED=$(IFS='|'; echo "${EXCLUDE_PATTERNS[*]}")

# If running as pre-commit hook, scan staged diff only
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git diff --cached --name-only)" ]; then
  DIFF=$(git diff --cached --diff-filter=ACMR -U0)
  SOURCE="staged changes"
else
  DIFF=$(git diff HEAD -U0 2>/dev/null || cat /dev/null)
  SOURCE="working tree"
fi

if [ -z "$DIFF" ]; then
  echo -e "${GREEN}No changes to scan.${NC}"
  exit 0
fi

MATCHES=$(echo "$DIFF" | grep -Pn "$COMBINED_PATTERN" 2>/dev/null | grep '^\+' | grep -v '^\+\+\+' | grep -Ev "$EXCLUDE_COMBINED" || true)

if [ -n "$MATCHES" ]; then
  echo -e "${RED}Potential secret detected in ${SOURCE}:${NC}"
  echo ""
  echo "$MATCHES" | head -20
  echo ""
  echo -e "${YELLOW}If these are false positives, add to .secretscanignore${NC}"
  exit 1
fi

echo -e "${GREEN}No secrets detected in ${SOURCE}.${NC}"
exit 0
