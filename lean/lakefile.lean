import Lake
open Lake DSL

package kinu where
  leanOptions := #[
    ⟨`autoImplicit, false⟩
  ]

@[default_target]
lean_lib Kinu where
  roots := #[`Kinu, `Kinu.Axioms]
