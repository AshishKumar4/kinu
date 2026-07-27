#!/usr/bin/env bash
# Negative regression gate for the Lean corpus.
#
# scratch-verification/Boom.lean contains machine-checked proofs of `False`
# derived from axioms that once lived in this library (the unsound IEEE-754
# Float axioms of Safety/FloatAxioms.lean and the false String-based
# chunk_reassembly axiom — all removed in WP-F2). It must NEVER compile:
# if it does, someone reintroduced a convenient axiom and the corpus is
# inconsistent again (every theorem becomes vacuously derivable).
#
# Exits 0 only when (1) the library itself builds AND (2) Boom.lean fails to
# compile. Step (1) prevents a vacuous pass when the whole build is broken.
set -u
cd "$(dirname "$0")"

LAKE="${LAKE:-lake}"
command -v "$LAKE" >/dev/null 2>&1 || LAKE="$HOME/.elan/bin/lake"

if ! "$LAKE" build; then
  echo "check-no-false: FAIL — the Proteus Lean library does not build." >&2
  exit 1
fi

if "$LAKE" env lean scratch-verification/Boom.lean >/dev/null 2>&1; then
  echo "check-no-false: FAIL — scratch-verification/Boom.lean compiled: proofs of False are derivable; the Lean corpus is inconsistent." >&2
  exit 1
fi

echo "check-no-false: OK — Boom.lean does not compile (no False derivable from the removed axioms)."
