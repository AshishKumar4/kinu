# Vendored engine provenance

> This document is edited and maintained by Claude and presented as-is.

`src/engine/` is the neutral context-pruning ladder core vendored from:

- **Repo:** `git@github.com:AshishKumar4/opencode-better-compact.git`
- **Path:** `packages/core/src/` (all eleven files)
- **Commit:** `ee34ee90fadb6dc44b833d8eb6918c39fa9939e5`

Every file is byte-identical to upstream **except `identity.ts`**, which carries
the single unavoidable modification:

## The one modification — `identity.ts` hash swap

Upstream digests through `node:crypto` `createHash` (`sha256`/`sha1`), which is
not loadable in Cloudflare Workers. The swap replaces the `node:crypto` import
with `@proteus/core`'s pure-JS `fnv1a64` and rewrites exactly the three digest
expressions (output widths preserved — `fnv1a64` yields the same 16 hex chars
as upstream's `.slice(0, 16)`):

| Function | Upstream | Here |
|---|---|---|
| `rangeHash` | `createHash("sha256").update(seed).digest("hex").slice(0, 16)` | `fnv1a64(seed)` |
| `assistantRunKey` | `createHash("sha256").update(seed).digest("hex").slice(0, 16)` | `fnv1a64(seed)` |
| `syntheticTextKey` | `createHash("sha1").update(text).digest("hex").slice(0, 8)` | `fnv1a64(text).slice(0, 8)` |
| `contentHashKey` | `createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16)` | `fnv1a64(stableStringify(payload))` |

Why 64-bit FNV-1a is enough: these hashes guard *accidental* divergence
(an edited prefix invalidating a cached plan; duplicate payloads within one
session's history), never adversarial input. Per-session populations are
thousands of turns at most, so birthday-collision odds at 64 bits are
negligible — and both failure modes fail safe (a `rangeHash` mismatch rebuilds
the plan; a `contentHashKey` collision dedupes deterministically via
`keyDeduper` and at worst also falls back to a rebuild). Using core's existing
`fnv1a64` also keeps Proteus on one hash implementation (the same fingerprint
behind the ephemeral-context ledger and prompt byte-stability telemetry).

## Re-syncing

The package's tsconfig inherits `"moduleResolution": "bundler"` from
`tsconfig.base.json`, so upstream's extensionless relative imports
(`from "./ir"`) need no edits. To re-sync: copy `packages/core/src/*.ts` from
the new upstream commit over `src/engine/`, re-apply the `identity.ts` hash
swap above, and update the commit hash here. The diff against upstream must
remain exactly the table above.
