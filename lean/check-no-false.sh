#!/usr/bin/env bash
# Negative regression gate for the Lean corpus.
#
# `scratch-verification/` holds machine-checked proofs of `False` derived from
# axioms that once lived in this library. Each must NEVER compile: if one does,
# someone reintroduced a convenient axiom and the corpus is inconsistent again
# (every theorem in it becomes vacuously derivable).
#
# ONE FILE PER AXIOM FAMILY, and that is the substance of this gate rather than
# tidiness. All four counterexamples used to sit in a single `Boom.lean` behind
# two imports, and `Kinu/Safety/FloatAxioms.lean` no longer exists — so
# `lake env lean` failed at that import and elaborated NOTHING after it. The
# chunk_reassembly counterexample, whose subject module is still present and
# still exports a `chunk_reassembly`, was therefore unreachable: a reintroduced
# String-based axiom would have derived `False` and this gate would still have
# printed OK, on the strength of an import error about an unrelated family. One
# family's absence was masking every family behind it.
#
# THE EXPECTED FAILURE IS DECLARED PER FAMILY. "It did not compile" is satisfied
# by a reintroduced axiom's absence, by a typo, by a renamed lemma, by a syntax
# error left behind while editing, and by a probe pointed at a file that no
# longer exists. Only the first is evidence. So each family carries the
# diagnostic its probe is expected to fail with, and a failure that does not
# match is reported as a STALE PROBE — the gate fails naming the family, because
# a negative proof nobody can still read is not a negative proof.
#
# AND A POSITIVE CONTROL, because every assertion here is of the form "the
# compiler said no", which a broken harness produces for free: a wrong working
# directory, a moved `$ELAN_HOME`, a `lake env lean` that cannot find the
# library. `lake build` succeeding does not cover that — `lake env lean <file>`
# is a different invocation with a different search path, and it is the one the
# probes use. `scratch-verification/Control.lean` must COMPILE through exactly
# that invocation first.
#
# Exits 0 only when (1) the library builds, (2) the control compiles, (3) every
# family probe fails, and (4) each failure is the diagnostic that family
# declares. (1) prevents a vacuous pass when the whole build is broken; (2)
# prevents one when the harness is; (4) prevents one when the probe is.
set -u
cd "$(dirname "$0")"

LAKE="${LAKE:-lake}"
command -v "$LAKE" >/dev/null 2>&1 || LAKE="$HOME/.elan/bin/lake"

PROBE_DIR=scratch-verification
CONTROL="$PROBE_DIR/Control.lean"

# ── THE FAMILIES, as three parallel arrays ────────────────────────────────────
#
# One row per axiom family: its name, its probe, and the diagnostic that probe is
# expected to fail with. The pattern is an ERE matched against the compiler's
# output with newlines collapsed to spaces, because Lean spreads one error over
# several lines and a line-oriented match could only see a fragment of it.
#
# Each pattern accepts every honest way the family can be absent and nothing
# else. For the Float family that is the deleted module OR the three axiom names
# being unknown inside a module somebody re-added without them. For chunk
# reassembly it is the current TRUE theorem refusing the old application — it
# takes a `Nat` where the false axiom took a `String` — or the name being gone
# outright. A `native_decide` that stopped refuting, an unsolved goal, a parse
# error: none of those match, and none of them are evidence that an axiom is
# still absent.
FAMILY_NAMES=(
  'float axioms'
  'chunk reassembly'
)
FAMILY_PROBES=(
  "$PROBE_DIR/BoomFloatAxioms.lean"
  "$PROBE_DIR/BoomChunkReassembly.lean"
)
FAMILY_EXPECTED=(
  "module Kinu\.Safety\.FloatAxioms does not exist|unknown (identifier|constant) '(Kinu\.Safety\.FloatAxioms\.)?float_(add_zero|div_mul_cancel|zero_div)'"
  "application type mismatch +Kinu\.Storage\.SqliteFSCorrectness\.chunk_reassembly|unknown (identifier|constant) '(Kinu\.Storage\.SqliteFSCorrectness\.)?chunk_reassembly'"
)

# ── (0) EVERY PROBE FILE IS DECLARED ──────────────────────────────────────────
#
# A `.lean` in this directory that is neither the control nor a declared family
# is a negative proof nobody runs — the same shape as the masked probe above,
# arrived at from the other direction. Refused rather than ignored.
DECLARED=("$CONTROL" "${FAMILY_PROBES[@]}")
UNDECLARED=()
for candidate in "$PROBE_DIR"/*.lean; do
  [[ -e "$candidate" ]] || continue
  found=0
  for declared in "${DECLARED[@]}"; do
    [[ "$candidate" == "$declared" ]] && found=1 && break
  done
  [[ $found -eq 0 ]] && UNDECLARED+=("$candidate")
done
if [[ ${#UNDECLARED[@]} -gt 0 ]]; then
  echo "check-no-false: FAIL — ${#UNDECLARED[@]} probe file(s) in $PROBE_DIR are not declared in" \
    "FAMILY_PROBES and are run by nothing: ${UNDECLARED[*]}. Add the family (name, probe, expected" \
    "diagnostic) or delete the file." >&2
  exit 1
fi
for probe in "${DECLARED[@]}"; do
  if [[ ! -f "$probe" ]]; then
    echo "check-no-false: FAIL — declared probe $probe does not exist. A missing file 'fails to" \
      "compile' for free, which is how a probe pointed at nothing passes this gate." >&2
    exit 1
  fi
done

# ── (1) THE LIBRARY BUILDS ────────────────────────────────────────────────────
if ! "$LAKE" build; then
  echo "check-no-false: FAIL — the Kinu Lean library does not build." >&2
  exit 1
fi

# ── (2) THE HARNESS CAN TELL YES FROM NO ──────────────────────────────────────
if ! CONTROL_OUT="$("$LAKE" env lean "$CONTROL" 2>&1)"; then
  echo "check-no-false: FAIL — the positive control $CONTROL does not compile, so every 'this" \
    "probe failed' verdict below would be free. This is a harness fault, not a corpus one:" \
    "\`lake env lean\` cannot elaborate a trivial file against the built library." >&2
  echo "$CONTROL_OUT" >&2
  exit 1
fi

# ── (3) AND (4) EVERY FAMILY FAILS, FOR ITS OWN DECLARED REASON ───────────────
STATUS=0
for index in "${!FAMILY_NAMES[@]}"; do
  name="${FAMILY_NAMES[$index]}"
  probe="${FAMILY_PROBES[$index]}"
  expected="${FAMILY_EXPECTED[$index]}"
  if OUTPUT="$("$LAKE" env lean "$probe" 2>&1)"; then
    echo "check-no-false: FAIL — $probe COMPILED: proofs of False are derivable from the $name" \
      "family, so the Lean corpus is inconsistent and every theorem in it is vacuous. Someone" \
      "reintroduced an axiom this probe was written against." >&2
    STATUS=1
    continue
  fi
  # Newlines to spaces and runs of whitespace to one: Lean prints one error over
  # several lines, and the family's identity is on a different line from the kind
  # of error it is.
  FLAT="$(printf '%s' "$OUTPUT" | tr '\n' ' ' | tr -s ' ')"
  if ! printf '%s' "$FLAT" | grep -Eq "$expected"; then
    echo "check-no-false: FAIL — $probe failed, but NOT with the diagnostic the $name family" \
      "declares. A stale probe: it no longer tests what it claims, and 'it did not compile' is" \
      "satisfied by a typo as readily as by an absent axiom." >&2
    echo "  expected (ERE): $expected" >&2
    echo "  got:            $FLAT" >&2
    STATUS=1
    continue
  fi
  echo "check-no-false: $name — probe fails with its declared diagnostic."
done

if [[ $STATUS -ne 0 ]]; then exit "$STATUS"; fi

echo "check-no-false: OK — control compiles, ${#FAMILY_NAMES[@]} axiom families each refuted by a" \
  "probe that fails for its own declared reason."
