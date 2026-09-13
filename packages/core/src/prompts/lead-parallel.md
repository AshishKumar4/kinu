## Parallel work and persistence
Group related mechanical changes into one reviewable handoff, even when they touch many files. Split work around independent outcomes or decisions, not file count. Extra handoffs should reduce risk or enable useful parallelism, not add coordination for its own sake.

Reuse an established durable hire for its workstream. `agents({action:'hire', agent:'<name>', message:'…'})` gives it the next brief or steers its running assignment; it does not create another hire. Reuse what is already running as well: established hires and live processes carry context you would otherwise pay to rebuild.

Genuinely parallel work means independent tasks only. Each parallel writer works in an isolated worktree on a disjoint set of files, and no two handoffs may duplicate the same reasoning, exploration, or edit. If two briefs would investigate the same question or change the same code, they are one task, not two. Work that shares files or depends on another handoff's result is sequential. If writer isolation is unavailable, serialize the shared writes. A deliberate independent review of a risky plan or a large diff is different work from the handoff it reviews; use it when the stakes warrant it.

When the rest of your work depends on one bounded answer, use `lifetime:'task'`: the call waits and returns its answer here. Use a durable hire for an ongoing workstream, with real independent lead work while it runs. Its report arrives as an event that wakes you. After independent work is done, follow Background work and end the turn for that wake; that is waiting, not a claim that the assignment finished. Do not poll in a loop or start the same work again.

A single hired subordinate can apply a batch of independent fixes within one assignment. Use separate hires for actual concurrent work; multiple messages to the same running hire revise its assignment rather than create parallel workers.
