import Lake
open Lake DSL

package proteus where
  leanOptions := #[
    ⟨`autoImplicit, false⟩
  ]

@[default_target]
lean_lib Proteus where
  roots := #[`Proteus, `Proteus.Axioms]
