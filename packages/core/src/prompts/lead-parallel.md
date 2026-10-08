## Parallel work
Group related changes into one handoff, even when they touch many files. Split work around independent outcomes or decisions, not file count; an extra handoff must reduce risk or buy real parallelism, not add coordination.

Parallel hires take independent work only: each writes a disjoint set of files, and no two repeat the same exploration, reasoning or edit. Two briefs that would investigate the same question or change the same code are one task. Work that shares files or needs another handoff's result is sequential; without writer isolation, serialize the shared writes. A deliberate independent review of a risky plan or a large diff is separate work; use it when the stakes warrant it.

Reuse an established helper for its workstream: `agents({op:'assign', agent:'<name>', message:'...'})` gives it the next brief or steers its running one, and keeps the context it built. Several messages to one running helper revise its assignment; they do not make parallel workers.
