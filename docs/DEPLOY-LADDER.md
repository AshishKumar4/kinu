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
- the row's declared `reads`, expanded against the tracked corpus;
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
warning.

## The soundness gate

`scripts/ladder-cache.test.ts` builds a throwaway repository and runs the
real planner and recorder over it. It proves each direction red before green:

- after a green run, a rerun hits every cacheable gate and prints the hash;
- touching one file in a gate's closure misses exactly the gates whose
  closure holds it, and hits the rest;
- a gate with no computable closure never hits;
- a red result leaves no store entry;
- a tool version change misses everything;
- a `live` row is never planned as a hit, read from the declaration;
- a tree that changes while a gate runs is not recorded.

## Scheduling

Gates in a tier run cheapest first by declared seconds, with the serial gates
in their declared positions, at the measured width. On the first red no new
gate is scheduled, running gates finish, and every red is reported with its
reproduce line. `--all` runs the whole tier anyway for a full audit.

## Width

The wave is not scheduled by a count of gates. Each heavy gate declares the
threads it occupies at peak (`GATE_WEIGHTS` in `scripts/ladder.ts`, mirrored
as `GATE_WEIGHT` in `scripts/deploy.sh`) and the runner launches a gate only
while the running weight fits the box's thread count.

Measured 2026-09-15 on the 24-thread workstation (i9-12900K), sampled by
process tree once a second:

| gate | peak threads | mean | samples | declared weight |
| --- | --- | --- | --- | --- |
| `bun test scripts/react-runtime-identity.test.ts` (one Chrome) | 4.3 | 2.4 | 11 | 5 |
| `bun test --parallel=4 packages/cf-backend/` | 10.5 | 5.1 | 23 | 11 |
| `bun run gate:dead-code` | 1.7 | 0.9 | 37 | 1 |

Under a six-gate width the eleven-suite UI row failed every deploy on a
puppeteer wall beside two `--parallel=4` rows: six browser rows and two
worker rows is forty threads on a box with twenty-four. Under the budget the
pre-publish tier ran twice on 2026-09-15 with the UI row inside it: 390 s on
19f9c6666 (one connectome pin red, see below) and 602 s including the
account gate on 1c82aee60, every source gate green.

The budget-6, 12 and 18 curve the brief asked for is not measured. The
scheduler no longer has a gate-count width to sweep; the measurement that
replaces it is the weight table above, and the next figure to take is the
tier wall at budget 12 against budget 24.

## Timing pins under contention

A wall-clock pin is a latency contract and is not converted to CPU time by
this track. The one pin that went red under the wave was already a CPU-time
pin, and CPU time is not contention-invariant on this box either: the mesh
frame read 0.61 ms alone and 1.13 ms under twelve busy threads. It is now a
ratio against a calibration unit measured in the same loop (3.9 to 5.2 under
both conditions), proved red at ten steps per frame.

## Blind spots, printed on the green path

- `node_modules` is trusted to match `bun.lock` and `patches/`;
  `gate:patch-parity` is the gate for that.
- An environment variable read through a computed key or a spread is not an
  input the key sees; only literal names and declared names are hashed.
- A file read by a path the walker cannot see and the audit has not been run
  against is a hole until `--audit-closure` has been run on that gate.
- Reads outside the tree (`$HOME` state, `/etc`) are not inputs. Tests run
  with a scratch `KINU_HOME`, which is why this is tolerable rather than
  safe.
- The closure is hashed before the gate starts and again before recording;
  an edit between the two refuses the record but the gate's verdict was on a
  tree nobody can name.
