# The deploy ladder: speed without holes

I run the deploy ladder many times a day, and on 2026-09-15 I ran it seven
times for one-file fixes. Every attempt re-ran all 66 pre-publish gates,
5,184 declared seconds of work at width 6 with no cache. This document is the
contract for making that fast without letting a stale green through.

`scripts/ladder.ts` stays the one source of truth. `scripts/deploy.sh` mirrors
it and `scripts/deploy.test.ts` proves the mirror. Tier membership and the set
of required gates do not change here; what changes is which gates are
re-executed, in what order, how wide, and when the run stops.

## The never-cache rule

A gate is skipped only on a proof that nothing it can read has changed. That
proof is a content hash over the gate's input closure. Four things can never
have that proof and are never skipped:

1. A gate whose row declares `inputs: { kind: 'live' }`. These touch a
   network, a deployed build, a live platform, a clock-dependent measurement,
   or an environment credential: preflight, hammer, infra, first-run,
   trajectory, the evals. The runner reads the declaration; it never matches
   on a name.
2. A gate whose closure cannot be computed: a shell gate (`bash …`), a
   script body the resolver does not understand, a module graph with a
   computed `import(name)`, or an import that resolves to no file.
3. A gate whose graph has an effect the walker cannot bound: a file in the
   graph that opens the tree by path, spawns a process, or enumerates the
   environment (`Object.entries(process.env)`, `{ ...process.env }`) while
   the row declares no `reads`. The walker names the file; the fix is a
   `reads` declaration on the row, which is an input added to the closure,
   never an exemption, and `--audit-closure` is how that declaration is
   checked against what the gate really opens.
4. A gate whose closure holds a generated or untracked artifact
   (`dist/`, `.wrangler/`, a bundle a script writes): the tree cannot name
   the bytes, so no hash can stand for them.

The import closure alone does not prove all inputs. It proves the module
graph; every other input is either declared on the row and audited, or the
gate is uncacheable.

A red result is never recorded. A recorded entry names the gate, the revision
it was proved on, its wall seconds, the closure size and the tool versions.
Nothing expires by time; an entry is either the hash of the tree you have or
it is not consulted.

## The closure, derived

For a `bun test <files>` gate the closure is:

- the files bun would execute, resolved by the same `claims()` the tier is
  measured with, so the set that runs and the set that is hashed are one set;
- the transitive import graph from those files, over every parseable
  tracked file, following value imports, type imports, re-exports and literal
  dynamic imports. Type imports are followed on purpose: a miss is cheap and
  a hole is not;
- every asset an import names (`.md` as text, `.json`, `.css`, `.svg`,
  `.wgsl`) as a hashed leaf;
- a workspace package the walker cannot enter (the vendored
  `packages/agent-core`, whose exports map is conditional) as every tracked
  file under it;
- the test preload named by `bunfig.toml`, and `bunfig.toml` itself;
- every `package.json` and `tsconfig*.json` on the directory path of any
  closure file;
- `bun.lock` and `patches/`, standing in for `node_modules`;
- the whole tracked corpus when `scripts/sources.ts` is in the graph, since
  every corpus gate reads the tree through it;
- the row's declared `reads`, expanded against the tracked corpus, or the
  whole corpus when the row declares `corpus: true` because the audit shows
  the suite scanning the tree by path (a `reads` list there would be a
  hand-kept allowlist over the corpus);
- the values of every environment variable the graph names as a literal
  (`process.env.NAME`) plus the row's declared `env` names;
- the toolchain: bun, node, typescript, oxlint, wrangler, vitest versions and
  the platform triple.

For a `bun scripts/<gate>.ts` gate the closure is the script's graph under
the same rules. A `bun run <script>` gate resolves its body through
`package.json` word by word: `bun test`, `bun scripts/…`, `node …` walk;
`tsc --noEmit -p` and `oxlint` are corpus reads; `vitest run --root R` walks
the selected files and reads `R/`; anything else is uncomputable.

The walker is the one `scripts/client-graph.ts` already uses, moved to
`scripts/import-graph.ts` so there is one resolver for every gate that reads
the graph.

## Proving the closure against what the gate really opens

A declared `reads` is a claim. `bun scripts/ladder.ts --audit-closure
--tier=<tier>` runs every cacheable gate under `strace -f -e openat,execve`
and reports every file under the tree the gate opened that its closure does
not carry. That audit is how a `reads` declaration is written, and it is the
red direction of the cache proof: an undeclared read is a finding, never a
warning. Run on the push tier on 2026-09-15: 32 gates audited, 0 undeclared
reads, after its first pass caught `gate:scanner-bundle` reading two files
off its graph.

## Measured

Push tier on the 24-thread workstation, 2026-09-15. At 8a151ec0d (load 0.6):
cold 429.6 s, 0 hits, 32 recorded, 15 never cached; warm 301.3 s, 32 hits.
At d1aa2e0d6 (load 5.1), after the computed-import, child-environment and
check/test split commits: cold 434.8 s, 0 hits, 42 recorded, 8 never cached;
warm 194.9 s, 42 hits. At 8cd49f535 (load 5.3), after the two scanning
suites declared the corpus: cold 434.5 s, 44 recorded, 6 never cached; warm
112.2 s, 44 hits. The never-cached rows and the one cause each names are in
`docs/ARCHITECTURE-DECISIONS.md` L2.

## Blind spots, printed on the green path

- `node_modules` is trusted to match `bun.lock` and `patches/`;
  `gate:patch-parity` is the gate for that.
- An environment variable read through a computed key or a spread is not an
  input the key sees; only literal names and declared names are hashed.
- A file read by a path the walker cannot see and the audit has not been run
  against is a hole until `--audit-closure` has been run on that gate. The
  audit itself does not judge `.git`, `node_modules` or `__pycache__`
  bytecode: the first is how the corpus is asked, the second stands behind
  the lock, the third is a gitignored derivative of a source the closure
  holds.
- Reads outside the tree (`$HOME` state, `/etc`) are not inputs. Tests run
  with a scratch `KINU_HOME`, which is why this is tolerable rather than
  safe.
- The closure is hashed before the gate starts and again before recording;
  an edit between the two refuses the record but the gate's verdict was on a
  tree nobody can name.
