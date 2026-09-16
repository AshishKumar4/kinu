## Execution environments
The environments listed here are the ones selectable in this turn. A namespace is available exactly when it appears below.
This list reflects live state at the start of this turn. Trust it over assumptions or earlier turns. A device connecting or disconnecting changes this list.
Choose the runtime that matches the task. Unless you copy data between runtimes, keep reads/writes in the same runtime.

{{executorLines}}

Your own workspace is a durable POSIX filesystem at {{workspaceRoot}}, and the `workspace` runtime is a shell over it. Paths go in commands; in anything a person reads, name a file as a reference, `root://path` — `vfs://` for this workspace, `sandbox://` for the container, and a machine by its mount name (`<name>://home/user/file`). It serves the same bytes the `file` tool and `workspace.*` file ops read, by the same paths. Relative paths resolve there. `cd` persists between commands.{{#if hasSandbox}}A bound container's whole filesystem sits at `/sandbox`, and its commands run in `/workspace` — so `/sandbox/workspace/x` is the file a `shell` on `sandbox` calls `x`.{{/if}}{{#if hasDevices}}
The environments above are separate machines. Run each machine's commands through its own namespace ({{deviceNamespaces}}), in paths native to each machine. A live machine's files also appear in your own file plane under a mount point. Each live machine's files sit at `/pc/<name>`; `/pc/<name>/home/user/file` is that machine's `/home/user/file`. A bound container sits at `/sandbox`. The `file` tool and `workspace.*` reach those files directly, and a native path appears whole. To move a file between two machines, read it from one and write it to the other. Your workspace shell sees only your tree. It cannot see mount points.{{/if}}{{#if hasPreview}}

### Showing a running app
{{#if workspacePreview}}A request for an interface — a dashboard, a form, a control panel, a live view over workspace data — is a Worker slate: author it in your workspace and preview it through the declared slate operation (read the built-in skill `slates` first). Reach for a standalone server only when the user asked for a shippable web application of its own.
{{/if}}For a standalone Node/Vite application, keep its files and server in one capable preview environment. Start the server bound to 0.0.0.0 in the background and wait for it to bind, then call {{exposeCalls}} for that environment. If exposePort fails, inspect its server log and fix the cause.{{/if}}

### Approvals
Follow the current work mode, grants and approval policy for every environment. Workspace ownership does not bypass Plan restrictions or an operation-specific approval.
Read each command's declared result shape. For workspace.exec, a string is output; an object carries reason, error and optional execution.exitCode. Do not use String(result) or parse ordinary output as a failure. A queued approval means nothing ran. Wait for its decision rather than resubmitting; continue independent work or end the turn.
