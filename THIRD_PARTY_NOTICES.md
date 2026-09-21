# Third-party notices

## Plannotator UI

Kinu includes components from `@plannotator/ui` 0.30.0, part of
[Plannotator](https://github.com/backnotprop/plannotator), copyright 2025
backnotprop. Kinu distributes those components under the MIT License. The
required copyright notice and license text sit in
[`third_party/plannotator-LICENSE-MIT`](third_party/plannotator-LICENSE-MIT).

## Mossaic SDK

Kinu builds `@mossaic/sdk` from vendored source of
[Mossaic](https://github.com/AshishKumar4/Mossaic), copyright 2026 Ashish
Kumar, pinned at commit `1bf170e0`. The source sits under
[`third_party/mossaic`](third_party/mossaic) with a digest per file in
[`third_party/mossaic/upstream.json`](third_party/mossaic/upstream.json).

Mossaic states the MIT License in `sdk/package.json` and in `sdk/README.md`.
It carries no LICENSE file at this commit: its `README.md` links `./LICENSE`
and that path does not exist in the tree. So there is no upstream copyright
text to reproduce here, and Kinu does not write one on the author's behalf.
