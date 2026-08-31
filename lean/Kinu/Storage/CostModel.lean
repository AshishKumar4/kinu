/-
  Kinu.Storage.CostModel — the counted resources. 0 sorry.

  Vocabulary is DurableFsResearch §3, bound here so the two strategy
  files cannot drift from it:

    n = total tree bytes / paths
    p = pending change since the last tick
    c = cumulative changed-set since the base
    L = layer count, ≤ 2 on the shipped chain

  Counted: R2 class-A ops, class-B ops, bytes staged or uploaded, journal
  entries scanned, layers mounted.

  Lean proves the complexity class of the modelled algorithm. It does not
  prove wall-clock. The deployed bench owns constants.

  -- WHAT THIS ABSTRACTION KEEPS: the five counters and the four size names.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. WALL-CLOCK AND PLATFORM LATENCY. A class-A op is one request, not a
     millisecond. The danger of a slow request lives in the bench.

  2. COMPRESSION AND MULTIPART THRESHOLDS. A squashfs may be smaller than
     the upper; a multipart PUT is still one logical class-A here. The
     bench owns the ratio. `SINGLE_PUT_MAX_BYTES` is 8 MiB
     (`object-store.ts`); tick class-A is therefore O(p / 8 MiB) in the
     overlay model, written as `newBlobs` rather than as a byte quotient
     so the proofs stay in Nat.
-/

namespace Kinu.Storage.CostModel

/-- One accounted operation. `classA` is write-class (PUT, LIST, DELETE);
    `classB` is read-class (GET, HEAD).

    The size parameters are NOT a record here. Each strategy's cost is a
    function of the parameters that strategy actually reads, and taking a
    parameter it must then be proved to IGNORE is what makes the ignoring
    checkable — see `SnapshotChain.attachCostAt` and
    `OverlayCas.hotPathCost`. A single record passed everywhere would make
    every cost mention every parameter and the independence claims
    unstateable. -/
structure Cost where
  classA : Nat
  classB : Nat
  bytes : Nat
  journalScanned : Nat
  layersMounted : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

def Cost.add (x y : Cost) : Cost :=
  { classA := x.classA + y.classA
    classB := x.classB + y.classB
    bytes := x.bytes + y.bytes
    journalScanned := x.journalScanned + y.journalScanned
    layersMounted := x.layersMounted + y.layersMounted }

end Kinu.Storage.CostModel
