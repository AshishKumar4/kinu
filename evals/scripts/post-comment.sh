#!/usr/bin/env bash
# Post a comment about a deployed build: on the pull request that merged it, else on the commit.
# This workflow's earlier comments there that start with the marker, or with any further marker
# named (comments the new one supersedes), are deleted first, so the latest is the only one.
# GH_TOKEN and GH_REPO come from the environment.
#   evals/scripts/post-comment.sh <sha> <body-file> <marker> [<superseded-marker>...]
set -euo pipefail

sha="$1"
body="$2"
shift 2

pr=$(gh api "repos/$GH_REPO/commits/$sha/pulls" --jq '[.[] | select(.merged_at != null)][0].number // empty')

if [[ -n "$pr" ]]; then
  comments="repos/$GH_REPO/issues/$pr/comments"
  one="repos/$GH_REPO/issues/comments"
else
  comments="repos/$GH_REPO/commits/$sha/comments"
  one="repos/$GH_REPO/comments"
fi

for marker in "$@"; do
  MARKER="$marker" gh api --paginate "$comments?per_page=100" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith(env.MARKER))) | .id' |
    while read -r id; do
      gh api --method DELETE "$one/$id" > /dev/null
    done
done

gh api --method POST "$comments" -F body=@"$body" > /dev/null

if [[ -n "$pr" ]]; then echo "Posted on pull request #$pr"; else echo "Posted on commit $sha"; fi
