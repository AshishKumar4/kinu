/-
  POSITIVE CONTROL for `check-no-false.sh`. This file must ALWAYS compile.

  Every other file in this directory is asserted to FAIL, and "the compiler said
  no" is a verdict a broken harness produces for free: a `lake env lean` that
  cannot find the library, a wrong working directory, an `$ELAN_HOME` that moved,
  a probe path that no longer exists — each makes every probe "fail" and the gate
  report OK over nothing. `lake build` succeeding does not cover it, because
  `lake env lean <file>` is a different invocation with a different search path,
  and it is the one the probes use.

  So this compiles, against the same imports the probes reach for, through the
  same invocation. It asserts nothing about the corpus and is deliberately
  trivial: its only job is to prove the harness can tell yes from no.
-/

import Kinu.Storage.SqliteFSCorrectness

theorem control_compiles : 1 + 1 = 2 := rfl

/-- The probes reach into this namespace, so the control does too: a control that
    imported nothing would still pass if the library were unreachable. -/
example (bytes : List UInt8) :
    Kinu.Storage.SqliteFSCorrectness.chunkCount bytes.length 1 = bytes.length := by
  unfold Kinu.Storage.SqliteFSCorrectness.chunkCount
  omega
