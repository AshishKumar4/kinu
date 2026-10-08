# Sourced by scripts/deploy.sh: the smoke test's reads of the version this deploy made. deploy.test.ts drives them
# against a server that answers as an edge still holding an older version does.

# How long a version this deploy replaced may still answer at an edge. A new
# version reaches every edge machine over seconds: 23 s after the deploy of
# b8340eebf (2026-10-08), the reset placeholder before it answered one of its
# smoke requests (zone ray a475f77c5ae1f09e, Workers analytics), between
# requests the new version answered.
KINU_PROPAGATION_SECONDS=120

# `ours <body file> <curl arguments…>`: the response of the version this deploy
# made, which names itself in `x-kinu-version` (server.ts `published`, and the
# reset placeholder). While another version of the Worker answers, it asks again
# until the bound above; an answer that names no version, a connection that
# failed or an edge error page, is judged as it is. Sets KINU_STATUS to the
# status and KINU_ANSWERED_BY to the version that answered: called in this
# shell, never in `$(…)`, which would lose both.
ours() {
  local body="$1" headers status deadline
  shift
  headers="$(mktemp -t kinu-smoke-headers.XXXXXX)"
  deadline=$(( $(date +%s) + KINU_PROPAGATION_SECONDS ))
  while :; do
    status="$(curl -s -D "$headers" -o "$body" -w '%{http_code}' "$@" 2>/dev/null || true)"
    KINU_ANSWERED_BY="$(grep -i '^x-kinu-version:' "$headers" | tail -1 | awk '{print $2}' | tr -d '\r')"
    if [ -z "$KINU_ANSWERED_BY" ] || [ "$KINU_ANSWERED_BY" = "$KINU_VERSION" ] || [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    sleep 2
  done
  rm -f "$headers"
  KINU_STATUS="${status:-000}"
}

# The finding for a check answered by another version than this deploy's, or
# empty when this deploy's answered it.
not_ours() {
  if [ "$KINU_ANSWERED_BY" = "$KINU_VERSION" ]; then return 0; fi
  if [ -z "$KINU_ANSWERED_BY" ]; then
    printf '%s answered %s naming no version, so not as this deploy'"'"'s version %s' "$1" "$KINU_STATUS" "$KINU_VERSION"
  else
    printf '%s was still answered by version %s, not this deploy'"'"'s %s, after %ss' "$1" "$KINU_ANSWERED_BY" "$KINU_VERSION" "$KINU_PROPAGATION_SECONDS"
  fi
}
