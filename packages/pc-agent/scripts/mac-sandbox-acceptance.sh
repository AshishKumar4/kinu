#!/usr/bin/env bash
# The macOS half of the device sandbox, measured on a Mac.
#
# Everything about the Linux sandbox is proved by running it. On macOS the
# enforcer is `/usr/bin/sandbox-exec` with a generated SBPL profile, and this
# machine cannot run that — so the profile GENERATOR is asserted as text in
# `packages/pc-agent/tests/sandbox.test.js` and the behaviour is unproved until
# this script runs on a Mac.
#
# It answers four questions, and prints what it measured rather than a verdict
# it inferred:
#   1. Does sandbox-exec accept the generated profile at all?
#   2. Does the deny of /Users, re-allowed for the agent home, actually hide the
#      owner's files? (SBPL takes the LAST matching rule; that ordering is the
#      whole mechanism and is unmeasured until here.)
#   3. Do writes land in the agent home and the consented directory, and nowhere
#      else?
#   4. Does Metal work? The iokit/mach-lookup class list in sandbox.js is a
#      STARTING set taken from public GPU-sandbox profiles, not a claim. Every
#      `deny` line the sandbox logger prints during the probes below is a class
#      that has to be added to it.
#
# Usage, from the repository root on a Mac:
#
#   bash packages/pc-agent/scripts/mac-sandbox-acceptance.sh
#
# It writes nothing outside its own scratch directory and installs nothing.
# Paste the whole final block back.
set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script measures the macOS sandbox and must run on a Mac; this is $(uname -s)."
  exit 64
fi

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRATCH="$(mktemp -d /tmp/kinu-mac-acceptance.XXXXXX)"
AGENT_HOME="$SCRATCH/agents/ws-1/home"
AGENT_TMP="$SCRATCH/agents/ws-1/tmp"
CONSENTED="$SCRATCH/consented"
PLANTED="$HOME/.kinu-mac-acceptance-planted"
DENY_LOG="$SCRATCH/sandbox-denials.log"
mkdir -p "$AGENT_HOME" "$AGENT_TMP" "$CONSENTED"
chmod 700 "$AGENT_HOME" "$AGENT_TMP"

cleanup() {
  [ -n "${LOGGER_PID:-}" ] && kill "$LOGGER_PID" 2>/dev/null
  rm -f "$PLANTED"
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

results=()
record() { results+=("$1"); }

# ── 1. The suite, and the darwin-only half of it ─────────────────────
echo "== running the daemon suites (the generator, the probe, the policy) =="
if (cd "$REPO" && bun test packages/pc-agent/ 2>&1 | tail -4); then
  record "daemon suites: green"
else
  record "daemon suites: RED — paste the output above"
fi

# ── 2. The probe's own answer on this machine ────────────────────────
echo
echo "== what this machine reports it can do =="
PROBE="$(cd "$REPO" && bun -e '
const sandbox = require("./packages/pc-agent/src/sandbox.js");
const probe = sandbox.probe();
console.log(JSON.stringify({ probe, hello: sandbox.helloCapability(probe) }));
' 2>&1)"
echo "$PROBE"
record "probe: $PROBE"

# ── 3. Behaviour, through the real enforcer ──────────────────────────
# The plan comes from the same `plan()` the daemon spawns, so what is measured
# is the shipped policy and not a hand-written profile.
echo
echo "== the owner's files, the agent home, and the consented directory =="
printf 'owner-private-material' > "$PLANTED"
chmod 600 "$PLANTED"

# The sandbox logger records every refusal the kernel makes, which is how the
# Metal class list below is completed. Started before the probes.
log stream --style compact --predicate 'sender == "Sandbox"' > "$DENY_LOG" 2>/dev/null &
LOGGER_PID=$!
sleep 2

run_sandboxed() {
  (cd "$REPO" && AGENT_HOME="$AGENT_HOME" AGENT_TMP="$AGENT_TMP" CONSENTED="$CONSENTED" \
    KINU_COMMAND="$1" bun -e '
const sandbox = require("./packages/pc-agent/src/sandbox.js");
const { spawnSync } = require("node:child_process");
const plan = sandbox.plan({
  tier: "sandboxed",
  platform: "darwin",
  home: process.env.HOME,
  agentHome: process.env.AGENT_HOME,
  agentTmp: process.env.AGENT_TMP,
  deviceHome: `${process.env.HOME}/.kinu`,
  roots: [process.env.CONSENTED],
  cwd: process.env.AGENT_HOME,
  command: process.env.KINU_COMMAND,
  source: process.env,
});
const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: "utf8" });
process.stdout.write(`exit=${run.status}\n${run.stdout ?? ""}${run.stderr ?? ""}`);
' 2>&1)
}

READ_OWNER="$(run_sandboxed "cat \"$PLANTED\" 2>&1 | head -2")"
echo "-- reading the planted secret --"; echo "$READ_OWNER"
case "$READ_OWNER" in
  *owner-private-material*) record "planted secret: READABLE — the /Users deny is not holding" ;;
  *) record "planted secret: refused" ;;
esac

WRITES="$(run_sandboxed 'printf agent > "$HOME/mine" && echo agent-home-write-ok; printf root > '"$CONSENTED"'/mine && echo consented-write-ok; touch /usr/local/kinu-nope 2>&1 | head -1')"
echo "-- writes --"; echo "$WRITES"
case "$WRITES" in
  *agent-home-write-ok*consented-write-ok*) record "writes: agent home ok, consented ok" ;;
  *) record "writes: FAILED — paste the block above" ;;
esac
if [ -f /usr/local/kinu-nope ]; then
  record "write outside the roots: LANDED — the profile is not confining writes"
  rm -f /usr/local/kinu-nope
else
  record "write outside the roots: refused"
fi

BASHISM="$(run_sandboxed 'set -o pipefail; [[ 1 == 1 ]] && printf %s "bash=${BASH_VERSION%%.*}"')"
echo "-- bash-only syntax --"; echo "$BASHISM"
case "$BASHISM" in *bash=*) record "bash: $BASHISM" ;; *) record "bash: FAILED — $BASHISM" ;; esac

# ── 4. Metal, which decides the iokit/mach-lookup class list ─────────
echo
echo "== Metal =="
echo "Each probe needs its toolchain in the agent home; the first run installs it."
METAL_TORCH="$(run_sandboxed '
  command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
  export PATH="$HOME/.local/bin:$PATH"
  uv venv >/dev/null 2>&1
  uv pip install --quiet torch >/dev/null 2>&1
  uv run python -c "import torch;x=torch.ones(4,device=\"mps\");print(\"mps-sum\", (x*2).sum().item())" 2>&1 | tail -3
')"
echo "-- torch mps --"; echo "$METAL_TORCH"
case "$METAL_TORCH" in *mps-sum\ 8*) record "torch MPS: green" ;; *) record "torch MPS: not green — see the deny lines below" ;; esac

sleep 2
kill "$LOGGER_PID" 2>/dev/null
LOGGER_PID=""

DENIALS="$(grep -E 'deny\(1\)' "$DENY_LOG" 2>/dev/null \
  | grep -Eo '(iokit-open [^ ]+|mach-lookup [^ ]+|file-[a-z*-]+ [^ ]+)' \
  | sort -u | head -40)"

echo
echo "================ PASTE FROM HERE ================"
echo "kinu mac sandbox acceptance — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "macOS $(sw_vers -productVersion) on $(uname -m); sandbox-exec: $([ -x /usr/bin/sandbox-exec ] && echo present || echo ABSENT)"
for line in "${results[@]}"; do echo "  - $line"; done
echo
if [ -n "$DENIALS" ]; then
  echo "  sandbox denials observed (each one is a class to add to sandbox.js):"
  echo "$DENIALS" | sed 's/^/    /'
else
  echo "  sandbox denials observed: none"
fi
echo "================ PASTE TO HERE =================="
